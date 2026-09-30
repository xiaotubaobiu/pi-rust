import { parseArgs, normalizeSessionName } from "../../../pi/packages/coding-agent/src/cli/args.ts";
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
  ["--tools", " a , , b "], ["hello","world"], ["@README.md","@src/main.ts"], ["@file.txt","explain this","@image.png"],
  ["--unknown-flag","message"], ["--unknown-flag"], ["--unknown-flag=value"], ["-z"], ["--"],
  ["--","@prompt.md","-x","hello"], ["--provider","anthropic","--model","claude-sonnet","--print","--thinking","high","@prompt.md","Do the task"],
  ["--list-models"], ["--list-models","sonnet"], ["--list-models","-p"], ["--list-models","@img.png"],
];
const out = {};
for (const c of cases) {
  const r = parseArgs([...c]);
  out[JSON.stringify(c)] = {
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
    listModels: r.listModels === undefined ? null : (r.listModels === true ? true : r.listModels),
    offline: r.offline ?? null, tuiMode: r.tuiMode ?? null, verbose: r.verbose ?? null,
    projectTrustOverride: r.projectTrustOverride === undefined ? null : r.projectTrustOverride,
    messages: r.messages, fileArgs: r.fileArgs,
    unknownFlags: [...r.unknownFlags.entries()],
    diagnostics: r.diagnostics,
  };
}
out["__normalize"] = [normalizeSessionName("  named session  "), normalizeSessionName("   ")];
process.stdout.write(JSON.stringify(out, null, 1));
