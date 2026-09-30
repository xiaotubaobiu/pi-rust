/**
 * Oracle harness for the verbatim upstream `radius-relay.ts`.
 *
 * Mirrors the scenarios of upstream `test/experimental-radius-relay.test.ts`
 * (FakeWebSocket reproduced verbatim) plus control/data frame failure cases
 * driven through the host so the private `parseHostControlMessage` error
 * strings are observed. Node runtime:
 *   node --experimental-strip-types oracle_relay.ts
 */
import {
  createRadiusClientTransportFactory,
  encodeRelayDataFrame,
  parseRelayDataFrame,
  RadiusClientReconnect,
  RadiusRelayHost,
} from "./upstream/radius-relay.ts";
import { RadiusRelayAuthResolver } from "./upstream/radius-auth.ts";

const serverId = "00000000-0000-4000-8000-000000000001";
const connectionId = "00000000-0000-4000-8000-000000000002";

class FakeWebSocket {
  sent = [];
  onSend;
  listeners = new Map();
  binaryType = "blob";
  bufferedAmount = 0;
  protocol = "";
  readyState = 0;
  OPEN = 1;

  addEventListener(type, listener) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  send(data) {
    if (this.readyState !== this.OPEN) throw new Error("socket is not open");
    this.sent.push(data);
    this.onSend?.(data);
  }
  close(code = 1000, reason = "") {
    if (code !== 1000 && (code < 3000 || code > 4999)) {
      throw new Error("Invalid close code");
    }
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }
  open(protocol) {
    this.protocol = protocol;
    this.readyState = this.OPEN;
    this.emit("open", {});
  }
  message(data) {
    this.emit("message", { data });
  }
  remoteClose(code = 1006, reason = "lost") {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }
  fail(error) {
    this.emit("error", { error, message: error.message });
  }
  abnormalClose(error) {
    this.readyState = 3;
    this.emit("error", { error, message: error.message });
    this.emit("close", { code: 1006, reason: "" });
  }
  emit(type, event) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

function socketFactory() {
  const sockets = [];
  const factory = (options) => {
    const socket = new FakeWebSocket();
    sockets.push({ socket, options });
    return socket;
  };
  return { sockets, factory };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error("waitFor timeout");
}
const bytes = (buffer) => [...new Uint8Array(buffer)];

const out = {};

// --- envelope round trip + failure cases -----------------------------------
{
  const payload = Uint8Array.from([0, 1, 2, 255]);
  const parsed = parseRelayDataFrame(encodeRelayDataFrame(connectionId, payload));
  out.envelope = {
    connectionId: parsed?.connectionId,
    payload: bytes(parsed.payload),
    encoded: bytes(encodeRelayDataFrame(connectionId, payload)),
  };
  let encodeError = "";
  try {
    encodeRelayDataFrame("not-a-uuid", payload);
  } catch (error) {
    encodeError = `${error.name}: ${error.message}`;
  }
  out.encodeInvalidId = encodeError;
  out.parseTooShort = parseRelayDataFrame(new ArrayBuffer(4)) ?? null;
  const wrongVersion = encodeRelayDataFrame(connectionId, payload);
  new Uint8Array(wrongVersion)[1] = 2;
  out.parseWrongVersion = parseRelayDataFrame(wrongVersion) ?? null;
  const badId = encodeRelayDataFrame(connectionId, payload);
  new Uint8Array(badId)[3] = 0x7f; // breaks the version-4 nibble
  out.parseNonV4 = parseRelayDataFrame(badId) ?? null;
}

// --- host bridge -----------------------------------------------------------
{
  const webSockets = socketFactory();
  const received = [];
  let accepted;
  let onCloseCalls = 0;
  const server = {
    accept(connection) {
      accepted = connection;
      return {
        onData: (chunk) => received.push([...chunk]),
        onClose: () => {
          onCloseCalls += 1;
        },
        onError: () => {},
      };
    },
  };
  const statuses = [];
  const host = new RadiusRelayHost({
    serverId,
    server,
    auth: new RadiusRelayAuthResolver({ type: "token", token: "secret" }),
    webSocketFactory: webSockets.factory,
    onStatus: (status) => statuses.push(status.status),
  });
  host.start();
  await waitFor(() => webSockets.sockets.length === 1);
  const { socket, options } = webSockets.sockets[0];
  const openOptions = { authorization: options.authorization, url: options.url, protocol: options.protocol };
  socket.open(options.protocol);
  await waitFor(() => statuses.includes("connected"));

  socket.message(JSON.stringify({ version: 1, type: "connection_open", connection_id: connectionId }));
  const acceptedAfterOpen = accepted !== undefined;
  const fromClient = Uint8Array.from([1, 2, 3]);
  socket.message(encodeRelayDataFrame(connectionId, fromClient));
  await accepted.send(Uint8Array.from([4, 5, 6]));
  const outbound = parseRelayDataFrame(socket.sent.at(-1));
  socket.message(JSON.stringify({ version: 1, type: "connection_close", connection_id: connectionId }));
  await waitFor(() => onCloseCalls === 1);
  // Ping control: host must answer pong over the same socket.
  socket.message(JSON.stringify({ version: 1, type: "ping" }));
  await sleep(30);
  const lastSent = socket.sent.at(-1);
  // Unknown connection data: host answers connection_close with code 1000.
  const unknownId = "00000000-0000-4000-8000-000000000003";
  socket.message(encodeRelayDataFrame(unknownId, Uint8Array.from([9])));
  await sleep(30);
  const unknownClose = socket.sent.at(-1);
  await host.close();
  out.hostBridge = {
    openOptions,
    statuses,
    acceptedAfterOpen,
    received,
    outbound: { connectionId: outbound.connectionId, payload: bytes(outbound.payload) },
    pingReply: lastSent,
    unknownConnectionClose: unknownClose,
    onCloseCalls,
  };
}

// --- control/data failures through the host --------------------------------
{
  const webSockets = socketFactory();
  const statuses = [];
  const host = new RadiusRelayHost({
    serverId,
    server: { accept: () => ({ onData() {}, onClose() {}, onError() {} }) },
    auth: new RadiusRelayAuthResolver({ type: "token", token: "secret" }),
    webSocketFactory: webSockets.factory,
    onStatus: (status) => statuses.push(status),
  });
  host.start();
  await waitFor(() => webSockets.sockets.length === 1);
  const { socket } = webSockets.sockets[0];
  socket.open(socket.protocol || "pi-session-relay.host.v1");
  await waitFor(() => statuses.some((status) => status.status === "connected"));
  const cases = [
    JSON.stringify({ version: 2, type: "ping" }),
    JSON.stringify({ version: 1, type: "nonsense" }),
    JSON.stringify({ version: 1, type: "connection_open", connection_id: "nope" }),
    JSON.stringify({ version: 1, type: "connection_close", connection_id: connectionId, code: 42 }),
    "not json",
    JSON.stringify(["array"]),
    encodeRelayDataFrame(connectionId, Uint8Array.from([1])), // binary before open: "data message must be binary"? no: data without open -> close
  ];
  const retryErrors = [];
  const previous = statuses.length;
  for (const message of cases) {
    socket.message(message);
    await sleep(30);
    for (const status of statuses.slice(previous + retryErrors.length)) {
      if (status.status === "retrying") retryErrors.push(status.error);
    }
  }
  await host.close();
  out.hostFailures = { statuses: statuses.map((status) => status.status), retryErrors };
}

// --- host reconnect with backoff -------------------------------------------
{
  const webSockets = socketFactory();
  const statuses = [];
  const host = new RadiusRelayHost({
    serverId,
    server: { accept: () => ({ onData() {}, onClose() {}, onError() {} }) },
    auth: new RadiusRelayAuthResolver({ type: "token", token: "secret" }),
    webSocketFactory: webSockets.factory,
    onStatus: (status) => statuses.push(status.status),
  });
  host.start();
  await waitFor(() => webSockets.sockets.length === 1);
  webSockets.sockets[0].socket.open(webSockets.sockets[0].options.protocol);
  await waitFor(() => statuses.includes("connected"));
  webSockets.sockets[0].socket.remoteClose();
  await sleep(1300);
  await waitFor(() => webSockets.sockets.length === 2);
  webSockets.sockets[1].socket.open(webSockets.sockets[1].options.protocol);
  await sleep(50);
  await host.close();
  out.hostReconnect = { statusesAfterDrop: statuses.slice(statuses.lastIndexOf("connected")) };
}

// --- client byte transport --------------------------------------------------
{
  const webSockets = socketFactory();
  const onData = [];
  let onCloseCalls = 0;
  const onErrorMessages = [];
  const transportPromise = createRadiusClientTransportFactory({
    serverId,
    auth: new RadiusRelayAuthResolver({ type: "token", token: "secret" }),
    webSocketFactory: webSockets.factory,
  })({
    onData: (chunk) => onData.push([...chunk]),
    onClose: () => {
      onCloseCalls += 1;
    },
    onError: (error) => onErrorMessages.push(error.message),
  });
  await waitFor(() => webSockets.sockets.length === 1);
  const { socket, options } = webSockets.sockets[0];
  socket.open(options.protocol);
  const transport = await transportPromise;
  await transport.send(Uint8Array.from([1, 2, 3]));
  const sentBytes = bytes(socket.sent[0]);
  socket.message(Uint8Array.from([4, 5, 6]).buffer);
  socket.remoteClose();
  out.clientTransport = { authorization: options.authorization, sentBytes, onData, onCloseCalls, onErrorMessages };
}

// --- abnormal closure -------------------------------------------------------
{
  const webSockets = socketFactory();
  const onCloseCalls = [];
  const onErrorMessages = [];
  let abnormalThrew = null;
  const opening = createRadiusClientTransportFactory({
    serverId,
    auth: new RadiusRelayAuthResolver({ type: "token", token: "secret" }),
    webSocketFactory: webSockets.factory,
  })({ onData: () => {}, onClose: () => onCloseCalls.push(1), onError: (e) => onErrorMessages.push(e.message) });
  await waitFor(() => webSockets.sockets.length === 1);
  const { socket, options } = webSockets.sockets[0];
  socket.open(options.protocol);
  await opening;
  try {
    socket.abnormalClose(new Error("network lost"));
  } catch (error) {
    abnormalThrew = String(error);
  }
  out.abnormalClose = { abnormalThrew, onErrorMessages, onCloseCalls };
}

// --- undici-style empty error ----------------------------------------------
{
  const webSockets = socketFactory();
  const opening = createRadiusClientTransportFactory({
    serverId,
    auth: new RadiusRelayAuthResolver({ type: "token", token: "secret" }),
    webSocketFactory: webSockets.factory,
  })({ onData: () => {}, onClose: () => {}, onError: () => {} });
  let rejection = "";
  opening.catch((error) => {
    rejection = error.message;
  });
  await waitFor(() => webSockets.sockets.length === 1);
  webSockets.sockets[0].socket.fail(new Error(""));
  await sleep(30);
  const closeArgs = { readyState: webSockets.sockets[0].socket.readyState };
  out.emptyError = { rejection, closeArgs };
}

// --- unexpected subprotocol -------------------------------------------------
{
  const webSockets = socketFactory();
  const opening = createRadiusClientTransportFactory({
    serverId,
    auth: new RadiusRelayAuthResolver({ type: "token", token: "secret" }),
    webSocketFactory: webSockets.factory,
  })({ onData: () => {}, onClose: () => {}, onError: () => {} });
  let rejection = "";
  opening.catch((error) => {
    rejection = error.message;
  });
  await waitFor(() => webSockets.sockets.length === 1);
  webSockets.sockets[0].socket.open("pi-session-relay.other.v1");
  await sleep(30);
  out.protocolMismatch = { rejection };
}

// --- client reconnect state machine -----------------------------------------
{
  const connectionListeners = new Set();
  const attachmentListeners = new Set();
  let attempts = 0;
  const reattachCalls = [];
  const client = {
    connected: true,
    connectionState: "connected",
    attachment: { sessionId: "demo-1" },
    onConnectionStateChange(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    onAttachmentChange(listener) {
      attachmentListeners.add(listener);
      return () => attachmentListeners.delete(listener);
    },
    async reconnect() {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary failure");
      this.connected = true;
      this.connectionState = "connected";
      for (const listener of connectionListeners) listener({ state: "connected" });
      return { serverId };
    },
    disconnect() {
      this.connected = false;
      this.connectionState = "disconnected";
      for (const listener of connectionListeners) listener({ state: "disconnected" });
    },
  };
  const reconnect = new RadiusClientReconnect(client, async (sessionId) => {
    reattachCalls.push(sessionId);
  });
  client.disconnect();
  await sleep(1300);
  const attemptsAfterFirst = attempts;
  await sleep(2200);
  out.clientReconnect = { attemptsAfterFirst, attemptsFinal: attempts, reattachCalls };
  await reconnect.dispose();
}

// --- auth resolver decisions (verbatim upstream radius-auth.ts) -------------
import { ModelRuntime } from "./core/model-runtime.ts";

out.authResolver = await (async () => {
  const out2 = {};
  delete process.env.PI_OFFLINE;
  delete process.env.ORACLE_STORED_TOKEN;

  out2.defaultGateway = new RadiusRelayAuthResolver().gateway;
  out2.gatewayNormalization = ["radius.example", "https://x.dev/", "http://y.dev///", "https://z.dev"].map(
    (value) => new RadiusRelayAuthResolver(undefined, value).gateway,
  );

  const explicit = new RadiusRelayAuthResolver({ type: "token", token: "  secret  " });
  out2.explicitToken = await explicit.resolve({ required: false });

  let emptyError = "";
  try {
    await new RadiusRelayAuthResolver({ type: "token", token: "   " }).resolve({ required: true });
  } catch (error) {
    emptyError = error.message;
  }
  out2.emptyTokenError = emptyError;

  const env = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  let offlineRequired = "";
  let offlineOptional;
  try {
    await new RadiusRelayAuthResolver({ type: "token", token: "secret" }).resolve({ required: true });
  } catch (error) {
    offlineRequired = error.message;
  }
  offlineOptional = await new RadiusRelayAuthResolver().resolve({ required: false });
  if (env === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = env;
  out2.offline = { offlineRequired, offlineOptional };

  delete process.env.PI_OFFLINE;
  let missingRequired = "";
  try {
    await new RadiusRelayAuthResolver().resolve({ required: true });
  } catch (error) {
    missingRequired = error.message;
  }
  const missingOptional = await new RadiusRelayAuthResolver().resolve({ required: false });
  out2.missingCredential = { missingRequired, missingOptional };
  out2.missingOptionalRuns = ModelRuntime.createCount;

  process.env.ORACLE_STORED_TOKEN = "stored-token";
  const stored = await new RadiusRelayAuthResolver().resolve({ required: false });
  const storedAgain = await new RadiusRelayAuthResolver().resolve({ required: false });
  delete process.env.ORACLE_STORED_TOKEN;
  out2.storedCredential = stored;
  out2.storedCredentialAgain = storedAgain;
  out2.createCount = ModelRuntime.createCount;
  return out2;
})();

console.log(JSON.stringify(out, null, 2));
