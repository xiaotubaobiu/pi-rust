// Byte-oracle capture for the chord delta slice (upstream 2bbfcca43,
// baseline 590144609): copies the UNMODIFIED upstream TypeScript dependency
// closure into a temp directory (hashing every file for the provenance
// manifest) and executes it under Node's --experimental-strip-types with
// deterministic stubs (Date.now, Math.random).
//
// Scenarios captured into chord_delta_oracle.json:
// 1. tracker transaction scenarios: beginChange draft mutation scripts
//    (object writes/deletes/readds, array mutators, reserved-key folds,
//    dense-region overrides, operation-cap collapse, prepared
//    replace/adopt/stale lifecycles) with per-step outcomes and the
//    canonical ops/value/revision of every prepare.
// 2. a seeded random mutation transcript (replay recorded verbatim).
// 3. diffRevisions before/after pairs, including permutation, anchoring
//    and cost-collapse cases.
// 4. services: replicated state publication (change/replace/subscribe
//    ordering), provider buffer-overflow reset + snapshot-sequence
//    coverage, replica hydrate/update/gap, revision validator, json guards.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";

const upstreamRoot = fileURLToPath(new URL("../../../../pi/", import.meta.url));
const chordSrc = path.join(upstreamRoot, "packages", "chord", "src");

// Dependency closures (entry files relative to packages/chord/src); the
// transitive relative imports are copied verbatim.
const CLOSURES = {
  delta: ["delta/index.ts", "delta/tracker.ts", "delta/diff.ts", "delta/revision-validator.ts"],
  json: ["json.ts"],
  api: ["api.ts"],
  services: ["services/state.ts", "services/provider.ts", "services/wire.ts"],
};

const hashes = {};
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "chord-delta-oracle-"));
const stagedRoot = path.join(staging, "packages", "chord", "src");

function copyClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const rel = queue.pop().split(path.sep).join("/");
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.join(chordSrc, ...rel.split("/"));
    const source = fs.readFileSync(abs, "utf8");
    hashes[`packages/chord/src/${rel}`] = createHash("sha256").update(source).digest("hex");
    const target = path.join(stagedRoot, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
    for (const [, spec] of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      if (spec.endsWith(".ts")) {
        queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
      }
    }
  }
}

for (const entries of Object.values(CLOSURES)) {
  for (const entry of entries) copyClosure(entry);
}

// Determinism stubs (the staged modules run in this process).
const FIXED_NOW = 1758240000000;
Date.now = () => FIXED_NOW;
Math.random = () => 0.5;

const stagedUrl = (rel) => pathToFileURL(path.join(stagedRoot, ...rel.split("/"))).href;

const delta = await import(stagedUrl("delta/index.ts"));
const { track, diffRevisions, apply, applyImmutable } = delta;
const validatorMod = await import(stagedUrl("delta/revision-validator.ts"));
const { copyJson, isJsonValue } = await import(stagedUrl("json.ts"));
const apiMod = await import(stagedUrl("api.ts"));
const stateMod = await import(stagedUrl("services/state.ts"));
const providerMod = await import(stagedUrl("services/provider.ts"));

