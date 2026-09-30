// Oracle capture for the M6 chord delta port. Runs the read-only upstream
// sources under node --experimental-strip-types and records canonical JSON of
// every flushed batch plus final state per scenario. Canonical form: compact
// JSON.stringify with recursively sorted object keys, so the Rust side
// (serde_json BTreeMap) is byte-comparable. See the report: object key order
// is the only intentional canonicalization (upstream JS uses insertion order).
import { createHash } from "node:crypto";
import {
  apply,
  applyImmutable,
  decoder,
  encoder,
  isBase,
  overlap,
  track,
} from "file:///C:/Users/13063/Desktop/code/agent%20work/pi/packages/chord/src/delta/index.ts";

const PAD = "p".repeat(400);

// Structural (key-order-insensitive) deep equality, matching the upstream
// tests' toEqual semantics; key order is not part of the contract.
function deepEq(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEq(item, b[i]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && deepEq(a[k], b[k]));
  }
  return false;
}

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const canon = (value) =>
  JSON.stringify(value, (_key, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const out = {};
      for (const key of Object.keys(v).sort()) out[key] = v[key];
      return out;
    }
    return v;
  });

const scenarios = [];
const digests = [];
let sc;

function scenario(name, init, body) {
  sc = { name, flushes: [], flags: {}, error: null };
  const t = init === null ? null : track(structuredClone(init));
  const f = () => sc.flushes.push(canon(t.flush()));
  const flag = (k, v) => (sc.flags[k] = v);
  try {
    body(t, f, flag);
  } catch (error) {
    sc.error = String(error && error.message ? error.message : error);
  }
  if (sc.final === undefined) sc.final = canon(t === null ? null : t.state);
  scenarios.push(sc);
  sc = undefined;
}

