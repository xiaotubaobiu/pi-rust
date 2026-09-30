// Oracle driver for the client-package port (M6 client slice). Runs the
// verbatim copied upstream `packages/client` sources (src/, test/support.ts)
// against a local `@earendil-works/pi-protocol` copy (real cbor/framing/codec;
// TypeBox replaced by a minimal descriptor evaluator — see
// node_modules/typebox/index.mjs) and the verbatim copied `chord` package.
// Prints deterministic lines; the Rust port's tests assert the captured
// outputs byte-for-byte. Run:
//   node --experimental-strip-types oracle.mjs > oracle.out.txt 2> oracle.err.txt
import { Client, createClientServiceTransport } from "./src/index.ts";
import {
  encodeCbor,
  encodeFrame,
  encodeServerMessage,
  PROTOCOL_VERSION,
} from "@earendil-works/pi-protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryByteServer } from "./test/support.ts";

const serverId = "00000000-0000-4000-8000-000000000001";
const otherServerId = "00000000-0000-4000-8000-000000000002";
const serverTarget = { serverId };

const encoder = new TextEncoder();
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const label = (name) => console.log(`=== ${name}`);
const json = (value) => JSON.stringify(value);

async function capture(promise) {
  try {
    const value = await promise;
    return { ok: true, value: value === undefined ? null : value };
  } catch (error) {
    return {
      ok: false,
      name: error.name,
      message: error.message,
      code: error.code,
      cause: error.cause instanceof Error ? error.cause.message : undefined,
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wraps the upstream support server's transports so every client->server
 * chunk is recorded as hex before the real (verbatim) handling runs. */
function recordingFactory(server, log) {
  return (handlers) => {
    const transport = server.connect(handlers);
    const send = transport.send.bind(transport);
    transport.send = async (chunk) => {
      log.push(hex(chunk));
      return send(chunk);
    };
    return transport;
  };
}

async function connectWithRecording(server, log) {
  const client = new Client({ serverId, transportFactory: recordingFactory(server, log) });
  await client.connect();
  return client;
}

async function attachClient(client, server, sessionId) {
  const expectedMessages = server.messages.length + 1;
  const attaching = client.request(serverTarget, {
    serviceId: "pi.session-management",
    member: "attach",
    args: [sessionId],
  });
  await server.waitForMessages(expectedMessages);
  const request = server.messages.at(-1);
  server.send({
    type: "attachment",
    attachment: { serverId, sessionId, attachmentId: `attachment-${sessionId}` },
  });
  server.send({ type: "response", id: request.id, ok: true, result: null });
  await attaching;
}

// ---- S1: hello + request frame bytes ----
label("hello-and-request-bytes");
{
  const server = new MemoryByteServer();
  const bytes = [];
  const client = await connectWithRecording(server, bytes);
  console.log(json(bytes));
  const pending = client.request(serverTarget, {
    serviceId: "test",
    member: "mutate",
    args: [{ value: 42 }],
  });
  await server.waitForMessages(2);
  console.log(json(bytes));
  server.send({ type: "response", id: "request-1", ok: true, result: "done" });
  console.log(json(await capture(pending)));
  await client.dispose();
}

// ---- S2: cancel frame bytes ----
label("cancel-frame-bytes");
{
  const server = new MemoryByteServer();
  const bytes = [];
  const client = await connectWithRecording(server, bytes);
  const controller = new AbortController();
  const reason = new Error("stop this request");
  const pending = client.request(
    serverTarget,
    { serviceId: "test", member: "mutate", args: [{ value: 42 }] },
    controller.signal,
  );
  await server.waitForMessages(2);
  bytes.length = 0;
  controller.abort(reason);
  console.log(json(await capture(pending)));
  await server.waitForMessages(3);
  console.log(json(bytes));
  server.send({
    type: "response",
    id: "request-1",
    ok: false,
    error: { code: "cancelled", message: "cancelled" },
  });
  await sleep(10);
  console.log(`connected=${client.connected}`);
  await client.dispose();
}

// ---- S3: subscribe/unsubscribe frame bytes + snapshot/updates (full upstream flow) ----
label("subscription-flow");
{
  const server = new MemoryByteServer();
  const bytes = [];
  const client = await connectWithRecording(server, bytes);
  await attachClient(client, server, "session-1");
  const target = client.attachment;
  console.log(json(target));
  const transport = createClientServiceTransport(client, () => client.attachment);
  const updates = [];
  bytes.length = 0;
  const opening = transport.subscribe(
    "pi.models",
    "singleton",
    (update) => {
      updates.push(update);
    },
    BACKGROUND_CONTEXT,
  );
  await server.waitForMessages(3);
  console.log(`subscribe-frames=${json(bytes)}`);
  server.send({
    type: "service_update",
    subscriptionId: "service-1",
    update: { type: "state", member: "state", sequence: 1, ops: [["s", ["revision"], 1]] },
  });
  await Promise.resolve();
  console.log(`updates-before-snapshot=${json(updates)}`);
  server.send({
    type: "response",
    id: "request-2",
    ok: true,
    result: {
      serviceId: "pi.models",
      mode: "singleton",
      instances: [{ members: [{ name: "state", kind: "state", sequence: 0, ops: [["r", { revision: 0 }]] }] }],
    },
  });
  const subscription = await opening;
  console.log(`updates-after-open=${json(updates)}`);
  console.log(`snapshot=${json(subscription.snapshot)}`);
  server.send({
    type: "service_update",
    subscriptionId: "closed-subscription",
    update: { type: "state", member: "state", sequence: 99, ops: [["s", 99, 99]] },
  });
  await Promise.resolve();
  await Promise.resolve();
  console.log(`connected-after-unknown-subscription=${client.connected}`);
  subscription.activate();
  await sleep(20);
  console.log(`updates-after-activate=${json(updates.map((update) => update.type))}`);
  server.send({
    type: "service_update",
    subscriptionId: "service-1",
    update: { type: "state", member: "state", sequence: 2, ops: [["s", ["revision"], 2]] },
  });
  server.send({
    type: "service_update",
    subscriptionId: "service-1",
    update: {
      type: "state",
      member: "state",
      sequence: 3,
      ops: [
        ["#", 0, ["revision"]],
        ["s", 0, 3],
      ],
    },
  });
  for (let i = 0; i < 40 && updates.length < 3; i++) await sleep(5);
  console.log(`updates-final=${json(updates)}`);
  bytes.length = 0;
  const disposing = subscription.close(BACKGROUND_CONTEXT);
  await server.waitForMessages(4);
  console.log(`unsubscribe-frames=${json(bytes)}`);
  server.send({ type: "response", id: "request-3", ok: true });
  await disposing;
  console.log(`disposed-close-count=${server.clientCloseCount}`);
  await client.dispose();
}

// ---- S4: wrong logical server ----
label("wrong-server");
{
  const wrong = new MemoryByteServer(otherServerId);
  const error = await capture(
    new Client({ serverId, transportFactory: (handlers) => wrong.connect(handlers) }).connect(),
  );
  console.log(json(error));
  console.log(`close-count=${wrong.clientCloseCount}`);
}

// ---- S5: attachment routing ----
label("attachment-routing");
{
  const server = new MemoryByteServer();
  const client = await connectWithRecording(server, []);
  const changes = [];
  client.onAttachmentChange((attachment) => changes.push(attachment === undefined ? undefined : attachment));
  await attachClient(client, server, "session-1");
  console.log(`attachment=${json(client.attachment)}`);
  const messages = json(server.messages[1]);
  console.log(`attach-request=${messages}`);
  server.send({ type: "attachment", attachment: null });
  console.log(`detached-attachment=${json(client.attachment)}`);
  console.log(`changes=${json(changes)}`);
  await client.dispose();
}

// ---- S6: hello_error ----
label("hello-error");
{
  let closeCount = 0;
  let created;
  const client = new Client({
    serverId,
    transportFactory: (createdHandlers) => {
      created = createdHandlers;
      return {
        async send() {
          createdHandlers.onData(
            encodeServerMessage({
              type: "hello_error",
              error: { code: "version", message: "Unsupported protocol version" },
            }),
          );
        },
        close() {
          closeCount += 1;
        },
      };
    },
  });
  const error = await capture(client.connect());
  console.log(json(error));
  console.log(`state=${client.connectionState} close-count=${closeCount} factory-used=${created !== undefined}`);
}

// ---- S7: server data before client hello ----
label("data-before-hello");
{
  let closeCount = 0;
  let sendCount = 0;
  const client = new Client({
    serverId,
    transportFactory: (handlers) => {
      handlers.onData(encodeServerMessage({ type: "hello", version: PROTOCOL_VERSION, serverId }));
      return {
        async send() {
          sendCount += 1;
        },
        close() {
          closeCount += 1;
        },
      };
    },
  });
  const error = await capture(client.connect());
  console.log(json(error));
  console.log(`state=${client.connectionState} send-count=${sendCount} close-count=${closeCount}`);
}

// ---- S8: response without matching request ----
label("response-no-match");
{
  const server = new MemoryByteServer();
  const client = await connectWithRecording(server, []);
  server.send({ type: "response", id: "unknown-request", ok: true, result: [] });
  console.log(`state=${client.connectionState} close-count=${server.clientCloseCount}`);
  await client.dispose();
}

// ---- S9: truncated framing ----
label("truncated-framing");
{
  const invalidServer = new MemoryByteServer();
  const invalidClient = await connectWithRecording(invalidServer, []);
  invalidServer.sendRaw(encodeFrame(encodeCbor({ type: "response", id: "unknown", ok: true, result: 1 })));
  console.log(`invalid-state=${invalidClient.connectionState}`);

  const truncatedServer = new MemoryByteServer();
  const truncatedClient = await connectWithRecording(truncatedServer, []);
  const pending = truncatedClient.request(serverTarget, { serviceId: "test", member: "pending", args: [] });
  await truncatedServer.waitForMessages(2);
  truncatedServer.sendRaw(new Uint8Array([0, 0, 0, 2, 1]));
  truncatedServer.disconnect();
  console.log(json(await capture(pending)));
  console.log(`truncated-state=${truncatedClient.connectionState}`);
  await truncatedClient.dispose();
  await invalidClient.dispose();
}

// ---- S10: out-of-order responses ----
label("out-of-order-responses");
{
  const server = new MemoryByteServer();
  const client = await connectWithRecording(server, []);
  const first = client.request(serverTarget, { serviceId: "test", member: "first", args: [] });
  const second = client.request(serverTarget, { serviceId: "test", member: "second", args: [] });
  await server.waitForMessages(3);
  server.send({ type: "response", id: "request-2", ok: true, result: "second" });
  server.send({ type: "response", id: "request-1", ok: true, result: "first" });
  console.log(json(await capture(Promise.all([first, second]))));
  await client.dispose();
}

// ---- S11: bounded server errors ----
label("server-error");
{
  const server = new MemoryByteServer();
  const client = await connectWithRecording(server, []);
  const pending = client.request(serverTarget, { serviceId: "test", member: "missing", args: [] });
  await server.waitForMessages(2);
  server.send({
    type: "response",
    id: "request-1",
    ok: false,
    error: { code: "session_not_found", message: "Unknown session" },
  });
  console.log(json(await capture(pending)));
  await client.dispose();
}

// ---- S12: pre-aborted request ----
label("pre-aborted-request");
{
  const server = new MemoryByteServer();
  const client = await connectWithRecording(server, []);
  const controller = new AbortController();
  const reason = new Error("already cancelled");
  controller.abort(reason);
  console.log(json(await capture(
    client.request(serverTarget, { serviceId: "test", member: "noop", args: [] }, controller.signal),
  )));
  console.log(`messages=${json(server.messages)}`);
  await client.dispose();
}

// ---- S13: reconnect through a fresh transport ----
label("reconnect-sequence");
{
  const first = new MemoryByteServer();
  const second = new MemoryByteServer();
  let connection = 0;
  const client = new Client({
    serverId,
    transportFactory: (handlers) => (connection++ === 0 ? first : second).connect(handlers),
  });
  const states = [];
  client.onConnectionStateChange(({ state }) => states.push(state));
  await client.connect();
  await attachClient(client, first, "session-1");
  const target = client.attachment;
  const pending = client.request(target, { serviceId: "test.session", member: "run", args: [] });
  await first.waitForMessages(3);
  first.disconnect();
  console.log(json(await capture(pending)));
  const hello = await client.reconnect();
  console.log(`connection=${connection} connected=${client.connected} second-messages=${second.messages.length}`);
  console.log(`hello=${json(hello)}`);
  console.log(`states=${json(states)}`);
  await client.dispose();
}

// ---- S14: transport failure ----
label("transport-failure");
{
  const server = new MemoryByteServer();
  const client = await connectWithRecording(server, []);
  const pending = client.request(serverTarget, { serviceId: "test", member: "pending", args: [] });
  await server.waitForMessages(2);
  server.error(new Error("read failed"));
  console.log(json(await capture(pending)));
  console.log(`state=${client.connectionState}`);
  await client.dispose();
}

// ---- S15: service catalogue ----
label("service-catalogue");
{
  const server = new MemoryByteServer();
  const client = await connectWithRecording(server, []);
  const pending = client.serviceCatalogue(serverTarget);
  await server.waitForMessages(2);
  server.send({
    type: "response",
    id: "request-1",
    ok: true,
    result: [{ serviceId: "pi.models", mode: "singleton" }],
  });
  console.log(json(await capture(pending)));
  const invalid = client.serviceCatalogue(serverTarget);
  await server.waitForMessages(3);
  server.send({ type: "response", id: "request-2", ok: true, result: { not: "an array" } });
  console.log(json(await capture(invalid)));
  console.log(`state=${client.connectionState}`);
  await client.dispose();
}

// ---- S16: constructor validation + disposal ----
label("validation-and-disposal");
{
  try {
    new Client({ serverId: "invalid-server", transportFactory: () => Promise.reject() });
    console.log("no-error");
  } catch (error) {
    console.log(`${error.name}: ${error.message}`);
  }
  try {
    new Client({ serverId, transportFactory: () => Promise.reject(), maxFrameLength: 0 });
    console.log("no-error");
  } catch (error) {
    console.log(`${error.name}: ${error.message}`);
  }
  const server = new MemoryByteServer();
  const client = await connectWithRecording(server, []);
  await client.dispose();
  await client.dispose();
  const after = await capture(client.request(serverTarget, { serviceId: "test", member: "disposed", args: [] }));
  console.log(json(after));
  try {
    client.onConnectionStateChange(() => {});
    console.log("no-error");
  } catch (error) {
    console.log(`${error.name}: ${error.message}`);
  }
  console.log(`disposed=${client.disposed} close-count=${server.clientCloseCount}`);
}

// ---- S17: connect while connecting, dispose idempotence ----
label("connect-while-connecting");
{
  const server = new MemoryByteServer();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let blocked;
  const client = new Client({
    serverId,
    transportFactory: async (handlers) => {
      if (blocked) {
        return server.connect(handlers);
      }
      blocked = true;
      await gate;
      return server.connect(handlers);
    },
  });
  const first = client.connect();
  await sleep(10);
  const second = await capture(client.connect());
  console.log(json(second));
  release();
  console.log(json(await capture(first)));
  const reconnectState = await capture(client.connect());
  console.log(`third-connect=${json(reconnectState)}`);
  await client.dispose();
  const postDispose = await capture(client.connect());
  console.log(json(postDispose));
}

// ---- S18: disconnect clears attachment and rejects pending ----
label("disconnect-clears-state");
{
  const server = new MemoryByteServer();
  const client = await connectWithRecording(server, []);
  await attachClient(client, server, "session-1");
  const pending = client.request(serverTarget, { serviceId: "test", member: "pending", args: [] });
  client.disconnect();
  console.log(json(await capture(pending)));
  console.log(`attachment=${json(client.attachment)} hello=${json(client.hello)} state=${client.connectionState}`);
  const states = [];
  client.onConnectionStateChange(({ state }) => states.push(state));
  await client.reconnect();
  console.log(`reconnected-states=${json(states)} attachment-still-clear=${client.attachment === undefined}`);
  await client.dispose();
}

await sleep(20);
console.log("=== done");
