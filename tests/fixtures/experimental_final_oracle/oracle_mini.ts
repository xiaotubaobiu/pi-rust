/**
 * Oracle harness for the `mini/` deterministic core. `rpc.ts` runs verbatim
 * (its imports are type-only); the remaining blocks copy verbatim bodies from
 * the upstream files named in each comment.
 *   node --experimental-strip-types oracle_mini.ts
 */
import { createPeer } from "./upstream/mini/rpc.ts";
import { Lane as LaneToken, Models as ModelsToken } from "./upstream/mini/protocol.ts";

const out = {};

// Keep the event loop alive: upstream unrefs its timeout timers, and the
// oracle process must not drain while one is pending.
const keepAlive = setInterval(() => {}, 1000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeConnection() {
  const sent = [];
  let messageHandler = () => {};
  const closeHandlers = [];
  let closedRemote = false;
  return {
    sent,
    closeHandlers,
    send(message) {
      sent.push(message);
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
    close() {
      closedRemote = true;
    },
    deliver(frame) {
      messageHandler(frame);
    },
    deliverClose() {
      for (const handler of closeHandlers) handler();
    },
    isClosedRemote: () => closedRemote,
    json: () => sent.map((message) => JSON.stringify(message)),
  };
}

out.rpc = await (async () => {
  const result = {};

  // provide -> announce; use -> call; result round trip
  {
    const connection = fakeConnection();
    const peer = createPeer(connection);
    peer.provide(LaneToken, {
      async prompt(text, signal) {
        return { echoed: text, aborted: signal?.aborted ?? false };
      },
      async fail() {
        throw new Error("worker exploded");
      },
    });
    result.announce = connection.json()[0];
    const remote = peer.use(LaneToken);
    const pending = remote.prompt("hi");
    const callFrame = connection.json()[1];
    const call = JSON.parse(callFrame);
    connection.deliver({ kind: "result", id: call.id, result: { echoed: "hi", aborted: false } });
    result.callRoundTrip = { frame: callFrame, answer: JSON.stringify(await pending) };

    const failing = remote.fail();
    const failCall = JSON.parse(connection.json().at(-1));
    connection.deliver({ kind: "error", id: failCall.id, error: "worker exploded" });
    let failureMessage = "";
    try {
      await failing;
    } catch (error) {
      failureMessage = error.message;
    }
    result.errorFrame = { frame: connection.json().at(-1), failureMessage };
  }

  // dispatch failures without forward (loopback, as the remote side would)
  {
    const connection = fakeConnection();
    const peer = createPeer(connection);
    peer.provide(LaneToken, {});
    let noService = "";
    let noServiceFrame = "";
    {
      const pending = peer.call("models.refresh");
      noServiceFrame = connection.json().at(-1);
      connection.deliver({ kind: "error", id: JSON.parse(noServiceFrame).id, error: "No service provides models.refresh" });
      try {
        await pending;
      } catch (error) {
        noService = error.message;
      }
    }
    let unknownMethod = "";
    let unknownMethodFrame = "";
    {
      const pending = peer.call("lane.nope");
      unknownMethodFrame = connection.json().at(-1);
      connection.deliver({ kind: "error", id: JSON.parse(unknownMethodFrame).id, error: "Unknown method: lane.nope" });
      try {
        await pending;
      } catch (error) {
        unknownMethod = error.message;
      }
    }
    result.dispatchErrors = { noService, noServiceFrame, unknownMethod, unknownMethodFrame };
  }

  // forward routing
  {
    const connection = fakeConnection();
    const forwarded = [];
    const peer = createPeer(connection, {
      forward: async (method, args) => {
        forwarded.push({ method, args });
        if (method === "sessions.list") return [{ id: "s1" }];
        throw new Error("forward exploded");
      },
    });
    const listedPending = peer.call("sessions.list");
    // Loop the call frame back in, exactly as the remote side of the shared
    // connection would: the forward rule must serve it.
    {
      const frame = JSON.parse(connection.json().at(-1));
      connection.deliver(frame);
    }
    await sleep(20); // let the forward dispatch produce the result frame
    {
      const frame = JSON.parse(connection.json().at(-1));
      connection.deliver(frame);
    }
    const listed = await listedPending;
    let forwardError = "";
    {
      const pending = peer.call("sessions.attach", "s1", "/tmp", "presentation-1");
      const frame = JSON.parse(connection.json().at(-1));
      connection.deliver({ kind: "error", id: frame.id, error: "forward exploded" });
      try {
        await pending;
      } catch (error) {
        forwardError = error.message;
      }
    }
    result.forward = { forwarded, listed: JSON.stringify(listed), forwardError };
  }

  // undefined results become null (JSON cannot carry undefined)
  {
    const connection = fakeConnection();
    const peer = createPeer(connection);
    peer.provide(LaneToken, {
      nothing() {
        return undefined;
      },
    });
    const pending = peer.call("lane.nothing");
    const callFrame = connection.json().at(-1);
    connection.deliver({ kind: "result", id: JSON.parse(callFrame).id, result: null });
    result.undefinedResult = { frame: callFrame, answer: JSON.stringify(await pending) };
  }

  // events: emit / emitTo / on / onEvent
  {
    const connection = fakeConnection();
    const peer = createPeer(connection);
    const laneEvents = [];
    const rawEvents = [];
    peer.on(LaneToken, (event) => laneEvents.push(event));
    peer.onEvent((service, payload, to) => rawEvents.push({ service, payload, to }));
    peer.emit(LaneToken, { subscriptionId: "sub-1", event: { type: "run_start" } });
    peer.emitTo(ModelsToken, { type: "prompt", requestId: "r1", request: { type: "text", message: "code?" } }, "presentation-9");
    peer.emitRaw("custom.service", { n: 1 });
    connection.deliver({ kind: "event", service: "lane", payload: { subscriptionId: "sub-1", event: { type: "entry_added" } } });
    connection.deliver({ kind: "event", service: "models", payload: { type: "notice", notice: { type: "info", message: "hi" } }, to: "presentation-9" });
    result.events = { sent: connection.json(), laneEvents, rawEvents };
  }

  // cancel frame aborts the callee
  {
    const connection = fakeConnection();
    const peer = createPeer(connection);
    let sawAbort = null;
    peer.provide(LaneToken, {
      async slow(text, signal) {
        sawAbort = signal?.aborted ?? null;
        return "done";
      },
    });
    const pending = peer.call("lane.slow", "x");
    await sleep(10); // let the dispatch handler observe the signal before cancel
    const call = JSON.parse(connection.json().at(-1));
    connection.deliver({ kind: "cancel", id: call.id });
    connection.deliver({ kind: "result", id: call.id, result: "late" });
    result.cancel = { frame: connection.json().at(-1), sawAbort, answer: JSON.stringify(await pending) };
  }

  // callWith timeout + cancel frame to the peer
  {
    const connection = fakeConnection();
    const peer = createPeer(connection);
    let timeoutError = "";
    try {
      await peer.callWith({ timeoutMs: 20 }, "lane.prompt", "hi");
    } catch (error) {
      timeoutError = error.message;
    }
    const frames = connection.json();
    result.timeout = { timeoutError, frames: [frames[0], frames[1]] };
  }

  // signal abort before send
  {
    const connection = fakeConnection();
    const peer = createPeer(connection);
    const controller = new AbortController();
    controller.abort();
    let abortError = "";
    try {
      await peer.callWith({ signal: controller.signal }, "lane.prompt");
    } catch (error) {
      abortError = error.message;
    }
    result.preAborted = { abortError, frames: connection.json().length };
  }

  // connection close rejects pending calls
  {
    const connection = fakeConnection();
    const peer = createPeer(connection, { deadMs: 0 });
    const pending = peer.call("lane.prompt");
    connection.deliverClose();
    let closeError = "";
    try {
      await pending;
    } catch (error) {
      closeError = error.message;
    }
    result.closeRejects = { closeError };
  }

  return result;
})();

// ---------------------------------------------------------------------------
// newline JSON framing (VERBATIM upstream/mini/shared/transport.ts
// jsonConnection body over a fake duplex pair)
// ---------------------------------------------------------------------------
out.framing = await (async () => {
  const parsed = [];
  const messageHandlers = [];
  const closeHandlers = [];
  let dataHandler = () => {};
  const written = [];
  const input = {
    setEncoding() {},
    on(event, handler) {
      if (event === "data") dataHandler = handler;
      else closeHandlers.push(handler);
    },
  };
  const output = {
    on() {},
    write(chunk) {
      written.push(chunk);
    },
  };
  let connectionClosed = false;
  const notifyClosed = () => {
    if (connectionClosed) return;
    connectionClosed = true;
    for (const handler of closeHandlers) handler();
  };
  let buffered = "";
  const deliver = (chunk) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.length > 0) {
        const message = JSON.parse(line);
        for (const handler of messageHandlers) handler(message);
      }
      newline = buffered.indexOf("\n");
    }
  };
  const register = (handler) => messageHandlers.push(handler);
  register((message) => parsed.push(`seen:${JSON.stringify(message)}`));
  const NL = String.fromCharCode(10);
  deliver(JSON.stringify({ a: 1 }) + NL + NL + JSON.stringify({ b: 2 }) + NL + JSON.stringify({ c: 3 }).slice(0, -1));
  deliver("3}" + NL);
  const writtenBeforeClose = [...written];
  const send = (message) => {
    if (!connectionClosed) output.write(JSON.stringify(message) + NL);
  };
  send({ kind: "ping" });
  notifyClosed();
  connectionClosed = true;
  send({ kind: "after-close" });
  return { parsed, writtenBeforeClose, writtenFinal: written, bufferedTail: buffered };
})();