// ── tracker: intent ──────────────────────────────────────────────────────────
scenario("append_intent", { s: "", pad: PAD }, (t, f) => {
  f();
  t.state.s += "ab";
  t.state.s += "cd";
  f();
});
scenario("truncate_append_window", { s: "abcdefgh", pad: PAD }, (t, f) => {
  f();
  t.state.s = `${t.state.s.slice(3)}xyz`;
  f();
});
scenario("array_splice_intent", { xs: [1, 2], pad: PAD }, (t, f) => {
  f();
  t.state.xs.push(3);
  f();
});
scenario("undefined_delete", { a: 1, pad: PAD }, (t, f) => {
  f();
  t.state.a = undefined;
  f();
});
scenario("optional_absence", { foo: 1 }, (t, f) => {
  f();
  t.state.something = "enabled";
  f();
  t.state.something = undefined;
  f();
});
scenario("interleaved_roundtrip", { out: "x".repeat(500), total: 0 }, (t, f) => {
  f();
  for (let i = 0; i < 1000; i++) {
    t.state.out = `${t.state.out.slice(10)}${String(i).padStart(10, "0")}`;
    t.state.total += 10;
  }
  const ops = t.flush();
  sc.flags.ops_len = ops.length;
  sc.flushes.push(canon(ops));
  const replica = apply({ out: "x".repeat(500), total: 0 }, ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});
scenario("deep_diff_reassigned", { message: { content: [{ text: "hello" }], count: 0 } }, (t, f) => {
  f();
  // multi-key objects are built in SORTED key order so JS insertion-order
  // iteration matches the Rust port's BTreeMap iteration (report note D1)
  t.state.message = { content: [{ text: "hello world" }], count: 1 };
  f();
});
scenario("retained_edits_append", { view: { messages: [{ text: "a" }, { text: "b" }] } }, (t, f) => {
  f();
  t.state.view = { messages: [{ text: "ax" }, { text: "b" }, { text: "c" }] };
  f();
});
const wireRoundTrip = (t) => decoder().decode(JSON.parse(JSON.stringify(encoder().encode(t.flush()))));
scenario("anchored_through_replacement", { xs: [{ k: "a" }] }, (t, f) => {
  f();
  t.state.xs[0].k += "b";
  t.state.xs = [{ k: "abc" }, { k: "z" }];
  const ops = wireRoundTrip(t);
  sc.flushes.push(canon(ops));
  const replica = applyImmutable({ xs: [{ k: "a" }] }, ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});
scenario("front_truncate_pending", { xs: [0] }, (t, f) => {
  f();
  t.state.xs[0] = "abc";
  t.state.xs = ["bc", 0];
  const ops = wireRoundTrip(t);
  sc.flushes.push(canon(ops));
  const replica = applyImmutable({ xs: [0] }, ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});
scenario("deep_equal_replacement", { value: { nested: [1, { text: "same" }] } }, (t, f, flag) => {
  f();
  t.state.value = { nested: [1, { text: "same" }] };
  flag("dirty_after_mutation", t.dirty);
  f();
  flag("dirty_after_flush", t.dirty);
});
scenario("invalidate_pending_child", { a: { b: 1, x: 1 } }, (t, f) => {
  f();
  t.state.a.b = 99;
  t.state.a = { c: 2 };
  const ops = t.flush();
  sc.flushes.push(canon(ops));
  const replica = apply({ a: { x: 1 } }, ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});

// ── tracker: root ops ────────────────────────────────────────────────────────
scenario("root_array_splice", [1, 2, 3, PAD], (t, f) => {
  f();
  t.state.push(4);
  f();
});
scenario("root_splice_all", [1, 2, 3], (t, f) => {
  f();
  t.state.splice(0, 3, 9);
  const ops = t.flush();
  sc.flags.is_base = isBase(ops);
  sc.flushes.push(canon(ops));
});
scenario("nested_splice_all", { xs: [1, 2, 3], pad: PAD }, (t, f) => {
  f();
  t.state.xs.splice(0, 3, 9);
  f();
});
scenario("splice_no_args", { xs: [1, 2, 3] }, (t, f) => {
  f();
  t.state.xs.splice();
  f();
});
scenario("splice_normalize_adapted", { xs: [1, 2, 3] }, (t, f) => {
  f();
  t.state.xs.splice(0, 0, 9);
  t.state.xs.splice(1, 1);
  const ops = t.flush();
  sc.flushes.push(canon(ops));
  const replica = apply({ xs: [1, 2, 3] }, ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});
scenario("root_length_zero", [1, 2, 3], (t, f) => {
  f();
  t.state.length = 0;
  f();
});
scenario("repeated_nested_splices", { xs: [1] }, (t, f) => {
  f();
  for (let i = 2; i <= 100; i++) t.state.xs.push(i);
  const ops = t.flush();
  sc.flushes.push(canon(ops));
  const replica = apply({ xs: [1] }, ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});
scenario("no_fold_across_parent_splice", { xs: ["ab", "cd"] }, (t, f) => {
  f();
  t.state.xs[0] += "x";
  t.state.xs.shift();
  t.state.xs[0] += "y";
  const ops = t.flush();
  sc.flushes.push(canon(ops));
  const replica = apply({ xs: ["ab", "cd"] }, ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});
scenario("collapse_drops_child_ops", { xs: ["ab"] }, (t, f) => {
  f();
  t.state.xs.push("q");
  t.state.xs[0] += "cd";
  t.state.xs.push("z");
  const ops = t.flush();
  sc.flushes.push(canon(ops));
  const replica = apply({ xs: ["ab"] }, ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});
scenario("post_splice_set_dominance", { xs: ["ab"] }, (t, f) => {
  f();
  t.state.xs[0] += "x";
  t.state.xs.unshift("q");
  t.state.xs[0] = "Z";
  const ops = t.flush();
  sc.flushes.push(canon(ops));
  const replica = apply({ xs: ["ab"] }, ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});
scenario("nested_append_reindexed_set", { xs: [{ k: "a" }] }, (t, f) => {
  f();
  t.state.xs[0].k += "x";
  t.state.xs.unshift(9);
  t.state.xs[0] = 7;
  const ops = t.flush();
  sc.flushes.push(canon(ops));
  const replica = apply({ xs: [{ k: "a" }] }, ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});
scenario("element_ops_middle_insert", { xs: ["a", "b"] }, (t, f) => {
  f();
  t.state.xs[1] += "x";
  t.state.xs.splice(1, 0, "inserted");
  t.state.xs[1] = "changed";
  const ops = t.flush();
  sc.flushes.push(canon(ops));
  const replica = apply({ xs: ["a", "b"] }, ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});
scenario("detached_writes_root_replace", [{ k: "a" }, { k: "b" }], (t, f) => {
  f();
  t.state[0].k += "x";
  t.state.unshift({ k: "head" });
  t.state.splice(0, t.state.length, { k: "final" });
  const ops = t.flush();
  sc.flags.first_verb = ops.length > 0 ? ops[0][0] : null;
  sc.flushes.push(canon(ops));
  const replica = apply([{ k: "a" }, { k: "b" }], ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});
scenario("nested_writes_reindex", [], (t, f) => {
  f();
  t.state.push([10, 20]);
  t.state[0].shift();
  t.state[0][0] = 30;
  const ops = wireRoundTrip(t);
  sc.flushes.push(canon(ops));
  const replica = applyImmutable([], ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});
scenario("folded_invalidation_replacement", [], (t, f) => {
  f();
  t.state.push([]);
  t.state[0].push(1);
  t.state[0] = 0;
  const ops = wireRoundTrip(t);
  sc.flushes.push(canon(ops));
  const replica = applyImmutable([], ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});
scenario("folded_invalidation_clear", [], (t, f) => {
  f();
  t.state.push([]);
  t.state[0].push(1);
  t.state[0].length = 0;
  const ops = wireRoundTrip(t);
  sc.flushes.push(canon(ops));
  const replica = applyImmutable([], ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});

// deterministic random element mutations (LCG, mirrors the upstream seed)
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s;
  };
}
{
  const next = lcg(0x1234abcd);
  const t = track({ xs: [{ k: "a" }, { k: "b" }, { k: "c" }] });
  t.flush();
  const batches = [];
  for (let round = 0; round < 200; round++) {
    for (let step = 0; step < 30; step++) {
      const index = next() % t.state.xs.length;
      switch (next() % 5) {
        case 0:
          t.state.xs[index].k += String.fromCharCode(97 + (next() % 26));
          break;
        case 1:
          t.state.xs[index] = { k: `set-${round}-${step}` };
          break;
        case 2:
          t.state.xs.unshift({ k: `head-${round}-${step}` });
          break;
        case 3:
          if (t.state.xs.length > 1) t.state.xs.shift();
          break;
        default: {
          const at = next() % (t.state.xs.length + 1);
          const remove = t.state.xs.length > 1 && next() % 2 === 0 ? 1 : 0;
          t.state.xs.splice(at, remove, { k: `mid-${round}-${step}` });
        }
      }
      if (t.state.xs.length > 10) t.state.xs.shift();
    }
    batches.push(canon(t.flush()));
  }
  // verify convergence like upstream: replay all batches over the initial value
  let acc;
  let first = true;
  for (const batch of batches) {
    const ops = JSON.parse(batch);
    acc = first ? apply({ xs: [{ k: "a" }, { k: "b" }, { k: "c" }] }, ops) : apply(acc, ops);
    first = false;
  }
  const ok = deepEq(acc, JSON.parse(JSON.stringify(t.state)));
  digests.push({
    name: "random_element_mutations",
    sha256: sha(batches.join("\n")),
    batches: batches.length,
    eq: ok,
    final: canon(t.state),
  });
}
scenario("mutator_chaining", { xs: [3, 1, 2] }, (t, f) => {
  f();
  t.state.xs.sort();
  t.state.xs.push(4);
  const ops = t.flush();
  sc.flushes.push(canon(ops));
  const replica = apply({ xs: [3, 1, 2] }, ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});
scenario("retained_edits_one_append", { count: 0, messages: [{ text: "a" }, { text: "b" }] }, (t, f) => {
  f();
  t.state.messages[0].text += "x";
  t.state.count = 1;
  t.state.messages.push({ text: "c" });
  t.state.messages[1].text += "y";
  t.state.messages[2].text += "z";
  const ops = t.flush();
  sc.flushes.push(canon(ops));
  const replica = apply({ count: 0, messages: [{ text: "a" }, { text: "b" }] }, ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});
scenario("many_pushes_collapse", { xs: [1] }, (t, f) => {
  f();
  for (let value = 2; value <= 100; value++) t.state.xs.push(value);
  f();
});
scenario("tail_writes_growth", { xs: [1] }, (t, f) => {
  f();
  t.state.xs[1] = { value: 2 };
  t.state.xs[1].value = 3;
  t.state.xs.length = 4;
  f();
});
scenario("tail_only_splices", { xs: [{ value: 1 }] }, (t, f) => {
  f();
  t.state.xs.push({ value: 2 }, { value: 3 });
  t.state.xs.splice(1, 1, { value: 4 });
  t.state.xs[2].value = 5;
  f();
});
scenario("cancelling_append_tail", { xs: [1] }, (t, f) => {
  f();
  t.state.xs.push(2);
  t.state.xs.push(3);
  t.state.xs.pop();
  t.state.xs.pop();
  f();
});
{
  const t = track({ xs: [] });
  t.flush();
  const items = Array(100_000).fill(null);
  t.state.xs.push(...items);
  const ops = t.flush();
  digests.push({
    name: "large_append_list",
    sha256: sha(canon(ops)),
    batches: 1,
    ops_len: ops.length,
    eq: true,
    final: canon(t.state),
  });
}
scenario("grow_with_nulls", { xs: [1] }, (t, f) => {
  f();
  t.state.xs.length = 4;
  const ops = t.flush();
  sc.flushes.push(canon(ops));
  sc.flags.state_eq = deepEq(t.state.xs, [1, null, null, null]);
  const replica = apply({ xs: [1] }, ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});

// ── replacing the whole value ────────────────────────────────────────────────
scenario("set_value_base", { p: 1, q: PAD }, (t, f) => {
  f();
  t.state.p = 2;
  t.state = { r: 9, s: "new" };
  const ops = t.flush();
  sc.flags.is_base = isBase(ops);
  sc.flushes.push(canon(ops));
  const replica = apply({}, ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
  t.state.r = 10;
  f();
});
scenario("set_value_rebase_same_root", { value: 1 }, (t, f) => {
  f();
  t.state = t.state;
  f();
  t.state.value = 2;
  f();
});
scenario("child_self_assignment", { child: { value: 1 } }, (t, f) => {
  f();
  t.state.child = t.state.child;
  f();
});
scenario("set_value_discards_ops", { p: 1, q: PAD }, (t, f) => {
  f();
  t.state.p = 2;
  t.state = { z: 1 };
  f();
});
scenario("partial_rewrite", { a: "x".repeat(200), b: "y".repeat(200) }, (t, f) => {
  f();
  t.state.a = "p";
  const ops = t.flush();
  sc.flags.is_base = isBase(ops);
  sc.flushes.push(canon(ops));
});
scenario("rebase_force", { p: 1, pad: PAD }, (t, f) => {
  f();
  t.rebase();
  const ops = t.flush();
  sc.flags.is_base = isBase(ops);
  sc.flushes.push(canon(ops));
  const replica = apply({}, ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});
scenario("rebase_once", { p: 1, pad: PAD }, (t, f) => {
  f();
  t.rebase();
  f();
  t.state.p = 2;
  f();
});

// ── the first flush ──────────────────────────────────────────────────────────
scenario("first_flush_base", { x: 0 }, (t, f) => {
  t.state.x = 100;
  const ops = t.flush();
  sc.flags.is_base = isBase(ops);
  sc.flushes.push(canon(ops));
});
scenario("first_flush_deltas", { x: 0, pad: PAD }, (t, f) => {
  f();
  t.state.x = 1;
  f();
});
scenario("untouched", { x: 0 }, (t, f, flag) => {
  flag("dirty_initial", t.dirty);
  f();
  flag("dirty_after_flush", t.dirty);
  f();
});
scenario("discard", { x: 0, y: 0 }, (t, f, flag) => {
  f();
  t.state.x = 1;
  flag("dirty_after_mutation", t.dirty);
  t.discard();
  flag("dirty_after_discard", t.dirty);
  f();
  t.state.y = 1;
  f();
});

// ── immutable application and fan-out ────────────────────────────────────────
scenario("immutable_no_mutate", null, () => {
  const replacement = { nested: { value: 1 } };
  const next = applyImmutable(undefined, [
    ["r", replacement],
    ["s", ["nested", "value"], 2],
  ]);
  sc.final = canon({ next: next, replacement_value: replacement.nested.value });
  sc.flushes = [];
});
scenario("whole_stream_fold", { l: [], x: 0 }, (t, f) => {
  const enc = encoder();
  const dec = decoder();
  let replica;
  const send = () => {
    replica = apply(replica, dec.decode(enc.encode(t.flush())));
    sc.flushes.push(canon(replica));
  };
  t.state.x = 100;
  t.state.l.push("xyz");
  send();
  t.state.x = 101;
  send();
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
  sc.final = canon(replica);
});
scenario("does_not_alias_producer", { x: 0 }, (t, f) => {
  const replica = apply(undefined, t.flush());
  t.state.x = 999;
  t.flush();
  sc.final = canon({ replica_x: replica.x, state_x: t.state.x });
  sc.flushes = [];
});
scenario("does_not_alias_pushed", { xs: [] }, (t, f) => {
  const replica = apply(undefined, t.flush());
  t.state.xs.push({ value: 1 });
  const next = apply(replica, t.flush());
  next.xs[0].value = 2;
  sc.final = canon({ replica0: replica.xs[0].value, live0: t.state.xs[0].value });
  sc.flushes = [];
});

// ── pending operation coalescing ─────────────────────────────────────────────
const coalesceRun = (name, mutate, init = { a: { b: 1 }, x: 1, y: 2 }) => {
  scenario(name, init, (t, f) => {
    f();
    mutate(t.state);
    f();
  });
};
coalesceRun("repeated_writes", (s) => {
  s.x = 1;
  s.x = 2;
  s.x = 3;
});
coalesceRun("non_adjacent_supersede", (s) => {
  s.x = 10;
  s.y = 20;
  s.x = 30;
});
coalesceRun("child_dropped_parent_replace", (s) => {
  s.a.b = 99;
  s.a = { c: 5 };
});
coalesceRun("fold_child_into_parent", (s) => {
  s.a = { b: 1 };
  s.a.b = 7;
});
coalesceRun("set_then_delete", (s) => {
  s.x = 5;
  delete s.x;
});
coalesceRun("delete_then_set", (s) => {
  delete s.x;
  s.x = 5;
});
scenario("converge_delete_recreate", { x: "", y: 1 }, (t, f) => {
  f();
  delete t.state.x;
  t.state.x = "ab";
  t.state.x += "cd";
  f();
});
scenario("redundant_batch", { x: 1, xs: [1, 2] }, (t, f) => {
  f();
  t.state.x = 2;
  t.state.x = 1;
  t.state.xs.reverse();
  t.state.xs.reverse();
  const ops = t.flush();
  sc.flags.ops_len = ops.length;
  sc.flushes.push(canon(ops));
  const replica = apply({ x: 1, xs: [1, 2] }, ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});
{
  const n = 2500;
  const root = {};
  for (let i = 0; i < n; i++) root[`f${i}`] = i;
  const t = track(structuredClone(root));
  t.flush();
  for (let i = 0; i < n; i++) t.state[`f${i}`] = i + 1;
  const ops = t.flush();
  digests.push({
    name: "wide_flush",
    sha256: sha(canon(ops)),
    batches: 1,
    ops_len: ops.length,
    eq: true,
    final: canon(t.state),
  });
}
scenario("pathological_redundant", { a: { b: 1 }, x: 1 }, (t, f) => {
  f();
  for (let i = 0; i < 2000; i++) {
    t.state.x = i;
    t.state.a.b = i;
  }
  t.state.a = { done: true };
  const ops = t.flush();
  sc.flags.ops_len = ops.length;
  sc.flushes.push(canon(ops));
  const replica = apply({ a: { b: 1 }, x: 1 }, ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});
{
  const initial = { xs: [{ value: 0 }, { value: 1 }] };
  const t = track(structuredClone(initial));
  t.flush();
  for (let i = 0; i < 5000; i++) {
    t.state.xs[0].value = i;
    t.state.xs.shift();
    t.state.xs.push({ value: i });
  }
  const ops = t.flush();
  const replica = apply(initial, ops);
  digests.push({
    name: "bounds_long_windows",
    sha256: sha(canon(ops)),
    batches: 1,
    is_base: isBase(ops),
    eq: deepEq(replica, JSON.parse(JSON.stringify(t.state))),
    final: canon(t.state),
  });
}

// ── flush safety ─────────────────────────────────────────────────────────────
scenario("flush_drops_before_replacement", [1, 2], (t, f) => {
  f();
  t.state.push(3);
  t.state.splice(0, 3, 7);
  f();
});
scenario("keeps_prefix_nested", { a: 1, pad: PAD, xs: [1, 2, 3] }, (t, f) => {
  f();
  t.state.a = 2;
  t.state.xs.splice(0, 3, 9);
  f();
});
scenario("reserved_parent_replacement", { value: { constructor: { label: "data" }, x: 1 } }, (t, f) => {
  f();
  t.state.value = { x: 2 };
  const ops = wireRoundTrip(t);
  sc.flushes.push(canon(ops));
  const replica = applyImmutable({ value: { constructor: { label: "data" }, x: 1 } }, ops);
  sc.flags.eq = deepEq(replica, JSON.parse(JSON.stringify(t.state)));
});
scenario("sparse_write_reject", { xs: [1, 2, 3] }, (t, f) => {
  f();
  try {
    t.state.xs[5] = 9;
  } catch (error) {
    sc.error = String(error.message);
  }
  f();
  sc.flags.state = canon(t.state.xs);
});
scenario("array_delete_reject", { xs: [1, 2, 3] }, (t, f) => {
  f();
  try {
    delete t.state.xs[1];
  } catch (error) {
    sc.error = String(error.message);
  }
  f();
  sc.flags.state = canon(t.state.xs);
});
scenario("op_like_value", { pad: PAD }, (t, f) => {
  f();
  t.state.x = ["r", { evil: true }];
  f();
});

// ── property: mixed nested writes (LCG mirror of the upstream property test)
{
  const next = lcg(0x5eed1234);
  let allEq = true;
  const batches = [];
  const trackerBatches = [];
  for (let round = 0; round < 100; round++) {
    const initial = {
      meta: { revision: 0 },
      rows: [
        { count: 0, text: "a" },
        { count: 0, text: "b" },
      ],
    };
    const tracker = track(structuredClone(initial));
    const enc = encoder();
    const dec = decoder();
    let replica = apply(undefined, dec.decode(enc.encode(tracker.flush())));
    for (let step = 0; step < 60; step++) {
      const rows = tracker.state.rows;
      switch (next() % 10) {
        case 0:
          if (rows.length > 0) rows[next() % rows.length].text += String.fromCharCode(97 + (next() % 26));
          break;
        case 1:
          if (rows.length > 0) rows[next() % rows.length].count++;
          break;
        case 2:
          rows.push({ count: step, text: `tail-${round}-${step}` });
          break;
        case 3:
          if (rows.length > 0) rows.pop();
          break;
        case 4:
          rows.unshift({ count: step, text: `head-${round}-${step}` });
          break;
        case 5:
          if (rows.length > 0) rows.shift();
          break;
        case 6: {
          const index = next() % (rows.length + 1);
          const remove = rows.length > 0 && next() % 2 === 0 ? 1 : 0;
          rows.splice(index, remove, { count: step, text: `mid-${round}-${step}` });
          break;
        }
        case 7: {
          const replacement = JSON.parse(JSON.stringify(rows));
          if (replacement.length > 0) replacement[0].text += "r";
          if (next() % 2 === 0) replacement.push({ count: step, text: "replacement-tail" });
          tracker.state.rows = replacement;
          break;
        }
        case 8:
          tracker.state.meta = { revision: tracker.state.meta.revision + 1 };
          break;
        default:
          if (rows.length > 1) rows.reverse();
      }
      if (tracker.state.rows.length > 12) tracker.state.rows.splice(0, tracker.state.rows.length - 12);
      if (next() % 5 === 0) {
        const wire = enc.encode(tracker.flush());
        batches.push(canon(wire));
        replica = apply(replica, dec.decode(wire));
        if (!deepEq(replica, JSON.parse(JSON.stringify(tracker.state)))) allEq = false;
      }
    }
    const wire = enc.encode(tracker.flush());
    batches.push(canon(wire));
    trackerBatches.push(canon(wire));
    replica = apply(replica, dec.decode(wire));
    if (!deepEq(replica, JSON.parse(JSON.stringify(tracker.state)))) allEq = false;
  }
  digests.push({
    name: "mixed_property_lcg",
    sha256: sha(batches.join("\n")),
    batches: batches.length,
    eq: allEq,
  });
}

// ── property: random round-trip (LCG mirror of the upstream rnd()) ───────────
{
  const next = lcg(0xbeefcafe);
  const rnd = (d = 0) => {
    const r = (next() % 10_000) / 10_000;
    if (d > 2 || r < 0.3) return Math.floor(((next() % 10_000) / 10_000) * 5);
    if (r < 0.45) return ["x", "y", null, true][Math.floor(((next() % 10_000) / 10_000) * 4)];
    if (r < 0.7) return Array.from({ length: Math.floor(((next() % 10_000) / 10_000) * 4) }, () => rnd(d + 1));
    const o = {};
    for (const k of ["a", "b", "c"]) if ((next() % 10_000) / 10_000 < 0.6) o[k] = rnd(d + 1);
    return o;
  };
  let checked = 0;
  let allEq = true;
  const batches = [];
  for (let i = 0; i < 3000; i++) {
    const base = rnd();
    if (typeof base !== "object" || base === null) continue;
    const t = track(structuredClone(base));
    t.flush();
    const nxt = rnd();
    if (Array.isArray(t.state) && Array.isArray(nxt)) {
      t.state.splice(0, t.state.length, ...nxt);
    } else if (!Array.isArray(t.state) && typeof nxt === "object" && nxt !== null && !Array.isArray(nxt)) {
      const s = t.state;
      for (const k of Object.keys(s)) if (!(k in nxt)) delete s[k];
      for (const [k, v] of Object.entries(nxt)) s[k] = v;
    } else continue;
    const ops = t.flush();
    batches.push(canon(ops));
    const replica = apply(structuredClone(base), ops);
    if (!deepEq(replica, JSON.parse(JSON.stringify(t.state)))) allEq = false;
    checked++;
  }
  digests.push({
    name: "random_roundtrip_lcg",
    sha256: sha(batches.join("\n")),
    batches: batches.length,
    checked,
    eq: allEq,
  });
}

// ── codec hand scenarios ─────────────────────────────────────────────────────
const codecScenarios = [];
{
  const t = track({ a: { deep: "" }, b: { deep: "" } });
  t.flush();
  const batches = [];
  for (let i = 0; i < 6; i++) {
    t.state.a.deep += `x${i}`;
    t.state.b.deep += `y${i}`;
    batches.push(t.flush());
  }
  const enc = encoder();
  const dec = decoder();
  const round = batches.map((ops) => dec.decode(enc.encode(ops)));
  codecScenarios.push({
    name: "codec_roundtrip_stream",
    batches: batches.map(canon),
    roundtripped: round.map(canon),
    eq: deepEq(batches, round),
  });
}
{
  const enc = encoder();
  const p = ["a", "deep"];
  const first = enc.encode([["a", p, "1"]]);
  const second = enc.encode([["a", p, "2"]]);
  codecScenarios.push({ name: "codec_intern_second_use", first: canon(first), second: canon(second) });
}
{
  const enc = encoder();
  const p = ["a"];
  const wire = enc.encode([
    ["s", p, 1],
    ["s", p, 2],
  ]);
  codecScenarios.push({ name: "codec_omit_repeat", wire: canon(wire) });
}
{
  const ops = [
    ["s", ["a\u0000b"], 1],
    ["s", ["a", "b"], 2],
  ];
  const decoded = decoder().decode(encoder().encode(ops));
  codecScenarios.push({ name: "codec_null_char", decoded: canon(decoded), eq: canon(decoded) === canon(ops) });
}
{
  let error = null;
  try {
    decoder().decode([["a", "x"]]);
  } catch (e) {
    error = String(e.message);
  }
  codecScenarios.push({ name: "codec_short_without_previous", error });
}
{
  const dec = decoder();
  dec.decode([
    ["#", 0, ["a"]],
    ["a", 0, "1"],
  ]);
  dec.decode([["r", { a: "" }]]);
  let error = null;
  try {
    dec.decode([["a", 0, "2"]]);
  } catch (e) {
    error = String(e.message);
  }
  codecScenarios.push({ name: "codec_decoder_clear_on_base", error });
}
{
  const enc = encoder();
  const p = ["a", "deep"];
  enc.encode([["a", p, "1"]]);
  enc.encode([["a", p, "2"]]);
  const base = enc.encode([["r", { a: { deep: "x" } }]]);
  const after = enc.encode([["a", p, "3"]]);
  const dec = decoder();
  let baseError = null;
  let afterDecoded = null;
  try {
    dec.decode(base);
  } catch (e) {
    baseError = String(e.message);
  }
  try {
    afterDecoded = canon(dec.decode(after));
  } catch (e) {
    afterDecoded = null;
  }
  codecScenarios.push({
    name: "codec_reset_on_base",
    base: canon(base),
    after: canon(after),
    baseError,
    afterDecoded,
  });
}
{
  const enc = encoder();
  const t = track({ a: { deep: "" }, b: { deep: "" } });
  t.flush();
  const wire = [];
  for (let i = 0; i < 8; i++) {
    t.state.a.deep += `x${i}`;
    t.state.b.deep += `y${i}`;
    if (i === 5) t.rebase();
    wire.push(enc.encode(t.flush()));
  }
  const lastBase = wire.map(isBase).lastIndexOf(true);
  const dec = decoder();
  let replica;
  for (const w of wire.slice(lastBase)) {
    const ops = dec.decode(w);
    replica = replica === undefined ? structuredClone(ops[0][1]) : apply(replica, ops);
  }
  codecScenarios.push({
    name: "codec_recovery_last_base",
    wire: wire.map(canon),
    lastBase,
    eq: deepEq(replica, JSON.parse(JSON.stringify(t.state))),
  });
}
{
  const next = lcg(0xfeedface);
  let allEq = true;
  const batches = [];
  for (let round = 0; round < 300; round++) {
    const t = track({ a: { p: "", q: "" }, b: [], c: 0 });
    t.flush();
    const local = [];
    for (let i = 0; i < 8; i++) {
      const r = (next() % 10_000) / 10_000;
      if (r < 0.3) t.state.a.p += "x";
      else if (r < 0.5) t.state.a.q += "y";
      else if (r < 0.65) t.state.b.push(i);
      else if (r < 0.8) t.state.c = i;
      else if (r < 0.9) delete t.state.c;
      else t.rebase();
      const ops = t.flush();
      if (ops.length > 0) local.push(ops);
    }
    const enc = encoder();
    const dec = decoder();
    const roundOps = local.map((ops) => dec.decode(enc.encode(ops)));
    const ok = deepEq(local, roundOps);
    if (!ok) allEq = false;
    batches.push(canon(local));
  }
  codecScenarios.push({
    name: "codec_random_streams",
    sha256: sha(batches.join("\n")),
    batches: batches.length,
    eq: allEq,
  });
}
{
  let error = null;
  try {
    decoder().decode([
      ["#", 0, ["__proto__", "w"]],
      ["s", 0, true],
    ]);
  } catch (e) {
    error = String(e.message);
  }
  codecScenarios.push({ name: "codec_forbidden_interned_path", error });
}

// ── overlap ──────────────────────────────────────────────────────────────────
const overlapScenarios = [
  { name: "overlap_short", a: "abcdefgh", b: "defghxyz", scan: 65_536, result: overlap("abcdefgh", "defghxyz", 65_536) },
  { name: "overlap_disabled", a: "abcdef", b: "defghi", scan: 0, result: overlap("abcdef", "defghi", 0) },
];

const out = { scenarios, digests, codec: codecScenarios, overlap: overlapScenarios };
process.stdout.write(JSON.stringify(out));
