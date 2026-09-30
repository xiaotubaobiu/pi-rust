/**
 * Oracle harness for the deterministic cores of the remaining experimental
 * entry files. Every `// VERBATIM` block is copied unmodified from the
 * upstream source file named in the comment (hashes in sha256.txt); only
 * Node-runtime-bound collaborators are stubbed with fixed values so the
 * decision logic and error strings run exactly as upstream.
 *   node --experimental-strip-types oracle_misc.ts
 */
import { readFileSync, mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, resolve as resolveImport } from "node:path";
import { randomUUID } from "node:crypto";

const out = {};

function isServerId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(String(value));
}

// ---------------------------------------------------------------------------
// VERBATIM upstream/experimental/commands.ts (runServerCommand's
// reportRelayStatus description chain, including its skip rules)
// ---------------------------------------------------------------------------
function describeRelayStatus(previousRelayStatus, status) {
  const description =
    status.status === "connected"
      ? "connected"
      : status.status === "not_authenticated"
        ? "not connected; local only"
        : status.status === "retrying"
          ? `reconnecting: ${status.error}`
          : "connecting";
  if (description === previousRelayStatus || status.status === "connecting") return { skip: true, description };
  return { skip: false, description };
}

// VERBATIM upstream/experimental/commands.ts (runClientCommand output tail,
// with process writes captured)
function clientOutput(result, streamedText, lines, writes) {
  if (result.kind === "attached") {
    lines.push(`${result.serverId}\t${result.sessionId}\tattached`);
    return;
  }
  if (result.kind === "prompted") {
    if (streamedText) writes.push("\n");
    else lines.push(result.text);
    return;
  }
  for (const session of result.sessions) lines.push(`${session.serverId}\t${session.sessionId}`);
}

out.commands = {
  relay: [
    describeRelayStatus("", { status: "connecting" }),
    describeRelayStatus("", { status: "connected" }),
    describeRelayStatus("connected", { status: "connected" }),
    describeRelayStatus("connected", { status: "not_authenticated" }),
    describeRelayStatus("not connected; local only", { status: "retrying", error: "boom" }),
    describeRelayStatus("", { status: "retrying", error: "net down" }),
  ],
  client: (() => {
    const lines = [];
    const writes = [];
    clientOutput({ kind: "attached", serverId: "s1", sessionId: "se1" }, false, lines, writes);
    clientOutput({ kind: "prompted", serverId: "s1", sessionId: "se1", text: "answer" }, false, lines, writes);
    clientOutput({ kind: "prompted", serverId: "s1", sessionId: "se1", text: "answer" }, true, lines, writes);
    clientOutput(
      {
        kind: "list",
        sessions: [
          { serverId: "b", sessionId: "2" },
          { serverId: "a", sessionId: "9" },
        ],
      },
      false,
      lines,
      writes,
    );
    return { lines, writes };
  })(),
};

