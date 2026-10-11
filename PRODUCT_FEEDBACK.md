# Product feedback

Feedback on every tool, API and SDK used to build Books.check (an MCP server
for purchase-fraud findings plus a simulated Alexa+ Echo Show), written while
building it. Each entry covers what it was used for, what worked, what needs
work, getting from zero to a first working result, and whether I'd use it
again. The dated, step by step record is in [FRICTION_LOG.md](FRICTION_LOG.md).

**The three things that would help Alexa+ developers most:** a way to test
against Alexa+ without the gated tooling, a precise definition of the 500 ms
latency target, and consistent protocol versions across the docs.

---

## Alexa+ add-ons and the Alexa+ MCP documentation

- **Used for:** the design of the whole server: which tools to offer, how to
  describe them, how answers should sound, and the latency target.
- **What worked:** the tool-design guidance is excellent and specific: one tool
  per customer intent, stable IDs (list first, then details), synonyms in
  parameter descriptions, always return something, `isError` for bad input,
  short spoken answers. Following it made the server noticeably better.
  Basing add-ons on plain MCP means the server works with any MCP client today.
- **What needs work:**
  - The add-on CLI pulls packages from a private CodeArtifact registry and
    needs a Solutions Architect to allow-list an AWS account, so entrants can't
    run it. The quickstart doesn't say this; the troubleshooting page does.
  - There's no way to test how Alexa+ picks a tool from what a user says, so
    tool descriptions are written blind.
  - "Round-trip latency under 500 ms" isn't defined (per call or per turn,
    measured where, which percentile), and the certification page says
    "3 seconds".
  - The overview says protocol 2025-11-25; the client-lifecycle examples use
    2025-03-26.
- **Zero to hello world:** not possible with the add-on tooling itself (blocked
  at the private registry). Reading the docs and designing to them took an
  afternoon.
- **Would I use it again?** Yes, once the tooling is open: the MCP-based model
  is the right one, and the guidance is the best part of the docs. A public
  sandbox or an "utterance to tool call" test page would make the biggest
  difference.

## Model Context Protocol Python SDK (`mcp` 2.3.0)

- **Used for:** the server (`MCPServer`, four tools with pydantic output
  models, read-only annotations, Host/Origin checks, a custom `/health` and
  `/speak` route) and the test client (`mcp.Client`) in the test suite.
- **What worked:** typed tools whose return models become both
  `structuredContent` and the text content automatically; `ToolError` turning
  into a proper `isError` result; stateless Streamable HTTP with JSON
  responses in two arguments; DNS-rebinding protection on by default;
  `Client(url, mode="legacy")` to force protocol 2025-11-25 in tests. Tool
  calls take about 3 ms.
- **What needs work:**
  - Version 2 renamed `FastMCP` to `MCPServer`, so most tutorials no longer
    run. The error message does point to the migration guide.
  - Behind a tunnel, the automatic Host check rejects the tunnel's hostname
    until you pass `TransportSecuritySettings` yourself; the docs could
    mention this next to the transport options.
  - In stateless mode the server logs "Terminating session: None" after every
    request.
- **Zero to hello world:** about 20 minutes, including the rename.
- **Would I use it again?** Yes: it's the fastest way I know to a correct MCP
  server, and the typed outputs remove a whole class of bugs.

## MCP Inspector (`@modelcontextprotocol/inspector`, CLI mode)

- **Used for:** checking the running server from outside my own code
  (`--method tools/list` against `/mcp`).
- **What worked:** one `npx` command, no install, worked first time over
  Streamable HTTP, and prints the full tool schemas.
- **What needs work:** nothing blocking; the CLI flags are easy to miss
  because the docs lead with the browser UI.
- **Zero to hello world:** under 5 minutes.
- **Would I use it again?** Yes, as the quickest independent check that a
  server is reachable and well formed.

## MCP conformance suite (`@modelcontextprotocol/conformance` 0.1)

- **Used for:** validating the server against the 2025-11-25 specification.
- **What worked:** one command against a URL; individual scenarios can be run
  with `--scenario`, and each explains its result.
- **What needs work:** the summary reported 9 passed and 21 failed, but every
  failure was a scenario needing a fixture tool with a fixed name or a
  capability the server never declared (prompts, resources, logging,
  completion). Every applicable check passed, but the summary doesn't say so.
