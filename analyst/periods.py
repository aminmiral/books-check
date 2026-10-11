"""Turn a spoken time period into a date range.

Voice users say "last quarter" or "in March", not ISO dates. `parse_period`
returns a half-open range [start, end) plus a label to speak back, so the
answer can confirm what was understood ("In March 2026, ...").
"""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import date, timedelta

ALL_TIME = (date(1900, 1, 1), date(9999, 1, 1))

MONTHS = {name.lower(): i for i, name in enumerate(calendar.month_name) if name}
MONTHS |= {name.lower(): i for i, name in enumerate(calendar.month_abbr) if name}
MONTHS["sept"] = 9

NUMBERS = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve".split())}
NUMBERS |= {"a": 1, "an": 1, "a couple of": 2, "a few": 3}
QUARTER_WORDS = {"first": 1, "second": 2, "third": 3, "fourth": 4}

FILLER = re.compile(r"\b(in|during|for|over|from|the|so far)\b")


@dataclass(frozen=True)
class Period:
    start: date
    end: date  # exclusive
    label: str

    def contains(self, d: date) -> bool:
        return self.start <= d < self.end


def _add_months(d: date, months: int) -> date:
    y, m = divmod(d.month - 1 + months, 12)
    return date(d.year + y, m + 1, 1)


def _month(year: int, month: int) -> Period:
    start = date(year, month, 1)
    return Period(start, _add_months(start, 1),
                  f"{calendar.month_name[month]} {year}")


def _quarter(year: int, q: int) -> Period:
    start = date(year, 3 * (q - 1) + 1, 1)
    return Period(start, _add_months(start, 3), f"Q{q} {year}")


def parse_period(text: str | None, today: date) -> Period:
    """Raises ValueError if the period is not understood."""
    raw = (text or "").strip().lower()
    s = re.sub(r"\s+", " ", FILLER.sub(" ", raw)).strip(" ?.!,")
    tomorrow = today + timedelta(days=1)

    if s in {"", "all", "all time", "ever", "everything", "anytime", "any time"}:
        return Period(*ALL_TIME, "all time")
    if s == "today":
        return Period(today, tomorrow, "today")
    if s == "yesterday":
        return Period(today - timedelta(days=1), today, "yesterday")

    m = re.fullmatch(r"(this|last|previous|past) (week|month|quarter|year)", s)
    if m:
        which, unit = m.groups()
        back = 0 if which == "this" else 1
        label = f"{'this' if back == 0 else 'last'} {unit}"
        if unit == "week":
            start = today - timedelta(days=today.weekday() + 7 * back)
            return Period(start, start + timedelta(days=7), label)
        if unit == "month":
            start = _add_months(today.replace(day=1), -back)
            return Period(start, _add_months(start, 1), label)
        if unit == "quarter":
            q_start = date(today.year, 3 * ((today.month - 1) // 3) + 1, 1)
            start = _add_months(q_start, -3 * back)
            return Period(start, _add_months(start, 3), label)
        start = date(today.year - back, 1, 1)
        return Period(start, date(start.year + 1, 1, 1), label)

    if s in {"year to date", "ytd"}:
        return Period(date(today.year, 1, 1), tomorrow, "this year so far")

    number = "|".join(sorted(map(re.escape, NUMBERS), key=len, reverse=True))
    m = re.fullmatch(rf"(?:last|past|previous) (\d+|{number}) "
                     r"(day|week|month|year)s?", s)
    if m:
        n = int(m.group(1)) if m.group(1).isdigit() else NUMBERS[m.group(1)]
        unit = m.group(2)
        if n < 1:
            raise ValueError(f"I didn't understand the period {text!r}")
        if unit in {"day", "week"}:
            start = tomorrow - timedelta(days=n * (7 if unit == "week" else 1))
        else:
            months = n * (12 if unit == "year" else 1)
            y, mo = divmod(today.month - 1 - months, 12)
            day = min(today.day, calendar.monthrange(today.year + y, mo + 1)[1])
            start = date(today.year + y, mo + 1, day) + timedelta(days=1)
        label = f"the last {n} {unit}s" if n > 1 else f"the last {unit}"
        return Period(start, tomorrow, label)

    m = re.fullmatch(r"(\d{4})-(\d{1,2})", s)
    if m and 1 <= int(m.group(2)) <= 12:
        return _month(int(m.group(1)), int(m.group(2)))

    m = re.fullmatch(rf"({'|'.join(MONTHS)})(?: (\d{{4}}))?", s)
    if m:
        month = MONTHS[m.group(1)]
        if m.group(2):
            return _month(int(m.group(2)), month)
        # A bare month means its most recent occurrence, this year or last.
        year = today.year if month <= today.month else today.year - 1
        return _month(year, month)

    m = re.fullmatch(r"q([1-4])(?: (\d{4}))?|(\d{4}) q([1-4])", s)
    if m:
        q = int(m.group(1) or m.group(4))
        return _quarter(int(m.group(2) or m.group(3) or today.year), q)

    m = re.fullmatch(r"(first|second|third|fourth) quarter(?: of)?(?: (\d{4}))?", s)
    if m:
        return _quarter(int(m.group(2) or today.year), QUARTER_WORDS[m.group(1)])

    m = re.fullmatch(r"(\d{4})", s)
    if m:
        y = int(m.group(1))
        return Period(date(y, 1, 1), date(y + 1, 1, 1), str(y))

    raise ValueError(f"I didn't understand the period {text!r}")