// ── canonical serialization ─────────────────────────────────────────────────
// Deep-copy first with defineProperty so own `__proto__` keys survive (plain
// assignment would set the prototype), then stringify.
const canonDeep = (value) => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonDeep);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(out, key, {
      value: canonDeep(value[key]),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
};
const canon = (value) => JSON.stringify(canonDeep(value));

const describeError = (error) => `${error && error.name ? error.name : "Error"}: ${
  error && error.message ? error.message : String(error)
}`;

// Deterministic PRNG for the random transcript (mulberry32).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── tracker interpreter (shared step language with the Rust oracle) ────────
// Steps descend draft proxies exactly like the port's path-addressed API.
function descend(root, segments) {
  let at = root;
  for (const segment of segments) {
    if (typeof segment === "number") at = at[segment];
    else at = at[segment];
    if (at === undefined) throw new TypeError("descend into undefined");
  }
  return at;
}

function runTrackerScenario(scenario) {
  const record = {
    name: scenario.name,
    init: scenario.init,
    steps: scenario.steps,
    outcomes: [],
    final: null,
    revision: null,
    error: null,
  };
  let tracker;
  let change = null;
  const prepared = [null, null];
  try {
    tracker = track(structuredClone(scenario.init));
    for (let index = 0; index < scenario.steps.length; index++) {
      const step = scenario.steps[index];
      const outcome = { step: index, op: step.op };
      const slot = step.slot ?? 0;
      try {
        switch (step.op) {
          case "begin_change": {
            change = tracker.beginChange();
            break;
          }
          case "set": {
            const parent = descend(change.state, step.path.slice(0, -1));
            const last = step.path[step.path.length - 1];
            parent[last] = structuredClone(step.value);
            break;
          }
          case "delete": {
            const parent = descend(change.state, step.path.slice(0, -1));
            delete parent[step.path[step.path.length - 1]];
            break;
          }
          case "push": {
            const at = descend(change.state, step.path);
            at.push(...structuredClone(step.items));
            break;
          }
          case "pop": {
            descend(change.state, step.path).pop();
            break;
          }
          case "shift": {
            descend(change.state, step.path).shift();
            break;
          }
          case "unshift": {
            const at = descend(change.state, step.path);
            at.unshift(...structuredClone(step.items));
            break;
          }
          case "splice": {
            const at = descend(change.state, step.path);
            at.splice(step.start, step.remove, ...structuredClone(step.items ?? []));
            break;
          }
          case "set_length": {
            descend(change.state, step.path).length = step.n;
            break;
          }
          case "reverse": {
            descend(change.state, step.path).reverse();
            break;
          }
          case "sort_default": {
            descend(change.state, step.path).sort();
            break;
          }
          case "fill": {
            const at = descend(change.state, step.path);
            at.fill(step.value, step.start, step.end);
            break;
          }
          case "copy_within": {
            const at = descend(change.state, step.path);
            at.copyWithin(step.target, step.start, step.end);
            break;
          }
          case "read_draft": {
            const at = descend(change.state, step.path ?? []);
            outcome.value = canon(JSON.parse(JSON.stringify(at === undefined ? null : at)));
            break;
          }
          case "read": {
            const at = descend(tracker.value, step.path ?? []);
            outcome.value = canon(at === undefined ? null : at);
            break;
          }
          case "prepare": {
            prepared[slot] = change.prepare();
            outcome.ops = canon(prepared[slot].ops);
            outcome.value = canon(prepared[slot].value);
            outcome.base_revision = prepared[slot].baseRevision;
            break;
          }
          case "adopt": {
            tracker.adopt(prepared[slot]);
            break;
          }
          case "abort": {
            if (prepared[slot] !== null) {
              prepared[slot].abort();
              prepared[slot] = null;
            } else if (change !== null) {
              change.abort();
              change = null;
            }
            break;
          }
          case "prepare_replace": {
            prepared[slot] = tracker.prepareReplace(structuredClone(step.value));
            outcome.ops = canon(prepared[slot].ops);
            outcome.value = canon(prepared[slot].value);
            outcome.base_revision = prepared[slot].baseRevision;
            break;
          }
          case "flag_revision": {
            outcome.value = tracker.revision;
            break;
          }
          case "begin_change_again": {
            change = tracker.beginChange();
            break;
          }
          default:
            throw new TypeError(`unknown step ${step.op}`);
        }
      } catch (error) {
        outcome.error = describeError(error);
      }
      record.outcomes.push(outcome);
    }
    record.final = canon(tracker.value);
    record.revision = tracker.revision;
  } catch (error) {
    record.error = describeError(error);
  }
  return record;
}

// ── scenario list ───────────────────────────────────────────────────────────
const trackerScenarios = [];
const addScenario = (name, init, steps) => trackerScenarios.push({ name, init, steps });

addScenario(
  "object_writes_coalesce",
  { a: 1, b: "x", pad: "p".repeat(400) },
  [
    { op: "begin_change" },
    { op: "set", path: ["a"], value: 2 },
    { op: "set", path: ["a"], value: 3 },
    { op: "set", path: ["b"], value: "xy" },
    { op: "set", path: ["new"], value: { n: 1 } },
    { op: "read_draft", path: [], },
    { op: "prepare" },
    { op: "adopt" },
    { op: "flag_revision" },
  ],
);

addScenario(
  "write_restore_noop",
  { a: 1 },
  [
    { op: "begin_change" },
    { op: "set", path: ["a"], value: 9 },
    { op: "set", path: ["a"], value: 1 },
    { op: "prepare" },
    { op: "adopt" },
    { op: "flag_revision" },
  ],
);

addScenario(
  "delete_then_readd",
  { a: 1, b: 2 },
  [
    { op: "begin_change" },
    { op: "delete", path: ["a"] },
    { op: "set", path: ["a"], value: 5 },
    { op: "delete", path: ["b"] },
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "nested_object_writes",
  { deep: { a: { b: 1 } }, other: 0 },
  [
    { op: "begin_change" },
    { op: "set", path: ["deep", "a", "b"], value: 2 },
    { op: "set", path: ["deep", "a", "c"], value: 3 },
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "reserved_key_forced_fold",
  { safe: 1 },
  [
    { op: "begin_change" },
    { op: "set", path: ["safe"], value: 2 },
    { op: "set", path: ["__proto__"], value: { x: 1 } },
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "string_append_intent",
  { s: "", pad: "p".repeat(400) },
  [
    { op: "begin_change" },
    { op: "set", path: ["s"], value: "ab" },
    { op: "set", path: ["s"], value: "abcd" },
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "string_truncate_append",
  { s: "abcdefgh" },
  [
    { op: "begin_change" },
    { op: "set", path: ["s"], value: "defghxyz" },
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "string_unrelated_replacement",
  { s: "hello world" },
  [
    { op: "begin_change" },
    { op: "set", path: ["s"], value: "whorl" },
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "array_push_splice",
  { xs: [1, 2], pad: "p".repeat(200) },
  [
    { op: "begin_change" },
    { op: "push", path: ["xs"], items: [3, 4] },
    { op: "splice", path: ["xs"], start: 1, remove: 1, items: ["a"] },
    { op: "pop", path: ["xs"] },
    { op: "unshift", path: ["xs"], items: [0] },
    { op: "shift", path: ["xs"] },
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "push_then_mutate_inserted",
  { xs: [{ k: 1 }] },
  [
    { op: "begin_change" },
    { op: "push", path: ["xs"], items: [{ k: 2 }] },
    { op: "set", path: ["xs", 1, "k"], value: 22 },
    { op: "set", path: ["xs", 0, "k"], value: 11 },
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "array_length_shrink_grow",
  { xs: [1, 2, 3, 4] },
  [
    { op: "begin_change" },
    { op: "set_length", path: ["xs"], n: 2 },
    { op: "set_length", path: ["xs"], n: 4 },
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "array_reverse",
  { xs: [1, 2, 3, 4, 5] },
  [
    { op: "begin_change" },
    { op: "reverse", path: ["xs"] },
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "array_sort_default_mixed",
  { xs: ["b", 3, null, "a", 1, true, null] },
  [
    { op: "begin_change" },
    { op: "sort_default", path: ["xs"] },
    { op: "read_draft", path: ["xs"] },
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "array_fill_copywithin",
  { xs: [1, 2, 3, 4, 5] },
  [
    { op: "begin_change" },
    { op: "fill", path: ["xs"], value: 0, start: 1, end: 3 },
    { op: "copy_within", path: ["xs"], target: 0, start: 2, end: 5 },
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "array_index_override_then_restore",
  { xs: [1, 2, 3] },
  [
    { op: "begin_change" },
    { op: "set", path: ["xs", 1], value: 22 },
    { op: "set", path: ["xs", 1], value: 2 },
    { op: "set", path: ["xs", 1], value: 23 },
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "structural_splice_reindex",
  { xs: [0, 1, 2, 3, 4, 5] },
  [
    { op: "begin_change" },
    { op: "splice", path: ["xs"], start: 0, remove: 2, items: [] },
    { op: "set", path: ["xs", 1], value: 33 },
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "deep_equal_still_replaces",
  { value: { nested: [1, { text: "same" }] } },
  [
    { op: "begin_change" },
    { op: "set", path: ["value"], value: { nested: [1, { text: "same" }] } },
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "empty_change_still_consumes_revision",
  { a: 1 },
  [
    { op: "begin_change" },
    { op: "prepare" },
    { op: "adopt" },
    { op: "flag_revision" },
  ],
);

addScenario(
  "replace_noop_and_real",
  { a: 1 },
  [
    { op: "prepare_replace", value: { a: 1 } },
    { op: "adopt" },
    { op: "flag_revision" },
    { op: "prepare_replace", value: { a: 2 } },
    { op: "adopt" },
    { op: "flag_revision" },
    { op: "read" },
  ],
);

addScenario(
  "abort_change",
  { a: 1 },
  [
    { op: "begin_change" },
    { op: "set", path: ["a"], value: 2 },
    { op: "abort" },
    { op: "read" },
    { op: "flag_revision" },
  ],
);

addScenario(
  "abort_prepared",
  { a: 1 },
  [
    { op: "begin_change" },
    { op: "set", path: ["a"], value: 2 },
    { op: "prepare" },
    { op: "abort" },
    { op: "flag_revision" },
    { op: "read" },
  ],
);

addScenario(
  "competing_change_stale",
  { a: 1 },
  [
    { op: "begin_change" },
    { op: "set", path: ["a"], value: 2 },
    { op: "begin_change_again" },
    { op: "set", path: ["a"], value: 5, stale: true },
    { op: "prepare" },
    { op: "adopt" },
    { op: "flag_revision" },
  ],
);

addScenario(
  "adopt_twice_fails",
  { a: 1 },
  [
    { op: "begin_change" },
    { op: "set", path: ["a"], value: 2 },
    { op: "prepare" },
    { op: "adopt" },
    { op: "adopt" },
    { op: "flag_revision" },
  ],
);

addScenario(
  "stale_prepared_rejected",
  { a: 1 },
  [
    { op: "begin_change" },
    { op: "set", path: ["a"], value: 2 },
    { op: "prepare", slot: 0 },
    { op: "begin_change_again" },
    { op: "set", path: ["a"], value: 3 },
    { op: "prepare", slot: 1 },
    { op: "adopt", slot: 1 },
    { op: "flag_revision" },
    { op: "adopt", slot: 0 },
    { op: "flag_revision" },
  ],
);

addScenario(
  "foreign_prepared_rejected",
  { a: 1 },
  [
    { op: "begin_change" },
    { op: "set", path: ["a"], value: 2 },
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "settle_write_after_prepare",
  { a: 1 },
  [
    { op: "begin_change" },
    { op: "set", path: ["a"], value: 2 },
    { op: "prepare" },
    { op: "set", path: ["a"], value: 3 },
  ],
);

addScenario(
  "dense_region_overrides",
  { xs: Array.from({ length: 600 }, (_, i) => i) },
  [
    { op: "begin_change" },
    ...Array.from({ length: 256 }, (_, k) => ({
      op: "set",
      path: ["xs", k * 2],
      value: k * 20,
    })),
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "sparse_small_overrides_no_dense",
  { xs: Array.from({ length: 300 }, (_, i) => i) },
  [
    { op: "begin_change" },
    ...Array.from({ length: 100 }, (_, k) => ({
      op: "set",
      path: ["xs", k * 3],
      value: -k,
    })),
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "operation_cap_collapse",
  Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i])),
  [
    { op: "begin_change" },
    ...Array.from({ length: 5000 }, (_, i) => ({
      op: "set",
      path: [`k${i}`],
      value: i + 1,
    })),
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "root_array_writes",
  [1, 2, 3],
  [
    { op: "begin_change" },
    { op: "push", path: [], items: [4] },
    { op: "set", path: [0], value: 10 },
    { op: "splice", path: [], start: 1, remove: 1, items: [] },
    { op: "prepare" },
    { op: "adopt" },
  ],
);

addScenario(
  "read_draft_reflects_overlay",
  { a: { b: [1, 2] } },
  [
    { op: "begin_change" },
    { op: "set", path: ["a", "c"], value: 5 },
    { op: "push", path: ["a", "b"], items: [3] },
    { op: "read_draft", path: ["a"] },
    { op: "prepare" },
    { op: "read" },
  ],
);

addScenario(
  "write_through_missing_path",
  { a: 1 },
  [
    { op: "begin_change" },
    { op: "set", path: ["a", "b"], value: 1 },
  ],
);

addScenario(
  "delete_missing_key_noop",
  { a: 1 },
  [
    { op: "begin_change" },
    { op: "delete", path: ["missing"] },
    { op: "prepare" },
    { op: "adopt" },
    { op: "flag_revision" },
  ],
);

addScenario(
  "array_delete_rejected",
  { xs: [1, 2, 3] },
  [
    { op: "begin_change" },
    { op: "delete", path: ["xs", 1] },
  ],
);

addScenario(
  "append_beyond_end_rejected",
  { xs: [1, 2, 3] },
  [
    { op: "begin_change" },
    { op: "set", path: ["xs", 5], value: 9 },
  ],
);

// ── seeded random transcript ────────────────────────────────────────────────
{
  const random = mulberry32(0x5eed);
  const keys = ["a", "b", "c"];
  const steps = [{ op: "begin_change" }];
  for (let i = 0; i < 150; i++) {
    const roll = random();
    if (roll < 0.35) {
      steps.push({
        op: "set",
        path: [keys[(random() * keys.length) | 0], `f${(random() * 6) | 0}`],
        value: random() < 0.5 ? (random() * 100) | 0 : `s${(random() * 40) | 0}`,
      });
    } else if (roll < 0.5) {
      steps.push({ op: "delete", path: [keys[(random() * keys.length) | 0], `f${(random() * 6) | 0}`] });
    } else if (roll < 0.7) {
      steps.push({
        op: "push",
        path: [keys[(random() * keys.length) | 0], "xs"],
        items: [random() < 0.5 ? (random() * 9) | 0 : { v: (random() * 9) | 0 }],
      });
    } else if (roll < 0.8) {
      steps.push({ op: "pop", path: [keys[(random() * keys.length) | 0], "xs"] });
    } else if (roll < 0.9) {
      steps.push({
        op: "splice",
        path: [keys[(random() * keys.length) | 0], "xs"],
        start: (random() * 4) | 0,
        remove: (random() * 2) | 0,
        items: [(random() * 9) | 0],
      });
    } else if (roll < 0.95) {
      steps.push({ op: "set_length", path: [keys[(random() * keys.length) | 0], "xs"], n: (random() * 6) | 0 });
    } else {
      steps.push({ op: "read_draft", path: [keys[(random() * keys.length) | 0]] });
    }
    if (i === 74) {
      steps.push({ op: "prepare" });
      steps.push({ op: "adopt" });
      steps.push({ op: "begin_change" });
    }
  }
  steps.push({ op: "prepare" });
  steps.push({ op: "adopt" });
  steps.push({ op: "flag_revision" });
  trackerScenarios.push({
    name: "random_transcript_seed_5eed",
    init: { a: { f0: 0, xs: [1] }, b: { xs: [] }, c: { f3: "x", xs: [7, 8] } },
    steps,
  });
}

const trackerRecords = trackerScenarios.map(runTrackerScenario);

// ── diffRevisions pairs ─────────────────────────────────────────────────────
const diffPairs = [];
const addDiff = (name, before, after) =>
  diffPairs.push({ name, before, after, ops: canon(diffRevisions(before, after)) });

addDiff("equal", { a: 1, b: [1, 2] }, { a: 1, b: [1, 2] });
addDiff("scalar_set", { a: 1 }, { a: 2 });
addDiff("added_removed", { a: 1 }, { b: 2 });
addDiff("string_append", { s: "abc" }, { s: "abcdef" });
addDiff("string_truncate_append", { s: "abcdefgh" }, { s: "defghxyz" });
addDiff("string_unrelated", { s: "hello world" }, { s: "whorl" });
addDiff("array_reorder", { xs: [1, 2, 3, 4, 5] }, { xs: [5, 2, 3, 4, 1] });
addDiff("array_scatter", { xs: [1, 2, 3, 4, 5, 6, 7, 8] }, { xs: [1, 9, 3, 4, 10, 6, 7, 8] });
addDiff("array_shift", { xs: [1, 2, 3, 4] }, { xs: [2, 3, 4] });
addDiff("array_push", { xs: [1] }, { xs: [1, 2, 3] });
addDiff("array_of_objects_reorder", { xs: [{ id: 1 }, { id: 2 }] }, { xs: [{ id: 2 }, { id: 1 }] });
addDiff("nested_object", { a: { b: { c: 1 } } }, { a: { b: { c: 2 } } });
addDiff("type_change", { v: [1, 2] }, { v: { x: 1 } });
addDiff("root_array", [1, 2, 3], [1, 2, 3, 4]);
addDiff("root_scalar", 1, 2);
addDiff("reserved_key", { a: 1, __proto__: null }, { a: 1, __proto__: null, b: 2 });
addDiff("long_strings_overlap", { s: `${"x".repeat(300)}tail` }, { s: `${"x".repeat(290)}new-tail` });
addDiff(
  "identity_anchored_mixed",
  { xs: [1, "two", 3, "four", 5] },
  { xs: [0, "two", 3, "four", 5, 6] },
);
addDiff("null_to_value", null, { a: [1] });
addDiff("boolean_flip", { ok: true }, { ok: false });
addDiff(
  "duplicate_elements",
  { xs: ["a", "a", "b"] },
  { xs: ["b", "a", "a"] },
);
addDiff(
  "identity_subsequence_containers",
  { xs: [{ k: 1 }, { k: 2 }, { k: 3 }] },
  { xs: [{ k: 2 }, { k: 3 }, { k: 1 }, { k: 4 }] },
);

// ── services: replicated state + provider reset ────────────────────────────
const BACKGROUND_CONTEXT = stateMod.serviceDeliveryContext();

function runStateScenario() {
  const record = { events: [], error: null };
  try {
    const state = apiMod.replicatedState({ count: 0, log: [] });
    const unsubscribe = state.subscribe((value, _context, delivery) => {
      record.events.push({
        kind: "listener",
        delivery,
        value: canon(JSON.parse(JSON.stringify(value))),
      });
    });
    // change 1: draft mutation
    state.change(BACKGROUND_CONTEXT, (draft) => {
      draft.count = 1;
      draft.log.push("one");
    });
    // change 2: scalar write
    state.change(BACKGROUND_CONTEXT, (draft) => {
      draft.count = 2;
    });
    // change 3: empty (revision consumes, no publication)
    state.change(BACKGROUND_CONTEXT, () => {});
    // replace
    state.replace(BACKGROUND_CONTEXT, { count: 2, log: ["one"], extra: true });
    // replace noop
    state.replace(BACKGROUND_CONTEXT, { count: 2, log: ["one"], extra: true });
    unsubscribe();
    // change 4: after unsubscribe — no further deliveries.
    state.change(BACKGROUND_CONTEXT, (draft) => {
      draft.count = 3;
    });
    record.final = canon(JSON.parse(JSON.stringify(state.value)));
    record.final_sequence =
      record.events.at(-1)?.delivery.sequence ?? null;
  } catch (error) {
    record.error = describeError(error);
  }
  return record;
}

function runProviderResetScenario() {
  const record = { updates: [], error: null };
  try {
    const provider = new providerMod.RemoteServiceProvider([
      { id: "svc", mode: "singleton", local: false },
    ]);
    const state = apiMod.replicatedState({ n: 0 });
    provider.provide({ id: "svc", local: false }, { state });
    const subscription = provider.subscribe("svc", "singleton", (update, _context) => {
      record.updates.push(canon(update));
      return true;
    });
    subscription.activate();
    // Drive 120 publications while the subscriber is ACTIVE: the first ones
    // deliver inline; none should buffer.
    for (let i = 1; i <= 120; i++) {
      state.change(BACKGROUND_CONTEXT, (draft) => {
        draft.n = i;
      });
    }
    // A fresh buffering subscriber: snapshot seq = 120, then 120 more
    // publications overflow the 100-slot buffer and rebaseline with reset.
    const buffered = [];
    const lateSubscription = provider.subscribe("svc", "singleton", (update, _context) => {
      buffered.push(canon(update));
      return true;
    });
    for (let i = 121; i <= 240; i++) {
      state.change(BACKGROUND_CONTEXT, (draft) => {
        draft.n = i;
      });
    }
    lateSubscription.activate();
    record.buffered = buffered;
    record.buffered_count = buffered.length;
    record.resets = buffered.filter((update) => update.type === "reset").length;
    // covered-by-snapshot: re-activate a subscriber whose snapshot is
    // current; its own sequence-bounded updates are dropped.
    const covered = [];
    const third = provider.subscribe("svc", "singleton", (update, _context) => {
      covered.push(canon(update));
      return true;
    });
    third.activate();
    record.covered_after_activate = covered.length;
    provider.dispose();
  } catch (error) {
    record.error = describeError(error);
  }
  return record;
}

function runReplicaScenario() {
  const record = { events: [], error: null };
  try {
    const replica = new stateMod.ReplicatedStateReplica();
    replica.subscribe((value, _context, delivery) => {
      record.events.push({ delivery, value: canon(JSON.parse(JSON.stringify(value))) });
    });
    replica.hydrate(1, [["r", { v: 1 }]], BACKGROUND_CONTEXT);
    replica.update(2, [["s", ["v"], 2]], BACKGROUND_CONTEXT);
    try {
      replica.update(5, [["s", ["v"], 5]], BACKGROUND_CONTEXT);
    } catch (error) {
      record.gap_error = describeError(error);
      record.value_after_gap = canon(replica.value === undefined ? null : replica.value);
    }
    try {
      replica.hydrate(9, [["s", ["v"], 9]], BACKGROUND_CONTEXT);
    } catch (error) {
      record.non_base_error = describeError(error);
    }
  } catch (error) {
    record.error = describeError(error);
  }
  return record;
}

function runValidatorScenario() {
  const record = {};
  try {
    const validator = new validatorMod.JsonRevisionValidator();
    record.plain = canon(validator.validate({ a: [1, { b: null }] }));
    record.copy_json = canon(copyJson({ a: 1, b: [true, null] }));
    record.copy_json_undefined_omitted = canon(
      copyJson({ a: undefined, b: 2 }, { omitUndefinedProperties: true }),
    );
    record.is_json = [isJsonValue({ a: 1 }), isJsonValue(new Map())];
  } catch (error) {
    record.error = describeError(error);
  }
  return record;
}

const servicesRecords = {
  state: runStateScenario(),
  provider_reset: runProviderResetScenario(),
  replica: runReplicaScenario(),
  validator: runValidatorScenario(),
};

// applyImmutable / apply / applyImmutableBatches sanity pairs
const applyChecks = [];
{
  const cases = [
    { target: null, ops: [["r", { a: 1 }]] },
    { target: { a: [1, 2, 3] }, ops: [["p", ["a"], 1, 1, ["x"]]] },
    { target: { a: [1, 2, 3] }, ops: [["m", ["a"], [2, 0, 1]]] },
    { target: { s: "ab" }, ops: [["a", ["s"], "cd"], ["t", ["s"], 1]] },
    { target: { a: { b: 1 } }, ops: [["d", ["a", "b"]]] },
  ];
  for (const item of cases) {
    applyChecks.push({
      input: canon(item),
      applied: canon(apply(structuredClone(item.target), structuredClone(item.ops))),
      immutable: canon(applyImmutable(item.target === null ? undefined : structuredClone(item.target), structuredClone(item.ops))),
      batches: canon(
        applyImmutableBatches(
          item.target === null ? undefined : structuredClone(item.target),
          [structuredClone(item.ops), structuredClone(item.ops)],
        ),
      ),
    });
  }
}

function applyImmutableBatches(target, batches) {
  let at = target;
  for (const ops of batches) at = applyImmutable(at, ops);
  return at;
}

const output = {
  meta: {
    upstream_head: "2bbfcca43",
    baseline: "590144609",
    node: process.version,
    fixed_now: FIXED_NOW,
  },
  tracker: trackerRecords,
  diffs: diffPairs,
  applies: applyChecks,
  services: servicesRecords,
  manifest: hashes,
};

const outDir = fileURLToPath(new URL(".", import.meta.url));
fs.writeFileSync(
  path.join(outDir, "chord_delta_oracle.json"),
  JSON.stringify(output, null, 1),
);
fs.writeFileSync(
  path.join(outDir, "chord_delta_oracle.manifest.json"),
  JSON.stringify(
    Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b))),
    null,
    1,
  ),
);
console.log(`captured ${trackerRecords.length} tracker scenarios, ${diffPairs.length} diff pairs`);
console.log(`staged ${Object.keys(hashes).length} files at ${staging}`);
