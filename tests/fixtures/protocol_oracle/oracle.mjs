// Oracle driver: runs the copied upstream protocol src (cbor + framing, no
// external deps) and prints deterministic outputs for byte-exact comparison
// with the Rust port. Run:
//   node oracle.mjs > oracle.out.txt
import { decodeCbor, encodeCbor } from "./src/cbor/index.ts";
import { encodeFrame, FrameDecoder } from "./src/framing.ts";

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
function label(name) {
  console.log(`=== ${name}`);
}
function encodeCase(name, value, options) {
  label(`encode:${name}`);
  try {
    console.log(toHex(encodeCbor(value, options)));
  } catch (error) {
    console.log(`ERR ${error.name}: ${error.message}`);
  }
}
function decodeCase(name, hex, options) {
  label(`decode:${name}`);
  try {
    const value = decodeCbor(fromHex(hex), options);
    if (value instanceof Uint8Array) console.log(`bytes ${toHex(value)}`);
    else if (typeof value === "number" && Object.is(value, -0)) console.log("number -0");
    else console.log(JSON.stringify(value) ?? String(value));
  } catch (error) {
    console.log(`ERR ${error.name}: ${error.message}`);
  }
}

// ---- 1. RFC 8949 known vectors (from upstream test) ----
const vectors = [
  ["null", null], ["false", false], ["true", true], ["0", 0], ["1", 1], ["10", 10], ["23", 23],
  ["24", 24], ["25", 25], ["100", 100], ["1000", 1000], ["1e6", 1000000], ["1e12", 1000000000000],
  ["maxsafe", Number.MAX_SAFE_INTEGER], ["-1", -1], ["-10", -10], ["-24", -24], ["-25", -25],
  ["-100", -100], ["-1000", -1000], ["-1e6", -1000000], ["minsafe", Number.MIN_SAFE_INTEGER],
  ["1.1", 1.1], ["-0", -0], ["bytes4", new Uint8Array([1, 2, 3, 4])], ["emptystr", ""],
  ["IETF", "IETF"], ["u-umlaut", "ü"], ["water", "水"], ["gothic", "𐅑"],
  ["emptyarr", []], ["arr123", [1, 2, 3]], ["nested", [1, [2, 3], [4, 5]]],
  ["map", { a: 1, b: [2, 3] }],
];
for (const [name, value] of vectors) encodeCase(name, value);
for (const [name, value] of vectors) {
  if (value instanceof Uint8Array) continue;
  try {
    decodeCase(`roundtrip:${name}`, toHex(encodeCbor(value)));
  } catch { /* unreachable */ }
}

// ---- 2. Number dispatch edges ----
encodeCase("float-integral-8.0", 8.0);
encodeCase("float-integral-neg", -8.0);
encodeCase("float-integral-1e10", 1e10);
encodeCase("float-negzero", Object.is(-0, -0) ? -0 : -0);
encodeCase("unsafe-float-2^53", 9007199254740992);
encodeCase("float-2^60", 2 ** 60);
encodeCase("nan", Number.NaN);
encodeCase("posinf", Number.POSITIVE_INFINITY);
encodeCase("neginf", Number.NEGATIVE_INFINITY);

// ---- 3. Undefined omission / falsey retention ----
encodeCase("undef-omitted", { omitted: undefined, zero: 0, empty: "", no: false, nil: null });

// ---- 4. BOM + __proto__ ----
decodeCase("bom", "63efbbbf");
encodeCase("proto-key", { __proto__: null, safe: "safe" });
encodeCase("dupe-undef-values", { a: undefined, b: undefined });

// ---- 5. Encoder rejects ----
encodeCase("cyclic-array", (() => { const a = []; a.push(a); return a; })());
encodeCase("too-deep", (() => {
  let v = null;
  for (let d = 0; d <= 64; d++) v = [v];
  return v;
})());
encodeCase("lone-surrogate", "\ud800");
encodeCase("array-with-undefined", [undefined]);

