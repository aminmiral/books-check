"""MCP server: purchase-fraud findings for a voice assistant.

Three read-only tools, one per thing a user asks:

    list_anomalies    "Anything suspicious last quarter?"
    explain_case      "Why was purchase order 293 flagged?"
    summarise_period  "Give me a summary of this year."

Every result carries a `speech` field written to be read aloud as-is, plus
structured fields for a screen card. Nothing is computed per request beyond
filtering an in-memory list: scoring happened offline (analyst/precompute.py).

Streamable HTTP, stateless, JSON responses (no SSE): quick tunnels such as
`cloudflared tunnel --url` do not pass Server-Sent Events.

Run:
    python -m analyst.server            # http://127.0.0.1:8000/mcp
Environment:
    MCP_HOST, MCP_PORT                  bind address (default 127.0.0.1:8000)
    PUBLIC_HOSTS                        comma-separated extra Host names to
                                        accept, e.g. a tunnel hostname
    PIPER_VOICE                         path to a Piper .onnx voice for /speak
                                        (default: data/voices/, fetched by
                                        scripts/get_voice.py)
    DEMO_TODAY                          pin "today" (YYYY-MM-DD) so answers
                                        are reproducible; default: real date
"""

from __future__ import annotations

import io
import os
import re
import wave
from collections import Counter
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Annotated

import anyio
import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from pydantic import BaseModel, Field
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Mount
from starlette.staticfiles import StaticFiles

from .periods import Period, parse_period
from .store import Case, Store

ROOT = Path(__file__).resolve().parents[1]
WEB_DIR = ROOT / "web"
VOICE_NAME = "en_US-ljspeech-medium"
VOICE_PATHS = [ROOT / "data" / "voices" / f"{VOICE_NAME}.onnx",
               Path.home() / ".local" / "share" / "piper-voices" / f"{VOICE_NAME}.onnx"]
DEFAULT_PERIOD = "last 12 months"

# How a finding kind reads in a count ("2 duplicate payments").
KIND_NOUNS = {
    "duplicate_bill": ("duplicate payment", "duplicate payments"),
    "overbilled": ("overbilled order", "overbilled orders"),
    "no_receipt": ("payment without a goods receipt",
                   "payments without a goods receipt"),
    "self_approved": ("self-approved order", "self-approved orders"),
    "split_purchase": ("order split to stay under the approval limit",
                       "orders split to stay under the approval limit"),
    "after_hours": ("order handled outside office hours",
                    "orders handled outside office hours"),
    "slightly_overbilled": ("small billing difference",
                            "small billing differences"),
    "unusual_pattern": ("unusual pattern", "unusual patterns"),
}

READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False,
                            idempotentHint=True, openWorldHint=False)


# ---- output shapes ---------------------------------------------------------

class Finding(BaseModel):
    kind: str
    text: str
    exposure: float


class FlaggedOrder(BaseModel):
    purchase_order: int
    vendor: str
    requester: str
    amount: float
    placed: str = Field(description="date the order was raised, YYYY-MM-DD")
    confidence: str = Field(description="high, medium or low")
    exposure: float = Field(description="dollars at risk")
    kind: str = Field(description="main finding, e.g. duplicate_bill, split_purchase")
    headline: str


class AnomalyList(BaseModel):
    speech: str
    period: str
    orders_checked: int
    flagged_count: int
    exposure_total: float
    orders: list[FlaggedOrder]


class TimelineStep(BaseModel):
    at: str = Field(description="ISO timestamp")
    activity: str
    actor: str
    amount: float | None


class CaseExplanation(BaseModel):
    speech: str
    found: bool
    purchase_order: int
    flagged: bool = False
    confidence: str | None = None
    vendor: str | None = None
    requester: str | None = None
    approver: str | None = None
    amount: float | None = None
    billed: float | None = None
    paid: float | None = None
    exposure: float = 0.0
    findings: list[Finding] = []
    related_orders: list[int] = []
    next_step: str | None = None
    timeline: list[TimelineStep] = []