- **Zero to hello world:** 5 minutes to run; about 30 more to work out that
  the failures didn't apply.
- **Would I use it again?** Yes, for the handshake and error checks, but I'd
  want undeclared capabilities reported as "not applicable".

## Web Speech API (Chrome speech recognition and `speechSynthesis`)

- **Used for:** voice input in the simulated Echo Show, with interim results
  shown on the Echo's screen while you speak; `speechSynthesis` is the
  fallback voice when the neural voice isn't installed.
- **What worked:** no keys or accounts; interim transcripts make it feel live;
  clear error codes (`not-allowed`, `no-speech`, `network`) that map to
  helpful messages.
- **What needs work:** recognition only works in Chrome and Edge and sends
  audio to the browser vendor's servers; the built-in voices on Linux sound
  robotic; voices load asynchronously, so the first answer can use the wrong
  one.
- **Zero to hello world:** 15 minutes.
- **Would I use it again?** For input, yes, in a demo. For output, only as a
  fallback.

## Piper text-to-speech (`piper-tts` 1.8.0, LJSpeech voice)

- **Used for:** the spoken answers. The MCP server turns each answer's
  `speech` field into a WAV at `/speak`; it's an optional, separately
  installed dependency.
- **What worked:** natural enough to sound like an assistant, runs on a laptop
  CPU in about 0.3 seconds per sentence, no network or account. (Kokoro
  sounded better but took about 14 seconds per answer on CPU.)
- **What needs work:** licences need checking voice by voice: the popular
  "Lessac" voice is research-only and "HFC" is non-commercial, so LJSpeech
  (public domain) was the safe choice for a public repo; and the package
  itself is GPL-3.0, which is why it's kept out of the MIT code's required
  dependencies. The Python API changed in version 1.3, so older examples fail.
- **Zero to hello world:** about 30 minutes, mostly choosing a voice and
  reading licences.
- **Would I use it again?** Yes, for local or offline voice; I'd check licences
  first next time.

## three.js (0.170.0)

- **Used for:** the 3D stage: the Echo Show with its coin slot, holographic
  coins, the jar, the printed receipt and the counting mat, all drawn from
  code and canvas textures with no image files.
- **What worked:** an import map from a CDN means no build step; addons like
  `RoundedBoxGeometry` and `RoomEnvironment` cover a lot; toon materials with
  back-face outlines give a drawn look cheaply.
- **What needs work:** physical-material effects such as iridescence silently
  do little without an environment map, and it isn't obvious from the docs;
  headless screenshots for checking the design needed a real-time capture
  because time-budgeted rendering froze animations at random points.
- **Zero to hello world:** 15 minutes to a spinning box; most of the time went
  into design, not the library.
- **Would I use it again?** Yes.

## scikit-learn (1.9.1) and pandas (3.0.6)

- **Used for:** offline scoring only: an Isolation Forest over per-order and
  context features (through my earlier benchmark project), and the evidence
  and money-at-risk calculations, written to SQLite.
- **What worked:** stable, fast enough (about 1.7 seconds to score 309
  orders), reproducible with a fixed random seed.
- **What needs work:** nothing for this use. The 1.7 seconds is the reason
  scoring had to move out of the request path to meet the 500 ms target.
- **Zero to hello world:** already familiar.
- **Would I use it again?** Yes.

## Starlette and Uvicorn (1.7.0 and 0.54.0, through the MCP SDK)

- **Used for:** serving `/mcp`, `/health`, `/speak` and the web client's static
  files from one process, so the page and the server share an origin and need
  no CORS.
- **What worked:** mounting the static files next to the MCP app was a few
  lines.
- **What needs work:** static files are sent without a `Cache-Control` header,
  so browsers sometimes kept showing an old version of the page after an
  edit; I added `no-cache` revalidation.
- **Zero to hello world:** no separate setup; it came with the SDK.
- **Would I use it again?** Yes.

## cloudflared quick tunnels

- **Used for:** the public HTTPS link for judges (planned near submission).
- **What worked:** to be completed once the tunnel is in use.
- **What needs work:** from the docs, quick tunnels don't carry Server-Sent
  Events, which Streamable HTTP uses by default, so the server runs in JSON
  response mode; and the tunnel's hostname has to be allowed through the MCP
  SDK's Host check (`PUBLIC_HOSTS`).
- **Zero to hello world:** to be completed.
- **Would I use it again?** To be completed.