// ---- 6. Decoder rejects (upstream invalid list) ----
const invalid = [
  ["empty", ""], ["trunc-int", "18"], ["reserved-ai", "1c"], ["indef-bytes", "5f"],
  ["indef-text", "7f"], ["indef-arr", "9f"], ["indef-map", "bf"], ["tag", "c000"],
  ["undefined", "f7"], ["simple-e0", "e0"], ["break", "ff"], ["float16", "f93c00"],
  ["float32", "fa3f800000"], ["posinf", "fb7ff0000000000000"], ["nan", "fb7ff8000000000000"],
  ["trunc-f64", "fb3ff00000"], ["trunc-bytes", "44010203"], ["trunc-text", "636162"],
  ["trunc-arr", "8201"], ["trunc-map", "a16161"], ["trailing", "0000"],
  ["nonstr-key", "a10102"], ["dup-key", "a2616101616102"], ["bad-utf8", "61ff"],
  ["overlong-utf8", "62c080"], ["utf8-surrogate", "63eda080"],
  ["unsafe-uint", "1b0020000000000000"], ["unsafe-nint", "3b001fffffffffffff"],
  ["unsafe-f64-int", "fb4340000000000000"],
  // extras
  ["neg-2^53-minus-2-f64", "fbc340000000000000"],
];
for (const [name, hex] of invalid) decodeCase(name, hex);

// ---- 7. Limits ----
decodeCase("depth-65-ok", "81".repeat(64) + "f6");
decodeCase("depth-66-err", "81".repeat(65) + "f6");
decodeCase("oversized-bytes", `5a${(16 * 1024 * 1024 + 1).toString(16).padStart(8, "0")}`);
decodeCase("oversized-text", `7a${(16 * 1024 * 1024 + 1).toString(16).padStart(8, "0")}`);
decodeCase("oversized-arr", `9a${(1000001).toString(16).padStart(8, "0")}`);
decodeCase("oversized-map", `ba${(1000001).toString(16).padStart(8, "0")}`);
decodeCase("strict-container", "83010203", { maxContainerLength: 2 });
decodeCase("strict-bytes", "626162", { maxByteLength: 2 });
encodeCase("strict-enc-container", [1, 2, 3], { maxContainerLength: 2 });
encodeCase("strict-enc-bytes", "ab", { maxByteLength: 2 });
encodeCase("text-over-max", "x".repeat(17), { maxByteLength: 16 });
decodeCase("safe-uint-2^53-1", "1b001fffffffffffff");
decodeCase("float-not-int", toHex(encodeCbor(1.5)));

// ---- 8. Protocol messages as plain objects (envelope field order = schema order) ----
const serverId = "00000000-0000-4000-8000-000000000001";
const messages = {
  client_hello: { type: "hello", version: 8 },
  client_hello_v0: { type: "hello", version: 0 },
  client_hello_v9: { type: "hello", version: 9 },
  request_server: {
    type: "request", id: "request-1",
    target: { serverId },
    call: { serviceId: "pi.models", member: "list", args: [] },
  },
  request_session: {
    type: "request", id: "request-2",
    target: { serverId, sessionId: "session-1", attachmentId: "attachment-1" },
    call: {
      serviceId: "application.custom",
      instance: { key: "instance-1", generation: 2 },
      member: "invoke",
      args: [{ arbitrary: true }, ["opaque"]],
    },
  },
  cancel: { type: "cancel", id: "request-1", target: { serverId } },
  server_hello: { type: "hello", version: 8, serverId },
  hello_error: { type: "hello_error", error: { code: "wrong_server", message: "safe" } },
  response_void: { type: "response", id: "request-1", ok: true },
  response_result: { type: "response", id: "request-1", ok: true, result: [] },
  response_error: {
    type: "response", id: "request-1", ok: false,
    error: { code: "service_not_found", message: "safe" },
  },
  service_update: {
    type: "service_update", subscriptionId: "subscription-1",
    update: { applicationDefined: true },
  },
  attachment_attached: {
    type: "attachment",
    attachment: { serverId, sessionId: "session-1", attachmentId: "attachment-1" },
  },
  attachment_detached: { type: "attachment", attachment: null },
};
for (const [name, value] of Object.entries(messages)) {
  encodeCase(`msg:${name}`, value);
  const payload = encodeCbor(value);
  const frame = encodeFrame(payload);
  label(`frame:${name}`);
  console.log(`payload=${toHex(payload)}`);
  console.log(`frame=${toHex(frame)}`);
  const decoded = new FrameDecoder().push(frame);
  label(`reframe:${name}`);
  console.log(decoded.map((f) => toHex(f)).join(","));
  console.log(JSON.stringify(decodeCbor(payload)));
}

