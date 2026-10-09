// Glue: MCP results -> coins, screen, receipt and voice.

import { McpClient, ToolError } from "./mcp.js";
import { understand } from "./ask.js";
import { createStage, FLOATING } from "./scene.js";

const $ = id => document.getElementById(id);
const caption = $("caption"), status = $("status"), log = $("log"), keys = $("keys");
const money = x => "$" + Math.round(x).toLocaleString("en-US");
const cents = x => x == null ? "" : x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---- the MCP traffic drawer --------------------------------------------------------
const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const times = []; // round trips, for the drawer's summary line
function onTraffic({ method, request, reply, status: code, ms, error }) {
  const tool = method === "tools/call" ? ` ${request.params.name}` : "";
  const li = document.createElement("li");
  const ok = !error && code < 400 && !reply?.error && !reply?.result?.isError;
  li.innerHTML = `<details><summary><span class="m">${esc(method)}${esc(tool)}</span>
    <span class="ms ${ok ? "" : "bad"}">${error ? "failed" : code === 202 ? "202" : Math.round(ms) + " ms"}</span></summary>
    <p>Sent</p><pre>${esc(JSON.stringify(request, null, 2))}</pre>
    ${reply ? `<p>Received</p><pre>${esc(JSON.stringify(reply, null, 2))}</pre>` : ""}</details>`;
  log.prepend(li);
  if (!error && method !== "notifications/initialized") {
    times.push(ms);
    const sorted = [...times].sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
    $("logStats").textContent = `${times.length} request${times.length === 1 ? "" : "s"}, median ${Math.round(median)} ms, slowest ${Math.round(sorted.at(-1))} ms`;
  }
  while (log.children.length > 40) log.lastChild.remove();
}
$("logToggle").onclick = () => {
  const open = document.body.classList.toggle("log-open");
  $("logToggle").setAttribute("aria-expanded", open);
};

// ---- how each finding looks ------------------------------------------------------------
const TONES = {
  duplicate_bill: ["#FF5FB8", "#FFD23F", "#3EE6B0", "#3FB8FF", "#FF5FB8"],
  split_purchase: ["#FFC93F", "#FF9A1F", "#FF6A3D", "#FFE066", "#FFC93F"],
  after_hours: ["#9A7BFF", "#4FC3FF", "#5B6CFF", "#C38BFF", "#9A7BFF"],
  self_approved: ["#3EE6B0", "#3FB8FF", "#9A7BFF", "#FF5FB8", "#3EE6B0"],
  overbilled: ["#FF5FB8", "#FF3D7F", "#FF8A4C", "#FFD23F", "#FF5FB8"],
  no_receipt: ["#3FB8FF", "#3EE6B0", "#FFD23F", "#9A7BFF", "#3FB8FF"],
  slightly_overbilled: ["#FFE066", "#3EE6B0", "#FFD23F", "#9FE8FF", "#FFE066"],
  unusual_pattern: ["#C9D1EA", "#9FE8FF", "#E0C8FF", "#C9D1EA", "#C9D1EA"],
};
function coinFace(kind, headline) {
  const n = headline.match(/(\d+(?:\.\d)?)%/)?.[1];
  switch (kind) {
    case "duplicate_bill": return /three/.test(headline) ? "×3" : headline.match(/(\d+) times/) ? `×${headline.match(/(\d+) times/)[1]}` : "×2";
    case "split_purchase": return `${headline.match(/one of (\d+)/)?.[1] || 2}in1`;
    case "after_hours": return headline.match(/at (\d+:\d+)/)?.[1] || "LATE";
    case "self_approved": return "SELF";
    case "no_receipt": return "NO GOODS";
    case "overbilled": case "slightly_overbilled": return `+${n}%`;
    default: return "ODD";
  }
}
const cap = s => s[0].toUpperCase() + s.slice(1);
const toCoin = o => ({ po: o.purchase_order, face: coinFace(o.kind, o.headline),
  tones: TONES[o.kind] || TONES.unusual_pattern, tip: `${o.vendor}. ${cap(o.headline)}.`, label: cap(o.headline) });

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const when = iso => { const d = new Date(iso); return `${WEEKDAY[d.getDay()]} ${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]} ${iso.slice(11, 16)}`; };
const day = iso => { const [y, m, d] = iso.split("-"); return `${d} ${MONTHS[+m - 1]} ${y}`; };
const offHours = iso => { const d = new Date(iso), h = d.getHours(); return h < 8 || h >= 19 || d.getDay() % 6 === 0; };
const STEP = { "Create PO": s => `Raised by ${s.actor}`, "Approve PO": s => `Approved by ${s.actor}`,
  "Receive Goods": () => "Goods received", "Post Vendor Bill": () => "Bill posted", "Pay Vendor Bill": () => "Paid" };

