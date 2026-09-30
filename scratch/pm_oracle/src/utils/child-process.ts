// Oracle stub for upstream `src/utils/child-process.ts`.
//
// The oracle scenarios never let a real package-manager command run: every
// `spawnProcess`/`spawnProcessSync` call is routed through a script installed
// by the capture harness (`globalThis.__pmSpawnScript`). The script is either
// a function `(command, args, options) => result` or a record of results.
// Calls are recorded in `globalThis.__pmSpawnLog` so the harness can pin the
// exact argv the upstream source produces.
//
// The real `cross-spawn`-based implementation is exercised on the Rust side
// through real child processes where the upstream tests spawn one
// (`runCommandSync` argv-with-spaces test); that path is not oracle-pinned.

import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

export function spawnProcess(command, args, options) {
	const log = globalThis.__pmSpawnLog;
	log.push({ kind: "spawn", command, args, options: spawnOptionsSummary(options) });
	const script = globalThis.__pmSpawnScript;
	const child = new EventEmitter();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = () => {
		child.emit("close", null, "SIGTERM");
		return true;
	};
	queueMicrotask(() => {
		let outcome;
		try {
			outcome = typeof script === "function" ? script(command, args, options) : script?.[`${command} ${args.join(" ")}`];
		} catch (error) {
			child.emit("error", error);
			return;
		}
		if (outcome && typeof outcome === "object" && !(outcome instanceof Error) && "error" in outcome) {
			child.emit("error", outcome.error);
			return;
		}
		if (outcome instanceof Error) {
			child.emit("error", outcome);
			return;
		}
		const stdout = outcome?.stdout ?? "";
		const stderr = outcome?.stderr ?? "";
		const code = outcome?.code ?? 0;
		if (stdout) child.stdout.write(stdout);
		if (stderr) child.stderr.write(stderr);
		child.stdout.end();
		child.stderr.end();
		child.emit("exit", code, null);
		child.emit("close", code, null);
	});
	return child;
}

export function spawnProcessSync(command, args, options) {
	const log = globalThis.__pmSpawnLog;
	log.push({ kind: "spawnSync", command, args, options: spawnOptionsSummary(options) });
	const script = globalThis.__pmSpawnScript;
	let outcome;
	try {
		outcome = typeof script === "function" ? script(command, args, options) : script?.[`${command} ${args.join(" ")}`];
	} catch (error) {
		return { status: null, error, stdout: "", stderr: String(error?.message ?? error) };
	}
	if (outcome instanceof Error) {
		return { status: null, error: outcome, stdout: "", stderr: outcome.message };
	}
	if (outcome && typeof outcome === "object" && "error" in outcome && outcome.error) {
		return { status: null, error: outcome.error, stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? outcome.error.message };
	}
	return {
		status: outcome?.code ?? 0,
		error: undefined,
		stdout: outcome?.stdout ?? "",
		stderr: outcome?.stderr ?? "",
	};
}

export function waitForChildProcess(child) {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code));
	});
}

function spawnOptionsSummary(options) {
	if (!options) return undefined;
	// The process environment is passed through verbatim by the upstream code
	// (getEnv() on win32 returns process.env); it is not pinned in the capture.
	// stdio shapes are not pinned either; the Rust port maps them onto its own
	// spawn plumbing (inherit vs pipe) with the same semantics.
	return { cwd: options.cwd };
}