// ---- 9. Framing vectors ----
label("encode:frame-3-bytes");
console.log(toHex(encodeFrame(new Uint8Array([0xaa, 0xbb, 0xcc]))));
label("encode:frame-empty");
console.log(toHex(encodeFrame(new Uint8Array())));
label("frame-coalesced");
{
  const wire = new Uint8Array([
    ...encodeFrame(new Uint8Array([1, 2, 3])),
    ...encodeFrame(new Uint8Array()),
    ...encodeFrame(new Uint8Array([4])),
  ]);
  console.log(`wire=${toHex(wire)}`);
  const dec = new FrameDecoder();
  console.log(`all=${dec.push(wire).map(toHex).join(",")}`);
  dec.end();
  const dec2 = new FrameDecoder();
  const out = [];
  for (const byte of wire) out.push(...dec2.push(new Uint8Array([byte])));
  dec2.end();
  console.log(`byByte=${out.map(toHex).join(",")}`);
}
label("frame-70000-blocks");
{
  const payload = Uint8Array.from({ length: 70_000 }, (_, i) => i % 251);
  const wire = encodeFrame(payload);
  const dec = new FrameDecoder();
  const frames = [
    ...dec.push(wire.subarray(0, 101)),
    ...dec.push(wire.subarray(101, 65_541)),
    ...dec.push(wire.subarray(65_541)),
  ];
  dec.end();
  console.log(`len=${frames.length} first40=${toHex(frames[0].subarray(0, 40))}`);
  console.log(`sha-ish=${toHex(frames[0].subarray(69990))}`);
}
label("frame-oversized");
{
  const dec = new FrameDecoder({ maxFrameLength: 3 });
  try {
    dec.push(new Uint8Array([0, 0, 0, 4]));
  } catch (error) {
    console.log(`ERR ${error.name}: ${error.message}`);
  }
  try {
    dec.push(new Uint8Array([1]));
  } catch (error) {
    console.log(`ERR ${error.name}: ${error.message}`);
  }
}
label("frame-range-errors");
for (const bad of [-1, 1.5, Number.NaN, 16 * 1024 * 1024 * 1000]) {
  try {
    new FrameDecoder({ maxFrameLength: bad });
    console.log("no-error");
  } catch (error) {
    console.log(`ERR ${error.name}: ${error.message}`);
  }
}
label("options-range-errors");
for (const [name, opts] of [
  ["maxByteLength-neg", { maxByteLength: -1 }],
  ["maxByteLength-float", { maxByteLength: 1.5 }],
  ["maxByteLength-over", { maxByteLength: 4294967296 }],
  ["maxDepth-over", { maxDepth: 513 }],
  ["maxDepth-neg", { maxDepth: -1 }],
  ["maxContainerLength-over", { maxContainerLength: 4294967296 }],
]) {
  try {
    encodeCbor(null, opts);
    console.log("no-error");
  } catch (error) {
    console.log(`${name} ERR ${error.name}: ${error.message}`);
  }
}
label("END");
