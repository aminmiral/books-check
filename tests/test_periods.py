from datetime import date

import pytest

from analyst.periods import parse_period

TODAY = date(2026, 10, 8)  # a Thursday


@pytest.mark.parametrize("text, start, end, label", [
    ("this month", date(2026, 10, 1), date(2026, 11, 1), "this month"),
    ("last month", date(2026, 9, 1), date(2026, 10, 1), "last month"),
    ("previous month", date(2026, 9, 1), date(2026, 10, 1), "last month"),
    ("this week", date(2026, 10, 5), date(2026, 10, 12), "this week"),
    ("last week", date(2026, 9, 28), date(2026, 10, 5), "last week"),
    ("this quarter", date(2026, 10, 1), date(2027, 1, 1), "this quarter"),
    ("the last quarter", date(2026, 7, 1), date(2026, 10, 1), "last quarter"),
    ("this year", date(2026, 1, 1), date(2027, 1, 1), "this year"),
    ("last year", date(2025, 1, 1), date(2026, 1, 1), "last year"),
    ("year to date", date(2026, 1, 1), date(2026, 10, 9), "this year so far"),
    ("last 90 days", date(2026, 7, 11), date(2026, 10, 9), "the last 90 days"),
    ("past two weeks", date(2026, 9, 25), date(2026, 10, 9), "the last 2 weeks"),
    ("last 12 months", date(2025, 10, 9), date(2026, 10, 9), "the last 12 months"),
    ("over the last six months", date(2026, 4, 9), date(2026, 10, 9),
     "the last 6 months"),
    ("in March", date(2026, 3, 1), date(2026, 4, 1), "March 2026"),
    ("December", date(2025, 12, 1), date(2026, 1, 1), "December 2025"),
    ("sept 2025", date(2025, 9, 1), date(2025, 10, 1), "September 2025"),
    ("2026-02", date(2026, 2, 1), date(2026, 3, 1), "February 2026"),
    ("Q2 2026", date(2026, 4, 1), date(2026, 7, 1), "Q2 2026"),
    ("q1", date(2026, 1, 1), date(2026, 4, 1), "Q1 2026"),
    ("first quarter of 2025", date(2025, 1, 1), date(2025, 4, 1), "Q1 2025"),
    ("2025", date(2025, 1, 1), date(2026, 1, 1), "2025"),
    ("today", date(2026, 10, 8), date(2026, 10, 9), "today"),
    ("all time", date(1900, 1, 1), date(9999, 1, 1), "all time"),
    ("", date(1900, 1, 1), date(9999, 1, 1), "all time"),
])
def test_parse(text, start, end, label):
    p = parse_period(text, TODAY)
    assert (p.start, p.end, p.label) == (start, end, label)


def test_month_end_clamps():
    # 31 March minus one month has no 31 February to land on.
    p = parse_period("last month", date(2026, 3, 31))
    assert (p.start, p.end) == (date(2026, 2, 1), date(2026, 3, 1))
    p = parse_period("last 1 month", date(2026, 3, 31))
    assert p.start == date(2026, 3, 1)


@pytest.mark.parametrize("text", ["blue moon", "last 0 days", "2026-13", "q5"])
def test_rejects(text):
    with pytest.raises(ValueError):
        parse_period(text, TODAY)
