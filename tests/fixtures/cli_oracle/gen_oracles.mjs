// Oracle generator: runs the REAL upstream cli modules (verbatim copies in
// ./upstream, import paths adjusted only where npm packages are absent) under
// node --experimental-strip-types and captures deterministic outputs.
import { parseArgs, normalizeSessionName, printHelp } from "./upstream/packages/coding-agent/src/cli/args.ts";
import {
  parseAuthCommand, getAuthCommandUsage, getAuthCommandName, isAuthCommandHelp,
  printAuthCommandHelp, getAuthCredential, AuthCommandError,
} from "./upstream/packages/coding-agent/src/cli/auth-command.ts";
import { listModels } from "./upstream/packages/coding-agent/src/cli/list-models.ts";
import { cli } from "./upstream/packages/coding-agent/src/cli/experimental/cli.ts";

const out = {};

// ---------------- args ----------------
const cases = [
  [], ["--version"], ["-v"], ["--version","--help","some message"], ["--help"], ["-h"],
  ["--print"], ["-p"], ["-p","---\ntitle: hello\n---\nSay hi."], ["-p","--provider","openai","Say hi."],
  ["--continue"], ["-c"], ["--resume"], ["-r"],
  ["--provider","openai"], ["--model","gpt-4o"], ["--api-key","sk-test-key"], ["--system-prompt","You are a helpful assistant"],
  ["--append-system-prompt","Additional context"], ["--append-system-prompt","Context A","--append-system-prompt","Context B"],
  ["--mode","json"], ["--mode","rpc"], ["--session","/path/to/session.jsonl"], ["--session-id","orchestrated-session"],
  ["--fork","1234abcd"], ["--export","session.jsonl"], ["--thinking","high"], ["--thinking","bogus"],
  ["--models","gpt-4o,claude-sonnet,gemini-pro"], ["--name","my-session"], ["-n","quick-session"], ["--name",""],
  ["--name"], ["--name","named-run","--print","--model","gpt-4o","hello"],
  ["--no-session"], ["--session-id","ephemeral-id","--help"], ["--session-id","ephemeral-id","--list-models"], ["--session-id","ephemeral-id","--no-session"],
  ["--extension","./my-extension.ts"], ["-e","./my-extension.ts"], ["--extension","./ext1.ts","-e","./ext2.ts"],
  ["--no-extensions"], ["--no-extensions","-e","foo.ts","-e","bar.ts"],
  ["--skill","./skill-dir"], ["--skill","./skill-a","--skill","./skill-b"],
  ["--prompt-template","./prompts"], ["--prompt-template","./one","--prompt-template","./two"],
  ["--theme","./theme.json"], ["--theme","./dark.json","--theme","./light.json"],
  ["--use-theme","light"], ["--use-theme","--print"], ["--no-skills"], ["--no-prompt-templates"], ["--no-themes"],
  ["--no-context-files"], ["-nc"], ["--approve"], ["-a"], ["--no-approve"], ["-na"], ["--verbose"], ["--offline"],
  ["--tui-mode","regular"], ["--tui-mode","fullscreen"], ["--tui-mode","other"], ["--tui-mode"], ["--ui-mode","fullscreen"],
  ["--no-tools"], ["-nt"], ["--no-builtin-tools"], ["-nbt"], ["--tools","read,bash"], ["-t","read,bash"],
  ["--exclude-tools","read,bash"], ["-xt","read,bash"], ["--no-tools","--tools","read,bash"], ["--no-builtin-tools","--tools","read,bash"],
  ["--tools"," a , , b "], ["hello","world"], ["@README.md","@src/main.ts"], ["@file.txt","explain this","@image.png"],
  ["--unknown-flag","message"], ["--unknown-flag"], ["--unknown-flag=value"], ["-z"], ["--"],
  ["--","@prompt.md","-x","hello"], ["--provider","anthropic","--model","claude-sonnet","--print","--thinking","high","@prompt.md","Do the task"],
  ["--list-models"], ["--list-models","sonnet"], ["--list-models","-p"], ["--list-models","@img.png"],
];
const pick = (r) => ({
  provider: r.provider ?? null, model: r.model ?? null, apiKey: r.apiKey ?? null,
  systemPrompt: r.systemPrompt ?? null, appendSystemPrompt: r.appendSystemPrompt ?? null,
  thinking: r.thinking ?? null, continue_: r.continue ?? null, resume: r.resume ?? null,
  help: r.help ?? null, version: r.version ?? null, mode: r.mode ?? null, name: r.name ?? null,
  noSession: r.noSession ?? null, session: r.session ?? null, sessionId: r.sessionId ?? null,
  fork: r.fork ?? null, sessionDir: r.sessionDir ?? null, models: r.models ?? null,
  tools: r.tools ?? null, excludeTools: r.excludeTools ?? null, noTools: r.noTools ?? null,
  noBuiltinTools: r.noBuiltinTools ?? null, extensions: r.extensions ?? null,
  noExtensions: r.noExtensions ?? null, print: r.print ?? null, export_: r.export ?? null,
  noSkills: r.noSkills ?? null, skills: r.skills ?? null, promptTemplates: r.promptTemplates ?? null,
  noPromptTemplates: r.noPromptTemplates ?? null, themes: r.themes ?? null, useTheme: r.useTheme ?? null,
  noThemes: r.noThemes ?? null, noContextFiles: r.noContextFiles ?? null,
  listModels: r.listModels === undefined ? null : r.listModels,
  offline: r.offline ?? null, tuiMode: r.tuiMode ?? null, verbose: r.verbose ?? null,
  projectTrustOverride: r.projectTrustOverride === undefined ? null : r.projectTrustOverride,
  messages: r.messages, fileArgs: r.fileArgs,
  unknownFlags: [...r.unknownFlags.entries()],
  diagnostics: r.diagnostics,
});
out.args = {};
for (const c of cases) out.args[JSON.stringify(c)] = pick(parseArgs([...c]));
out.normalizeSessionName = [normalizeSessionName("  named session  "), normalizeSessionName("   ")];