class KindCount(BaseModel):
    kind: str
    label: str
    count: int


class PeriodSummary(BaseModel):
    speech: str
    period: str
    orders_checked: int
    total_value: float
    flagged_count: int
    exposure_total: float
    by_kind: list[KindCount]
    top_vendor: str | None


# ---- wording ---------------------------------------------------------------

def money(x: float) -> str:
    return f"${x:,.0f}"


def person(login: str | None) -> str:
    return " ".join(p.capitalize() for p in str(login).split(".")) if login else ""


def plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def join_and(parts: list[str]) -> str:
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]


def sentence_start(label: str) -> str:
    """'last quarter' -> 'Last quarter'; 'March 2026' -> 'In March 2026'."""
    if label.split()[0] in {"this", "last", "the"} or label in {"today", "yesterday"}:
        return label[0].upper() + label[1:]
    return "Across all time" if label == "all time" else f"In {label}"


def next_step(case: Case) -> str:
    f = case.findings[0]
    kind, vendor = f["kind"], case.vendor
    if kind == "duplicate_bill":
        return f"Ask {vendor} for a refund or credit note for the second payment."
    if kind == "overbilled":
        return (f"Recover the {money(f['exposure'])} difference from {vendor} "
                f"and check its other bills.")
    if kind == "no_receipt":
        return ("Confirm with the warehouse that the goods arrived before "
                f"paying {vendor} again.")
    if kind == "self_approved":
        return "Have an independent manager review and re-approve this order."
    if kind == "split_purchase":
        others = join_and([str(p) for p in f.get("related", [])])
        return (f"Review it together with order{'s' * (len(f.get('related', [])) > 1)} "
                f"{others}; combined, they needed senior approval.")
    if kind == "after_hours":
        return "Check who was signed in at that time and whether the approval was genuine."
    if kind == "slightly_overbilled":
        return "Compare the bill with the order line by line."
    return "Give it a quick look; no specific control was broken."


def parse_or_fail(period: str | None) -> Period:
    try:
        return parse_period(period or DEFAULT_PERIOD, store.today)
    except ValueError:
        raise ToolError(
            f"I didn't understand the period '{period}'. Try 'last quarter', "
            "'this year', 'March', 'Q2 2026' or 'the last 90 days'.") from None


# ---- server ----------------------------------------------------------------

store = Store(today=date.fromisoformat(os.environ["DEMO_TODAY"])
              if os.environ.get("DEMO_TODAY") else None)

mcp = MCPServer(
    name="erp-anomaly-analyst",
    title="ERP Anomaly Analyst",
    version="0.1.0",
    instructions=(
        "Answers questions about suspicious purchase orders, such as "
        "duplicate payments, overbilling, payments without a goods receipt, "
        "self-approval, purchases split under the approval limit and "
        "activity outside office hours. Each result has a 'speech' field "
        "meant to be read aloud unchanged. Typical flow: summarise_period or "
        "list_anomalies, then explain_case with a purchase order number."),
)

PeriodArg = Annotated[str, Field(
    description="Time period in plain words, e.g. 'this year', 'last quarter', "
                "'last month', 'March', 'Q2 2026', 'the last 90 days', 'all time'. "
                "Also called timeframe, date range, window.")]