// The screen headline for an explained order.
function headlineFor(c) {
  const k = c.findings[0]?.kind, bills = c.timeline.filter(s => s.activity === "Post Vendor Bill");
  const firstBill = bills[0]?.amount ?? c.billed, pct = c.amount ? (firstBill / c.amount - 1) * 100 : 0;
  const odd = c.timeline.find(s => offHours(s.at));
  switch (k) {
    case "duplicate_bill": return [bills.length === 2 ? "Billed twice" : `Billed ${bills.length} times`, `Order ${c.purchase_order}, ${c.vendor}`, "#FF3D7F"];
    case "overbilled": return [`+${pct.toFixed(0)}%`, `Billed ${money(c.findings[0].exposure)} over the order`, "#FF3D7F"];
    case "slightly_overbilled": return [`+${pct.toFixed(1)}%`, "A small billing difference", "#FFB020"];
    case "no_receipt": return ["No delivery", `Paid ${money(c.paid)} anyway`, "#FF3D7F"];
    case "self_approved": return ["Self-approved", `Order ${c.purchase_order}, ${c.vendor}`, "#FF3D7F"];
    case "split_purchase": return ["Split order", `${c.related_orders.length + 1} orders, ${c.vendor}`, "#FFB020"];
    case "after_hours": {
      const d = new Date(odd.at), h = d.getHours() % 12 || 12;
      return [`${h}:${odd.at.slice(14, 16)} ${d.getHours() < 12 ? "AM" : "PM"}`, `${STEP[odd.activity](odd).split(" by")[0]} on a ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()]}`, "#05A0D1"];
    }
    default: return ["Unusual", "No rule broken, but the pattern is rare", "#05A0D1"];
  }
}

// The receipt for an explained order: its history, with what matters highlighted.
async function receiptFor(c) {
  const k = c.findings[0]?.kind;
  if (k === "split_purchase") { // fetch the sibling orders: another MCP call each
    const all = [c, ...await Promise.all(c.related_orders.map(po => mcp.call("explain_case", { purchase_order: String(po) })))]
      .sort((a, b) => a.timeline[0].at.localeCompare(b.timeline[0].at));
    const total = all.reduce((s, o) => s + o.amount, 0);
    return { kicker: "flagged by the detector", title: `ORDER ${c.purchase_order}`, subtitle: `${c.vendor}, raised by ${c.requester}`,
      rows: [...all.map(o => [when(o.timeline[0].at), `Order ${o.purchase_order}`, cents(o.amount), 2]),
             ["", "Approval limit", "5,000.00"], ["", `All ${all.length} together`, cents(total), 1]],
      totalLabel: "AT RISK", total: money(total), note: c.next_step };
  }
  let bills = 0;
  const rows = [];
  for (const s of c.timeline) {
    if (s.activity === "Post Vendor Bill") bills++;
    if (k === "no_receipt" && s.activity === "Post Vendor Bill" && !rows.some(r => r[1] === "Goods received: never"))
      rows.push(["", "Goods received: never", "", 1]);
    const hl = (k === "duplicate_bill" && bills > 1)
            || ((k === "overbilled" || k === "slightly_overbilled") && s.amount != null && s.activity !== "Create PO" && s.amount > c.amount * 1.001)
            || (k === "self_approved" && (s.activity === "Create PO" || s.activity === "Approve PO"))
            || (k === "after_hours" && offHours(s.at))
            || (k === "no_receipt" && s.activity === "Pay Vendor Bill");
    const what = (k === "duplicate_bill" && bills > 1 && /Bill|Paid/.test(STEP[s.activity](s)) ? STEP[s.activity](s) + " again" : STEP[s.activity](s));
    rows.push([when(s.at), what, cents(s.amount), hl ? 1 : 0]);
  }
  return { kicker: c.flagged ? "flagged by the detector" : "checked by the detector",
    title: `ORDER ${c.purchase_order}`, subtitle: `${c.vendor}, raised by ${c.requester}`, rows,
    totalLabel: "AT RISK", total: money(c.exposure), totalColour: c.flagged ? null : "#14251B",
    note: c.flagged ? c.next_step : "Nothing out of line." };
}

