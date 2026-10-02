// Generates prelude.js from the VERBATIM upstream prelude-source.ts.
import { PRELUDE_SOURCE, MAX_STORE_VALUE_CHARS, MAX_STORE_TOTAL_CHARS } from "./src/runtime/prelude-source.ts";
import { writeFile } from "node:fs/promises";
if (MAX_STORE_VALUE_CHARS !== 256 * 1024 || MAX_STORE_TOTAL_CHARS !== 1024 * 1024) throw new Error("store limits changed");
await writeFile(new URL("./src/runtime/prelude.js", import.meta.url), PRELUDE_SOURCE, "utf8");
console.log("written", PRELUDE_SOURCE.length, "chars");
