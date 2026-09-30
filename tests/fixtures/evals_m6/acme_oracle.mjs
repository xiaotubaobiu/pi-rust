import { createAcmeServer, OPENAI_MODEL_ID, OPENAI_PROBE_PROMPT, OPENAI_PROBE_RESPONSE, STREAM_MODEL_ID, STREAM_PROBE_PROMPT, STREAM_PROBE_RESPONSE } from "file:///C:/Users/13063/Desktop/code/agent%20work/pi/packages/evals/evals/acme-server.ts";
import { writeFileSync } from "node:fs";
function body(model, prompt, stream = true) {
  return { model, messages: [{ role: "user", content: prompt }], stream };
}
async function post(url, headers, payload) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload) });
  const text = await response.text();
  return { status: response.status, contentType: response.headers.get("content-type"), body: text };
}
const fixtures = [
  { mode: "openai", url: (s) => `${s.baseUrl()}/chat/completions`, ok: { authorization: "Bearer resolved-acme-key" }, bad: { authorization: "Bearer wrong-key" }, model: OPENAI_MODEL_ID, prompt: OPENAI_PROBE_PROMPT },
  { mode: "stream", url: (s) => `${s.origin()}/generate`, ok: { "x-acme-key": "resolved-stream-key" }, bad: { "x-acme-key": "wrong-key" }, model: STREAM_MODEL_ID, prompt: STREAM_PROBE_PROMPT },
];
const out = {};
for (const fixture of fixtures) {
  const server = createAcmeServer(fixture.mode);
  await server.start();
  const cap = {};
  cap.probe = await post(fixture.url(server), fixture.ok, body(fixture.model, fixture.prompt));
  server.reset();
  cap.unauthorized = await post(fixture.url(server), fixture.bad, body(fixture.model, fixture.prompt));
  cap.malformed = await post(fixture.url(server), fixture.ok, body(fixture.model, fixture.prompt, false));
  cap.nonProbe = await post(fixture.url(server), fixture.ok, body(fixture.model, "hello"));
  cap.nonProbeFlag = server.validRequestReceived();
  cap.probeFlag = server.validRequestReceived();
  server.reset();
  cap.probe2 = await post(fixture.url(server), fixture.ok, body(fixture.model, fixture.prompt));
  cap.probeFlag2 = server.validRequestReceived();
  server.reset();
  cap.flagAfterReset = server.validRequestReceived();
  out[fixture.mode] = cap;
  await server.stop();
}
writeFileSync("oracle/acme.json", JSON.stringify(out, null, 2) + "\n");
