"""In-memory view of the precomputed cases, with dates moved to the present.

The benchmark log's simulated clock runs from 2025 into 2031, so "this
month" would mean nothing against the raw dates. At load time every
timestamp is shifted by a whole number of weeks so the newest activity lands
in the current week. Whole weeks keep each step's weekday and time of day,
which the off-hours findings ("approved at 4:59 AM on a Sunday") depend on.

Stdlib only: the server never imports pandas or scikit-learn.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

from .periods import Period

DEFAULT_DB = Path(__file__).resolve().parents[1] / "data" / "cases.sqlite"


@dataclass
class Step:
    activity: str
    at: datetime
    actor: str
    role: str
    amount: float | None


@dataclass
class Case:
    po: int
    start: datetime
    end: datetime
    requester: str
    approver: str | None
    vendor: str
    po_amount: float
    billed: float
    paid: float
    score: float
    flagged: bool
    confidence: str | None
    exposure: float
    findings: list[dict]
    steps: list[Step] = field(default_factory=list)

    @property
    def placed(self) -> date:
        """The date a case belongs to: when the order was raised."""
        return self.start.date()


# Words people say around a search that aren't part of what they're looking for.
SEARCH_FILLER = {"po", "p", "o", "order", "orders", "purchase", "number", "no", "the",
                 "by", "from", "for", "of", "s", "with", "find", "search", "show", "me"}


class Store:
    def __init__(self, db_path: Path = DEFAULT_DB, today: date | None = None):
        self.today = today or date.today()
        db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        db.row_factory = sqlite3.Row
        rows = db.execute("SELECT * FROM cases ORDER BY po").fetchall()
        latest = max(datetime.fromisoformat(r["end"]) for r in rows)
        self.shift = timedelta(weeks=(self.today - latest.date()).days // 7)
        self.meta = dict(db.execute("SELECT key, value FROM meta").fetchall())

        self.cases: dict[int, Case] = {}
        for r in rows:
            self.cases[r["po"]] = Case(
                po=r["po"], start=self._at(r["start"]), end=self._at(r["end"]),
                requester=r["requester"], approver=r["approver"],
                vendor=r["vendor"], po_amount=r["po_amount"],
                billed=r["billed"], paid=r["paid"], score=r["score"],
                flagged=bool(r["flagged"]), confidence=r["confidence"],
                exposure=r["exposure"], findings=json.loads(r["evidence"]))
        for e in db.execute("SELECT * FROM events ORDER BY po, seq"):
            self.cases[e["po"]].steps.append(Step(
                e["activity"], self._at(e["timestamp"]), e["actor"], e["role"],
                e["amount"]))
        db.close()

    def _at(self, iso: str) -> datetime:
        return datetime.fromisoformat(iso) + self.shift

    def get(self, po: int) -> Case | None:
        return self.cases.get(po)

    def in_period(self, period: Period) -> list[Case]:
        return [c for c in self.cases.values() if period.contains(c.placed)]

    def flagged_in(self, period: Period) -> list[Case]:
        """Flagged cases, strongest evidence first, then by model score."""
        tier = {"high": 0, "medium": 0, "low": 1}
        return sorted((c for c in self.in_period(period) if c.flagged),
                      key=lambda c: (tier[c.confidence], -c.score))

    def search(self, query: str) -> list[Case]:
        """Orders matching every word of the query: a number matches the start
        of an order number, a word matches the start of a word in the vendor
        or the requester's or approver's name. Exact order number first, then
        flagged orders by strength, then newest first."""
        words = [w for w in re.findall(r"[a-z]+|\d+", query.lower()) if w not in SEARCH_FILLER]
        if not words:
            return []

        def matches(c: Case) -> bool:
            names = re.findall(r"[a-z]+", f"{c.vendor} {c.requester} {c.approver or ''}".lower())
            return all(str(c.po).startswith(w) if w.isdigit()
                       else any(n.startswith(w) for n in names) for w in words)

        tier = {"high": 0, "medium": 0, "low": 1}
        exact = {int(w) for w in words if w.isdigit()}
        return sorted((c for c in self.cases.values() if matches(c)),
                      key=lambda c: (c.po not in exact, not c.flagged,
                                     tier.get(c.confidence, 2), -c.score, -c.po))

    @property
    def po_range(self) -> tuple[int, int]:
        return min(self.cases), max(self.cases)
