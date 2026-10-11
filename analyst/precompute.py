"""Offline scoring: run the detector once, persist scores and evidence.

A voice round trip has a 500 ms budget and fitting the context-aware detector
takes ~2 s, so the MCP server never runs a model. This script does all of the
work ahead of time and writes a small SQLite file the server only reads.

What the server can see is deliberately limited to what a real deployment
would have. The event log's ground-truth columns (`anomaly_type`,
`trace_label`) are stripped before anything is computed, and the generator's
case ids are dropped too — split-purchase traces carry a `-S<n>` suffix that
would give the answer away. Cases are keyed by their ERP purchase-order
number instead. Labels are used only by scripts/evaluate.py.

Usage:
    python -m analyst.precompute [--log PATH] [--erpbench-src PATH]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
BENCH = ROOT.parent / "erp-anomaly-bench"
DEFAULT_LOG = BENCH / "src" / "data" / "p2p_hard.csv"
DEFAULT_OUT = ROOT / "data" / "cases.sqlite"

APPROVAL_THRESHOLD = 5000.0  # same policy the benchmark's context features use
BILL_TOLERANCE = 0.02        # bills within 2% of the PO are routine corrections
NEAR_BAND = (0.80, 1.00)
WINDOW_DAYS = 14
BUSINESS_HOURS = (8, 19)     # matches erpbench.bench.features off-hours test


def po_number(doc_ref: str) -> int:
    return int(str(doc_ref).split("/")[1])


def money(x: float) -> str:
    return f"${x:,.0f}"


def clock(ts: pd.Timestamp) -> str:
    return ts.strftime("%I:%M %p").lstrip("0") + " on a " + ts.strftime("%A")


def person(login: str) -> str:
    return " ".join(p.capitalize() for p in str(login).split("."))


def case_facts(g: pd.DataFrame) -> dict:
    acts = g["activity"]
    po = g[acts == "Create PO"].iloc[0]
    approve = g[acts == "Approve PO"]
    bills = g.loc[acts == "Post Vendor Bill", "amount"]
    pays = g.loc[acts == "Pay Vendor Bill", "amount"]
    return {
        "po": po_number(po["doc_ref"]),
        "start": g["timestamp"].min(),
        "end": g["timestamp"].max(),
        "requester": po["actor"],
        "approver": approve["actor"].iloc[0] if len(approve) else None,
        "vendor": po["vendor"],
        "po_amount": float(po["amount"]),
        "first_bill": float(bills.iloc[0]) if len(bills) else 0.0,
        "n_bills": int(len(bills)),
        "billed": float(bills.sum()),
        "paid": float(pays.sum()),
        "first_payment": float(pays.iloc[0]) if len(pays) else 0.0,
        "has_receipt": bool((acts == "Receive Goods").any()),
    }


def split_neighbours(facts: pd.DataFrame) -> dict[int, list[int]]:
    """POs by the same requester to the same vendor, each just under the
    approval threshold, chained together when consecutive orders are within
    the window. Mirrors the benchmark's cross-trace features, but keeps the
    members so the finding can name them. Every member of a group gets the
    same group, so the orders never disagree about how many there were."""
    near = facts[(facts["po_amount"] / APPROVAL_THRESHOLD).between(*NEAR_BAND)]
    window = pd.Timedelta(days=WINDOW_DAYS)
    out = {}
    for _, same in near.sort_values("start").groupby(["requester", "vendor"]):
        group, last = [], None
        for po, row in same.iterrows():
            if last is not None and row["start"] - last > window:
                if len(group) >= 2:
                    out.update({p: sorted(group) for p in group})
                group = []
            group.append(po); last = row["start"]
        if len(group) >= 2:
            out.update({p: sorted(group) for p in group})
    return out


def span_words(days: int) -> str:
    return "on the same day" if days == 0 else f"in {days} day{'s' * (days != 1)}"


def evidence_for(f: dict, g: pd.DataFrame, neighbours: list[int] | None,
                 facts: pd.DataFrame) -> list[dict]:
    """Findings ordered strongest first. Each carries the money it puts at
    risk; a case's exposure is its largest finding, never a sum, so one
    payment is not counted twice."""
    ev = []
    ratio = f["first_bill"] / f["po_amount"] if f["po_amount"] else 1.0

    if f["n_bills"] > 1:
        extra = f["paid"] - f["first_payment"]
        times = {2: "twice", 3: "three times"}.get(f["n_bills"],
                                                   f"{f['n_bills']} times")
        ev.append({"kind": "duplicate_bill", "tier": "rule", "exposure": extra,
                   "short": f"billed {times}",
                   "text": f"The same order was billed {times}, and "
                           f"{money(extra)} was paid more than once."})
    if ratio > 1 + BILL_TOLERANCE:
        diff = f["first_bill"] - f["po_amount"]
        ev.append({"kind": "overbilled", "tier": "rule", "exposure": diff,
                   "short": f"billed {(ratio - 1) * 100:.0f}% over the order",
                   "text": f"The bill is {(ratio - 1) * 100:.0f}% above the "
                           f"purchase order, {money(diff)} more than agreed."})
    if f["paid"] > 0 and not f["has_receipt"]:
        ev.append({"kind": "no_receipt", "tier": "rule", "exposure": f["paid"],
                   "short": "paid with no goods receipt",
                   "text": f"{money(f['paid'])} was paid with no record of "
                           f"the goods being received."})
    if f["approver"] and f["approver"] == f["requester"]:
        ev.append({"kind": "self_approved", "tier": "rule",
                   "exposure": f["po_amount"],
                   "short": "approved by the person who requested it",
                   "text": f"{person(f['requester'])} approved their own "
                           f"purchase order."})
    if neighbours:
        group = facts.loc[neighbours]
        others = [p for p in neighbours if p != f["po"]]
        span = (group["start"].max() - group["start"].min()).days
        ev.append({"kind": "split_purchase", "tier": "context",
                   "exposure": f["po_amount"], "related": others,
                   "short": f"one of {len(neighbours)} orders split under "
                            f"the approval limit",
                   "text": f"It is one of {len(neighbours)} orders "
                           f"{person(f['requester'])} placed with "
                           f"{f['vendor']} {span_words(span)}, each just under "
                           f"the {money(APPROVAL_THRESHOLD)} approval limit, "
                           f"{money(group['po_amount'].sum())} in total."})
    ts = g["timestamp"]
    odd = g[(ts.dt.hour < BUSINESS_HOURS[0]) | (ts.dt.hour >= BUSINESS_HOURS[1])
            | (ts.dt.weekday >= 5)]
    if len(odd):
        first = odd.iloc[0]
        verb = {"Approve PO": "approved", "Post Vendor Bill": "billed",
                "Pay Vendor Bill": "paid", "Create PO": "created",
                "Receive Goods": "received"}[first["activity"]]
        more = (f", and {len(odd) - 1} more step{'s' * (len(odd) > 2)} "
                f"happened outside office hours" if len(odd) > 1 else "")
        ev.append({"kind": "after_hours", "tier": "context",
                   "exposure": f["paid"],
                   "short": f"{verb} at {clock(first['timestamp'])}",
                   "text": f"It was {verb} at {clock(first['timestamp'])}"
                           f"{more}."})
    if 1.0 < ratio <= 1 + BILL_TOLERANCE:
        diff = f["first_bill"] - f["po_amount"]
        ev.append({"kind": "slightly_overbilled", "tier": "weak",
                   "exposure": diff,
                   "short": f"billed {(ratio - 1) * 100:.1f}% over the order",
                   "text": f"The bill is {(ratio - 1) * 100:.1f}% above the "
                           f"order. That is inside normal tolerance, so treat "
                           f"it as a weak signal."})
    return ev


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", type=Path, default=DEFAULT_LOG)
    ap.add_argument("--erpbench-src", type=Path, default=BENCH / "src")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--review-share", type=float, default=0.12,
                    help="share of cases the model alone sends for review "
                         "(an audit team's capacity, not tuned on labels)")
    args = ap.parse_args()

    sys.path.insert(0, str(args.erpbench_src))
    from erpbench.bench.data import load_log, strip_labels
    from erpbench.bench.features import context_features
    from erpbench.bench.methods import FeatureOutlier
    from sklearn.ensemble import IsolationForest

    log = strip_labels(load_log(args.log))  # labels gone before anything else

    detector = FeatureOutlier(IsolationForest(n_estimators=200, random_state=0),
                              features=context_features)
    scores = detector.fit(log).score(log)
    threshold = float(scores.quantile(1 - args.review_share))

    groups = dict(tuple(log.groupby("case_id", sort=False)))
    facts = pd.DataFrame([case_facts(g) for g in groups.values()],
                         index=list(groups)).assign(score=scores)
    trace_of = dict(zip(facts["po"], facts.index))
    facts = facts.set_index("po").sort_index()
    neighbours = split_neighbours(facts)

    case_rows, event_rows = [], []
    for po, f in facts.iterrows():
        g = groups[trace_of[po]]
        ev = evidence_for({**f, "po": po}, g, neighbours.get(po), facts)
        tiers = {e["tier"] for e in ev}
        flagged = f["score"] >= threshold or bool(tiers & {"rule", "context"})
        confidence = ("high" if "rule" in tiers else
                      "medium" if "context" in tiers else "low")
        if flagged and not ev:
            ev.append({"kind": "unusual_pattern", "tier": "model",
                       "exposure": 0.0, "short": "an unusual pattern",
                       "text": "No single control was broken, but the "
                               "combination of amount, timing and people "
                               "is unusual compared with similar orders."})
        case_rows.append((
            int(po), f["start"].isoformat(), f["end"].isoformat(),
            f["requester"], f["approver"], f["vendor"], f["po_amount"],
            f["billed"], f["paid"], float(f["score"]), int(flagged),
            confidence if flagged else None,
            max((e["exposure"] for e in ev), default=0.0) if flagged else 0.0,
            json.dumps(ev)))
        for seq, e in enumerate(g.itertuples(index=False)):
            event_rows.append((int(po), seq, e.activity, e.timestamp.isoformat(),
                               e.actor, e.role,
                               None if pd.isna(e.amount) else float(e.amount),
                               e.doc_ref))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.unlink(missing_ok=True)
    db = sqlite3.connect(args.out)
    db.executescript("""
        CREATE TABLE cases (
            po INTEGER PRIMARY KEY, start TEXT, end TEXT, requester TEXT,
            approver TEXT, vendor TEXT, po_amount REAL, billed REAL, paid REAL,
            score REAL, flagged INTEGER, confidence TEXT, exposure REAL,
            evidence TEXT);
        CREATE TABLE events (
            po INTEGER, seq INTEGER, activity TEXT, timestamp TEXT, actor TEXT,
            role TEXT, amount REAL, doc_ref TEXT, PRIMARY KEY (po, seq));
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    """)
    db.executemany("INSERT INTO cases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   case_rows)
    db.executemany("INSERT INTO events VALUES (?,?,?,?,?,?,?,?)", event_rows)
    db.executemany("INSERT INTO meta VALUES (?,?)", [
        ("detector", "iforest_ctx (erp-anomaly-bench)"),
        ("review_share", str(args.review_share)),
        ("score_threshold", f"{threshold:.4f}"),
        ("source_log", args.log.name),
        ("source_sha256", hashlib.sha256(args.log.read_bytes()).hexdigest()),
        ("generated_at", datetime.now(timezone.utc).isoformat(timespec="seconds")),
    ])
    db.commit()
    n_flagged = sum(r[10] for r in case_rows)
    print(f"Scored {len(case_rows)} cases, flagged {n_flagged} "
          f"(threshold {threshold:.3f}) -> {args.out}")


if __name__ == "__main__":
    main()
