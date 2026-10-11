# Books.check

Ask Alexa about suspicious purchase orders, and hear which ones look wrong and why.

Books.check is an **MCP server** that exposes purchase-fraud findings from an
anomaly detector, plus a **simulated Alexa+ Echo Show** in the browser that
talks to it as a real MCP client. Flagged orders are holographic coins: drop
one into the Echo's coin slot and Alexa reads out what's wrong while a receipt
of the order's history prints, with the suspicious steps highlighted.

![Books.check: an Echo Show with a coin slot on a teller's counting mat](docs/screenshot.png)

Built for the Build, Ship, Shape: Amazon Developer Hackathon (Alexa+ track).
Alexa+ add-on tooling isn't open to entrants, so the Echo Show here is a
simulation in a web page; the MCP server is real and works with any MCP client.
Not affiliated with or endorsed by Amazon.

## What you can ask

| You say or type | MCP tool | What happens |
|---|---|---|
| "Anything suspicious this year?" | `list_anomalies` | The flagged orders for that period become coins; Alexa names the top three. |
| "Why was order 293 flagged?" (or drop its coin in the slot) | `explain_case` | The evidence, money at risk, a suggested next step, and a printed receipt of the order's history. |
| "Give me a summary of last quarter" | `summarise_period` | Spend, how many orders were flagged and why, money at risk. |
| "Mia Patel", "Vendor H", "29" (or "find Vendor H") | `search_orders` | Orders by number, vendor, or whoever raised or approved them; flagged ones first. |

Periods are understood in plain words: *this month, last quarter, Q2 2026,
March, the last 90 days, this year, all time*. Every answer has a `speech`
field written to be read aloud as-is, and structured fields for the screen.

## Run it

Tested with Python 3.14.

```bash
git clone https://github.com/aminmiral/books-check
cd books-check
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python -m analyst.server          # then open http://127.0.0.1:8000/
```

Voice input uses the browser's speech recognition (Chrome or Edge); typing
works everywhere. For a natural spoken voice instead of the browser's built-in
one, add the optional Piper voice (about 63 MB):

```bash
pip install -r requirements-voice.txt
python scripts/get_voice.py
```

Environment variables: `MCP_HOST` / `MCP_PORT` (default `127.0.0.1:8000`),
`PUBLIC_HOSTS` (extra host names to accept, e.g. a tunnel's), `DEMO_TODAY`
(pin "today" as `YYYY-MM-DD` for reproducible answers), `PIPER_VOICE`.

### Use it from another MCP client

The server speaks MCP **2025-11-25** over **Streamable HTTP** at `/mcp`,
stateless, with JSON responses (no SSE, so it also works through simple
tunnels). For example, with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector --cli --transport http \
    --server-url http://127.0.0.1:8000/mcp --method tools/list
```

All four tools are read-only and annotated as such.

## How it works

```
OFFLINE, once                                   RUNTIME
erp-anomaly-bench event log                     Browser (web/)
  -> analyst/precompute.py                        voice or typing -> keyword rules (ask.js)
     strip labels, score with an                  MCP client over fetch (mcp.js)
     Isolation Forest + context features            initialize, tools/list, tools/call
     derive evidence and money at risk            3D stage (scene.js, three.js)
  -> data/cases.sqlite (committed)                     |
                                                       v
                                                analyst/server.py  (/mcp, /speak, /)
                                                  in-memory store, spoken-period parser
```

- **No model in the request path.** Scoring takes about 1.7 s, so it runs once,
  offline; the server only filters an in-memory list. Tool calls take a few
  milliseconds (median 2.8 ms, worst 34 ms over HTTP in the test suite), well
  under Alexa's 500 ms guidance. The web page's **MCP log** shows every
  message and its round-trip time.
- **Evidence a person can act on.** Each flag comes with reasons the detector
  can see: duplicate bills, bills above the order, payment without a goods
  receipt, self-approval, purchases split to stay under the approval limit,
  and steps done outside office hours. Money at risk is the largest single
  finding per order, never a sum, so one payment isn't counted twice.
- **No answer key reaches the server.** The generator's labels and case ids are
  removed before scoring; only `scripts/evaluate.py` reads labels, to measure
  the result.
- **Dates stay current.** The data is shifted by whole weeks at startup so the
  newest order lands in the current week, so "this month" means something
  whenever you run it, and weekdays and times of day are unchanged.
- **No language model, no cloud.** Intent routing is plain keyword rules in the
  browser; the voice runs locally. Nothing needs an account or an API key.

### How well it finds the problems

On the benchmark's synthetic purchase-to-pay data (309 orders, 44 with planted
fraud), `python scripts/evaluate.py` reports **precision 0.93, recall 0.95**:
45 orders flagged, 42 of them real. Every kind of planted fraud is caught except
small overbilling, where 1 of 3 is found. The data is synthetic, so treat these
as a sanity check, not a promise about real books.

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```

Covers period parsing, every tool, a full handshake and 40 tool calls over real
HTTP against the 500 ms budget, raw JSON-RPC as a browser sends it, and the
host/origin checks. The server also passes the applicable checks of
`npx @modelcontextprotocol/conformance@0.1 server --url http://127.0.0.1:8000/mcp`
(see [FRICTION_LOG.md](FRICTION_LOG.md) for the fixture-only scenarios).

## What's new here

Everything in this repository was written during the hackathon. It builds on
my earlier project [erp-anomaly-bench](https://github.com/aminmiral/erp-anomaly-bench),
which generated the synthetic event log and provides the detector; three of
its modules (`load_log`/`strip_labels`, `context_features`, `FeatureOutlier`)
are imported by `analyst/precompute.py` only. Running the server does not need
that repository: its output, `data/cases.sqlite`, is committed. New here: the
evidence and money-at-risk logic, the MCP server and its four tools, the
spoken-period parser, the date shift, the web client and its MCP client, and
the tests.

## Credits

- [three.js](https://threejs.org/) (MIT) for the 3D stage.
- [Piper](https://github.com/OHF-Voice/piper1-gpl) (GPL-3.0-or-later), an
  optional, separately installed dependency for the spoken voice, with the
  [LJSpeech](https://keithito.com/LJ-Speech-Dataset/) voice (public domain).
- Fonts: Big Shoulders Display, Instrument Sans and Sometype Mono, via Google
  Fonts (SIL Open Font License).
- The [Model Context Protocol](https://modelcontextprotocol.io/) Python SDK.

## License

[MIT](LICENSE), © 2026 Miral Amin.
