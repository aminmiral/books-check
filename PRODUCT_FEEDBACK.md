# Product feedback: building an Alexa+ MCP add-on

Written from building Books.check (an MCP server for purchase-fraud findings
plus a simulated Echo Show client) for the Alexa+ track. The dated, step by
step version is in [FRICTION_LOG.md](FRICTION_LOG.md); this is the short list,
most important first.

## What worked well

- **MCP as the integration point.** Because Alexa+ add-ons are plain MCP
  servers, everything built here works with any MCP client today and needs no
  Alexa-specific code. That makes it cheap to try an add-on idea.
- **The tool-design guidance.** "One tool per customer intent", stable IDs
  (list, then details), synonyms in parameter descriptions, `isError` for bad
  input, and short spoken responses all translated directly into a better
  design. Writing a ready-to-read `speech` field into every result was the
  single most useful habit.
- **The Python SDK.** Version 2 supports protocol 2025-11-25, stateless
  Streamable HTTP with JSON responses, and DNS-rebinding protection out of the
  box. Its error message for the renamed main class pointed straight at the
  migration guide.

## What would help most

1. **Let entrants test against Alexa+.** The add-on tooling needs a Solutions
   Architect to allow-list an AWS account, so hackathon entrants build blind.
   Even a rate-limited sandbox, or a page that shows which tool Alexa+ would
   call for a given sentence and with which arguments, would let people check
   their tool descriptions against the real planner.
2. **Define the 500 ms latency target.** Say whether it is per tool call or
   per user turn, measured where (server, network, or end to end) and at which
   percentile, and reconcile it with the "3 seconds" in the certification
   guidance. It decides whether a model can run inside a request at all; here
   it pushed all scoring offline.
3. **Keep the protocol version consistent.** The overview says 2025-11-25; the
   client-lifecycle examples use 2025-03-26. State which newer versions Alexa+
   accepts.
4. **Document what a server needs to be reachable.** The quickstart suggests a
   quick tunnel, but quick tunnels drop Server-Sent Events and the SDK refuses
   unknown Host headers by default. Two sentences (use JSON responses; allow
   the tunnel's host name) would save an hour.
5. **Give simulated clients a voice.** Alexa's voice is device-only and Polly
   needs a paid account once credits run out. A free Polly allowance for
   entrants, or a short list of voices whose licences are safe for a public
   repository, would make simulated demos much closer to the real thing.

## Smaller notes

- The $150 AWS credits ran out on October 7, partway through; stating the size
  of the pool up front would help people plan.
- The MCP conformance suite reports scenarios for capabilities a server never
  declared (prompts, resources, fixture tools) as failures; marking them "not
  applicable" would make its summary trustworthy at a glance.
