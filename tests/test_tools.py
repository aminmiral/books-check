"""Tool behaviour, in process. Exact figures are pinned to the committed
data/cases.sqlite and DEMO_TODAY=2026-10-08 (see conftest.py)."""

import pytest
from mcp import Client

from analyst.server import mcp, store

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def call(name, args):
    async with Client(mcp) as c:
        return await c.call_tool(name, args)


async def test_tools_are_listed_read_only_with_output_schemas():
    async with Client(mcp) as c:
        tools = {t.name: t for t in (await c.list_tools()).tools}
    assert set(tools) == {"list_anomalies", "explain_case", "summarise_period"}
    for t in tools.values():
        assert t.annotations.read_only_hint is True
        assert t.output_schema is not None


async def test_list_anomalies_ranks_rule_findings_first():
    r = await call("list_anomalies", {"period": "this year", "limit": 3})
    sc = r.structured_content
    assert not r.is_error
    assert (sc["orders_checked"], sc["flagged_count"]) == (32, 10)
    assert [o["purchase_order"] for o in sc["orders"]][:2] == [293, 288]
    assert sc["orders"][0]["confidence"] == "high"
    assert sc["orders"][0]["kind"] == "duplicate_bill"
    assert sc["speech"].startswith("This year, I flagged 10 of 32")


async def test_list_anomalies_empty_period_still_answers():
    r = await call("list_anomalies", {"period": "this month"})
    assert not r.is_error
    assert r.structured_content["speech"] == \
        "I don't have any purchase orders for this month."


async def test_explain_split_purchase_names_the_other_orders():
    sc = (await call("explain_case", {"purchase_order": "PO/239"})).structured_content
    assert sc["flagged"] and sc["related_orders"] == [238, 240]
    assert "just under the $5,000 approval limit" in sc["speech"]
    assert len(sc["timeline"]) == 5


async def test_split_orders_agree_on_their_group():
    groups = {}
    for po in (238, 239, 240):
        sc = (await call("explain_case", {"purchase_order": str(po)})).structured_content
        groups[po] = sorted([po, *sc["related_orders"]])
        assert "one of 3 orders" in sc["speech"] and "in 17 days" in sc["speech"]
    assert groups[238] == groups[239] == groups[240] == [238, 239, 240]


async def test_explain_normal_and_unknown_orders():
    normal = (await call("explain_case", {"purchase_order": "12"})).structured_content
    assert normal["found"] and not normal["flagged"] and not normal["findings"]
    missing = (await call("explain_case", {"purchase_order": "999"})).structured_content
    assert not missing["found"]
    assert "run from 1 to 309" in missing["speech"]


async def test_summary_counts_add_up():
    sc = (await call("summarise_period", {"period": "this year"})).structured_content
    assert sum(k["count"] for k in sc["by_kind"]) == sc["flagged_count"] == 10
    assert sc["top_vendor"] == "Vendor E"


@pytest.mark.parametrize("name, args", [
    ("list_anomalies", {"period": "blue moon"}),
    ("list_anomalies", {"limit": 50}),
    ("explain_case", {"purchase_order": "the big one"}),
])
async def test_bad_input_is_a_tool_error(name, args):
    r = await call(name, args)
    assert r.is_error


def test_no_ground_truth_reaches_the_server():
    # The server's data must not carry generator labels or case ids.
    import sqlite3
    from analyst.store import DEFAULT_DB
    db = sqlite3.connect(DEFAULT_DB)
    columns = {row[1] for t in ("cases", "events")
               for row in db.execute(f"PRAGMA table_info({t})")}
    assert not columns & {"trace_label", "anomaly_type", "case_id"}
    assert not any("P2P-" in str(v) for c in store.cases.values()
                   for v in vars(c).values())
