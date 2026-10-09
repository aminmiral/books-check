// A minimal MCP client over Streamable HTTP: plain fetch, JSON responses.
// Speaks protocol 2025-11-25: initialize -> notifications/initialized ->
// tools/list -> tools/call. Every exchange is reported to `onTraffic` so the
// page can show what went over the wire and how long it took.

export const PROTOCOL = "2025-11-25";

export class ToolError extends Error {}

export class McpClient {
  constructor(url, onTraffic = () => {}) {
    this.url = url;
    this.onTraffic = onTraffic;
    this.nextId = 1;
    this.server = null;
    this.tools = [];
  }

  async rpc(method, params, { notify = false } = {}) {
    const msg = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    if (!notify) msg.id = this.nextId++;
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (this.server) headers["MCP-Protocol-Version"] = PROTOCOL;

    const t0 = performance.now();
    let res, reply = null;
    try {
      res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(msg) });
      if (!notify && res.ok) reply = await res.json();
    } catch (err) {
      this.onTraffic({ method, request: msg, error: String(err), ms: performance.now() - t0 });
      throw new Error("The analyst server isn't reachable. Is it running?");
    }
    const ms = performance.now() - t0;
    this.onTraffic({ method, request: msg, reply, status: res.status, ms });
    if (!res.ok) throw new Error(`The server answered ${res.status}.`);
    if (reply?.error) throw new Error(reply.error.message);
    return reply?.result;
  }

  async connect() {
    const init = await this.rpc("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "books-check-echo", title: "Books.check Echo", version: "0.1.0" },
    });
    this.server = init;
    await this.rpc("notifications/initialized", undefined, { notify: true });
    this.tools = (await this.rpc("tools/list", {})).tools;
    return init;
  }

  async call(name, args) {
    const result = await this.rpc("tools/call", { name, arguments: args });
    if (result.isError) throw new ToolError(result.content?.[0]?.text || "The tool reported an error.");
    return result.structuredContent;
  }
}
