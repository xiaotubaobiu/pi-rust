import { parseDiscoveredCases, createTaskPlan, DOCUMENTATION_VARIANTS } from "file:///C:/Users/13063/Desktop/code/agent%20work/pi/packages/evals/src/plan.ts";
import { writeFileSync } from "node:fs";
const out = {};
const discovered = [{ name: "Add model > adds the model", file: "evals/models.docs.eval.ts" }];
out.parseOk = parseDiscoveredCases(discovered);
try { parseDiscoveredCases([{ name: "adds the model", file: "model.ts" }]); out.err1 = null; } catch (e) { out.err1 = String(e.message); }
try { parseDiscoveredCases([...discovered, ...discovered]); out.err2 = null; } catch (e) { out.err2 = String(e.message); }
try { parseDiscoveredCases([{}]); out.err3 = null; } catch (e) { out.err3 = String(e.message); }
try { parseDiscoveredCases("nope"); out.err4 = null; } catch (e) { out.err4 = String(e.message); }
try { parseDiscoveredCases([{ name: "A > B > C", file: "f.ts" }]); out.err5 = null; } catch (e) { out.err5 = String(e.message); }
out.variants = DOCUMENTATION_VARIANTS;
out.plan2 = createTaskPlan(parseDiscoveredCases(discovered), "fixture/model", 2);
out.plan3 = createTaskPlan(parseDiscoveredCases([
  { name: "A > one", file: "a.ts" }, { name: "B > two", file: "b.ts" },
]), "p/m", 3);
try { createTaskPlan(parseDiscoveredCases(discovered), "model", 1); out.err6 = null; } catch (e) { out.err6 = String(e.message); }
try { createTaskPlan(parseDiscoveredCases(discovered), "fixture/model", 0); out.err7 = null; } catch (e) { out.err7 = String(e.message); }
try { createTaskPlan(parseDiscoveredCases(discovered), "/model", 1); out.err8 = null; } catch (e) { out.err8 = String(e.message); }
try { createTaskPlan(parseDiscoveredCases(discovered), "model/", 1.5); out.err9 = null; } catch (e) { out.err9 = String(e.message); }
writeFileSync("oracle/plan.json", JSON.stringify(out, null, 2) + "\n");