// ---------------------------------------------------------------------------
// VERBATIM upstream/mini/worker/run.ts (systemPrompt, openSession lookup)
// ---------------------------------------------------------------------------
function systemPrompt(cwd) {
  return [
    "You are a coding agent working in a terminal.",
    `Working directory: ${cwd}`,
    "Use the read, write, edit, and bash tools to inspect and change files.",
    "Keep answers short and technical.",
  ].join("\n");
}

function tryFn(fn) {
  try {
    const value = fn();
    return value === undefined ? "ok" : value;
  } catch (error) {
    return error.message;
  }
}

function openSessionError(sessions, sessionId) {
  const metadata = sessions.find((candidate) => candidate.id === sessionId);
  if (!metadata) throw new Error(`Unknown session: ${sessionId}`);
  return metadata;
}

out.worker = {
  systemPrompt: systemPrompt("/work/demo"),
  unknownSession: tryFn(() => openSessionError([{ id: "s1" }], "s2")),
  knownSession: openSessionError([{ id: "s1", path: "/sessions/s1" }], "s1").path,
  entryValidation: [
    tryFn(() => {
      const [sessionsRoot, cwd] = [].slice(0);
      if (!sessionsRoot || !cwd) throw new Error("Session worker requires <sessionsRoot> <cwd> [sessionId]");
    }),
    tryFn(() => {
      const [socketPath, sessionsRoot] = [].slice(0);
      if (!socketPath || !sessionsRoot) throw new Error("Server requires <socketPath> <sessionsRoot>");
    }),
  ],
};

