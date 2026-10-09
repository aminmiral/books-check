// Keyword intent rules: a sentence in, one MCP tool call out. No model, no
// network, nothing to configure. Periods are passed through in plain words;
// the server parses them (analyst/periods.py).

const NUM = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d+";
const MONTH = "january|february|march|april|may|june|july|august|september|october|november|december";
const PERIOD = new RegExp([
  `\\b(?:this|last|past|previous)\\s+(?:week|month|quarter|year)\\b`,
  `\\b(?:last|past)\\s+(?:${NUM})\\s+(?:days?|weeks?|months?|years?)\\b`,
  `\\b(?:year to date|ytd|all time|ever|today|yesterday)\\b`,
  `\\b(?:first|second|third|fourth)\\s+quarter(?:\\s+of)?(?:\\s+\\d{4})?\\b`,
  `\\bq[1-4](?:\\s+\\d{4})?\\b`,
  `\\b(?:${MONTH})(?:\\s+\\d{4})?\\b`,
  `\\b(?:19|20)\\d{2}\\b`,
].join("|"), "i");

export function periodIn(text) {
  const m = text.match(PERIOD);
  if (!m) return null;
  return m[0].toLowerCase()
    .replace(/^(past|previous)\b/, "last")
    .replace(/^ever$/, "all time")
    .replace(/^year to date$/, "ytd");
}

export function orderIn(text) {
  const t = text.toLowerCase();
  const m = t.match(/\b(?:p\.?\s?o\.?|purchase order|order|number|case)\s*(?:number\s*)?#?\s*(\d{1,5})\b/)
         || t.match(/\b(?:why|explain|tell me about|what about|look at|check)\b.*?\b(\d{1,3})\b/);
  return m ? m[1] : null;
}

// -> { tool, args } or null
export function understand(text) {
  const t = text.toLowerCase();
  const period = periodIn(t);
  const po = orderIn(t);
  if (po && !/\b(summar|overview|recap)/.test(t)) return { tool: "explain_case", args: { purchase_order: po } };
  if (/summar|overview|recap|report|how (much|many)|total|spen[dt]|in a nutshell/.test(t))
    return { tool: "summarise_period", args: period ? { period } : {} };
  if (/suspicious|flag|anomal|odd|wrong|fraud|risk|anything|red flag|fishy|strange|weird|problem|issue|worr/.test(t))
    return { tool: "list_anomalies", args: { ...(period ? { period } : {}), limit: 6 } };
  if (period) return { tool: "summarise_period", args: { period } };
  return null;
}