@mcp.tool(title="List suspicious purchase orders", annotations=READ_ONLY)
def list_anomalies(
    period: PeriodArg = DEFAULT_PERIOD,
    limit: Annotated[int, Field(
        description="How many orders to describe (1-10). Also called top, count.")] = 3,
) -> AnomalyList:
    """Find suspicious, flagged or risky purchase orders (possible fraud,
    errors, red flags, anomalies) in a time period, most serious first."""
    if not 1 <= limit <= 10:
        raise ToolError("limit must be between 1 and 10.")
    p = parse_or_fail(period)
    checked = store.in_period(p)
    flagged = store.flagged_in(p)
    exposure = sum(c.exposure for c in flagged)
    top = flagged[:limit]
    lead = sentence_start(p.label)

    if not checked:
        speech = f"I don't have any purchase orders for {p.label}."
    elif not flagged:
        speech = (f"{lead}, nothing stood out. I checked "
                  f"{plural(len(checked), 'purchase order', 'purchase orders')}.")
    else:
        speech = (f"{lead}, I flagged {len(flagged)} of {len(checked)} purchase "
                  f"orders, with about {money(exposure)} at risk. ")
        if len(top) < len(flagged):
            speech += f"The top {len(top)}: "
        speech += " ".join(
            f"Purchase order {c.po}, {c.vendor}: {c.findings[0]['short']}."
            for c in top)

    return AnomalyList(
        speech=speech.strip(), period=p.label, orders_checked=len(checked),
        flagged_count=len(flagged), exposure_total=round(exposure, 2),
        orders=[FlaggedOrder(
            purchase_order=c.po, vendor=c.vendor, requester=person(c.requester),
            amount=c.po_amount, placed=c.placed.isoformat(),
            confidence=c.confidence, exposure=round(c.exposure, 2),
            kind=c.findings[0]["kind"], headline=c.findings[0]["short"]) for c in top])


@mcp.tool(title="Explain a purchase order", annotations=READ_ONLY)
def explain_case(
    purchase_order: Annotated[str, Field(
        description="The purchase order number, e.g. '293', 'PO 293' or "
                    "'PO/293'. Also called order number, PO, case.")],
) -> CaseExplanation:
    """Explain why a purchase order was flagged (or confirm it looks normal):
    the evidence, the money at risk, its history and a suggested next step."""
    digits = re.findall(r"\d+", purchase_order or "")
    if not digits:
        raise ToolError("Give a purchase order number, for example 'PO 293'.")
    po = int(digits[-1])
    case = store.get(po)
    if case is None:
        lo, hi = store.po_range
        return CaseExplanation(
            found=False, purchase_order=po,
            speech=f"I can't find purchase order {po}. "
                   f"Order numbers run from {lo} to {hi}.")

    intro = (f"Purchase order {po}, from {case.vendor} for "
             f"{money(case.po_amount)}, requested by {person(case.requester)}.")
    if case.flagged:
        step = next_step(case)
        speech = " ".join([intro, *(f["text"] for f in case.findings),
                           f"Suggested next step: {step}"])
    else:
        step = None
        speech = (f"{intro} It looks normal: approved by "
                  f"{person(case.approver)}, received, billed and paid with "
                  f"nothing out of line.")

    related = next((f.get("related", []) for f in case.findings
                    if f["kind"] == "split_purchase"), [])
    return CaseExplanation(
        speech=speech, found=True, purchase_order=po, flagged=case.flagged,
        confidence=case.confidence, vendor=case.vendor,
        requester=person(case.requester), approver=person(case.approver),
        amount=case.po_amount, billed=case.billed, paid=case.paid,
        exposure=round(case.exposure, 2),
        findings=[Finding(kind=f["kind"], text=f["text"],
                          exposure=round(f["exposure"], 2))
                  for f in case.findings] if case.flagged else [],
        related_orders=related, next_step=step,
        timeline=[TimelineStep(at=s.at.isoformat(timespec="minutes"),
                               activity=s.activity, actor=person(s.actor),
                               amount=s.amount) for s in case.steps])