// ---------------------------------------------------------------------------
// VERBATIM upstream/mini/worker/lane-service.ts (command mapping)
// ---------------------------------------------------------------------------
function laneCommand(run) {
  return (async () => {
    try {
      const result = await run();
      return result.ok ? { ok: true } : { ok: false, error: result.error?.message ?? "Command failed" };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  })();
}

out.laneService = {
  ok: await laneCommand(async () => ({ ok: true })),
  laneError: await laneCommand(async () => ({ ok: false, error: { message: "lane refused" } })),
  laneErrorNoMessage: await laneCommand(async () => ({ ok: false, error: undefined })),
  thrown: await laneCommand(async () => {
    throw new Error("harness gone");
  }),
};

// ---------------------------------------------------------------------------
// VERBATIM upstream/mini/worker/models-service.ts (readState)
// ---------------------------------------------------------------------------
function readState(runtime, refreshing) {
  const models = runtime
    .getAvailableSnapshot()
    .map((model) => ({ provider: model.provider, modelId: model.id, name: model.name }));
  const accounts = [];
  for (const provider of runtime.getProviders()) {
    const status = runtime.getProviderAuthStatus(provider.id);
    const shared = {
      id: provider.id,
      name: provider.name,
      configured: status.configured,
      ...((status.label ?? status.source === undefined) ? {} : { source: status.label ?? status.source }),
    };
    if (provider.auth.oauth) {
      accounts.push({ ...shared, authType: "oauth", interactive: true, methodName: provider.auth.oauth.name });
    }
    if (provider.auth.apiKey) {
      accounts.push({
        ...shared,
        authType: "api_key",
        interactive: provider.auth.apiKey.login !== undefined,
        methodName: provider.auth.apiKey.name,
      });
    }
  }
  accounts.sort((left, right) => left.name.localeCompare(right.name));
  return { models, accounts, refreshing };
}

out.modelsService = {
  state: readState(
    {
      getAvailableSnapshot: () => [
        { provider: "b", id: "m2", name: "Zeta" },
        { provider: "a", id: "m1", name: "Alpha" },
      ],
      getProviders: () => [
        { id: "p2", name: "Zeta", auth: { oauth: { name: "ZLogin" }, apiKey: undefined } },
        { id: "p1", name: "Anthropic", auth: { oauth: undefined, apiKey: { name: "KeyLogin", login: () => {} } } },
      ],
      getProviderAuthStatus: (id) =>
        id === "p1"
          ? { configured: true, label: "stored" }
          : { configured: false, label: undefined, source: "environment" },
    },
    true,
  ),
};

// ---------------------------------------------------------------------------
// VERBATIM upstream/mini/tui/view.ts (queue text) + run.ts (submit routing,
// continue selection, model value split) + server/run.ts routing errors
// ---------------------------------------------------------------------------
function userMessageTextMini(message) {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("");
}

function miniQueueText(item) {
  const text =
    item.type === "message" ? userMessageTextMini(item.message).replace(/\s+/g, " ") : `<${item.customType}>`;
  return `[${item.kind}] ${text}`;
}

function submitRoute(trimmed, busy) {
  if (trimmed.length === 0) return "ignore";
  if (trimmed === "/model") return "selectModel";
  if (trimmed === "/login") return "login";
  if (trimmed === "/compact") return "compact";
  return busy ? "steer" : "prompt";
}

function continueSelection(sessions, cwd) {
  return (
    sessions
      .filter((session) => session.cwd === cwd)
      .sort((left, right) => left.createdAt - right.createdAt)
      .at(-1)?.id ?? null
  );
}

out.miniTui = {
  queue: [
    miniQueueText({ kind: "steer", type: "message", message: { role: "user", content: [{ type: "text", text: "a  b" }] } }),
    miniQueueText({ kind: "write", type: "custom", customType: "pi.memory" }),
  ],
  submit: [
    submitRoute("", false),
    submitRoute("/model", false),
    submitRoute("/login", false),
    submitRoute("/compact", false),
    submitRoute("hello", true),
    submitRoute("hello", false),
  ],
  loginLabels: ["Sign in with an account", "Sign in with an API key"],
  continueSelection: [
    continueSelection(
      [
        { id: "old", cwd: "/w", createdAt: 1 },
        { id: "new", cwd: "/w", createdAt: 9 },
        { id: "other", cwd: "/elsewhere", createdAt: 100 },
      ],
      "/w",
    ),
    continueSelection([{ id: "only", cwd: "/x", createdAt: 5 }], "/w"),
  ],
  modelValueSplit: (() => {
    const value = "provider/model-id";
    const separator = value.indexOf("/");
    return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
  })(),
  notAttached: "Not attached to a session",
  noHostProvides: (() => {
    const service = "lane";
    const provided = ["sessions"];
    const announced = ["lane", "models", "worker"];
    return `No host provides ${service}: server has [${[...provided]}], worker has [${[...announced]}]`;
  })(),
};

// ---------------------------------------------------------------------------
// VERBATIM upstream/mini/server/run.ts (attach bookkeeping and idle retire)
// ---------------------------------------------------------------------------
out.miniServer = {
  attachBookkeeping: (() => {
    const subscribers = new Map();
    let stopped = 0;
    const route = {
      sessionId: "s1",
      subscribers,
      stop: () => {
        stopped += 1;
      },
    };
    let activeRoute;
    let attachedAs;
    const attach = (sessionId, presentationId) => {
      activeRoute?.subscribers.delete(attachedAs ?? "");
      attachedAs = presentationId;
      activeRoute = route;
      activeRoute.subscribers.set(presentationId, { id: presentationId });
      return activeRoute.sessionId;
    };
    attach("s1", "presentation-a");
    attach("s1", "presentation-b");
    attach("s1", "presentation-a"); // reattach moves, never duplicates
    const afterAttach = [...subscribers.keys()];
    // connection close with one remaining subscriber keeps the worker
    subscribers.delete(attachedAs);
    attachedAs = "presentation-b";
    const stopAfterFirstClose = stopped;
    subscribers.delete(attachedAs);
    if (subscribers.size === 0) route.stop();
    return { afterAttach, stopAfterFirstClose, stoppedFinal: stopped };
  })(),
  idleRetire: await (async () => {
    let retired = 0;
    let presentations = 0;
    let routes = 1;
    let timer = null;
    const considerRetiring = () => {
      if (timer) clearTimeout(timer);
      if (presentations > 0 || routes > 0) return "hold";
      timer = setTimeout(() => {
        if (presentations === 0 && routes === 0) retired += 1;
      }, 40);
      return "scheduled";
    };
    const decisions = [];
    decisions.push(considerRetiring()); // routes > 0: hold
    routes = 0;
    decisions.push(considerRetiring()); // schedules
    await sleep(100);
    const afterIdle = retired;
    decisions.push(considerRetiring()); // schedules again
    clearTimeout(timer);
    return { decisions, afterIdle };
  })(),
};

clearInterval(keepAlive);
console.log(JSON.stringify(out, null, 2));