// ---- voice out: Piper on the server, the browser's voice as a fallback ------------------
const player = new Audio();
let speakSeq = 0, browserVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices().filter(v => v.lang.startsWith("en"));
  browserVoice = vs.find(v => /Google US English/.test(v.name)) || vs.find(v => v.lang === "en-US") || vs[0] || null;
}
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function stopTalking() { speakSeq++; player.pause(); if ("speechSynthesis" in window) speechSynthesis.cancel(); }
async function speak(text) {
  stopTalking(); const seq = speakSeq;
  try {
    const r = await fetch("speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    if (!r.ok) throw new Error(r.status);
    const url = URL.createObjectURL(await r.blob());
    if (seq !== speakSeq) return;
    player.src = url; await player.play();
  } catch {
    if (seq !== speakSeq || !("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text); if (browserVoice) u.voice = browserVoice; speechSynthesis.speak(u);
  }
}
let typing;
function say(text, { talk = true } = {}) {
  if (talk) speak(text);
  clearInterval(typing); caption.textContent = "";
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { caption.textContent = text; return; }
  let i = 0; typing = setInterval(() => { caption.textContent = text.slice(0, ++i); if (i >= text.length) clearInterval(typing); }, 16);
}

// ---- asking ------------------------------------------------------------------------------
let mcp, stage, busy = false;
async function ask({ tool, args }, question) {
  if (busy) return; busy = true; stage.lock(true);
  stage.screen({ mode: "thinking", ask: question ? `“${question}”` : "" });
  try {
    const po = tool === "explain_case" ? +args.purchase_order.match(/\d+/g).pop() : null;
    const [result] = await Promise.all([mcp.call(tool, args), po != null ? stage.feed(po) : null]);
    await show(tool, result);
  } catch (err) {
    stage.screen({ mode: "error", head: err instanceof ToolError ? "Try again" : "No answer", sub: err.message });
    say(err.message);
  } finally { busy = false; stage.lock(false); }
}
async function show(tool, r) {
  say(r.speech);
  if (tool === "explain_case") {
    if (!r.found) { stage.screen({ mode: "error", head: "No such order", sub: r.speech.split(". ").slice(1).join(". ") }); stage.clearReceipt(); return; }
    const [head, sub, accent] = r.flagged ? headlineFor(r) : ["Looks normal", `Order ${r.purchase_order}, ${r.vendor}`, "#05A0D1"];
    stage.screen({ mode: "answer", head, sub, accent });
    stage.printReceipt(await receiptFor(r));
  } else if (tool === "list_anomalies") {
    stage.screen({ mode: "answer", head: `${r.flagged_count} flagged`, sub: `${cap(r.period)}, of ${r.orders_checked} orders`, accent: "#FF3D7F" });
    setTray(r);
    stage.printReceipt({ kicker: "flagged by the detector", title: "FLAGGED", subtitle: cap(r.period),
      rows: [...r.orders.slice(0, 8).map(o => [day(o.placed), `Order ${o.purchase_order}, ${o.vendor}`, money(o.exposure)]),
             ...(r.orders.length > 8 ? [["", `and ${r.orders.length - 8} more in the jar`, ""]] : [])],
      totalLabel: "AT RISK", total: money(r.exposure_total), note: "Drop a coin in for the full story." });
  } else if (tool === "search_orders") {
    if (!r.total) { stage.screen({ mode: "error", head: "No match", sub: `Nothing matches “${r.query}”.` }); return; }
    stage.screen({ mode: "answer", head: `${r.total} order${r.total === 1 ? "" : "s"}`, sub: `${cap(r.match_label)}, ${r.flagged_count} flagged`, accent: "#05A0D1" });
    const flagged = r.matches.filter(m => m.flagged);
    if (flagged.length) setTray({ orders: flagged, period: r.match_label }, `Every coin is a flagged order ${r.match_label}. Drop one in the slot and hear why.`);
    stage.printReceipt({ kicker: "search", title: "FOUND", subtitle: cap(r.match_label),
      rows: [...r.matches.slice(0, 8).map(m => [day(m.placed), `Order ${m.purchase_order}, ${m.vendor}`, m.flagged ? money(m.exposure) : "ok"]),
             ...(r.total > 8 ? [["", `and ${r.total - 8} more`, ""]] : [])],
      totalLabel: "FLAGGED", total: `${r.flagged_count} of ${r.total}`,
      note: flagged.length ? "The flagged ones are on the mat now." : "None of these were flagged." });
  } else {
    stage.screen({ mode: "answer", head: money(r.total_value), sub: `spent ${r.period}, ${r.flagged_count} orders flagged`, accent: "#05A0D1" });
    stage.printReceipt({ kicker: "period summary", title: r.period.toUpperCase(), subtitle: `${r.orders_checked} purchase orders`,
      rows: [["", "Spent", cents(r.total_value)], ...r.by_kind.map(k => ["", `${k.count} ${k.label}`, "", 1])],
      totalLabel: "AT RISK", total: money(r.exposure_total),
      note: r.top_vendor ? `${r.top_vendor} came up most often.` : "" });
  }
}

// "this year" / "in March 2026" / "across all time"
const during = p => p === "all time" ? "across all time" : /^(this|last)\b|^today$|^yesterday$/.test(p) ? p : `in ${p}`;

// the coins on the table, plus a keyboard button for each. One coin of each
// kind of finding floats first, so the table shows the variety; the rest,
// still most serious first, go in the jar.
function setTray(list, lede) {
  const firsts = [], seen = new Set();
  for (const o of list.orders) if (!seen.has(o.kind) && firsts.length < FLOATING) { seen.add(o.kind); firsts.push(o); }
  const items = [...firsts, ...list.orders.filter(o => !firsts.includes(o))].map(toCoin);
  $("lede").textContent = lede || (items.length
    ? `Every coin is a purchase order the detector flagged ${during(list.period)}. Drop one in the slot and hear why.`
    : `Nothing was flagged ${during(list.period)}. Ask about another period.`);
  const pourKey = Object.assign(document.createElement("button"), { textContent: "Pour the next coins out of the jar", onclick: pour });
  keys.replaceChildren(...items.map(it => {
    const b = document.createElement("button");
    b.textContent = `Order ${it.po}: ${it.label}`;
    b.onfocus = () => stage.focusCoin(it.po); b.onblur = () => stage.focusCoin(null);
    b.onclick = () => feedCoin(it.po);
    return b;
  }), ...(items.length > FLOATING ? [pourKey] : []));
  return stage.setCoins(items, { period: list.period });
}
async function pour() {
  if (busy || !stage.jarCount()) return;
  busy = true; stage.lock(true);
  await stage.pour();
  busy = false; stage.lock(false);
}
const feedCoin = po => ask({ tool: "explain_case", args: { purchase_order: String(po) } }, `Why was order ${po} flagged?`);

// ---- the search bar: live matches from search_orders as you type ------------------
const find = $("find"), found = $("found");
let findSeq = 0, findTimer, options = [], active = -1;
function closeFound() { found.hidden = true; find.setAttribute("aria-expanded", "false"); find.removeAttribute("aria-activedescendant"); active = -1; }
function setActive(i) {
  options.forEach((li, j) => li.setAttribute("aria-selected", j === i));
  active = i;
  if (i >= 0) { find.setAttribute("aria-activedescendant", options[i].id); options[i].scrollIntoView({ block: "nearest" }); }
}
async function lookUp() {
  const q = find.value.trim(), seq = ++findSeq;
  if (!q) return closeFound();
  let r;
  try { r = await mcp.call("search_orders", { query: q, limit: 8 }); } catch { return; }
  if (seq !== findSeq) return; // a newer keystroke won
  const li = (cls, html, run) => {
    const el = document.createElement("li");
    el.className = cls; el.innerHTML = html;
    if (run) { el.id = `found-${options.length}`; el.setAttribute("role", "option"); el.onmousedown = e => { e.preventDefault(); pick(run); }; options.push(el); el.run = run; }
    return el;
  };
  options = [];
  const rows = [];
  if (!r.total) rows.push(li("note", `No order, vendor or person matches “${esc(q)}”.`));
  if (r.total > 1 && r.flagged_count)
    rows.push(li("all", `Put the ${r.flagged_count} flagged order${r.flagged_count === 1 ? "" : "s"} ${esc(r.match_label)} on the mat`,
      () => ask({ tool: "search_orders", args: { query: q, limit: 50 } }, `Find ${q}`)));
  for (const m of r.matches)
    rows.push(li("", `<span class="po">${m.purchase_order}</span>
      <span class="who">${esc(m.vendor)}, ${esc(m.requester)}</span><span class="amt">${money(m.amount)}</span>
      <span class="why ${m.flagged ? "" : "ok"}">${m.flagged ? esc(m.headline) : "looks normal"}</span>`,
      () => ask({ tool: "explain_case", args: { purchase_order: String(m.purchase_order) } },
                m.flagged ? `Why was order ${m.purchase_order} flagged?` : `Tell me about order ${m.purchase_order}`)));
  if (r.total > r.matches.length) rows.push(li("note", `${r.total} matches. Keep typing to narrow them down.`));
  found.replaceChildren(...rows);
  found.hidden = false; find.setAttribute("aria-expanded", "true"); setActive(-1);
}
function pick(run) { closeFound(); find.blur(); run(); }
find.addEventListener("input", () => { clearTimeout(findTimer); findTimer = setTimeout(lookUp, 160); });
find.addEventListener("focus", () => { if (find.value.trim()) lookUp(); });
find.addEventListener("blur", () => setTimeout(closeFound, 120));
find.addEventListener("keydown", e => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault(); if (found.hidden || !options.length) return;
    setActive((active + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
  } else if (e.key === "Enter") {
    e.preventDefault(); const o = options[active] || options.find(o => !o.classList.contains("all")) || options[0];
    if (o) pick(o.run);
  } else if (e.key === "Escape") { closeFound(); find.blur(); }
});
addEventListener("keydown", e => { // "/" jumps to search, as on many sites
  if (e.key === "/" && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) { e.preventDefault(); find.focus(); }
});

// typed questions
$("typed").addEventListener("submit", e => {
  e.preventDefault();
  const q = $("q").value.trim(); if (!q) return;
  $("q").value = ""; handle(q);
});
const HELP = "Try “anything suspicious this year?”, “why was order 293 flagged?” or “give me a summary of last quarter”.";
function handle(q) {
  const intent = understand(q);
  if (intent) ask(intent, q);
  else { stage.screen({ mode: "error", head: "Not sure", sub: "Ask about suspicious orders, an order number or a period." }); say(`I can't answer that one yet. ${HELP}`); }
}

// ---- voice in (Chrome / Edge) ---------------------------------------------------------------
const mic = $("mic");
const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!Rec) {
  mic.title = "Voice input needs Chrome or Edge. Typing works everywhere.";
  mic.onclick = () => say("Voice input needs Chrome or Edge. You can type your question instead.");
} else {
  const rec = new Rec();
  rec.lang = "en-US"; rec.interimResults = true;
  let heard = "";
  rec.onstart = () => { heard = ""; mic.classList.add("on"); stopTalking(); stage.screen({ mode: "listening", ask: "", heard: "" }); caption.textContent = "Listening…"; };
  rec.onresult = e => { heard = [...e.results].map(r => r[0].transcript).join(" "); stage.screen({ heard: `“${heard}”` }); caption.textContent = heard; };
  rec.onerror = e => {
    mic.classList.remove("on");
    const why = { "not-allowed": "Allow the microphone for this page, then try again.",
                  "no-speech": "I didn't hear anything. Press the mic and ask again.",
                  "network": "Voice recognition needs an internet connection." }[e.error] || "Voice input stopped. Press the mic to try again.";
    stage.screen({ mode: "idle", ask: "" }); say(why);
  };
  rec.onend = () => { mic.classList.remove("on"); if (heard) handle(heard.replace(/^(hey\s+)?alexa[, ]*/i, "")); else if (!busy) stage.screen({ mode: "idle" }); };
  mic.onclick = () => { if (mic.classList.contains("on")) rec.stop(); else if (!busy) rec.start(); };
}

// ---- start --------------------------------------------------------------------------------
document.documentElement.dataset.look = new URLSearchParams(location.search).get("look") || "mat";
stage = await createStage(document.body, { onFeed: po => feedCoin(po), onPour: pour });
mcp = new McpClient(new URL("mcp", location.href).href, onTraffic);
try {
  const init = await mcp.connect();
  status.textContent = `Connected: ${mcp.tools.length} MCP tools, protocol ${init.protocolVersion}`;
  status.classList.add("ok");
  const first = await mcp.call("list_anomalies", { period: "all time", limit: 50 });
  await setTray(first);
  const s = new URLSearchParams(location.search).get("ask");
  if (s) handle(s);
} catch (err) {
  status.textContent = `Not connected: ${err.message}`;
  stage.screen({ mode: "error", head: "Offline", sub: "Start the server with: python -m analyst.server" });
}