@mcp.tool(title="Summarise a period", annotations=READ_ONLY)
def summarise_period(period: PeriodArg = DEFAULT_PERIOD) -> PeriodSummary:
    """Summarise purchasing in a time period: how many orders and how much
    was spent, how many were flagged and why, money at risk, and the vendor
    that came up most often. Also called overview, report, recap."""
    p = parse_or_fail(period)
    checked = store.in_period(p)
    flagged = store.flagged_in(p)
    exposure = sum(c.exposure for c in flagged)
    total = sum(c.po_amount for c in checked)
    kinds = Counter(c.findings[0]["kind"] for c in flagged)
    vendors = Counter(c.vendor for c in flagged).most_common(2)
    # Only name a vendor when it stands out, not on a tie.
    top_vendor = (vendors[0][0] if vendors and vendors[0][1] > 1
                  and (len(vendors) == 1 or vendors[0][1] > vendors[1][1]) else None)
    by_kind = [KindCount(kind=k, label=plural(n, *KIND_NOUNS[k]).split(" ", 1)[1],
                         count=n) for k, n in kinds.most_common()]
    lead = sentence_start(p.label)

    if not checked:
        speech = f"I don't have any purchase orders for {p.label}."
    else:
        speech = (f"{lead}: {plural(len(checked), 'purchase order', 'purchase orders')} "
                  f"worth {money(total)}. ")
        if flagged:
            speech += (f"I flagged {len(flagged)}: "
                       + join_and([plural(n, *KIND_NOUNS[k])
                                   for k, n in kinds.most_common()])
                       + f". About {money(exposure)} is at risk.")
            if top_vendor:
                speech += f" {top_vendor} came up most often."
        else:
            speech += "Nothing was flagged."

    return PeriodSummary(
        speech=speech.strip(), period=p.label, orders_checked=len(checked),
        total_value=round(total, 2), flagged_count=len(flagged),
        exposure_total=round(exposure, 2), by_kind=by_kind, top_vendor=top_vendor)


@mcp.custom_route("/health", methods=["GET"])
async def health(request: Request) -> JSONResponse:
    return JSONResponse({"ok": True, "cases": len(store.cases),
                         "detector": store.meta.get("detector")})


@lru_cache(maxsize=1)
def piper_voice():
    """The neural voice for /speak, or None if Piper or the model is missing
    (the web client then falls back to the browser's own voice)."""
    try:
        from piper import PiperVoice
    except ImportError:
        return None
    env = os.environ.get("PIPER_VOICE")
    path = next((p for p in ([Path(env)] if env else VOICE_PATHS) if p.is_file()), None)
    return PiperVoice.load(str(path)) if path else None


@lru_cache(maxsize=256)
def synthesise(text: str) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        piper_voice().synthesize_wav(text, w)
    return buf.getvalue()


@mcp.custom_route("/speak", methods=["POST"])
async def speak(request: Request) -> Response:
    """Text in, WAV out: the demo client's Alexa voice. Not an MCP tool."""
    if await anyio.to_thread.run_sync(piper_voice) is None:
        return JSONResponse({"error": "no voice installed; run scripts/get_voice.py"},
                            status_code=503)
    try:
        text = str((await request.json())["text"]).strip()[:600]
    except (ValueError, KeyError, TypeError):
        return JSONResponse({"error": 'send JSON like {"text": "..."}'}, status_code=400)
    if not text:
        return JSONResponse({"error": "text is empty"}, status_code=400)
    return Response(await anyio.to_thread.run_sync(synthesise, text), media_type="audio/wav")


def build_app(host: str = "127.0.0.1"):
    public = [h.strip() for h in os.environ.get("PUBLIC_HOSTS", "").split(",")
              if h.strip()]
    security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=["127.0.0.1:*", "localhost:*", "[::1]:*", *public],
        allowed_origins=["http://127.0.0.1:*", "http://localhost:*",
                         "http://[::1]:*", *(f"https://{h}" for h in public)])
    app = mcp.streamable_http_app(stateless_http=True, json_response=True,
                                  transport_security=security, host=host)
    if WEB_DIR.is_dir():  # the demo client, same origin as /mcp: no CORS needed
        app.router.routes.append(Mount("/", StaticFiles(directory=WEB_DIR, html=True)))
    return app


def main() -> None:
    host = os.environ.get("MCP_HOST", "127.0.0.1")
    port = int(os.environ.get("MCP_PORT", "8000"))
    uvicorn.run(build_app(host), host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
