"""End to end over real Streamable HTTP, as a remote client would connect.

Starts the server on a free local port, speaks protocol 2025-11-25 (the
initialize handshake, forced with mode="legacy") and checks every tool call
stays under the 500 ms round-trip budget.
"""

import socket
import statistics
import threading
import time

import httpx2 as httpx  # ships with the mcp SDK
import pytest
import uvicorn
from mcp import Client

from analyst.server import build_app

pytestmark = pytest.mark.anyio
BUDGET_MS = 500


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(scope="module")
def base_url():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(build_app(), host="127.0.0.1",
                                           port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(timeout=5)


async def test_handshake_and_latency(base_url):
    calls = [("list_anomalies", {"period": "this year"}),
             ("explain_case", {"purchase_order": "293"}),
             ("summarise_period", {"period": "last quarter"}),
             ("search_orders", {"query": "mia patel"})] * 10
    timings = []
    async with Client(f"{base_url}/mcp", mode="legacy") as c:
        assert c.protocol_version == "2025-11-25"
        assert len((await c.list_tools()).tools) == 4
        for name, args in calls:
            t0 = time.perf_counter()
            r = await c.call_tool(name, args)
            timings.append((time.perf_counter() - t0) * 1000)
            assert not r.is_error
    print(f"\ntool call round trip over HTTP: median {statistics.median(timings):.1f} ms, "
          f"max {max(timings):.1f} ms ({len(timings)} calls)")
    assert max(timings) < BUDGET_MS


def test_raw_json_rpc_like_a_browser(base_url):
    """What the web client sends: plain fetch POSTs, JSON back (no SSE)."""
    headers = {"Accept": "application/json, text/event-stream",
               "Content-Type": "application/json",
               "Origin": base_url}
    init = httpx.post(f"{base_url}/mcp", headers=headers, json={
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-11-25", "capabilities": {},
                   "clientInfo": {"name": "test", "version": "0"}}})
    assert init.status_code == 200
    assert init.headers["content-type"].startswith("application/json")
    assert init.json()["result"]["protocolVersion"] == "2025-11-25"

    headers["MCP-Protocol-Version"] = "2025-11-25"
    call = httpx.post(f"{base_url}/mcp", headers=headers, json={
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": "explain_case", "arguments": {"purchase_order": "293"}}})
    result = call.json()["result"]
    assert result["structuredContent"]["purchase_order"] == 293


def test_foreign_origin_and_host_are_refused(base_url):
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    headers = {"Accept": "application/json, text/event-stream",
               "Content-Type": "application/json"}
    evil = httpx.post(f"{base_url}/mcp", json=body,
                      headers=headers | {"Origin": "https://evil.example"})
    assert evil.status_code == 403
    wrong_host = httpx.post(f"{base_url}/mcp", json=body,
                            headers=headers | {"Host": "evil.example"})
    assert wrong_host.status_code in (400, 421)


def test_health(base_url):
    assert httpx.get(f"{base_url}/health").json()["cases"] == 309


def test_web_client_is_served_from_the_same_origin(base_url):
    page = httpx.get(f"{base_url}/")
    assert page.status_code == 200 and 'src="app.js"' in page.text
    assert httpx.get(f"{base_url}/mcp.js").status_code == 200
    assert page.headers["cache-control"] == "no-cache"  # edits show up on reload


def test_speak_returns_audio_or_says_why_not(base_url):
    from analyst.server import piper_voice
    r = httpx.post(f"{base_url}/speak", json={"text": "Order 293 was billed twice."}, timeout=30)
    if piper_voice() is None:  # no voice model on this machine: the client falls back
        assert r.status_code == 503 and "get_voice.py" in r.json()["error"]
    else:
        assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
        assert r.content[:4] == b"RIFF"
    assert httpx.post(f"{base_url}/speak", json={"nope": 1}).status_code in (400, 503)