// ---------------- auth command ----------------
const authCmd = {};
const parse = (argv) => {
  try { const r = parseAuthCommand([...argv]); return r === undefined ? "undefined" : r; }
  catch (e) { return { error: e instanceof AuthCommandError ? e.message : "NON_AUTH: " + e.message }; }
};
for (const argv of [
  ["auth","check","--provider","openai"],
  ["auth","check","--json","--credentials","--no-refresh","--provider","openai"],
  ["auth","print-api-key","--provider","openai"],
  ["auth","print-bearer-token"],
  ["auth","print-bearer-token","--min-expiry","30m"],
  ["auth","print-bearer-token","--min-expiry","1h"],
  ["auth","print-bearer-token","--min-expiry","500ms"],
  ["auth","print-bearer-token","--min-expiry","45s"],
  ["auth","print-bearer-token","--min-expiry","2m"],
  ["auth","print-api-key","--min-expiry","30m"],
  ["auth","print-api-key","--json"],
  ["auth","unknown"],
  ["auth",""],
  ["notauth","check"],
  ["auth","print-bearer-token","--min-expiry","bad"],
  ["auth","print-bearer-token","--min-expiry"],
]) authCmd[JSON.stringify(argv)] = parse(argv);
authCmd.usage = {
  check: getAuthCommandUsage("check"), api_key: getAuthCommandUsage("api_key"), bearer_token: getAuthCommandUsage("bearer_token"),
};
authCmd.name = { check: getAuthCommandName("check"), api_key: getAuthCommandName("api_key"), bearer_token: getAuthCommandName("bearer_token") };
authCmd.isHelp = {
  bare: isAuthCommandHelp(["auth"]), helpWord: isAuthCommandHelp(["auth","help"]),
  helpFlag: isAuthCommandHelp(["auth","print-api-key","--help"]), hFlag: isAuthCommandHelp(["auth","print-bearer-token","-h"]),
  checkHelp: isAuthCommandHelp(["auth","check","--help"]), nonAuth: isAuthCommandHelp(["notauth"]),
};
authCmd.credential = {
  apiKey: getAuthCredential({ auth: { apiKey: "sk-1" } }),
  bearerHeader: getAuthCredential({ auth: { headers: { Authorization: "Bearer tok-1" } } }),
  bearerLower: getAuthCredential({ auth: { headers: { authorization: "bearer  spaced tok" } } }),
  none: getAuthCredential({ auth: {} }),
  undefined: getAuthCredential(undefined),
};
out.authCommand = authCmd;

