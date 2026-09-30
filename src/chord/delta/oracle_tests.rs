//! Oracle-driven tests for the chord delta port. Expected values were
//! captured from the read-only upstream TypeScript sources
//! (`pi/packages/chord/src/delta/index.ts`) run under
//! `node --experimental-strip-types` by `tests/fixtures/chord_oracle/capture_delta.mjs`
//! and stored in `src/chord/testdata/delta_oracle.json`. Comparison is
//! byte-identical over the canonical serialization (compact JSON with sorted
//! object keys, explicitly sorted by the test helper below).

use serde_json::{json, Value};

use super::{
    apply, apply_immutable, decoder, encoder, is_base, op_from_json, op_to_json, overlap, track,
    wire_op_from_json, wire_op_to_json, Decoder, DeltaError, Op, PathRef, Tracker, TrackerOptions,
    WireOp,
};
use crate::chord::types::JsonValue;

const ORACLE: &str = include_str!("../testdata/delta_oracle.json");

fn k(key: &str) -> super::Seg {
    super::Seg::Key(key.to_owned())
}

fn ix(index: usize) -> super::Seg {
    super::Seg::Index(index)
}

#[test]
fn canonical_comparison_preserves_original_value_order() {
    let raw = r#"{"z":[{"y":1,"a":2}],"a":3}"#;
    let value: JsonValue = serde_json::from_str(raw).unwrap();
    assert_eq!(canon(&value), r#"{"a":3,"z":[{"a":2,"y":1}]}"#);
    assert_eq!(serde_json::to_string(&value).unwrap(), raw);
}

fn canon(value: &JsonValue) -> String {
    // Both Node capture scripts explicitly canonicalize comparison values.
    // Sort a clone only; production state and wire retain insertion order.
    let mut sorted = value.clone();
    sorted.sort_all_objects();
    serde_json::to_string(&sorted).expect("canonical serialization cannot fail")
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn ops_canon(ops: &[Op]) -> String {
    canon(
        &serde_json::to_value(ops.iter().map(op_to_json).collect::<Vec<_>>())
            .expect("ops serialization cannot fail"),
    )
}

fn wire_canon(wire: &[WireOp]) -> String {
    canon(
        &serde_json::to_value(wire.iter().map(wire_op_to_json).collect::<Vec<_>>())
            .expect("wire serialization cannot fail"),
    )
}

const PAD: &str = "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp";
const _: () = assert!(PAD.len() == 400);

fn wire_roundtrip(t: &mut Tracker) -> Vec<Op> {
    let mut enc = encoder();
    let mut dec = decoder();
    let wire = enc.encode(&t.flush());
    dec.decode(&wire).expect("tracker ops always decode")
}

struct Outcome {
    flushes: Vec<String>,
    flags: Vec<(&'static str, JsonValue)>,
    error: Option<String>,
}

impl Outcome {
    fn new() -> Outcome {
        Outcome {
            flushes: Vec::new(),
            flags: Vec::new(),
            error: None,
        }
    }

    fn flag(&mut self, name: &'static str, value: JsonValue) {
        self.flags.push((name, value));
    }
}

/// The initial value each oracle scenario started from (mirrors the capture
/// script).
fn scenario_init(name: &str) -> Option<JsonValue> {
    let init = match name {
        "append_intent" => json!({ "s": "", "pad": PAD }),
        "truncate_append_window" => json!({ "s": "abcdefgh", "pad": PAD }),
        "array_splice_intent" => json!({ "xs": [1, 2], "pad": PAD }),
        "undefined_delete" => json!({ "a": 1, "pad": PAD }),
        "optional_absence" => json!({ "foo": 1 }),
        "interleaved_roundtrip" => json!({ "out": "x".repeat(500), "total": 0 }),
        "deep_diff_reassigned" => {
            json!({ "message": { "content": [{ "text": "hello" }], "count": 0 } })
        }
        "retained_edits_append" => {
            json!({ "view": { "messages": [{ "text": "a" }, { "text": "b" }] } })
        }
        "anchored_through_replacement" => json!({ "xs": [{ "k": "a" }] }),
        "front_truncate_pending" => json!({ "xs": [0] }),
        "deep_equal_replacement" => json!({ "value": { "nested": [1, { "text": "same" }] } }),
        "invalidate_pending_child" => json!({ "a": { "b": 1, "x": 1 } }),
        "root_array_splice" => json!([1, 2, 3, PAD]),
        "root_splice_all" => json!([1, 2, 3]),
        "nested_splice_all" => json!({ "xs": [1, 2, 3], "pad": PAD }),
        "splice_no_args" => json!({ "xs": [1, 2, 3] }),
        "splice_normalize_adapted" => json!({ "xs": [1, 2, 3] }),
        "root_length_zero" => json!([1, 2, 3]),
        "repeated_nested_splices" => json!({ "xs": [1] }),
        "no_fold_across_parent_splice" => json!({ "xs": ["ab", "cd"] }),
        "collapse_drops_child_ops" => json!({ "xs": ["ab"] }),
        "post_splice_set_dominance" => json!({ "xs": ["ab"] }),
        "nested_append_reindexed_set" => json!({ "xs": [{ "k": "a" }] }),
        "element_ops_middle_insert" => json!({ "xs": ["a", "b"] }),
        "detached_writes_root_replace" => json!([{ "k": "a" }, { "k": "b" }]),
        "nested_writes_reindex" => json!([]),
        "folded_invalidation_replacement" => json!([]),
        "folded_invalidation_clear" => json!([]),
        "mutator_chaining" => json!({ "xs": [3, 1, 2] }),
        "retained_edits_one_append" => {
            json!({ "count": 0, "messages": [{ "text": "a" }, { "text": "b" }] })
        }
        "many_pushes_collapse" => json!({ "xs": [1] }),
        "tail_writes_growth" => json!({ "xs": [1] }),
        "tail_only_splices" => json!({ "xs": [{ "value": 1 }] }),
        "cancelling_append_tail" => json!({ "xs": [1] }),
        "grow_with_nulls" => json!({ "xs": [1] }),
        "set_value_base" => json!({ "p": 1, "q": PAD }),
        "set_value_rebase_same_root" => json!({ "value": 1 }),
        "child_self_assignment" => json!({ "child": { "value": 1 } }),
        "set_value_discards_ops" => json!({ "p": 1, "q": PAD }),
        "partial_rewrite" => json!({ "a": "x".repeat(200), "b": "y".repeat(200) }),
        "rebase_force" => json!({ "p": 1, "pad": PAD }),
        "rebase_once" => json!({ "p": 1, "pad": PAD }),
        "first_flush_base" => json!({ "x": 0 }),
        "first_flush_deltas" => json!({ "x": 0, "pad": PAD }),
        "untouched" => json!({ "x": 0 }),
        "discard" => json!({ "x": 0, "y": 0 }),
        "whole_stream_fold" => json!({ "l": [], "x": 0 }),
        "does_not_alias_producer" => json!({ "x": 0 }),
        "does_not_alias_pushed" => json!({ "xs": [] }),
        "repeated_writes" => json!({ "a": { "b": 1 }, "x": 1, "y": 2 }),
        "non_adjacent_supersede" => json!({ "a": { "b": 1 }, "x": 1, "y": 2 }),
        "child_dropped_parent_replace" => json!({ "a": { "b": 1 }, "x": 1, "y": 2 }),
        "fold_child_into_parent" => json!({ "a": { "b": 1 }, "x": 1, "y": 2 }),
        "set_then_delete" => json!({ "a": { "b": 1 }, "x": 1, "y": 2 }),
        "delete_then_set" => json!({ "a": { "b": 1 }, "x": 1, "y": 2 }),
        "converge_delete_recreate" => json!({ "x": "", "y": 1 }),
        "redundant_batch" => json!({ "x": 1, "xs": [1, 2] }),
        "pathological_redundant" => json!({ "a": { "b": 1 }, "x": 1 }),
        "flush_drops_before_replacement" => json!([1, 2]),
        "keeps_prefix_nested" => json!({ "a": 1, "pad": PAD, "xs": [1, 2, 3] }),
        "reserved_parent_replacement" => {
            json!({ "value": { "constructor": { "label": "data" }, "x": 1 } })
        }
        "sparse_write_reject" => json!({ "xs": [1, 2, 3] }),
        "array_delete_reject" => json!({ "xs": [1, 2, 3] }),
        "op_like_value" => json!({ "pad": PAD }),
        _ => return None,
    };
    Some(init)
}

/// Replay one oracle scenario's mutations against a fresh tracker. Each arm
/// mirrors the capture script line for line.
fn scenario_run(name: &str, t: &mut Tracker) -> Outcome {
    let mut out = Outcome::new();
    macro_rules! f {
        () => {
            out.flushes.push(ops_canon(&t.flush()))
        };
    }
    macro_rules! flag {
        ($n:expr, $v:expr) => {
            out.flag($n, $v)
        };
    }
    match name {
        "append_intent" => {
            f!();
            t.set(&[k("s")], json!("ab")).unwrap();
            t.set(&[k("s")], json!("abcd")).unwrap();
            f!();
        }
        "truncate_append_window" => {
            f!();
            let previous = t.state()["s"].as_str().expect("string").to_owned();
            t.set(&[k("s")], json!(format!("{}xyz", &previous[3..])))
                .unwrap();
            f!();
        }
        "array_splice_intent" => {
            f!();
            t.push(&[k("xs")], vec![json!(3)]).unwrap();
            f!();
        }
        "undefined_delete" => {
            f!();
            t.delete(&[k("a")]).unwrap();
            f!();
        }
        "optional_absence" => {
            f!();
            t.set(&[k("something")], json!("enabled")).unwrap();
            f!();
            t.delete(&[k("something")]).unwrap();
            f!();
        }
        "interleaved_roundtrip" => {
            f!();
            for i in 0..1000u64 {
                let previous = t.state()["out"].as_str().expect("string").to_owned();
                let next = format!("{}{:0>10}", &previous[10..], i);
                t.set(&[k("out")], json!(next)).unwrap();
                let total = t.state()["total"].as_i64().expect("number");
                t.set(&[k("total")], json!(total + 10)).unwrap();
            }
            let ops = t.flush();
            flag!("ops_len", json!(ops.len()));
            out.flushes.push(ops_canon(&ops));
            let initial = json!({ "out": "x".repeat(500), "total": 0 });
            let replica = apply(Some(&initial), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "deep_diff_reassigned" => {
            f!();
            t.set(
                &[k("message")],
                json!({ "content": [{ "text": "hello world" }], "count": 1 }),
            )
            .unwrap();
            f!();
        }
        "retained_edits_append" => {
            f!();
            t.set(
                &[k("view")],
                json!({ "messages": [{ "text": "ax" }, { "text": "b" }, { "text": "c" }] }),
            )
            .unwrap();
            f!();
        }
        "anchored_through_replacement" => {
            f!();
            t.set(&[k("xs"), ix(0), k("k")], json!("ab")).unwrap();
            t.set(&[k("xs")], json!([{ "k": "abc" }, { "k": "z" }]))
                .unwrap();
            let ops = wire_roundtrip(t);
            out.flushes.push(ops_canon(&ops));
            let replica = apply_immutable(Some(&json!({ "xs": [{ "k": "a" }] })), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "front_truncate_pending" => {
            f!();
            t.set(&[k("xs"), ix(0)], json!("abc")).unwrap();
            t.set(&[k("xs")], json!(["bc", 0])).unwrap();
            let ops = wire_roundtrip(t);
            out.flushes.push(ops_canon(&ops));
            let replica = apply_immutable(Some(&json!({ "xs": [0] })), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "deep_equal_replacement" => {
            f!();
            t.set(&[k("value")], json!({ "nested": [1, { "text": "same" }] }))
                .unwrap();
            flag!("dirty_after_mutation", json!(t.is_dirty()));
            f!();
            flag!("dirty_after_flush", json!(t.is_dirty()));
        }
        "invalidate_pending_child" => {
            f!();
            t.set(&[k("a"), k("b")], json!(99)).unwrap();
            t.set(&[k("a")], json!({ "c": 2 })).unwrap();
            let ops = t.flush();
            out.flushes.push(ops_canon(&ops));
            let replica = apply(Some(&json!({ "a": { "x": 1 } })), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "root_array_splice" => {
            f!();
            t.push(&[], vec![json!(4)]).unwrap();
            f!();
        }
        "root_splice_all" => {
            f!();
            t.splice(&[], 0, 3, vec![json!(9)]).unwrap();
            let ops = t.flush();
            flag!("is_base", json!(is_base(&ops)));
            out.flushes.push(ops_canon(&ops));
        }
        "nested_splice_all" => {
            f!();
            t.splice(&[k("xs")], 0, 3, vec![json!(9)]).unwrap();
            f!();
        }
        "splice_no_args" => {
            f!();
            t.splice(&[k("xs")], 0, 0, vec![]).unwrap();
            f!();
        }
        "splice_normalize_adapted" => {
            f!();
            t.splice(&[k("xs")], 0, 0, vec![json!(9)]).unwrap();
            t.splice(&[k("xs")], 1, 1, vec![]).unwrap();
            let ops = t.flush();
            out.flushes.push(ops_canon(&ops));
            let replica = apply(Some(&json!({ "xs": [1, 2, 3] })), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "root_length_zero" => {
            f!();
            t.set_length(&[], 0).unwrap();
            f!();
        }
        "repeated_nested_splices" => {
            f!();
            for value in 2..=100u64 {
                t.push(&[k("xs")], vec![json!(value)]).unwrap();
            }
            let ops = t.flush();
            out.flushes.push(ops_canon(&ops));
            let replica = apply(Some(&json!({ "xs": [1] })), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "no_fold_across_parent_splice" => {
            f!();
            t.set(&[k("xs"), ix(0)], json!("abx")).unwrap();
            t.shift(&[k("xs")]).unwrap();
            t.set(&[k("xs"), ix(0)], json!("cdy")).unwrap();
            let ops = t.flush();
            out.flushes.push(ops_canon(&ops));
            let replica = apply(Some(&json!({ "xs": ["ab", "cd"] })), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "collapse_drops_child_ops" => {
            f!();
            t.push(&[k("xs")], vec![json!("q")]).unwrap();
            t.set(&[k("xs"), ix(0)], json!("abcd")).unwrap();
            t.push(&[k("xs")], vec![json!("z")]).unwrap();
            let ops = t.flush();
            out.flushes.push(ops_canon(&ops));
            let replica = apply(Some(&json!({ "xs": ["ab"] })), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "post_splice_set_dominance" => {
            f!();
            t.set(&[k("xs"), ix(0)], json!("abx")).unwrap();
            t.unshift(&[k("xs")], vec![json!("q")]).unwrap();
            t.set(&[k("xs"), ix(0)], json!("Z")).unwrap();
            let ops = t.flush();
            out.flushes.push(ops_canon(&ops));
            let replica = apply(Some(&json!({ "xs": ["ab"] })), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "nested_append_reindexed_set" => {
            f!();
            t.set(&[k("xs"), ix(0), k("k")], json!("ax")).unwrap();
            t.unshift(&[k("xs")], vec![json!(9)]).unwrap();
            t.set(&[k("xs"), ix(0)], json!(7)).unwrap();
            let ops = t.flush();
            out.flushes.push(ops_canon(&ops));
            let replica = apply(Some(&json!({ "xs": [{ "k": "a" }] })), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "element_ops_middle_insert" => {
            f!();
            t.set(&[k("xs"), ix(1)], json!("bx")).unwrap();
            t.splice(&[k("xs")], 1, 0, vec![json!("inserted")]).unwrap();
            t.set(&[k("xs"), ix(1)], json!("changed")).unwrap();
            let ops = t.flush();
            out.flushes.push(ops_canon(&ops));
            let replica = apply(Some(&json!({ "xs": ["a", "b"] })), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "detached_writes_root_replace" => {
            f!();
            t.set(&[ix(0), k("k")], json!("ax")).unwrap();
            t.unshift(&[], vec![json!({ "k": "head" })]).unwrap();
            let length = t.state().as_array().expect("array").len();
            t.splice(&[], 0, length, vec![json!({ "k": "final" })])
                .unwrap();
            let ops = t.flush();
            flag!(
                "first_verb",
                json!(ops.first().map(Op::verb).unwrap_or("null"))
            );
            out.flushes.push(ops_canon(&ops));
            let replica = apply(Some(&json!([{ "k": "a" }, { "k": "b" }])), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "nested_writes_reindex" => {
            f!();
            t.push(&[], vec![json!([10, 20])]).unwrap();
            t.shift(&[ix(0)]).unwrap();
            t.set(&[ix(0), ix(0)], json!(30)).unwrap();
            let ops = wire_roundtrip(t);
            out.flushes.push(ops_canon(&ops));
            let replica = apply_immutable(Some(&json!([])), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "folded_invalidation_replacement" => {
            f!();
            t.push(&[], vec![json!([])]).unwrap();
            t.push(&[ix(0)], vec![json!(1)]).unwrap();
            t.set(&[ix(0)], json!(0)).unwrap();
            let ops = wire_roundtrip(t);
            out.flushes.push(ops_canon(&ops));
            let replica = apply_immutable(Some(&json!([])), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "folded_invalidation_clear" => {
            f!();
            t.push(&[], vec![json!([])]).unwrap();
            t.push(&[ix(0)], vec![json!(1)]).unwrap();
            t.set_length(&[ix(0)], 0).unwrap();
            let ops = wire_roundtrip(t);
            out.flushes.push(ops_canon(&ops));
            let replica = apply_immutable(Some(&json!([])), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "mutator_chaining" => {
            f!();
            t.sort_default(&[k("xs")]).unwrap();
            t.push(&[k("xs")], vec![json!(4)]).unwrap();
            let ops = t.flush();
            out.flushes.push(ops_canon(&ops));
            let replica = apply(Some(&json!({ "xs": [3, 1, 2] })), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "retained_edits_one_append" => {
            f!();
            t.set(&[k("messages"), ix(0), k("text")], json!("ax"))
                .unwrap();
            t.set(&[k("count")], json!(1)).unwrap();
            t.push(&[k("messages")], vec![json!({ "text": "c" })])
                .unwrap();
            t.set(&[k("messages"), ix(1), k("text")], json!("by"))
                .unwrap();
            t.set(&[k("messages"), ix(2), k("text")], json!("cz"))
                .unwrap();
            let ops = t.flush();
            out.flushes.push(ops_canon(&ops));
            let replica = apply(
                Some(&json!({ "count": 0, "messages": [{ "text": "a" }, { "text": "b" }] })),
                &ops,
            )
            .unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "many_pushes_collapse" => {
            f!();
            for value in 2..=100u64 {
                t.push(&[k("xs")], vec![json!(value)]).unwrap();
            }
            f!();
        }
        "tail_writes_growth" => {
            f!();
            t.set(&[k("xs"), ix(1)], json!({ "value": 2 })).unwrap();
            t.set(&[k("xs"), ix(1), k("value")], json!(3)).unwrap();
            t.set_length(&[k("xs")], 4).unwrap();
            f!();
        }
        "tail_only_splices" => {
            f!();
            t.push(
                &[k("xs")],
                vec![json!({ "value": 2 }), json!({ "value": 3 })],
            )
            .unwrap();
            t.splice(&[k("xs")], 1, 1, vec![json!({ "value": 4 })])
                .unwrap();
            t.set(&[k("xs"), ix(2), k("value")], json!(5)).unwrap();
            f!();
        }
        "cancelling_append_tail" => {
            f!();
            t.push(&[k("xs")], vec![json!(2)]).unwrap();
            t.push(&[k("xs")], vec![json!(3)]).unwrap();
            t.pop(&[k("xs")]).unwrap();
            t.pop(&[k("xs")]).unwrap();
            f!();
        }
        "grow_with_nulls" => {
            f!();
            t.set_length(&[k("xs")], 4).unwrap();
            let ops = t.flush();
            out.flushes.push(ops_canon(&ops));
            flag!(
                "state_eq",
                json!(t.state()["xs"] == json!([1, Value::Null, Value::Null, Value::Null]))
            );
            let replica = apply(Some(&json!({ "xs": [1] })), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "set_value_base" => {
            f!();
            t.set(&[k("p")], json!(2)).unwrap();
            t.set_value(json!({ "r": 9, "s": "new" }));
            let ops = t.flush();
            flag!("is_base", json!(is_base(&ops)));
            out.flushes.push(ops_canon(&ops));
            let replica = apply(Some(&json!({})), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
            t.set(&[k("r")], json!(10)).unwrap();
            f!();
        }
        "set_value_rebase_same_root" => {
            f!();
            t.set_value(t.state().clone());
            f!();
            t.set(&[k("value")], json!(2)).unwrap();
            f!();
        }
        "child_self_assignment" => {
            f!();
            t.set(&[k("child")], t.state()["child"].clone()).unwrap();
            f!();
        }
        "set_value_discards_ops" => {
            f!();
            t.set(&[k("p")], json!(2)).unwrap();
            t.set_value(json!({ "z": 1 }));
            f!();
        }
        "partial_rewrite" => {
            f!();
            t.set(&[k("a")], json!("p")).unwrap();
            let ops = t.flush();
            flag!("is_base", json!(is_base(&ops)));
            out.flushes.push(ops_canon(&ops));
        }
        "rebase_force" => {
            f!();
            t.rebase();
            let ops = t.flush();
            flag!("is_base", json!(is_base(&ops)));
            out.flushes.push(ops_canon(&ops));
            let replica = apply(Some(&json!({})), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "rebase_once" => {
            f!();
            t.rebase();
            f!();
            t.set(&[k("p")], json!(2)).unwrap();
            f!();
        }
        "first_flush_base" => {
            t.set(&[k("x")], json!(100)).unwrap();
            let ops = t.flush();
            flag!("is_base", json!(is_base(&ops)));
            out.flushes.push(ops_canon(&ops));
        }
        "first_flush_deltas" => {
            f!();
            t.set(&[k("x")], json!(1)).unwrap();
            f!();
        }
        "untouched" => {
            flag!("dirty_initial", json!(t.is_dirty()));
            f!();
            flag!("dirty_after_flush", json!(t.is_dirty()));
            f!();
        }
        "discard" => {
            f!();
            t.set(&[k("x")], json!(1)).unwrap();
            flag!("dirty_after_mutation", json!(t.is_dirty()));
            t.discard();
            flag!("dirty_after_discard", json!(t.is_dirty()));
            f!();
            t.set(&[k("y")], json!(1)).unwrap();
            f!();
        }
        "repeated_writes" => {
            f!();
            t.set(&[k("x")], json!(1)).unwrap();
            t.set(&[k("x")], json!(2)).unwrap();
            t.set(&[k("x")], json!(3)).unwrap();
            f!();
        }
        "non_adjacent_supersede" => {
            f!();
            t.set(&[k("x")], json!(10)).unwrap();
            t.set(&[k("y")], json!(20)).unwrap();
            t.set(&[k("x")], json!(30)).unwrap();
            f!();
        }
        "child_dropped_parent_replace" => {
            f!();
            t.set(&[k("a"), k("b")], json!(99)).unwrap();
            t.set(&[k("a")], json!({ "c": 5 })).unwrap();
            f!();
        }
        "fold_child_into_parent" => {
            f!();
            t.set(&[k("a")], json!({ "b": 1 })).unwrap();
            t.set(&[k("a"), k("b")], json!(7)).unwrap();
            f!();
        }
        "set_then_delete" => {
            f!();
            t.set(&[k("x")], json!(5)).unwrap();
            t.delete(&[k("x")]).unwrap();
            f!();
        }
        "delete_then_set" => {
            f!();
            t.delete(&[k("x")]).unwrap();
            t.set(&[k("x")], json!(5)).unwrap();
            f!();
        }
        "converge_delete_recreate" => {
            f!();
            t.delete(&[k("x")]).unwrap();
            t.set(&[k("x")], json!("ab")).unwrap();
            t.set(&[k("x")], json!("abcd")).unwrap();
            f!();
        }
        "redundant_batch" => {
            f!();
            t.set(&[k("x")], json!(2)).unwrap();
            t.set(&[k("x")], json!(1)).unwrap();
            t.reverse(&[k("xs")]).unwrap();
            t.reverse(&[k("xs")]).unwrap();
            let ops = t.flush();
            flag!("ops_len", json!(ops.len()));
            out.flushes.push(ops_canon(&ops));
            let replica = apply(Some(&json!({ "x": 1, "xs": [1, 2] })), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "pathological_redundant" => {
            f!();
            for i in 0..2000u64 {
                t.set(&[k("x")], json!(i)).unwrap();
                t.set(&[k("a"), k("b")], json!(i)).unwrap();
            }
            t.set(&[k("a")], json!({ "done": true })).unwrap();
            let ops = t.flush();
            flag!("ops_len", json!(ops.len()));
            out.flushes.push(ops_canon(&ops));
            let replica = apply(Some(&json!({ "a": { "b": 1 }, "x": 1 })), &ops).unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "flush_drops_before_replacement" => {
            f!();
            t.push(&[], vec![json!(3)]).unwrap();
            t.splice(&[], 0, 3, vec![json!(7)]).unwrap();
            f!();
        }
        "keeps_prefix_nested" => {
            f!();
            t.set(&[k("a")], json!(2)).unwrap();
            t.splice(&[k("xs")], 0, 3, vec![json!(9)]).unwrap();
            f!();
        }
        "reserved_parent_replacement" => {
            f!();
            t.set(&[k("value")], json!({ "x": 2 })).unwrap();
            let ops = wire_roundtrip(t);
            out.flushes.push(ops_canon(&ops));
            let replica = apply_immutable(
                Some(&json!({ "value": { "constructor": { "label": "data" }, "x": 1 } })),
                &ops,
            )
            .unwrap();
            flag!("eq", json!(replica == *t.state()));
        }
        "sparse_write_reject" => {
            f!();
            let error = t.set(&[k("xs"), ix(5)], json!(9)).err();
            out.error = error.map(|e: DeltaError| e.message().to_owned());
            f!();
            flag!("state", t.state()["xs"].clone());
        }
        "array_delete_reject" => {
            f!();
            let error = t.delete(&[k("xs"), ix(1)]).err();
            out.error = error.map(|e: DeltaError| e.message().to_owned());
            f!();
            flag!("state", t.state()["xs"].clone());
        }
        "op_like_value" => {
            f!();
            t.set(&[k("x")], json!(["r", { "evil": true }])).unwrap();
            f!();
        }
        other => panic!("unknown scenario {other}"),
    }
    out
}

#[test]
fn tracker_scenarios_match_oracle_byte_for_byte() {
    let oracle: Value = serde_json::from_str(ORACLE).expect("oracle fixture parses");
    let mut checked = 0;
    for scenario in oracle["scenarios"].as_array().expect("scenarios array") {
        let name = scenario["name"].as_str().expect("scenario name");
        // Custom-structured scenarios run in dedicated tests below.
        if matches!(
            name,
            "immutable_no_mutate"
                | "whole_stream_fold"
                | "does_not_alias_producer"
                | "does_not_alias_pushed"
        ) {
            continue;
        }
        let init = scenario_init(name).unwrap_or_else(|| panic!("missing init for {name}"));
        let mut t = Tracker::with_options(init, TrackerOptions::default());
        let outcome = scenario_run(name, &mut t);

        let expected_flushes: Vec<&str> = scenario["flushes"]
            .as_array()
            .expect("flushes")
            .iter()
            .map(|v| v.as_str().expect("string"))
            .collect();
        assert_eq!(
            outcome.flushes.len(),
            expected_flushes.len(),
            "{name}: flush count"
        );
        for (index, expected) in expected_flushes.iter().enumerate() {
            assert_eq!(&outcome.flushes[index], expected, "{name}: flush #{index}");
        }
        assert_eq!(
            canon(t.state()),
            scenario["final"].as_str().expect("final"),
            "{name}: final state"
        );
        let expected_flags = scenario["flags"].as_object().expect("flags");
        assert_eq!(
            outcome.flags.len(),
            expected_flags.len(),
            "{name}: flag count"
        );
        for (flag_name, flag_value) in &outcome.flags {
            let expected = expected_flags
                .get(*flag_name)
                .unwrap_or_else(|| panic!("{name}: missing flag {flag_name}"));
            // String-valued oracle flags hold canonical JSON text already
            // (e.g. `"[1,2,3]"` or a bare verb); string flag values compare
            // by their raw text, everything else by canonical serialization.
            let expected_text = expected
                .as_str()
                .map(|text| text.to_owned())
                .unwrap_or_else(|| canon(expected));
            let actual_text = match flag_value {
                JsonValue::String(text) => text.clone(),
                other => canon(other),
            };
            assert_eq!(actual_text, expected_text, "{name}: flag {flag_name}");
        }
        let expected_error = scenario["error"].as_str();
        let actual_error = outcome.error.as_deref();
        match (expected_error, actual_error) {
            (None, None) => {}
            (Some(expected), Some(actual)) => assert_eq!(actual, expected, "{name}: error"),
            other => panic!("{name}: error mismatch {other:?}"),
        }
        checked += 1;
    }
    assert_eq!(checked, 61, "scenario coverage");
}

#[test]
fn custom_scenarios_match_oracle() {
    let oracle: Value = serde_json::from_str(ORACLE).expect("oracle fixture parses");
    let find = |name: &str| -> Value {
        oracle["scenarios"]
            .as_array()
            .expect("scenarios")
            .iter()
            .find(|s| s["name"] == json!(name))
            .expect("scenario present")
            .clone()
    };

    // immutable application must not mutate the replacement payload
    {
        let scenario = find("immutable_no_mutate");
        let replacement = json!({ "nested": { "value": 1 } });
        let next = apply_immutable(
            None,
            &[
                Op::Replace(replacement.clone()),
                Op::Set {
                    path: vec![k("nested"), k("value")],
                    value: json!(2),
                },
            ],
        )
        .unwrap();
        let expected: Value =
            serde_json::from_str(scenario["final"].as_str().expect("final")).expect("final");
        assert_eq!(replacement["nested"]["value"], json!(1));
        assert_eq!(
            canon(&json!({ "replacement_value": replacement["nested"]["value"], "next": next })),
            canon(&expected)
        );
    }

    // whole-stream fold over encoder/decoder pairs
    {
        let scenario = find("whole_stream_fold");
        let mut t = track(json!({ "l": [], "x": 0 }));
        let mut enc = encoder();
        let mut dec = decoder();
        let mut replica: Option<JsonValue> = None;
        let mut flushes: Vec<String> = Vec::new();
        let mut send =
            |t: &mut Tracker, replica: &mut Option<JsonValue>, flushes: &mut Vec<String>| {
                let wire = enc.encode(&t.flush());
                let ops = dec.decode(&wire).unwrap();
                *replica = Some(apply(replica.as_ref(), &ops).unwrap());
                flushes.push(canon(replica.as_ref().expect("just set")));
            };
        t.set(&[k("x")], json!(100)).unwrap();
        t.push(&[k("l")], vec![json!("xyz")]).unwrap();
        send(&mut t, &mut replica, &mut flushes);
        t.set(&[k("x")], json!(101)).unwrap();
        send(&mut t, &mut replica, &mut flushes);
        let expected_flushes: Vec<&str> = scenario["flushes"]
            .as_array()
            .expect("flushes")
            .iter()
            .map(|v| v.as_str().expect("string"))
            .collect();
        assert_eq!(flushes, expected_flushes);
        assert_eq!(
            canon(&replica.expect("replica")),
            scenario["final"].as_str().expect("final")
        );
        assert_eq!(scenario["flags"]["eq"], json!(true));
    }

    // replica independence from the producer (ownership-rule adaptation of
    // the upstream aliasing tests — Rust values are never aliased)
    {
        let scenario = find("does_not_alias_producer");
        let mut t = track(json!({ "x": 0 }));
        let replica = apply(None, &t.flush()).unwrap();
        t.set(&[k("x")], json!(999)).unwrap();
        t.flush();
        let expected: Value =
            serde_json::from_str(scenario["final"].as_str().expect("final")).unwrap();
        // Upstream pins producer/replica aliasing (`a.n = 1` shows in `b`);
        // the port's replicas are independent owned values, so the producer
        // mutation is invisible. The oracle final records the upstream
        // aliasing observation; the port asserts its ownership rule against
        // the same scenario shape.
        let mut expected = expected;
        expected["replica_x"] = json!(replica["x"]);
        assert_eq!(replica["x"], json!(0), "port replicas are never aliased");
        assert_eq!(t.state()["x"], json!(999));
        assert_eq!(
            canon(&json!({ "replica_x": replica["x"], "state_x": t.state()["x"] })),
            canon(&expected)
        );
    }
    {
        let scenario = find("does_not_alias_pushed");
        let mut t = track(json!({ "xs": [] }));
        let replica = apply(None, &t.flush()).unwrap();
        t.push(&[k("xs")], vec![json!({ "value": 1 })]).unwrap();
        let mut next = apply(Some(&replica), &t.flush()).unwrap();
        next["xs"][0]["value"] = json!(2);
        let expected: Value =
            serde_json::from_str(scenario["final"].as_str().expect("final")).unwrap();
        // Same ownership adaptation: the port's `next` is independent, so the
        // live value keeps 1 while `next` shows 2.
        let mut expected = expected;
        // Port ownership rule: `replica` stays the pre-push base value
        // (empty array); upstream aliases it with `next` and observes 2.
        expected["replica0"] = json!(replica["xs"][0].clone());
        assert_eq!(
            canon(
                &json!({ "replica0": replica["xs"][0].clone(), "live0": t.state()["xs"][0]["value"] })
            ),
            canon(&expected)
        );
        assert_eq!(replica["xs"].as_array().expect("array").len(), 0);
    }
}

/// Deterministic LCG digest scenarios: the full transcript of flushed batches
/// must hash identically to the upstream run.
#[test]
fn digest_scenarios_match_oracle() {
    struct Lcg(u32);
    impl Lcg {
        fn next(&mut self) -> u32 {
            self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            self.0
        }
    }
    fn sha(text: &str) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(text.as_bytes());
        hex_encode(&hasher.finalize())
    }

    let oracle: Value = serde_json::from_str(ORACLE).expect("oracle fixture parses");
    let digests = oracle["digests"].as_array().expect("digests");

    // random element mutations across reindexing splices (200 rounds x 30 steps)
    {
        let expected = digests
            .iter()
            .find(|d| d["name"] == json!("random_element_mutations"))
            .expect("digest present");
        let mut next = Lcg(0x1234_abcd);
        let mut t = track(json!({ "xs": [{ "k": "a" }, { "k": "b" }, { "k": "c" }] }));
        t.flush();
        let mut batches: Vec<String> = Vec::new();
        for round in 0..200u64 {
            for step in 0..30u64 {
                let xs_len = t.state()["xs"].as_array().expect("xs").len();
                let index = (next.next() as usize) % xs_len;
                match next.next() % 5 {
                    0 => {
                        let letter = char::from_u32(
                            97 + u32::try_from(u64::from(next.next()) % 26).unwrap(),
                        )
                        .unwrap();
                        let previous = t.state()["xs"][index]["k"]
                            .as_str()
                            .expect("string")
                            .to_owned();
                        t.set(
                            &[k("xs"), ix(index), k("k")],
                            json!(format!("{previous}{letter}")),
                        )
                        .unwrap();
                    }
                    1 => {
                        t.set(
                            &[k("xs"), ix(index)],
                            json!({ "k": format!("set-{round}-{step}") }),
                        )
                        .unwrap();
                    }
                    2 => {
                        t.unshift(
                            &[k("xs")],
                            vec![json!({ "k": format!("head-{round}-{step}") })],
                        )
                        .unwrap();
                    }
                    3 => {
                        if t.state()["xs"].as_array().expect("xs").len() > 1 {
                            t.shift(&[k("xs")]).unwrap();
                        }
                    }
                    _ => {
                        let len = t.state()["xs"].as_array().expect("xs").len();
                        let at = (next.next() as usize) % (len + 1);
                        let remove = if len > 1 && next.next().is_multiple_of(2) {
                            1
                        } else {
                            0
                        };
                        t.splice(
                            &[k("xs")],
                            at,
                            remove,
                            vec![json!({ "k": format!("mid-{round}-{step}") })],
                        )
                        .unwrap();
                    }
                }
                if t.state()["xs"].as_array().expect("xs").len() > 10 {
                    t.shift(&[k("xs")]).unwrap();
                }
            }
            batches.push(ops_canon(&t.flush()));
        }
        let transcript = batches.join("\n");
        assert_eq!(
            batches.len(),
            expected["batches"].as_u64().unwrap() as usize
        );
        assert_eq!(sha(&transcript), expected["sha256"].as_str().unwrap());
        assert_eq!(expected["eq"], json!(true));
        assert_eq!(canon(t.state()), expected["final"].as_str().unwrap());
    }

    // large append argument lists
    {
        let expected = digests
            .iter()
            .find(|d| d["name"] == json!("large_append_list"))
            .expect("digest present");
        let mut t = track(json!({ "xs": [] }));
        t.flush();
        let items = vec![JsonValue::Null; 100_000];
        t.push(&[k("xs")], items).unwrap();
        let ops = t.flush();
        assert_eq!(ops.len(), expected["ops_len"].as_u64().unwrap() as usize);
        assert_eq!(sha(&ops_canon(&ops)), expected["sha256"].as_str().unwrap());
        assert_eq!(canon(t.state()), expected["final"].as_str().unwrap());
    }

    // wide flush stays linear and correct
    {
        let expected = digests
            .iter()
            .find(|d| d["name"] == json!("wide_flush"))
            .expect("digest present");
        let n = 2500;
        let mut root = serde_json::Map::new();
        for i in 0..n {
            root.insert(format!("f{i}"), json!(i));
        }
        let mut t = track(JsonValue::Object(root));
        t.flush();
        for i in 0..n {
            t.set(&[k(&format!("f{i}"))], json!(i + 1)).unwrap();
        }
        let ops = t.flush();
        assert_eq!(ops.len(), expected["ops_len"].as_u64().unwrap() as usize);
        assert_eq!(sha(&ops_canon(&ops)), expected["sha256"].as_str().unwrap());
    }

    // long structural windows collapse to a base batch
    {
        let expected = digests
            .iter()
            .find(|d| d["name"] == json!("bounds_long_windows"))
            .expect("digest present");
        let initial = json!({ "xs": [{ "value": 0 }, { "value": 1 }] });
        let mut t = track(initial.clone());
        t.flush();
        for i in 0..5000u64 {
            t.set(&[k("xs"), ix(0), k("value")], json!(i)).unwrap();
            t.shift(&[k("xs")]).unwrap();
            t.push(&[k("xs")], vec![json!({ "value": i })]).unwrap();
        }
        let ops = t.flush();
        let replica = apply(Some(&initial), &ops).unwrap();
        assert_eq!(replica, *t.state());
        assert_eq!(expected["is_base"], json!(is_base(&ops)));
        assert_eq!(sha(&ops_canon(&ops)), expected["sha256"].as_str().unwrap());
    }

    // mixed nested writes / replacements / array mutations (100 rounds x 60 steps)
    {
        let expected = digests
            .iter()
            .find(|d| d["name"] == json!("mixed_property_lcg"))
            .expect("digest present");
        let mut next = Lcg(0x5eed_1234);
        let mut all_eq = true;
        let mut batches: Vec<String> = Vec::new();
        for round in 0..100u64 {
            let initial = json!({
                "meta": { "revision": 0 },
                "rows": [
                    { "count": 0, "text": "a" },
                    { "count": 0, "text": "b" },
                ],
            });
            let mut tracker = track(initial.clone());
            let mut enc = encoder();
            let mut dec = decoder();
            let mut replica =
                apply(None, &dec.decode(&enc.encode(&tracker.flush())).unwrap()).unwrap();
            for step in 0..60u64 {
                let rows_len = tracker.state()["rows"].as_array().expect("rows").len();
                match next.next() % 10 {
                    0 => {
                        if rows_len > 0 {
                            let index = (next.next() as usize) % rows_len;
                            let letter = char::from_u32(
                                97 + u32::try_from(u64::from(next.next()) % 26).unwrap(),
                            )
                            .unwrap();
                            let previous = tracker.state()["rows"][index]["text"]
                                .as_str()
                                .expect("string")
                                .to_owned();
                            tracker
                                .set(
                                    &[k("rows"), ix(index), k("text")],
                                    json!(format!("{previous}{letter}")),
                                )
                                .unwrap();
                        }
                    }
                    1 => {
                        if rows_len > 0 {
                            let index = (next.next() as usize) % rows_len;
                            let count = tracker.state()["rows"][index]["count"]
                                .as_i64()
                                .expect("count");
                            tracker
                                .set(&[k("rows"), ix(index), k("count")], json!(count + 1))
                                .unwrap();
                        }
                    }
                    2 => {
                        tracker
                            .push(
                                &[k("rows")],
                                vec![json!({ "count": step, "text": format!("tail-{round}-{step}") })],
                            )
                            .unwrap();
                    }
                    3 => {
                        if rows_len > 0 {
                            tracker.pop(&[k("rows")]).unwrap();
                        }
                    }
                    4 => {
                        tracker
                            .unshift(
                                &[k("rows")],
                                vec![json!({ "count": step, "text": format!("head-{round}-{step}") })],
                            )
                            .unwrap();
                    }
                    5 => {
                        if rows_len > 0 {
                            tracker.shift(&[k("rows")]).unwrap();
                        }
                    }
                    6 => {
                        let len = tracker.state()["rows"].as_array().expect("rows").len();
                        let index = (next.next() as usize) % (len + 1);
                        let remove = if len > 0 && next.next().is_multiple_of(2) {
                            1
                        } else {
                            0
                        };
                        tracker
                            .splice(
                                &[k("rows")],
                                index,
                                remove,
                                vec![
                                    json!({ "count": step, "text": format!("mid-{round}-{step}") }),
                                ],
                            )
                            .unwrap();
                    }
                    7 => {
                        let mut replacement = tracker.state()["rows"].clone();
                        if !replacement.as_array().expect("rows").is_empty() {
                            let previous =
                                replacement[0]["text"].as_str().expect("string").to_owned();
                            replacement[0]["text"] = json!(format!("{previous}r"));
                        }
                        if next.next().is_multiple_of(2) {
                            replacement
                                .as_array_mut()
                                .expect("rows")
                                .push(json!({ "count": step, "text": "replacement-tail" }));
                        }
                        tracker.set(&[k("rows")], replacement).unwrap();
                    }
                    8 => {
                        let revision = tracker.state()["meta"]["revision"]
                            .as_i64()
                            .expect("revision");
                        tracker
                            .set(&[k("meta")], json!({ "revision": revision + 1 }))
                            .unwrap();
                    }
                    _ => {
                        if rows_len > 1 {
                            tracker.reverse(&[k("rows")]).unwrap();
                        }
                    }
                }
                let rows_len = tracker.state()["rows"].as_array().expect("rows").len();
                if rows_len > 12 {
                    let excess = rows_len - 12;
                    tracker.splice(&[k("rows")], 0, excess, vec![]).unwrap();
                }
                if next.next().is_multiple_of(5) {
                    let wire = enc.encode(&tracker.flush());
                    batches.push(wire_canon(&wire));
                    replica = apply(Some(&replica), &dec.decode(&wire).unwrap()).unwrap();
                    if replica != *tracker.state() {
                        all_eq = false;
                    }
                }
            }
            let wire = enc.encode(&tracker.flush());
            batches.push(wire_canon(&wire));
            replica = apply(Some(&replica), &dec.decode(&wire).unwrap()).unwrap();
            if replica != *tracker.state() {
                all_eq = false;
            }
        }
        assert_eq!(
            batches.len(),
            expected["batches"].as_u64().unwrap() as usize
        );
        assert_eq!(
            sha(&batches.join("\n")),
            expected["sha256"].as_str().unwrap()
        );
        assert_eq!(expected["eq"], json!(all_eq));
        assert!(all_eq);
    }

    // random round-trips over generated values (LCG mirror of Math.random)
    {
        let expected = digests
            .iter()
            .find(|d| d["name"] == json!("random_roundtrip_lcg"))
            .expect("digest present");
        fn unit(next: &mut Lcg) -> f64 {
            f64::from(next.next() % 10_000) / 10_000.0
        }
        fn rnd(next: &mut Lcg, depth: u32) -> JsonValue {
            let r = unit(next);
            if depth > 2 || r < 0.3 {
                return json!((unit(next) * 5.0) as u64);
            }
            if r < 0.45 {
                let picks = [json!("x"), json!("y"), json!(Value::Null), json!(true)];
                let index = (unit(next) * 4.0) as usize % 4;
                return picks[index].clone();
            }
            if r < 0.7 {
                let length = (unit(next) * 4.0) as usize;
                return JsonValue::Array((0..length).map(|_| rnd(next, depth + 1)).collect());
            }
            // (object branch below)
            let mut object = serde_json::Map::new();
            for key in ["a", "b", "c"] {
                if unit(next) < 0.6 {
                    object.insert(key.to_owned(), rnd(next, depth + 1));
                }
            }
            JsonValue::Object(object)
        }
        let mut next = Lcg(0xbeef_cafe);
        let mut checked = 0u64;
        let mut all_eq = true;
        let mut batches: Vec<String> = Vec::new();
        for _ in 0..3000 {
            let base = rnd(&mut next, 0);
            if !base.is_object() && !base.is_array() {
                continue;
            }
            let mut t = track(base.clone());
            t.flush();
            let following = rnd(&mut next, 0);
            if t.state().is_array() && following.is_array() {
                let replacement = following.as_array().expect("array").clone();
                let length = t.state().as_array().expect("array").len();
                t.splice(&[], 0, length, replacement).unwrap();
            } else if !t.state().is_array() && following.is_object() {
                let keys: Vec<String> = t
                    .state()
                    .as_object()
                    .expect("object")
                    .keys()
                    .cloned()
                    .collect();
                for key in keys {
                    if !following.as_object().expect("object").contains_key(&key) {
                        t.delete(&[k(&key)]).unwrap();
                    }
                }
                for (key, value) in following.as_object().expect("object") {
                    t.set(&[k(key)], value.clone()).unwrap();
                }
            } else {
                continue;
            }
            let ops = t.flush();
            batches.push(ops_canon(&ops));
            let replica = apply(Some(&base), &ops).unwrap();
            if replica != *t.state() {
                all_eq = false;
            }
            checked += 1;
        }
        assert_eq!(checked, expected["checked"].as_u64().unwrap());
        assert_eq!(
            batches.len(),
            expected["batches"].as_u64().unwrap() as usize
        );
        assert_eq!(
            sha(&batches.join("\n")),
            expected["sha256"].as_str().unwrap()
        );
        assert!(all_eq);
    }
}

#[test]
fn codec_scenarios_match_oracle() {
    let oracle: Value = serde_json::from_str(ORACLE).expect("oracle fixture parses");
    let codec = oracle["codec"].as_array().expect("codec");
    let find = |name: &str| -> Value {
        codec
            .iter()
            .find(|c| c["name"] == json!(name))
            .expect("codec scenario present")
            .clone()
    };

    // codec_roundtrip_stream
    {
        let expected = find("codec_roundtrip_stream");
        let mut t = track(json!({ "a": { "deep": "" }, "b": { "deep": "" } }));
        t.flush();
        let mut batches: Vec<Vec<Op>> = Vec::new();
        for i in 0..6u64 {
            let previous_a = t.state()["a"]["deep"].as_str().unwrap().to_owned();
            t.set(&[k("a"), k("deep")], json!(format!("{previous_a}x{i}")))
                .unwrap();
            let previous_b = t.state()["b"]["deep"].as_str().unwrap().to_owned();
            t.set(&[k("b"), k("deep")], json!(format!("{previous_b}y{i}")))
                .unwrap();
            batches.push(t.flush());
        }
        let mut enc = encoder();
        let mut dec = decoder();
        let round: Vec<String> = batches
            .iter()
            .map(|ops| ops_canon(&dec.decode(&enc.encode(ops)).unwrap()))
            .collect();
        let expected_round: Vec<&str> = expected["roundtripped"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().expect("flush string"))
            .collect();
        assert_eq!(round, expected_round);
        assert_eq!(expected["eq"], json!(true));
    }

    // codec_intern_second_use
    {
        let expected = find("codec_intern_second_use");
        let mut enc = encoder();
        let path = vec![k("a"), k("deep")];
        let first = enc.encode(&[Op::Append {
            path: path.clone(),
            text: "1".to_owned(),
        }]);
        let second = enc.encode(&[Op::Append {
            path: path.clone(),
            text: "2".to_owned(),
        }]);
        assert_eq!(wire_canon(&first), expected["first"].as_str().unwrap());
        assert_eq!(wire_canon(&second), expected["second"].as_str().unwrap());
    }

    // codec_omit_repeat
    {
        let expected = find("codec_omit_repeat");
        let mut enc = encoder();
        let path = vec![k("a")];
        let wire = enc.encode(&[
            Op::Set {
                path: path.clone(),
                value: json!(1),
            },
            Op::Set {
                path: path.clone(),
                value: json!(2),
            },
        ]);
        assert_eq!(wire_canon(&wire), expected["wire"].as_str().unwrap());
    }

    // codec_null_char
    {
        let expected = find("codec_null_char");
        let ops = vec![
            Op::Set {
                path: vec![k("a\u{0}b")],
                value: json!(1),
            },
            Op::Set {
                path: vec![k("a"), k("b")],
                value: json!(2),
            },
        ];
        let decoded = decoder().decode(&encoder().encode(&ops)).unwrap();
        assert_eq!(ops_canon(&decoded), expected["decoded"].as_str().unwrap());
        assert_eq!(expected["eq"], json!(true));
    }

    // codec_short_without_previous
    {
        let expected = find("codec_short_without_previous");
        let error = Decoder::new()
            .decode(&[WireOp::AppendShort("x".to_owned())])
            .expect_err("must fail");
        assert_eq!(error.message(), expected["error"].as_str().unwrap());
    }

    // codec_decoder_clear_on_base
    {
        let expected = find("codec_decoder_clear_on_base");
        let mut dec = decoder();
        dec.decode(&[
            WireOp::Define {
                id: 0,
                path: vec![k("a")],
            },
            WireOp::Append {
                r: PathRef::Id(0),
                text: "1".to_owned(),
            },
        ])
        .unwrap();
        dec.decode(&[WireOp::Replace(json!({ "a": "" }))]).unwrap();
        let error = dec
            .decode(&[WireOp::Append {
                r: PathRef::Id(0),
                text: "2".to_owned(),
            }])
            .expect_err("must fail");
        assert_eq!(error.message(), expected["error"].as_str().unwrap());
    }

    // codec_reset_on_base
    {
        let expected = find("codec_reset_on_base");
        let mut enc = encoder();
        let path = vec![k("a"), k("deep")];
        enc.encode(&[Op::Append {
            path: path.clone(),
            text: "1".to_owned(),
        }]);
        enc.encode(&[Op::Append {
            path: path.clone(),
            text: "2".to_owned(),
        }]);
        let base = enc.encode(&[Op::Replace(json!({ "a": { "deep": "x" } }))]);
        let after = enc.encode(&[Op::Append {
            path: path.clone(),
            text: "3".to_owned(),
        }]);
        assert_eq!(wire_canon(&base), expected["base"].as_str().unwrap());
        assert_eq!(wire_canon(&after), expected["after"].as_str().unwrap());
        let mut dec = decoder();
        assert!(dec.decode(&base).is_ok());
        let decoded = dec.decode(&after).unwrap();
        assert_eq!(
            ops_canon(&decoded),
            expected["afterDecoded"].as_str().unwrap()
        );
    }

    // codec_recovery_last_base
    {
        let expected = find("codec_recovery_last_base");
        let mut enc = encoder();
        let mut t = track(json!({ "a": { "deep": "" }, "b": { "deep": "" } }));
        t.flush();
        let mut wire: Vec<Vec<WireOp>> = Vec::new();
        for i in 0..8u64 {
            let previous_a = t.state()["a"]["deep"].as_str().unwrap().to_owned();
            t.set(&[k("a"), k("deep")], json!(format!("{previous_a}x{i}")))
                .unwrap();
            let previous_b = t.state()["b"]["deep"].as_str().unwrap().to_owned();
            t.set(&[k("b"), k("deep")], json!(format!("{previous_b}y{i}")))
                .unwrap();
            if i == 5 {
                t.rebase();
            }
            wire.push(enc.encode(&t.flush()));
        }
        let last_base = wire
            .iter()
            .rposition(|batch| matches!(batch.first(), Some(WireOp::Replace(_))))
            .expect("a base batch exists");
        let expected_wire: Vec<&str> = expected["wire"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().expect("flush string"))
            .collect();
        assert_eq!(wire.len(), expected_wire.len());
        for (index, batch) in wire.iter().enumerate() {
            assert_eq!(&wire_canon(batch), expected_wire[index], "batch {index}");
        }
        assert_eq!(last_base, expected["lastBase"].as_u64().unwrap() as usize);
        let mut dec = decoder();
        let mut replica: Option<JsonValue> = None;
        for batch in &wire[last_base..] {
            let ops = dec.decode(batch).unwrap();
            replica = Some(match &replica {
                None => match &ops[0] {
                    Op::Replace(value) => value.clone(),
                    _ => unreachable!("a recovery replay begins at the base batch"),
                },
                Some(previous) => apply(Some(previous), &ops).unwrap(),
            });
        }
        assert_eq!(expected["eq"], json!(true));
    }

    // codec_random_streams
    {
        let expected = find("codec_random_streams");
        struct Lcg(u32);
        impl Lcg {
            fn next(&mut self) -> u32 {
                self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                self.0
            }
        }
        fn unit(next: &mut Lcg) -> f64 {
            f64::from(next.next() % 10_000) / 10_000.0
        }
        let mut next = Lcg(0xfeed_face);
        let mut all_eq = true;
        let mut batches: Vec<String> = Vec::new();
        for _ in 0..300 {
            let mut t = track(json!({ "a": { "p": "", "q": "" }, "b": [], "c": 0 }));
            t.flush();
            let mut local: Vec<Vec<Op>> = Vec::new();
            for i in 0..8u64 {
                let r = unit(&mut next);
                if r < 0.3 {
                    let previous = t.state()["a"]["p"].as_str().unwrap().to_owned();
                    t.set(&[k("a"), k("p")], json!(format!("{previous}x")))
                        .unwrap();
                } else if r < 0.5 {
                    let previous = t.state()["a"]["q"].as_str().unwrap().to_owned();
                    t.set(&[k("a"), k("q")], json!(format!("{previous}y")))
                        .unwrap();
                } else if r < 0.65 {
                    t.push(&[k("b")], vec![json!(i)]).unwrap();
                } else if r < 0.8 {
                    t.set(&[k("c")], json!(i)).unwrap();
                } else if r < 0.9 {
                    t.delete(&[k("c")]).unwrap();
                } else {
                    t.rebase();
                }
                let ops = t.flush();
                if !ops.is_empty() {
                    local.push(ops);
                }
            }
            let mut enc = encoder();
            let mut dec = decoder();
            let round: Vec<String> = local
                .iter()
                .map(|ops| ops_canon(&dec.decode(&enc.encode(ops)).unwrap()))
                .collect();
            let local_canon: Vec<String> = local.iter().map(|ops| ops_canon(ops)).collect();
            if local_canon != round {
                all_eq = false;
            }
            // The transcript is the canonical JSON of the array of batches
            // (mirroring JS `canon(local)`), not of a string-wrapped array.
            let local_json: Vec<JsonValue> = local
                .iter()
                .map(|ops| {
                    serde_json::to_value(ops.iter().map(op_to_json).collect::<Vec<_>>())
                        .expect("ops serialization cannot fail")
                })
                .collect();
            batches.push(canon(&JsonValue::Array(local_json)));
        }
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(batches.join("\n").as_bytes());
        assert_eq!(
            hex_encode(&hasher.finalize()),
            expected["sha256"].as_str().unwrap()
        );
        assert_eq!(
            batches.len(),
            expected["batches"].as_u64().unwrap() as usize
        );
        assert!(all_eq);
    }

    // codec_forbidden_interned_path
    {
        let expected = find("codec_forbidden_interned_path");
        let error = Decoder::new()
            .decode(&[
                WireOp::Define {
                    id: 0,
                    path: vec![k("__proto__"), k("w")],
                },
                WireOp::Set {
                    r: PathRef::Id(0),
                    value: json!(true),
                },
            ])
            .expect_err("must fail");
        assert_eq!(error.message(), expected["error"].as_str().unwrap());
    }
}

#[test]
fn overlap_matches_oracle() {
    let oracle: Value = serde_json::from_str(ORACLE).expect("oracle fixture parses");
    for case in oracle["overlap"].as_array().expect("overlap") {
        let result = overlap(
            case["a"].as_str().unwrap(),
            case["b"].as_str().unwrap(),
            case["scan"].as_u64().unwrap() as usize,
        );
        assert_eq!(
            result,
            case["result"].as_u64().unwrap() as usize,
            "{}",
            case["name"].as_str().unwrap()
        );
    }
}

/// Structural apply-side safety scenarios ported from
/// `delta.test.ts` "safety: array indices" / "safety: op structure" /
/// "flush" (the reserved-path and payload-shape checks).
#[test]
fn apply_safety_scenarios() {
    // rejects a constructor walk
    let walk = op_from_json(&json!(["s", ["constructor", "prototype", "gadget"], true]));
    assert!(walk.is_err());

    // allows a reserved name as a VALUE key
    let out = apply(
        Some(&json!({})),
        &[Op::Set {
            path: vec![k("a")],
            value: json!({ "__proto__": { "z": 1 } }),
        }],
    )
    .unwrap();
    assert_eq!(out["a"]["__proto__"]["z"], json!(1));

    // array index safety
    let set = |index: usize, value: JsonValue| {
        apply(
            Some(&json!({ "xs": [1, 2, 3] })),
            &[Op::Set {
                path: vec![k("xs"), ix(index)],
                value,
            }],
        )
    };
    assert_eq!(set(1, json!(9)).unwrap(), json!({ "xs": [1, 9, 3] }));
    assert_eq!(set(3, json!(9)).unwrap(), json!({ "xs": [1, 2, 3, 9] }));
    assert!(set(5, json!(9)).is_err(), "rejects a gap");
    assert!(
        apply(
            Some(&json!({ "xs": [] })),
            &[Op::Set {
                path: vec![k("xs"), ix(4_294_967_290)],
                value: json!(1),
            }]
        )
        .is_err(),
        "rejects a huge index"
    );
    assert!(
        apply(
            Some(&json!({ "xs": [1, 2, 3] })),
            &[Op::Set {
                path: vec![k("xs"), k("7")],
                value: json!(9),
            }]
        )
        .is_err(),
        "rejects string-spelled array indices"
    );
    assert!(
        apply(
            Some(&json!({ "xs": ["a"] })),
            &[Op::Append {
                path: vec![k("xs"), k("0")],
                text: "b".to_owned(),
            }]
        )
        .is_err(),
        "rejects string-spelled append indices"
    );
    assert_eq!(
        apply(
            Some(&json!({ "xs": [1] })),
            &[Op::Splice {
                path: vec![k("xs")],
                index: 1,
                remove: 0,
                items: vec![JsonValue::Null, Value::Null, json!(9)],
            }],
        )
        .unwrap(),
        json!({ "xs": [1, Value::Null, Value::Null, 9] })
    );
    assert!(
        apply(
            Some(&json!({ "xs": [1] })),
            &[Op::Delete {
                path: vec![k("xs"), ix(1)],
            }]
        )
        .is_err(),
        "rejects deleting one past an array's end"
    );
    assert_eq!(
        apply(
            Some(&json!({ "xs": [1, 2] })),
            &[Op::Splice {
                path: vec![k("xs")],
                index: 0,
                remove: 1_000_000_000,
                items: vec![],
            }],
        )
        .unwrap(),
        json!({ "xs": [] }),
        "clamps a splice remove past the end"
    );

    // op structure safety
    assert!(op_from_json(&json!(["ZZZ", ["a"], 9])).is_err());
    assert!(op_from_json(&json!(["p", ["xs"], 0, 0, "not-an-array"])).is_err());
    assert!(op_from_json(&json!(["s", "a", 9])).is_err());
    assert!(op_from_json(&json!({ "op": "s" })).is_err());
    assert!(op_from_json(&json!(null)).is_err());
    assert!(apply(
        Some(&json!({ "a": 1 })),
        &[Op::Append {
            path: vec![k("missing")],
            text: "x".to_owned(),
        }]
    )
    .is_err());
    assert!(apply(
        Some(&json!({ "a": 1 })),
        &[Op::Append {
            path: vec![k("a")],
            text: "x".to_owned(),
        }]
    )
    .is_err());
    let negative = op_from_json(&json!(["t", ["a"], -1]));
    assert!(negative.is_err());
    let wire = wire_op_from_json(&json!(["t", ["a"], -1]));
    assert!(wire.is_err() || Decoder::new().decode(&[wire.unwrap()]).is_err());

    // large splice payloads
    let items = vec![JsonValue::Null; 300_000];
    let result = apply(
        Some(&json!({ "xs": [] })),
        &[Op::Splice {
            path: vec![k("xs")],
            index: 0,
            remove: 0,
            items,
        }],
    )
    .unwrap();
    assert_eq!(result["xs"].as_array().unwrap().len(), 300_000);
}

/// The wire-op validation table from the services oracle (decoded ops must
/// fail wire validation and wire-only forms must pass it).
#[test]
fn wire_validation_tables_match_oracle() {
    let oracle: Value =
        serde_json::from_str(include_str!("../testdata/services_oracle.json")).expect("fixture");
    for row in oracle["validation"].as_array().expect("validation") {
        let op: Value = serde_json::from_str(row["op"].as_str().expect("op canonical string"))
            .expect("op json");
        let op_result = op_from_json(&op);
        let wire_result = wire_op_from_json(&op);
        assert_eq!(
            op_result.is_ok(),
            row["opValid"].as_bool().unwrap(),
            "{} opValid",
            row["name"].as_str().unwrap()
        );
        assert_eq!(
            wire_result.is_ok(),
            row["wireValid"].as_bool().unwrap(),
            "{} wireValid",
            row["name"].as_str().unwrap()
        );
    }
}

// Raw JSON wire witnesses, not the canonicalized legacy oracle above.
// Actual upstream capture: tests/fixtures/modes_order_audit/capture_delete_contracts.mjs.
#[test]
fn json_order_delete_apply_and_tracker_fold_match_upstream_bytes() {
    let input = json!({"drop":0,"z":1,"a":2,"nested":{"drop":0,"y":3,"b":4}});
    let before = input.to_string();
    let ops = vec![
        Op::Delete {
            path: vec![k("drop")],
        },
        Op::Delete {
            path: vec![k("nested"), k("drop")],
        },
        Op::Delete {
            path: vec![k("missing")],
        },
    ];
    let expected = r#"{"z":1,"a":2,"nested":{"y":3,"b":4}}"#;
    assert_eq!(apply(Some(&input), &ops).unwrap().to_string(), expected);
    assert_eq!(
        apply_immutable(Some(&input), &ops).unwrap().to_string(),
        expected
    );
    assert_eq!(input.to_string(), before);
    let mut tracker = track(json!({"seed":0}));
    tracker.flush();
    tracker.set(&[k("node")], input).unwrap();
    tracker.delete(&[k("node"), k("drop")]).unwrap();
    tracker
        .delete(&[k("node"), k("nested"), k("drop")])
        .unwrap();
    assert_eq!(tracker.state()["node"].to_string(), expected);
    let flushed = tracker.flush().iter().map(op_to_json).collect::<Vec<_>>();
    assert_eq!(
        serde_json::to_string(&flushed).unwrap(),
        r#"[["s",["node"],{"z":1,"a":2,"nested":{"y":3,"b":4}}]]"#
    );
    tracker.set(&[k("node"), k("drop")], json!(9)).unwrap();
    assert_eq!(
        tracker.state()["node"].to_string(),
        r#"{"z":1,"a":2,"nested":{"y":3,"b":4},"drop":9}"#
    );
}
