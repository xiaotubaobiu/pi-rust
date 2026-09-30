// Oracle driver for the server-package port (M6 server slice). Runs the
// verbatim copied upstream `packages/server` sources (src/) against the real
// vendored `pi-protocol` + `chord` copies and the minimal agent-core shim
// (vendor/agent-core — see its provenance note). Prints deterministic lines;
// the Rust port's tests assert the captured outputs byte-for-byte.
// Run:
//   node --import ./register.mjs --experimental-strip-types oracle.mjs > oracle.out.txt 2> oracle.err.txt
import { Server } from "./src/server.ts";
import { ProtocolTestClient, TestServerHost } from "./src/testing/index.ts";
import {
  createServiceSubscribeCall,
  createServiceUnsubscribeCall,
  decodeServiceControlCall,
} from "@earendil-works/chord";
import {
  encodeClientMessage,
  encodeCbor,
  encodeFrame,
  PROTOCOL_VERSION,
} from "@earendil-works/pi-protocol";

const serverId = "00000000-0000-4000-8000-000000000001";
// Frames are hexed; embedded ASCII UUIDv4s (randomUUID attachment ids) are
// masked in hex space: each text char is one byte pair ("2d" = '-').
const UUID_HEX = /[0-9a-f]{16}2d[0-9a-f]{8}2d34[0-9a-f]{6}2d(?:38|39|61|62)[0-9a-f]{6}2d[0-9a-f]{24}/g;
const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .replace(UUID_HEX, "<uuid>");
const label = (name) => console.log(`=== ${name}`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// randomUUID attachment ids are process-random; mask them on both sides.
const mask = (text) => text.replace(UUID, "<uuid>");
const out = (value) => console.log(mask(JSON.stringify(value)));

async function capture(promise) {
  try {
    const value = await promise;
    return { ok: true, value: value === undefined ? null : value };
  } catch (error) {
    return { ok: false, name: error.name, message: error.message };
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** The conformance loopback pair: server frames are recorded as hex chunks
 * (one entry per send, including final close frames). */
function connect(server) {
  let handler;
  let client;
  const frames = [];
  let closed = false;
  const connection = {
    get closed() {
      return closed;
    },
    async send(chunk) {
      frames.push(hex(chunk));
      client.receive(chunk);
    },
    close(finalChunk) {
      if (finalChunk) {
        frames.push(hex(finalChunk));
        client.receive(finalChunk);
      }
      closed = true;
      client.markClosed();
    },
  };
  const channel = {
    async send(chunk) {
      handler.onData(chunk);
    },
    async sendFragmented(chunk, splitAt) {
      handler.onData(chunk.subarray(0, splitAt));
      handler.onData(chunk.subarray(splitAt));
    },
    async close() {
      if (closed) return;
      closed = true;
      handler.onClose();
      client.markClosed();
    },
  };
  client = new ProtocolTestClient(channel);
  handler = server.accept(connection);
  client.frames = frames;
  return client;
}

function sessionCall(member, args = []) {
  return { serviceId: "test.session", member, args };
}

async function flushed(promise) {
  const outcome = await capture(promise);
  await tick();
  return outcome;
}

function makeServer(host, options = {}) {
  return new Server(host, { listeners: [], serverId, ...options });
}

// ---- option validation (resolveOptions TypeErrors) ----
label("option-validation");
{
  const messages = [];
  const attempt = (fn) => {
    try {
      fn();
      messages.push("(no error)");
    } catch (error) {
      messages.push(error.message);
    }
  };
  const host = new TestServerHost();
  attempt(() => new Server(host, { listeners: [], serverId: "" }));
  attempt(() => new Server(host, { listeners: [], serverId: "invalid-server" }));
  attempt(() => new Server(host, { listeners: [], serverId, maxFrameLength: 0 }));
  attempt(() => new Server(host, { listeners: [], serverId, maxFrameLength: 4294967296 }));
  attempt(() => new Server(host, { listeners: [], serverId, handshakeTimeoutMs: 0 }));
  attempt(() => new Server(host, { listeners: [], serverId, handshakeTimeoutMs: 2147483648 }));
  out(messages);
}

// ---- unix listener option validation (synchronous; no filesystem access) ----
label("unix-option-validation");
{
  const { createUnixServer, getUnixSocketPath } = await import("./src/transports/unix/index.ts");
  const messages = [];
  const attempt = (fn) => {
    try {
      fn();
      messages.push("(no error)");
    } catch (error) {
      messages.push(error.message);
    }
  };
  const host = new TestServerHost();
  attempt(() => createUnixServer(host, { path: "", serverId }));
  attempt(() => createUnixServer(host, { path: "/tmp/x.sock", serverId, mode: 0o1000 }));
  attempt(() => createUnixServer(host, { path: "/tmp/x.sock", serverId, maxFrameLength: 0 }));
  attempt(() =>
    createUnixServer(host, {
      path: "/tmp/x.sock",
      serverId,
      maxFrameLength: 128,
      maxPendingBytes: 131,
    }),
  );
  attempt(() => createUnixServer(host, { path: "/tmp/x.sock", serverId, gracefulCloseTimeoutMs: 0 }));
  attempt(() =>
    createUnixServer(host, { path: "/tmp/x.sock", serverId, handshakeTimeoutMs: 2147483648 }),
  );
  attempt(() => getUnixSocketPath("nope", "/tmp"));
  out(messages);
}

// ---- handshake frames ----
label("hello-frame");
{
  const server = makeServer(new TestServerHost());
  const client = connect(server);
  await flushed(client.hello());
  out(client.frames);
  await server.close();
}

label("first-message-not-hello");
{
  const server = makeServer(new TestServerHost());
  const client = connect(server);
  await flushed(
    client.sendMessage({
      type: "request",
      id: "request-1",
      target: { serverId },
      call: { serviceId: "pi.session-directory", member: "list", args: [] },
    }),
  );
  const error = await client.next((message) => message.type === "hello_error");
  await client.waitForClose();
  out({ frames: client.frames, error: error.error });
  await server.close();
}

label("unsupported-version");
{
  const server = makeServer(new TestServerHost());
  const client = connect(server);
  await flushed(client.hello(PROTOCOL_VERSION + 1));
  out(client.frames);
  await server.close();
}

label("malformed-frame");
{
  const server = makeServer(new TestServerHost());
  const client = connect(server);
  await client.sendBytes(encodeFrame(Uint8Array.of(0xff)));
  const error = await client.next((message) => message.type === "hello_error");
  await client.waitForClose();
  out({ frames: client.frames, error: error.error });
  await server.close();
}

label("schema-invalid-frame");
{
  const server = makeServer(new TestServerHost());
  const client = connect(server);
  await client.sendBytes(encodeFrame(encodeCbor({ type: "hello", version: 1, extra: true })));
  const error = await client.next((message) => message.type === "hello_error");
  await client.waitForClose();
  out({ frames: client.frames, error: error.error });
  await server.close();
}

label("oversized-frame");
{
  const server = makeServer(new TestServerHost());
  const client = connect(server);
  await client.sendBytes(new Uint8Array([1, 0, 0, 1]));
  const error = await client.next((message) => message.type === "hello_error");
  await client.waitForClose();
  out({ frames: client.frames, error: error.error });
  await server.close();
}

label("second-hello");
{
  const server = makeServer(new TestServerHost());
  const client = connect(server);
  await flushed(client.hello());
  client.frames.length = 0;
  await flushed(client.sendMessage({ type: "hello", version: PROTOCOL_VERSION }));
  const error = await client.next((message) => message.type === "hello_error");
  await client.waitForClose();
  out({ frames: client.frames, error: error.error });
  await server.close();
}

label("coalesced-hello-request");
{
  const server = makeServer(new TestServerHost());
  const client = connect(server);
  const hello = encodeClientMessage({ type: "hello", version: PROTOCOL_VERSION });
  const request = encodeClientMessage({
    type: "request",
    id: "request-1",
    target: { serverId },
    call: { serviceId: "pi.session-directory", member: "list", args: [] },
  });
  const wire = new Uint8Array(hello.byteLength + request.byteLength);
  wire.set(hello);
  wire.set(request, hello.byteLength);
  await client.sendBytes(wire);
  await client.next((message) => message.type === "response");
  await tick();
  out(client.frames);
  await server.close();
}

label("fragmented-hello");
{
  const server = makeServer(new TestServerHost());
  const client = connect(server);
  const hello = encodeClientMessage({ type: "hello", version: PROTOCOL_VERSION });
  await client.sendFragmentedMessage(
    { type: "hello", version: PROTOCOL_VERSION },
    Math.floor(hello.byteLength / 2),
  );
  await flushed(client.next((message) => message.type === "hello"));
  out(client.frames);
  await server.close();
}

label("truncated-final-frame");
{
  const errors = [];
  const server = makeServer(new TestServerHost(), { onError: (error) => errors.push(error.message) });
  let closed = false;
  const connection = {
    get closed() {
      return closed;
    },
    async send() {},
    close() {
      closed = true;
    },
  };
  const handler = server.accept(connection);
  handler.onData(new Uint8Array([0, 0, 0, 2, 1]));
  handler.onClose();
  await tick();
  out({ closed, errors });
  await server.close();
}

// ---- session routing ----
label("handshake-skips-sessions");
{
  const host = new TestServerHost();
  await host.seed();
  const server = makeServer(host);
  const client = connect(server);
  await flushed(client.hello());
  out({ frames: client.frames, harnesses: host.harnesses.size });
  await server.close();
}

label("attach-unknown");
{
  const host = new TestServerHost();
  const server = makeServer(host);
  const client = connect(server);
  await flushed(client.hello());
  client.frames.length = 0;
  const response = await flushed(client.attach(serverId, "missing"));
  out({ frames: client.frames, response, harnesses: host.harnesses.size });
  await server.close();
}

label("wrong-server");
{
  const host = new TestServerHost();
  await host.seed("session-1");
  const server = makeServer(host);
  const client = connect(server);
  await flushed(client.hello());
  client.frames.length = 0;
  const response = await flushed(client.attach("00000000-0000-4000-8000-000000000002", "session-1"));
  out({ frames: client.frames, response, harnesses: host.harnesses.size });
  await server.close();
}

label("ambiguous-session");
{
  // The agent-core shim's MemorySessionRepo cannot hold duplicate ids (the
  // real repo throws on create); force the ambiguity at the list boundary —
  // upstream's conformance test does the same via a resolveSession stub.
  const host = new TestServerHost();
  const duplicate = { id: "duplicate", createdAt: 1, storageVersion: 1 };
  host.repo.list = async () => [duplicate, duplicate];
  const server = makeServer(host);
  const client = connect(server);
  await flushed(client.hello());
  client.frames.length = 0;
  const response = await flushed(client.attach(serverId, "duplicate"));
  out({ frames: client.frames, response });
  await server.close();
}

label("invalid-call");
{
  const server = makeServer(new TestServerHost());
  const client = connect(server);
  await flushed(client.hello());
  client.frames.length = 0;
  const pending = client.next((message) => message.type === "response" && message.id === "invalid-call");
  await client.sendMessage({ type: "request", id: "invalid-call", target: { serverId }, call: { arbitrary: true } });
  const response = await flushed(pending);
  out({ frames: client.frames, response });
  await server.close();
}

label("session-not-attached");
{
  const host = new TestServerHost();
  await host.seed("session-1");
  const server = makeServer(host);
  const client = connect(server);
  await flushed(client.hello());
  client.frames.length = 0;
  const response = await flushed(
    client.requestSessionService(serverId, "session-1", sessionCall("run")),
  );
  out({ frames: client.frames, response });
  await server.close();
}

label("session-service-ok");
{
  const host = new TestServerHost();
  await host.seed("session-1");
  const server = makeServer(host);
  const client = connect(server);
  await flushed(client.hello());
  client.frames.length = 0;
  const attachResponse = await flushed(client.attach(serverId, "session-1"));
  const runResponse = await flushed(
    client.requestSessionService(serverId, "session-1", sessionCall("run", ["Hello"])),
  );
  out({
    frames: client.frames,
    attachResponse,
    runResponse,
    serviceCalls: host.latestHarness("session-1").serviceCalls,
  });
  await server.close();
}

label("stale-attachment");
{
  const host = new TestServerHost();
  await Promise.all([host.seed("session-1"), host.seed("session-2")]);
  const server = makeServer(host);
  const client = connect(server);
  await flushed(client.hello());
  await flushed(client.attach(serverId, "session-1"));
  const firstAttachmentId = client.messages.findLast(
    (message) => message.type === "attachment",
  )?.attachment?.attachmentId;
  await flushed(client.attach(serverId, "session-2"));
  client.frames.length = 0;
  const response = await flushed(
    client.requestService(
      { serverId, sessionId: "session-1", attachmentId: firstAttachmentId },
      sessionCall("run", ["stale"]),
    ),
  );
  out({ frames: client.frames, response, serviceCalls: host.latestHarness("session-1").serviceCalls });
  await server.close();
}

label("opaque-result");
{
  const host = new TestServerHost();
  await host.seed("session-1");
  const server = makeServer(host);
  const client = connect(server);
  await flushed(client.hello());
  await flushed(client.attach(serverId, "session-1"));
  host.latestHarness("session-1").nextServiceResult = { accepted: false, reason: "closed" };
  client.frames.length = 0;
  const response = await flushed(
    client.requestSessionService(serverId, "session-1", sessionCall("run")),
  );
  out({ frames: client.frames, response });
  await server.close();
}

label("internal-error");
{
  const host = new TestServerHost();
  await host.seed("session-1");
  const server = makeServer(host);
  const client = connect(server);
  await flushed(client.hello());
  await flushed(client.attach(serverId, "session-1"));
  host.latestHarness("session-1").nextServiceError = new Error("private adapter detail");
  client.frames.length = 0;
  const response = await flushed(
    client.requestSessionService(serverId, "session-1", sessionCall("run")),
  );
  out({ frames: client.frames, response });
  await server.close();
}

label("duplicate-request-id");
{
  const host = new TestServerHost();
  await host.seed("session-1");
  const server = makeServer(host);
  const client = connect(server);
  await flushed(client.hello());
  await flushed(client.attach(serverId, "session-1"));
  const harness = host.latestHarness("session-1");
  const gate = harness.gateNextServiceCall();
  const first = client.requestSessionService(serverId, "session-1", sessionCall("run", ["first"]));
  await gate.entered.promise;
  // `first` holds the auto id "request-2" (attach consumed "request-1"),
  // which is still active on the server while gated.
  const activeId = "request-2";
  client.frames.length = 0;
  const duplicate = await flushed(
    client.requestService(
      { serverId, sessionId: "session-1", attachmentId: "x" },
      sessionCall("run", ["second"]),
      activeId,
    ),
  );
  gate.release.resolve(undefined);
  await flushed(first);
  out({ frames: client.frames, duplicate });
  await server.close();
}

// ---- server-scoped service subscriptions (real chord state codec) ----
function subscriptionHost() {
  const snapshot = { serviceId: "pi.test", mode: "singleton", instances: [] };
  const host = new TestServerHost();
  host.serverServices = {
    attachClient(_presentation) {
      return {
        async invokeService(call, publish, _context) {
          const control = decodeServiceControlCall(call);
          if (control?.type === "subscribe") {
            await publish(control.subscriptionId, { type: "unavailable" });
            return snapshot;
          }
          if (control?.type === "unsubscribe") {
            return undefined;
          }
          throw new Error(`unexpected call ${call.serviceId}.${call.member}`);
        },
        release() {},
      };
    },
  };
  return host;
}

const subscribeCall = createServiceSubscribeCall("sub-1", "pi.test", "singleton");
const unsubscribeCall = createServiceUnsubscribeCall("sub-1");

label("subscription-flow");
{
  const server = makeServer(subscriptionHost());
  const client = connect(server);
  await flushed(client.hello());
  client.frames.length = 0;
  const response = await flushed(client.requestService({ serverId }, subscribeCall, "sub-req"));
  const responseEnvelope = client.messages.findLast(
    (message) => message.type === "response" && message.id === "sub-req",
  );
  const update = await flushed(client.next((message) => message.type === "service_update"));
  out({
    frames: client.frames,
    response,
    result: responseEnvelope?.result ?? null,
    update: update ?? null,
  });
  await server.close();
}

label("unsubscribe-flow");
{
  const server = makeServer(subscriptionHost());
  const client = connect(server);
  await flushed(client.hello());
  await flushed(client.requestService({ serverId }, subscribeCall, "sub-req"));
  client.frames.length = 0;
  const response = await flushed(client.requestService({ serverId }, unsubscribeCall, "unsub-req"));
  out({ frames: client.frames, response });
  await server.close();
}

label("duplicate-subscription");
{
  const server = makeServer(subscriptionHost());
  const client = connect(server);
  await flushed(client.hello());
  await flushed(client.requestService({ serverId }, subscribeCall, "sub-req"));
  client.frames.length = 0;
  const response = await flushed(client.requestService({ serverId }, subscribeCall, "dup-req"));
  out({ frames: client.frames, response });
  await server.close();
}

label("unknown-service-member");
{
  const server = makeServer(new TestServerHost());
  const client = connect(server);
  await flushed(client.hello());
  client.frames.length = 0;
  const response = await flushed(
    client.requestService({ serverId }, { serviceId: "pi.models", member: "list", args: [] }),
  );
  out({ frames: client.frames, response });
  await server.close();
}

label("handshake-timeout");
{
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  class TimedOutConnection {
    closed = false;
    finalChunk;
    frames = [];
    send() {
      return Promise.reject(new Error("handshake timeout must use the terminal close frame"));
    }
    close(finalChunk) {
      if (finalChunk) this.frames.push(hex(finalChunk));
      this.finalChunk = finalChunk;
      this.closed = true;
      resolveClosed();
    }
  }
  const core = makeServer(new TestServerHost(), { maxFrameLength: 1024, handshakeTimeoutMs: 10 });
  // The upstream handshake timer is `.unref()`ed; keep the event loop alive
  // so the awaited timeout can actually fire.
  const keepAlive = setInterval(() => {}, 1000);
  const connection = new TimedOutConnection();
  core.accept(connection);
  await closed;
  clearInterval(keepAlive);
  out({ frames: connection.frames, closed: connection.closed });
  await core.close();
}