// ---------------- experimental cli ----------------
out.experimental = {};
const expCases = [
  [],
  ["server","--server-id","00000000-0000-4000-8000-000000000001","--session-dir","~/pi-sessions","--provider","anthropic","--model","claude-sonnet-4-5","-e","./first-plugin","-e=./second-plugin"],
  ["server","--model","anthropic/claude-sonnet-4-5:high"],
  ["client","--connect","unix:///tmp/pi.sock"],
  ["client","--connect","radius://00000000-0000-4000-8000-000000000001","--session-id","demo-1"],
  ["client","-c"],["client","--continue"],["client","-r"],["client","--resume"],
  ["client","-r","Explain this project"],
  ["client","--model","anthropic/claude-sonnet-4-5:high","-e","./first-plugin","-e","./second-plugin"],
  ["server","--auth-token","secret"],["server","--auth-token-file","/tmp/token"],
  ["client","--auth-token","secret"],["client","--auth-token-file","/tmp/token"],
  ["server"],["client"],
  ["client","--listen","unix:///tmp/pi.sock"],
  ["server","--listen","unix:///tmp/pi.sock"],
  ["server","--connect","unix:///tmp/pi.sock"],
  ["client","--connect","ws://localhost:8080"],
  ["client","--connect","radius://not-a-server"],
  ["client","--connect","unix://relative.sock"],
  ["client","--connect","unix:///tmp/pi.sock?wrong=value"],
  ["client","--provider","anthropic"],
  ["client","-c","-r"],
  ["client","--continue=true"],
  ["server","--provider","anthropic"],
  ["server","--server-id","not-a-uuid"],
  ["server","--server-id"],
  ["server","--session-dir"],
  ["client","-e"],
  ["server","--session-dir","/tmp/first","--session-dir=/tmp/second"],
  ["client","--connect="],
  ["client","--tui-mode","wrong","--model","claude-sonnet"],
];
for (const argv of expCases) out.experimental[JSON.stringify(argv)] = cli.parse([...argv]);

// ---------------- list models ----------------
const MODELS = [
  { provider: "openai", id: "gpt-4o-mini", contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ["text","image"] },
  { provider: "openai", id: "gpt-5.5", contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text"] },
  { provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ["text","image"] },
  { provider: "google", id: "gemini-2.5-pro", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text","image"] },
  { provider: "zai-coding-plan", id: "glm-4.7", contextWindow: 200000, maxTokens: 128000, reasoning: true, input: ["text"] },
];
const makeRuntime = (models, loadError) => ({
  getError: () => loadError,
  getAvailable: async () => models,
});
const capture = async (fn) => {
  const chunks = [];
  const orig = console.log; const origErr = console.error;
  console.log = (...a) => chunks.push("out: " + a.join(" "));
  console.error = (...a) => chunks.push("err: " + a.join(" "));
  try { await fn(); } finally { console.log = orig; console.error = origErr; }
  return chunks.join("\n") + "\n";
};
out.listModels = {
  empty: await capture(() => listModels(makeRuntime([]))),
  all: await capture(() => listModels(makeRuntime(MODELS))),
  searchSonnet: await capture(() => listModels(makeRuntime(MODELS), "sonnet")),
  searchNoMatch: await capture(() => listModels(makeRuntime(MODELS), "zzzznotfound")),
  searchGpt: await capture(() => listModels(makeRuntime(MODELS), "gpt")),
  loadError: await capture(() => listModels(makeRuntime(MODELS.slice(0, 2), "boom\nsecond line"))),
};

// ---------------- help texts ----------------
out.help = {};
{
  const chunks = [];
  const orig = console.log;
  console.log = (...a) => chunks.push(a.join(" "));
  printHelp();
  console.log = orig;
  out.help.main = chunks.join("\n") + "\n";
}
{
  const chunks = [];
  const orig = console.log;
  console.log = (...a) => chunks.push(a.join(" "));
  printAuthCommandHelp();
  console.log = orig;
  out.help.auth = chunks.join("\n") + "\n";
}

process.stdout.write(JSON.stringify(out, null, 1));
