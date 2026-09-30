// Execute the actual ls.ts and truncate.ts. Filesystem and TypeBox constructors
// are injected; localeCompare delegates to Node's real ICU with an explicit
// default locale per case. No sorting, truncation, or execution is reimplemented.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
const source = process.env.PI_LS_ORACLE_SOURCE;
const output = process.env.PI_LS_ORACLE_OUTPUT;
const collationOutput = process.env.PI_COLLATION_ORACLE_OUTPUT;
if (!source || !output || !collationOutput) throw Error("set source/output env paths");
const provenance = {};
function load(file, deps, names) {
  const raw = fs.readFileSync(path.join(source, file), "utf8");
  provenance[file] = crypto.createHash("sha256").update(raw).digest("hex");
  const code = stripTypeScriptTypes(raw.replace(/^import\b[\s\S]*?;\s*$/gm, ""), { mode: "strip" }).replace(/\bexport\s+/g, "");
  return new Function(...Object.keys(deps), code + "\nreturn {" + names.join(",") + "};")(...Object.values(deps));
}
const optional = Symbol();
const Type = {
  String: (o = {}) => ({ type: "string", ...o }),
  Number: (o = {}) => ({ type: "number", ...o }),
  Optional: v => { Object.defineProperty(v, optional, { value: true }); return v; },
  Object: properties => {
    const required = Object.keys(properties).filter(k => !properties[k][optional]);
    return { type: "object", properties, ...(required.length ? { required } : {}) };
  }
};
const truncate = load("core/tools/truncate.ts", {}, ["DEFAULT_MAX_BYTES", "formatSize", "truncateHead"]);
const locales = ["en-US", "zh-CN", "zh-TW", "sv", "tr", "de", "de-u-co-phonebk", "es", "es-u-co-trad", "ja", "ko", "ar", "th", "da", "fr", "cs", "lt", "el", "ru", "hi"];
const names = ["Z", "a", "A", "alpha", ".hidden", "_under", "-dash", "space x", "space-x", "space_x", "file2", "file10", "file01", "é", "e\u0301", "e", "E", "É", "ä", "å", "ö", "Æ", "ø", "ß", "ss", "ẞ", "I", "İ", "ı", "i", "中文", "阿", "中", "国", "重", "重庆", "あ", "ア", "ｱ", "가", "ㄱ", "Ω", "Σ", "ΟΣ", "οσ", "οϲ", "ไทย", "เก", "แก", "ش", "ا", "ё", "е", "ё.txt", "च", "छ", "🙂", "🙃", "1", "10", "01", "١", "²", "①", "Ｆ", "F", "f", "K", "K", "ﬃ", "ffi", "A\u200d", "A\u00ad", "\ufeffbom", "\u{10400}", "\u{10428}"];
const originalCompare = String.prototype.localeCompare;
const specs = [];
const add = (id, fields = {}) => specs.push({ id, ...fields });
for (const windows of [false, true]) {
  const root = windows ? "C:\\work" : "/work";
  const prefix = windows ? "win-" : "posix-";
  const c = (id, fields = {}) => add(prefix + id, { windows, root, locale: "en-US", input: {}, entries: ["B", "a", "A", ".hidden", "dir"], directories: ["dir"], ...fields });
  c("normal"); c("relative-path", { input: { path: "nested/.." } }); c("empty-path", { input: { path: "" } });
  c("empty", { entries: [] }); c("missing", { exists: false }); c("not-directory", { isDirectory: false });
  c("exists-error", { existsError: "exists failed" }); c("stat-error", { statError: "stat failed" });
  c("readdir-error", { readdirError: "access denied" }); c("preabort", { preAbort: true });
  c("entry-skip", { statFailures: ["a", "A", "B"] });
  c("all-skip", { statFailures: ["a", "A", "B", ".hidden", "dir"] });
  c("skip-does-not-consume-limit", { input: { limit: 2 }, statFailures: ["a", ".hidden"] });
  for (const limit of [-3, 0, 1, 2, 2.5, 5, 6]) c("limit-" + limit, { input: { limit } });
  c("exact-limit", { input: { limit: 2 }, entries: ["a", "b"] });
  c("limit-before-inaccessible", { input: { limit: 1 }, entries: ["a", "b"], statFailures: ["b"] });
  c("default-limit", { entries: Array.from({ length: 501 }, (_, i) => String(i).padStart(3, "0")) });
  c("byte-limit", { input: { limit: 1000 }, entries: Array.from({ length: 200 }, (_, i) => i + "界".repeat(200)) });
  c("single-long-entry", { entries: ["界".repeat(18000)] });
  c("embedded-newline", { entries: ["first\nsecond", "dir"], directories: ["dir"] });
  c("symlink-follows-directory", { entries: ["link", "broken"], directories: ["link"], statFailures: ["broken"] });
  for (const locale of locales) c("collation-" + locale, { locale, entries: names });
}
const cases = [];
let metadata;
for (const spec of specs) {
  const p = spec.windows ? path.win32 : path.posix;
  const trace = [];
  const dirPath = p.resolve(spec.root, spec.input.path || ".");
  const operations = {
    exists: async absolute => { trace.push(["exists", absolute]); if (spec.existsError) throw Error(spec.existsError); return spec.exists !== false; },
    stat: async absolute => {
      trace.push(["stat", absolute]);
      if (absolute === dirPath) { if (spec.statError) throw Error(spec.statError); return { isDirectory: () => spec.isDirectory !== false }; }
      const name = p.relative(dirPath, absolute);
      if ((spec.statFailures ?? []).includes(name)) throw Error("inaccessible");
      return { isDirectory: () => (spec.directories ?? []).includes(name) };
    },
    readdir: async absolute => { trace.push(["readdir", absolute]); if (spec.readdirError) throw Error(spec.readdirError); return [...spec.entries]; }
  };
  const { createLsToolDefinition } = load("core/tools/ls.ts", {
    Type, ...truncate, nodePath: p, pathExists: operations.exists,
    fsStat: operations.stat, fsReaddir: operations.readdir,
    resolveToCwd: (value, cwd) => p.resolve(cwd, value), lsRenderers: {},
    wrapToolDefinition: () => { throw Error("not covered here"); }
  }, ["createLsToolDefinition"]);
  const tool = createLsToolDefinition("fallback-must-not-be-used", { operations });
  const { name, label, description, parameters, promptSnippet } = tool;
  metadata ??= { name, label, description, parameters, promptSnippet };
  const controller = new AbortController();
  if (spec.preAbort) controller.abort();
  String.prototype.localeCompare = function (other, localesArg, options) { return originalCompare.call(this, other, localesArg ?? spec.locale, options); };
  let outcome;
  try { outcome = { value: await tool.execute("id", spec.input, controller.signal, undefined, { cwd: spec.root }) }; }
  catch (error) { outcome = { error: error.message }; }
  finally { String.prototype.localeCompare = originalCompare; }
  cases.push({ ...spec, outcome, trace });
}
const sorts = locales.map(locale => ({ locale, entries: names, sorted: [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), locale)) }));
const pairs = [];
for (const locale of locales) for (const [left, right] of [["a", "A"], ["a", "á"], ["e\u0301", "é"], ["å", "z"], ["ä", "ae"], ["ß", "ss"], ["重庆", "重量"], ["file2", "file10"], ["a-b", "ab"], ["A\u200d", "A"], ["😀", "😁"]]) pairs.push({ locale, left, right, sign: Math.sign(left.localeCompare(right, locale)) });
fs.writeFileSync(output, JSON.stringify({ provenance, versions: process.versions, defaultLocale: new Intl.Collator().resolvedOptions().locale, metadata, cases }, null, 2) + "\n");
fs.writeFileSync(collationOutput, JSON.stringify({ versions: process.versions, sorts, pairs }, null, 2) + "\n");
console.log(`${cases.length} ls execution cases; ${sorts.length} locale sorts; ${pairs.length} collation pairs`);
