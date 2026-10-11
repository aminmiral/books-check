# Friction log

Kept while building, not written afterwards. Format per entry: task, steps,
expected vs actual, severity (low / medium / high / blocker), workaround,
suggestion.

---

## 2026-10-08 — Alexa+ developer tooling is not reachable

- **Task:** set up the Alexa+ add-on toolchain (`alexa-ai` CLI) to build and
  test an MCP add-on.
- **Steps:** read the MCP toolkit quickstart and its troubleshooting page.
- **Expected:** a self-serve install, like the classic Alexa Skills Kit.
- **Actual:** per Amazon's own troubleshooting page, the CLI pulls packages
  from a private AWS CodeArtifact registry (`401 Unauthorized`) and templates
  from CodeCommit (`403`). Access needs an
  Alexa Solutions Architect to allow-list the AWS account. The Devpost forum
  confirms hackathon participants will not be granted access.
- **Severity:** blocker for the native path.
- **Workaround:** built a standalone MCP server and an Echo-Show-style web
  client that acts as the MCP client (the route the FAQ permits).
- **Suggestion:** say "not available to hackathon participants" on the
  quickstart page itself, and offer a sandbox or simulator so entrants can
  test against the real Alexa+ client behaviour.

## 2026-10-08 — Protocol version is inconsistent across Amazon's docs

- **Task:** pick the MCP protocol version to implement.
- **Expected:** one version across the Alexa+ MCP docs.
- **Actual:** the toolkit overview says Alexa+ supports `2025-11-25`; the
  client-lifecycle page's example payloads use `"protocolVersion": "2025-03-26"`.
  Meanwhile modelcontextprotocol.io now lists `2026-07-28` as current.
- **Severity:** low.
- **Workaround:** implemented 2025-11-25 as the hackathon rules require; the
  SDK also accepts the newer version.
- **Suggestion:** update the lifecycle examples and state which newer
  versions Alexa+ accepts.

## 2026-10-08 — The 500 ms latency requirement is underspecified

- **Task:** design to the "round-trip query response latency of less than
  500 ms" in the quickstart.
- **Expected:** a definition: per tool call or per user turn, measured where,
  which percentile.
- **Actual:** not defined; a separate certification page says "return results
  within 3 seconds".
- **Severity:** medium (it drives the whole design).
- **Workaround:** treated it as per tool call, server side, and precomputed
  all model scoring offline (fitting the detector takes ~1.75 s).
- **Suggestion:** define the measurement and reconcile it with the 3-second
  guidance.

## 2026-10-08 — Python MCP SDK v2 renamed the main class

- **Task:** write the server with the Python `mcp` SDK.
- **Expected:** `from mcp.server.fastmcp import FastMCP`, as in most
  tutorials and examples.
- **Actual:** `mcp` 2.x raises `ModuleNotFoundError`; the class is now
  `mcp.server.mcpserver.MCPServer`. The error message does point to the
  migration guide, which helped.
- **Severity:** low.
- **Workaround:** used `MCPServer`.
- **Suggestion:** none for the SDK, whose error is good; tutorials linked
  from the Alexa+ docs should be updated.

## 2026-10-08 — Quick tunnels and the SDK's host check

- **Task:** plan a public HTTPS URL with a `cloudflared` quick tunnel, as the
  quickstart suggests.
- **Actual:** quick tunnels do not support Server-Sent Events, which
  Streamable HTTP uses by default; and the SDK automatically rejects any Host
  header other than localhost when bound to 127.0.0.1, so the tunnel's
  hostname is refused.
- **Severity:** medium.
- **Workaround:** run the server in JSON-response, stateless mode and pass the
  tunnel hostname through an environment variable.
- **Suggestion:** mention both in the quickstart's tunnelling note.

## 2026-10-08 — AWS credits ran out mid-hackathon

- **Task:** request the $150 AWS credits listed on the resources page.
- **Actual:** "October 7th Update: We are out of credit codes".
- **Severity:** low for this project (designed to run at zero cost).
- **Workaround:** no paid services: browser speech recognition and voices,
  keyword routing instead of a hosted model.
- **Suggestion:** state the credit pool size up front.

## 2026-10-08 — Conformance suite reports fixture scenarios as failures

- **Task:** validate the server with `npx @modelcontextprotocol/conformance server --url …`.
- **Expected:** a pass/fail for the protocol features the server implements.
- **Actual:** 9 passed, 21 failed. Every failure is a scenario that needs a
  fixture tool with a fixed name (e.g. `test_image_content`) or an optional
  capability the server does not offer (logging, completion, prompts,
  resources). The applicable checks (initialize, ping, tools/list, tool
  errors, DNS-rebinding protection) all pass, but the summary doesn't say so.
- **Severity:** low (misleading, not blocking).
- **Workaround:** ran failing scenarios one by one with `--scenario` to read
  the reason.
- **Suggestion:** skip scenarios for capabilities the server didn't declare
  in `initialize`, or report them as "not applicable".

## 2026-10-09 — No Alexa voice for a simulated client

- **Task:** make the simulated Echo Show answer out loud in a voice that sounds
  like an assistant, not a screen reader.
- **Expected:** some way to use Alexa's voice, or a recommended text-to-speech
  option, for the "simulated Alexa+ experience" the rules allow.
- **Actual:** Alexa's voice exists only on devices. Amazon Polly needs an AWS
  account, and the hackathon credits had run out. The browser's built-in
  voices on Linux sound robotic. Open neural voices needed licence checks one
  by one: the popular Piper "Lessac" voice is research-only, "HFC" is
  non-commercial, and the `piper-tts` package itself is GPL-3.0.
- **Severity:** medium (voice is most of what makes the demo feel like Alexa).
- **Workaround:** a local Piper voice trained on LJSpeech (public domain),
  served by the MCP server at `/speak` as an optional, separately installed
  dependency; the browser voice is the fallback.
- **Suggestion:** give entrants a free Polly allowance or a short list of
  voices that are safe to use in a public repo.

## 2026-10-09 — Tool descriptions can't be tested against Alexa+

- **Task:** follow Amazon's tool-design guidance (one tool per intent,
  synonyms in parameter descriptions, short spoken answers).
- **Expected:** a way to check how Alexa+ picks a tool and fills its
  arguments from what a user says.
- **Actual:** without the gated tooling there is no way to run real
  utterances through Alexa+'s planner, so the descriptions are written blind.
- **Severity:** medium.
- **Workaround:** keyword rules in the web client stand in for Alexa+'s
  routing; descriptions still carry synonyms ("also called timeframe, date
  range") for when a real assistant connects.
- **Suggestion:** a public "utterance to tool call" test page, even rate
  limited, would let entrants check their tool descriptions.

## 2026-10-10 — A browser client's own timer makes the server look slow

- **Task:** show each MCP round trip's time in the web client, to prove the
  500 ms target.
- **Expected:** timing `fetch` with `performance.now()` gives the round trip.
- **Actual:** while the page renders 3D and plays audio, the timer also
  counts time the page's main thread was busy: one call showed 3,423 ms that
  took 17 ms on the wire.
- **Severity:** low, but it would have put a wrong number in the demo video.
- **Workaround:** read the request's network time from the browser's
  Resource Timing API instead.
- **Suggestion:** when the latency requirement is defined (see the 500 ms
  entry above), say where it is measured.
