import { parseEvalCli } from "./cli_copy.ts";
import { writeFileSync } from "node:fs";
const out = [];
function run(args, env) {
  try { out.push({ args, env, ok: parseEvalCli(args, env) }); }
  catch (e) { out.push({ args, env, error: String(e.message) }); }
}
run([], {});
run(["--provider", "p1", "--model", "m1"], {});
run(["--provider=p1", "--model=m1", "--runs-per-variant=3"], {});
run(["--provider", " p1 ", "--model", " m1 "], {});
run(["--model", "m1"], {});
run(["--provider", "p1"], {});
run([], { PI_PROVIDER: "p2", PI_MODEL: "m2" });
run([], { PI_PROVIDER: "p2" });
run([], { PI_PROVIDER: " p2 ", PI_MODEL: " m2 " });
run(["--provider", "p1", "--model", "m1", "-t", "foo bar"], {});
run(["--provider", "p1", "--model", "m1", "--testNamePattern=x"], {});
run(["--provider", "p1", "--model", "m1", "--testNamePattern="], {});
run(["--provider", "p1", "--model", "m1", "-t"], {});
run(["--provider", "p1", "--model"], {});
run(["evals/models.docs.eval.ts", "--provider", "p1", "--model", "m1"], {});
run(["--runs-per-variant", "2", "--provider", "p1", "--model", "m1"], {});
run(["--runs-per-variant", "0", "--provider", "p1", "--model", "m1"], {});
run([], { PI_PROVIDER: "p2", PI_MODEL: "m2", PI_EVAL_RUNS_PER_VARIANT: "4" });
run([], { PI_PROVIDER: "p2", PI_MODEL: "m2", PI_EVAL_RUNS_PER_VARIANT: "x" });
run(["--bogus"], {});
run(["--runs-per-variant=-1", "--provider", "p1", "--model", "m1"], {});
writeFileSync("oracle/cli.json", JSON.stringify(out, null, 2) + "\n");