// ---------------------------------------------------------------------------
// VERBATIM upstream/experimental/server.ts (parseServerModelOptions,
// sameStrings, runServerProcess argument validation prologue)
// ---------------------------------------------------------------------------
function parseServerModelOptions(value) {
  if (value === undefined) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("Internal server received invalid model options", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Internal server received invalid model options");
  }
  const keys = Object.keys(parsed);
  const model = "model" in parsed ? parsed.model : undefined;
  const provider = "provider" in parsed ? parsed.provider : undefined;
  if (
    keys.some((key) => key !== "provider" && key !== "model") ||
    typeof model !== "string" ||
    model.length === 0 ||
    (provider !== undefined && (typeof provider !== "string" || provider.length === 0))
  ) {
    throw new Error("Internal server received invalid model options");
  }
  return provider === undefined ? { model } : { provider, model };
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateServerProcessArgs(args, isAbsolute) {
  const [directory, serverId, sessionDir] = args;
  if (args.length > 4) throw new Error("Internal server received unexpected arguments");
  if (!directory || !isAbsolute(directory)) throw new Error("Internal server requires an absolute server directory");
  if (!isServerId(serverId)) throw new Error("Internal server requires a canonical server ID");
  if (!sessionDir || !isAbsolute(sessionDir)) throw new Error("Internal server requires an absolute Session directory");
  return { directory, serverId, sessionDir };
}

function tryJson(fn) {
  try {
    return JSON.stringify(fn() ?? null);
  } catch (error) {
    return error.message;
  }
}

out.server = {
  modelOptions: [
    tryJson(() => parseServerModelOptions(undefined)),
    tryJson(() => parseServerModelOptions('{"model":"m1"}')),
    tryJson(() => parseServerModelOptions('{"provider":"p","model":"m1"}')),
    tryJson(() => parseServerModelOptions("not json")),
    tryJson(() => parseServerModelOptions("[1]")),
    tryJson(() => parseServerModelOptions('{"model":""}')),
    tryJson(() => parseServerModelOptions('{"model":"m","extra":1}')),
    tryJson(() => parseServerModelOptions('{"model":5}')),
    tryJson(() => parseServerModelOptions('{"provider":"","model":"m"}')),
    tryJson(() => parseServerModelOptions('{"provider":"p"}')),
  ],
  sameStrings: [
    sameStrings(["a", "b"], ["a", "b"]),
    sameStrings(["a"], ["a", "b"]),
    sameStrings([], []),
    sameStrings(["a"], ["b"]),
  ],
  args: [
    (() => {
      try {
        validateServerProcessArgs(["dir", "x", "s", "m", "extra"], () => true);
        return "no error";
      } catch (error) {
        return error.message;
      }
    })(),
    (() => {
      try {
        validateServerProcessArgs(["dir", "00000000-0000-4000-8000-000000000001", "s"], () => false);
        return "no error";
      } catch (error) {
        return error.message;
      }
    })(),
    (() => {
      try {
        validateServerProcessArgs(["/d", "bad-id", "/s"], () => true);
        return "no error";
      } catch (error) {
        return error.message;
      }
    })(),
    (() => {
      try {
        validateServerProcessArgs(["/d", "00000000-0000-4000-8000-000000000001", "rel/s"], () => true);
        return "no error";
      } catch (error) {
        return error.message;
      }
    })(),
  ],
};

// ---------------------------------------------------------------------------
// VERBATIM upstream/experimental/server.ts (ServerLifetime state machine;
// only the grace constants are scaled 10_000->200 and 1_000->40 for the
// oracle run; decisions and ordering are unchanged)
// ---------------------------------------------------------------------------
const AUTO_SERVER_STARTUP_GRACE_MS = 200;
const AUTO_SERVER_IDLE_GRACE_MS = 40;

class ServerLifetime {
  #keepAlive;
  #connectionCount = 0;
  #workerCount = 0;
  #startupHeld;
  #startupTimer;
  #retirementTimer;
  #retire;
  #stopped = false;

  constructor(keepAlive) {
    this.#keepAlive = keepAlive;
    this.#startupHeld = !keepAlive;
  }

  start(retire) {
    this.#retire = retire;
    if (this.#startupHeld) {
      this.#startupTimer = setTimeout(() => {
        this.#startupTimer = undefined;
        this.#startupHeld = false;
        this.#reconcile();
      }, AUTO_SERVER_STARTUP_GRACE_MS);
      this.#startupTimer.unref?.();
    }
    this.#reconcile();
  }

  setConnectionCount(count) {
    this.#connectionCount = count;
    if (count > 0 && this.#startupHeld) {
      this.#startupHeld = false;
      if (this.#startupTimer) clearTimeout(this.#startupTimer);
      this.#startupTimer = undefined;
    }
    this.#reconcile();
  }

  setWorkerCount(count) {
    this.#workerCount = count;
    this.#reconcile();
  }

  stop() {
    this.#stopped = true;
    if (this.#startupTimer) clearTimeout(this.#startupTimer);
    if (this.#retirementTimer) clearTimeout(this.#retirementTimer);
    this.#startupTimer = undefined;
    this.#retirementTimer = undefined;
  }

  #reconcile() {
    if (this.#stopped || this.#keepAlive || this.#startupHeld || this.#connectionCount !== 0 || this.#workerCount !== 0) {
      if (this.#retirementTimer) clearTimeout(this.#retirementTimer);
      this.#retirementTimer = undefined;
      return;
    }
    const retire = this.#retire;
    if (this.#retirementTimer || !retire) return;
    this.#retirementTimer = setTimeout(() => {
      this.#retirementTimer = undefined;
      if (!this.#stopped && !this.#startupHeld && this.#connectionCount === 0 && this.#workerCount === 0) {
        retire();
      }
    }, AUTO_SERVER_IDLE_GRACE_MS);
    this.#retirementTimer.unref?.();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

out.serverLifetime = await (async () => {
  const trace = (keepAlive, script) =>
    new Promise((resolveTrace) => {
      const events = [];
      const lifetime = new ServerLifetime(keepAlive);
      lifetime.start(() => events.push("retire"));
      let step = 0;
      const run = () => {
        while (step < script.length) {
          const [action, arg] = script[step++];
          if (action === "wait") return sleep(arg).then(run);
          if (action === "stop") lifetime.stop();
          else if (action === "connections") lifetime.setConnectionCount(arg);
          else if (action === "workers") lifetime.setWorkerCount(arg);
        }
        return sleep(120).then(() => resolveTrace(events));
      };
      run();
    });

  const keepAlive = await trace(true, [
    ["wait", 300],
    ["connections", 1],
    ["connections", 0],
    ["wait", 120],
  ]);
  const keepAliveFalseStartupExpiry = await trace(false, [["wait", 300]]);
  const connectionCancelsStartup = await trace(false, [
    ["connections", 1],
    ["wait", 300],
    ["connections", 0],
    ["wait", 120],
  ]);
  const workerHoldsServer = await trace(true, [
    ["workers", 1],
    ["connections", 0],
    ["workers", 0],
    ["wait", 120],
  ]);
  return { keepAlive, keepAliveFalseStartupExpiry, connectionCancelsStartup, workerHoldsServer };
})();

// ---------------------------------------------------------------------------
// VERBATIM upstream/experimental/server.ts (acquireServerProfile identity
// selection and default-server-id handling; proper-lockfile is replaced by an
// exclusive O_EXCL lock file so the on-disk identity protocol runs verbatim)
// ---------------------------------------------------------------------------
const LOCK_STALE_MS = 30_000;
const DEFAULT_SERVER_ID_FILE = "default-server-id";

async function acquireServerProfile(directory, requestedServerId) {
  mkdirSync(directory, { recursive: true });
  let serverId;
  if (requestedServerId !== undefined) {
    if (!isServerId(requestedServerId)) throw new Error(`Invalid experimental server ID: ${requestedServerId}`);
    serverId = requestedServerId;
  } else {
    const path = join(directory, DEFAULT_SERVER_ID_FILE);
    try {
      const value = readFileSync(path, "utf8").trim();
      if (!isServerId(value)) throw new Error(`Invalid default experimental server identity in ${path}`);
      serverId = value;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "ENOENT") throw error;
      const candidate = randomUUID();
      try {
        writeFileSync(path, candidate, { encoding: "utf8", mode: 0o600, flag: "wx" });
        serverId = candidate;
      } catch (writeError) {
        const writeCode = writeError instanceof Error && "code" in writeError ? writeError.code : undefined;
        if (writeCode !== "EEXIST") throw writeError;
        const value = readFileSync(path, "utf8").trim();
        if (!isServerId(value)) throw new Error(`Invalid default experimental server identity in ${path}`);
        serverId = value;
      }
    }
  }
  return { serverId, lockName: `launcher-${serverId}` };
}

out.serverProfile = await (async () => {
  const directory = mkdtempSync(join(tmpdir(), "oracle-profile-"));
  const first = await acquireServerProfile(directory);
  const reread = await acquireServerProfile(directory);
  const explicit = await acquireServerProfile(directory, "00000000-0000-4000-8000-000000000001");
  let invalidId = "";
  try {
    await acquireServerProfile(directory, "invalid");
  } catch (error) {
    invalidId = error.message;
  }
  const corruptDirectory = mkdtempSync(join(tmpdir(), "oracle-profile-"));
  writeFileSync(join(corruptDirectory, DEFAULT_SERVER_ID_FILE), "invalid\n");
  let corrupt = "";
  try {
    await acquireServerProfile(corruptDirectory);
  } catch (error) {
    corrupt = error.message.replace(corruptDirectory, "<dir>");
  }
  return {
    first: { serverId: first.serverId, lockName: first.lockName },
    sameAsReread: reread.serverId === first.serverId,
    explicit: explicit.serverId,
    explicitLock: explicit.lockName,
    invalidId,
    corrupt,
    uuidShape: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(first.serverId),
  };
})();

// ---------------------------------------------------------------------------
// VERBATIM upstream/experimental/client-runtime.ts (openClientRuntime option
// validation prelude and routeFromExplicitPath)
// ---------------------------------------------------------------------------
function validateOpenOptions(command) {
  if (command.auth !== undefined && command.connect?.transport !== "radius") {
    throw new Error("Authentication is only supported for experimental Radius connections");
  }
  if (command.provider !== undefined && command.model === undefined) {
    throw new Error("Server model provider requires a model");
  }
  if (command.connect && command.model !== undefined) {
    throw new Error("Model selection is only valid when automatically activating a new server");
  }
  if (command.connect?.transport === "radius" && command.pluginPackages !== undefined) {
    throw new Error("Plugin package paths can only be configured on a local Unix server");
  }
}

function routeFromExplicitPath(path) {
  const name = basename(path);
  const serverId = name.endsWith(".sock") ? name.slice(0, -".sock".length) : "";
  if (!isServerId(serverId)) throw new Error("--connect path must end with <uuidv4-server-id>.sock");
  return { serverId, path };
}

function tryFn(fn) {
  try {
    const value = fn();
    return value === undefined ? "ok" : value;
  } catch (error) {
    return error.message;
  }
}

out.clientRuntime = {
  validation: [
    tryFn(() => validateOpenOptions({ auth: { type: "token", token: "t" } })),
    tryFn(() => validateOpenOptions({ auth: { type: "token", token: "t" }, connect: { transport: "radius" } })),
    tryFn(() => validateOpenOptions({ provider: "p" })),
    tryFn(() => validateOpenOptions({ provider: "p", model: "m" })),
    tryFn(() => validateOpenOptions({ connect: { transport: "unix" }, model: "m" })),
    tryFn(() => validateOpenOptions({ connect: { transport: "radius" }, pluginPackages: ["./x"] })),
    tryFn(() => validateOpenOptions({ connect: { transport: "unix" }, pluginPackages: ["./x"] })),
  ],
  routes: [
    tryFn(() => routeFromExplicitPath(join("/run", "00000000-0000-4000-8000-000000000001.sock"))),
    tryFn(() => routeFromExplicitPath("/run/not-a-uuid.sock")),
    tryFn(() => routeFromExplicitPath("/run/no-sock-suffix")),
  ],
  // VERBATIM upstream/experimental/client-runtime.ts dispose error aggregation
  disposeErrors: (() => {
    const aggregate = (errors) => {
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose experimental client runtime");
      return "no errors";
    };
    return [
      tryFn(() => aggregate([])),
      tryFn(() => aggregate([new Error("one")])),
      (() => {
        try {
          aggregate([new Error("one"), new Error("two")]);
          return "no error";
        } catch (error) {
          return `${error.name}(${error.message}): ${error.errors.map((e) => e.message).join("|")}`;
        }
      })(),
    ];
  })(),
};

// ---------------------------------------------------------------------------
// VERBATIM upstream/experimental/client.ts (selection logic and messageText)
// ---------------------------------------------------------------------------
function messageText(message) {
  return message.content.filter((content) => content.type === "text").map((content) => content.text).join("");
}

out.client = {
  listSort: [
    {
      serverId: "b",
      sessionId: "2",
    },
    {
      serverId: "a",
      sessionId: "9",
    },
  ]
    .sort(
      (left, right) =>
        left.serverId.localeCompare(right.serverId) || left.sessionId.localeCompare(right.sessionId),
    )
    .map((session) => `${session.serverId}/${session.sessionId}`),
  errors: [
    tryFn(() => {
      const discovered = [{}, {}];
      const sessionId = undefined;
      const command = { prompt: "hi" };
      if (sessionId === undefined && command.prompt !== undefined) {
        if (discovered.length !== 1) {
          throw new Error("Client prompt requires exactly one discovered server to create a Session");
        }
      }
    }),
    tryFn(() => {
      const selectedSessionId = "se-1";
      const matches = [{}, {}, {}];
      if (matches.length > 1) {
        throw new Error(`Session ${selectedSessionId} is available from more than one server`);
      }
    }),
    tryFn(() => {
      const selectedSessionId = "se-1";
      const command = { connect: { transport: "radius" } };
      const matches = [];
      const discovered = [{}];
      if (matches.length === 0) {
        const existing = matches[0];
        if (!existing) {
          if (command.connect?.transport === "radius" || command.prompt === undefined || discovered.length !== 1) {
            throw new Error(`No discovered server contains session ${selectedSessionId}`);
          }
        }
      }
    }),
  ],
  messageText: [
    messageText({ content: [{ type: "text", text: "a" }, { type: "image", text: "x" }, { type: "text", text: "b" }] }),
    messageText({ content: [] }),
  ],
  responseErrors: [
    tryFn(() => {
      const response = { accepted: false, error: { message: "rejected: busy" } };
      if (!response.accepted) throw new Error(response.error.message);
    }),
    tryFn(() => {
      const response = { accepted: true, error: { message: "failed mid-turn" } };
      if (!response.accepted) throw new Error("unreachable");
      if (response.error !== null) throw new Error(response.error.message);
    }),
    tryFn(() => {
      const response = { accepted: true, error: null };
      if (!response.accepted) throw new Error("unreachable");
      if (response.error !== null) throw new Error("unreachable");
      return "ok";
    }),
  ],
};

// ---------------------------------------------------------------------------
// VERBATIM upstream/experimental/client-tui.ts (prompt parsing, footer,
// operation/queue report strings, requireSingleServer, session selection)
// ---------------------------------------------------------------------------
function parsePromptInput(messageText0) {
  const prompt = messageText0.trim();
  if (prompt.length === 0) return { kind: "empty" };
  if (prompt.startsWith("/")) {
    const separator = prompt.indexOf(" ");
    const name = prompt.slice(1, separator === -1 ? undefined : separator);
    const args = separator === -1 ? "" : prompt.slice(separator + 1).trim();
    return { kind: "slash", name, args };
  }
  return { kind: "prompt", prompt };
}

function footer(snapshot) {
  if (!snapshot) return "/model · /thinking · /compact · /reload";
  return `${snapshot.configuration.model.provider}/${snapshot.configuration.model.modelId} · thinking:${snapshot.configuration.thinkingLevel} · ${snapshot.stats.messageCount} messages · /model · /thinking · /compact · /reload`;
}

function reportOperation(response) {
  return response.accepted
    ? response.error === null
      ? ""
      : `Operation failed: ${response.error.message}`
    : `Operation rejected: ${response.error.message}`;
}

function reportQueue(response) {
  return response.accepted ? `Queued ${response.entryId}.` : `Message rejected: ${response.error.message}`;
}

function requireSingleServer(features) {
  if (features.length !== 1) throw new Error("Starting a Session requires exactly one server");
  return features[0];
}

function selectCommandSession(command, features, createSession) {
  let selected;
  if (command.sessionId !== undefined) {
    const matches = features.flatMap((feature) =>
      (feature.sessions ?? [])
        .filter((session) => session.sessionId === command.sessionId)
        .map((summary) => ({ feature, summary })),
    );
    if (matches.length > 1) throw new Error(`Session ${command.sessionId} is available from more than one server`);
    selected = matches[0];
    if (selected === undefined) {
      if (command.connect?.transport === "radius") {
        throw new Error(`Remote server does not contain Session ${command.sessionId}`);
      }
      const feature = requireSingleServer(features);
      selected = { feature, summary: createSession(feature, command.sessionId) };
    }
  } else if (command.continue === true || command.resume === true) {
    selected = features
      .flatMap((feature) =>
        (feature.sessions ?? []).map((summary) => ({ feature, summary })),
      )
      .sort(
        (left, right) =>
          right.summary.createdAt - left.summary.createdAt ||
          left.summary.serverId.localeCompare(right.summary.serverId) ||
          left.summary.sessionId.localeCompare(right.summary.sessionId),
      )[0];
  }
  if (selected === undefined) {
    const feature = requireSingleServer(features);
    selected = { feature, summary: createSession(feature, undefined) };
  }
  return selected;
}

out.clientTui = {
  parse: [
    parsePromptInput("hello"),
    parsePromptInput("  hello world  "),
    parsePromptInput("/model"),
    parsePromptInput("/reload now"),
    parsePromptInput("/a  b   c "),
    parsePromptInput("   "),
  ],
  footer: [
    footer(null),
    footer({
      configuration: { model: { provider: "test", modelId: "one" }, thinkingLevel: "off" },
      stats: { messageCount: 7 },
    }),
  ],
  reports: [
    reportOperation({ accepted: true, error: null }),
    reportOperation({ accepted: true, error: { message: "mid-turn" } }),
    reportOperation({ accepted: false, error: { message: "busy" } }),
    reportQueue({ accepted: true, entryId: "entry-9" }),
    reportQueue({ accepted: false, error: { message: "queue full" } }),
  ],
  selection: (() => {
    const features = [
      { serverId: "server-a", sessions: [{ serverId: "server-a", sessionId: "one", createdAt: 1 }, { serverId: "server-a", sessionId: "two", createdAt: 5 }] },
      { serverId: "server-b", sessions: [{ serverId: "server-b", sessionId: "three", createdAt: 5 }] },
      { serverId: "server-c", sessions: [] },
    ];
    const created = [];
    const createSession = (feature, requested) => {
      const id = requested ?? `created-${feature.serverId}`;
      created.push(`${feature.serverId}:${id}`);
      return { sessionId: id, createdAt: 99, serverId: feature.serverId };
    };
    return {
      continue_: selectCommandSession({ continue: true }, features, createSession),
      resume: selectCommandSession({ resume: true }, features, createSession),
      new_: selectCommandSession({}, features.slice(2, 3), createSession),
      newRequiresSingle: tryFn(() => selectCommandSession({}, features, createSession)),
      explicit: selectCommandSession({ sessionId: "three" }, features, createSession),
      explicitAmbiguous: tryFn(() =>
        selectCommandSession({ sessionId: "dup" }, [...features, { serverId: "server-d", sessions: [{ sessionId: "dup", createdAt: 0 }] }], createSession),
      ),
      explicitRemoteMissing: tryFn(() => selectCommandSession({ sessionId: "nope", connect: { transport: "radius" } }, features, createSession)),
      created,
    };
  })(),
};

console.log(JSON.stringify(out, null, 2));
