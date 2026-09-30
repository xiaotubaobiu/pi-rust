// Oracle capture: the deterministic parse/format tables of upstream
// coding-agent src/core/http-dispatcher.ts under node
// (--experimental-strip-types). configureHttpDispatcher itself manipulates
// Node's global undici dispatcher (no Rust analogue — the port stores the
// parsed configuration for the reqwest client instead; disclosed) and is not
// captured. undici is an oracle stub (only types are touched at load).
import { writeFileSync } from "node:fs";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, HTTP_IDLE_TIMEOUT_CHOICES, formatHttpIdleTimeoutMs, parseHttpIdleTimeoutMs } from "./src/core/http-dispatcher.ts";

const canonical = (value) => JSON.stringify(sortValue(value));
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

const results = {
  defaultHttpIdleTimeoutMs: DEFAULT_HTTP_IDLE_TIMEOUT_MS,
  idleTimeoutChoices: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => ({ label: choice.label, timeoutMs: choice.timeoutMs })),
  parse: [
    "disabled",
    " DISABLED ",
    "disabledx",
    "",
    "   ",
    "30",
    " 60 ",
    "0",
    "-1",
    "3.7",
    "Infinity",
    "NaN",
    "abc",
  ].map((value) => ({ value, parsed: parseHttpIdleTimeoutMs(value) })),
  parseNonString: [
    { value: 300000, parsed: parseHttpIdleTimeoutMs(300000) },
    { value: 0, parsed: parseHttpIdleTimeoutMs(0) },
    { value: -5, parsed: parseHttpIdleTimeoutMs(-5) },
    { value: 12.9, parsed: parseHttpIdleTimeoutMs(12.9) },
    { value: Number.POSITIVE_INFINITY, parsed: parseHttpIdleTimeoutMs(Number.POSITIVE_INFINITY) },
    { value: Number.NaN, parsed: parseHttpIdleTimeoutMs(Number.NaN) },
    { value: null, parsed: parseHttpIdleTimeoutMs(null) },
    { value: undefined, parsed: parseHttpIdleTimeoutMs(undefined) },
    { value: true, parsed: parseHttpIdleTimeoutMs(true) },
  ],
  format: [0, 30000, 60000, 120000, 300000, 45000, 1000, 1500, 61000].map((timeoutMs) => ({
    timeoutMs,
    label: formatHttpIdleTimeoutMs(timeoutMs),
  })),
};

writeFileSync(new URL("./http_dispatcher.oracle.json", import.meta.url), canonical(results) + "\n");
console.log("http_dispatcher oracle written");
