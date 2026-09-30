// r19 oracle driver. Runs every scenario, snapshots the action LOG around it,
// and writes component_r19_oracle.json.
import { writeFileSync } from "node:fs";
import { SCENARIOS, logReset } from "./scenarios.ts";
import { LOG } from "./deps.ts";

type AnyRec = Record<string, unknown>;

const out: AnyRec = { scenarios: [] as unknown[] };
const failures: string[] = [];

for (const [name, run] of Object.entries(SCENARIOS)) {
	logReset();
	LOG.length = 0;
	try {
		const result = await run();
		(out.scenarios as unknown[]).push({ name, log: [...LOG], result });
	} catch (error) {
		failures.push(`${name}: ${(error as Error).stack ?? String(error)}`);
		(out.scenarios as unknown[]).push({ name, error: String(error) });
	}
}

out.failures = failures;
writeFileSync(new URL("./component_r19_oracle.json", import.meta.url), JSON.stringify(out, null, "\t"));
console.log(`scenarios=${(out.scenarios as unknown[]).length} failures=${failures.length}`);
for (const f of failures) console.log(`FAIL ${f.split("\n")[0]}`);
