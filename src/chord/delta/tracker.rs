//! Port of the upstream `track()` write-time operation log
//! (`packages/chord/src/delta/index.ts:310-1179`).
//!
//! Mutations are recorded directly into a slot log with an active trie for
//! coalescing; retired child generations preserve dominance across array
//! reindexing. This module reproduces that machinery over an explicit
//! path-addressed mutation API (the upstream proxy traps are the JS-specific
//! front end; the observable behavior — which op is recorded, in which
//! coalesced form — is what the port keeps). See the [`super`] module docs for
//! the deferred proxy-identity surface.
//!
//! Every mutator follows the upstream trap order: inspect the target
//! immutably, record the operation, then mutate the target and run
//! [`Tracker::collapse_pending`].

use std::collections::HashMap;

use super::{
    diff_value, is_reserved, slice_utf16_from, splice_clamped, DeltaError, JsonValue, Op, Path, Seg,
};

#[derive(Debug)]
struct StrSlot {
    anchor: String,
    value: String,
}

#[derive(Debug)]
struct Slot {
    op: Op,
    dead: bool,
    order: u64,
    /// Position in `log`; refreshed by compaction.
    index: usize,
    str: Option<StrSlot>,
}

#[derive(Debug, Default)]
struct LogNode {
    slots: Vec<usize>,
    kids: HashMap<Seg, usize>,
    retired_kids: Vec<HashMap<Seg, usize>>,
    last_order: Option<u64>,
}

/// `track(root)`: take ownership of `root` and start tracking. Port of
/// `track<T extends object>` (`delta/index.ts:310`); the first flush is
/// always a base batch (`delta/index.ts:532-542`).
pub fn track(root: JsonValue) -> Tracker {
    Tracker::with_options(root, TrackerOptions::default())
}

/// Tracker options. Port of `TrackerOptions` (`delta/index.ts:108-110`).
#[derive(Clone, Copy, Debug)]
pub struct TrackerOptions {
    /// Fall back to a per-diff set once string overlap scanning would address
    /// more than this many UTF-16 code units (`maxOverlapScan`, default
    /// 65,536, `delta/index.ts:311`).
    pub max_overlap_scan: usize,
}

impl Default for TrackerOptions {
    fn default() -> Self {
        TrackerOptions {
            max_overlap_scan: 65_536,
        }
    }
}

/// Tracker over a JSON value. Port of the upstream `Tracker<T>` interface
/// (`delta/index.ts:112-127`) and the log machinery of `track`
/// (`delta/index.ts:310-1179`). The tracked value is mutated only through the
/// typed methods below; each mirrors the observable behavior of one upstream
/// proxy trap or array mutator.
#[derive(Debug)]
pub struct Tracker {
    target: JsonValue,
    nodes: Vec<LogNode>,
    slots: Vec<Option<Slot>>,
    /// Record-order slot ids; `None` marks a tombstone.
    log: Vec<Option<usize>>,
    next_order: u64,
    tombstones: usize,
    live_slots: usize,
    node_count: usize,
    last_added_slot: Option<usize>,
    has_pending: bool,
    force_base: bool,
    scan: usize,
}

impl Tracker {
    /// `track(root, options)` (`delta/index.ts:310-311`).
    pub fn with_options(root: JsonValue, options: TrackerOptions) -> Tracker {
        let nodes = vec![LogNode::default()];
        Tracker {
            target: root,
            nodes,
            slots: Vec::new(),
            log: Vec::new(),
            next_order: 0,
            tombstones: 0,
            live_slots: 0,
            node_count: 1,
            last_added_slot: None,
            has_pending: false,
            force_base: true,
            scan: options.max_overlap_scan,
        }
    }

    /// The tracked value (upstream `tracker.state` reads / `tracker.target`).
    pub fn state(&self) -> &JsonValue {
        &self.target
    }

    /// `rebase()` (`delta/index.ts:1146-1149`): make the next flush a complete
    /// base batch without changing the value.
    pub fn rebase(&mut self) {
        self.clear_pending();
        self.force_base = true;
    }

    /// `discard()` (`delta/index.ts:1155-1157`): accept pending mutations
    /// locally without emitting them.
    pub fn discard(&mut self) {
        self.clear_pending();
    }

    /// `dirty` (`delta/index.ts:1150-1154`): conservative — true if anything
    /// was written since the last flush, even if the writes cancelled out.
    pub fn is_dirty(&self) -> bool {
        self.force_base || self.has_pending
    }

    /// Upstream `tracker.state = next` (`delta/index.ts:1135-1145`): replace
    /// the whole value. Upstream compares reference identity with the proxy;
    /// the port compares by value, which gives the same observable outcomes:
    /// re-assigning the current value drops pending ops and rebases, any
    /// other value becomes the tracked root.
    pub fn set_value(&mut self, next: JsonValue) {
        if next == self.target {
            self.clear_pending();
            self.force_base = true;
            return;
        }
        self.clear_pending();
        self.target = next;
        self.force_base = true;
    }

    /// `flush()` (`delta/index.ts:1158-1177`): the first flush is a base
    /// batch; later flushes return the coalesced pending operations, `[]` when
    /// nothing is pending. A mutation window that restores its starting value
    /// may still produce a redundant batch.
    pub fn flush(&mut self) -> Vec<Op> {
        if self.force_base {
            let value = self.target.clone();
            self.force_base = false;
            self.clear_pending();
            return vec![Op::Replace(value)];
        }
        if !self.has_pending {
            return Vec::new();
        }
        let mut out = Vec::new();
        for entry in &self.log {
            let Some(id) = entry else { continue };
            let Some(slot) = self.slots[*id].as_ref() else {
                continue;
            };
            if slot.dead {
                continue;
            }
            if let Some(str_slot) = &slot.str {
                let path = match &slot.op {
                    Op::Set { path, .. } => path.clone(),
                    other => unreachable!("anchored string slots carry a set op, got {other:?}"),
                };
                diff_value(
                    Some(&JsonValue::String(str_slot.anchor.clone())),
                    Some(&JsonValue::String(str_slot.value.clone())),
                    &path,
                    self.scan,
                    &mut out,
                );
                continue;
            }
            out.push(slot.op.clone());
        }
        self.clear_pending();
        out
    }

    // ── Mutation API (upstream proxy traps) ─────────────────────────────────

    /// The `set` trap (`delta/index.ts:1009-1090`) for a scalar, string or
    /// whole-container value. `path` addresses the property or element from
    /// the tracked root; the empty path is the whole-value setter
    /// ([`Tracker::set_value`]). Setting an array element exactly one past
    /// the end appends (`delta/index.ts:1070-1071`); a larger gap is a sparse
    /// write and is rejected (`delta/index.ts:1049-1051`). Assigning a plain
    /// object over a plain object deep-diffs outgoing against incoming
    /// (`diffInto`, `delta/index.ts:717-757`); a string over a string anchors
    /// the path so flush emits a truncate/append pair (`recordString`).
    pub fn set(&mut self, path: &[Seg], value: JsonValue) -> Result<(), DeltaError> {
        guard(path)?;
        if path.is_empty() {
            // Upstream `tracker.state = next` is a tracker property, not a
            // proxy trap; a root set is that setter.
            self.set_value(value);
            return Ok(());
        }
        let (parent_path, last) = path.split_at(path.len() - 1);
        let key = &last[0];

        // Inspect immutably first: recording happens before the target
        // mutation, matching the upstream trap order.
        let parent_ref = read_container(&self.target, parent_path)?;
        if parent_ref.is_array() {
            let Seg::Index(index) = key else {
                return Err(DeltaError::UnsafePath {
                    segment: key.to_string(),
                });
            };
            if *index > parent_ref.as_array().expect("checked above").len() {
                return Err(DeltaError::UnsafePath {
                    segment: index.to_string(),
                });
            }
        } else {
            let Seg::Key(_) = key else {
                return Err(DeltaError::UnsafePath {
                    segment: key.to_string(),
                });
            };
        }
        let parent_is_array = parent_ref.is_array();
        let parent_len = parent_ref.as_array().map(|array| array.len());
        let previous_value: Option<JsonValue> = read_own(parent_ref, key).cloned();

        if previous_value.as_ref() == Some(&value) && !is_obj(&value) {
            // `previous === value` for primitives (JS value identity). A
            // structurally-equal container is a distinct object upstream, so
            // it proceeds into the diff branch and marks the window dirty.
            return Ok(());
        }

        if parent_is_array && matches!(key, Seg::Index(index) if Some(*index) == parent_len) {
            let index = match key {
                Seg::Index(index) => *index,
                _ => unreachable!("array key checked above"),
            };
            self.record(Op::Splice {
                path: parent_path.to_owned(),
                index,
                remove: 0,
                items: vec![clone_json(&value)],
            });
            let parent = read_container_mut(&mut self.target, parent_path)?;
            write_own(parent, key, value);
            self.collapse_pending();
            return Ok(());
        }

        let at: Path = path.to_owned();
        match (&previous_value, &value) {
            // whole-container assignment: diff locally so a producer that
            // rebuilds its partial each frame still emits appends rather than
            // replacements (delta/index.ts:1072-1075). Upstream `isObj` covers
            // arrays too — same-length arrays recurse per index and
            // differing-length arrays fall to chord's own diff.
            (Some(previous), value) if is_obj(previous) && is_obj(value) => {
                let mut scratch = at.clone();
                self.diff_into(previous.clone(), value.clone(), &mut scratch);
            }
            // A string path keeps an anchor: the value it had at the first
            // write in this window; flush diffs anchor -> final once
            // (delta/index.ts:1076-1082).
            (Some(previous), value) if previous.is_string() && value.is_string() => {
                let previous = previous.as_str().expect("checked above").to_owned();
                let value = value.as_str().expect("checked above").to_owned();
                self.record_string(&at, previous, value);
            }
            _ => {
                self.record(Op::Set {
                    path: at,
                    value: clone_json(&value),
                });
            }
        }
        let parent = read_container_mut(&mut self.target, parent_path)?;
        write_own(parent, key, value);
        self.collapse_pending();
        Ok(())
    }

    /// The `deleteProperty` trap (`delta/index.ts:1092-1105`): deletes an
    /// object property; arrays reject deletes (a sparse array does not
    /// survive a JSON round trip).
    pub fn delete(&mut self, path: &[Seg]) -> Result<(), DeltaError> {
        guard(path)?;
        if path.is_empty() {
            return Err(DeltaError::InvalidOp(
                "the tracked root cannot be deleted".to_owned(),
            ));
        }
        let (parent_path, last) = path.split_at(path.len() - 1);
        let key = &last[0];
        let parent_ref = read_container(&self.target, parent_path)?;
        if parent_ref.is_array() {
            return match key {
                Seg::Key(_) => Err(DeltaError::UnsafePath {
                    segment: key.to_string(),
                }),
                Seg::Index(_) => Err(DeltaError::InvalidOp(
                    "delete would create a sparse array; use splice instead".to_owned(),
                )),
            };
        }
        let Seg::Key(key) = key else {
            return Err(DeltaError::UnsafePath {
                segment: key.to_string(),
            });
        };
        if read_own(parent_ref, &Seg::Key(key.to_owned())).is_some() {
            self.record(Op::Delete {
                path: path.to_owned(),
            });
            let parent = read_container_mut(&mut self.target, parent_path)?;
            parent
                .as_object_mut()
                .expect("object parent checked above")
                .shift_remove(key);
            self.collapse_pending();
        }
        Ok(())
    }

    /// `push` (`delta/index.ts:909-917`): records a `p` append.
    pub fn push(&mut self, path: &[Seg], items: Vec<JsonValue>) -> Result<usize, DeltaError> {
        guard(path)?;
        let before = resolve_array(&self.target, path)?.len();
        if !items.is_empty() {
            self.record(Op::Splice {
                path: path.to_owned(),
                index: before,
                remove: 0,
                items: items.clone(),
            });
        }
        let new_len = {
            let array = resolve_array_mut(&mut self.target, path)?;
            array.extend(items);
            array.len()
        };
        self.collapse_pending();
        Ok(new_len)
    }

    /// `pop` (`delta/index.ts:927-930`): records a one-item removal.
    pub fn pop(&mut self, path: &[Seg]) -> Result<Option<JsonValue>, DeltaError> {
        guard(path)?;
        let array = resolve_array(&self.target, path)?;
        let before = array.len();
        let removed = array.last().cloned();
        if before > 0 {
            self.record(Op::Splice {
                path: path.to_owned(),
                index: before - 1,
                remove: 1,
                items: Vec::new(),
            });
        }
        let array = resolve_array_mut(&mut self.target, path)?;
        array.pop();
        self.collapse_pending();
        Ok(removed)
    }

    /// `shift` (`delta/index.ts:931-934`).
    pub fn shift(&mut self, path: &[Seg]) -> Result<Option<JsonValue>, DeltaError> {
        guard(path)?;
        let array = resolve_array(&self.target, path)?;
        let before = array.len();
        let removed = array.first().cloned();
        if before > 0 {
            self.record(Op::Splice {
                path: path.to_owned(),
                index: 0,
                remove: 1,
                items: Vec::new(),
            });
        }
        let array = resolve_array_mut(&mut self.target, path)?;
        if !array.is_empty() {
            array.remove(0);
        }
        self.collapse_pending();
        Ok(removed)
    }

    /// `unshift` (`delta/index.ts:918-926`).
    pub fn unshift(&mut self, path: &[Seg], items: Vec<JsonValue>) -> Result<usize, DeltaError> {
        guard(path)?;
        if !items.is_empty() {
            self.record(Op::Splice {
                path: path.to_owned(),
                index: 0,
                remove: 0,
                items: items.clone(),
            });
        }
        let new_len = {
            let array = resolve_array_mut(&mut self.target, path)?;
            array.splice(..0, items);
            array.len()
        };
        self.collapse_pending();
        Ok(new_len)
    }

    /// `splice` with the upstream argument normalization
    /// (`spliceRange`, `delta/index.ts:773-783`; a start past the end
    /// appends and the removal clamps to the tail). A splice that clears the
    /// whole array is a replacement of it (`delta/index.ts:944-947`).
    pub fn splice(
        &mut self,
        path: &[Seg],
        index: usize,
        remove: usize,
        items: Vec<JsonValue>,
    ) -> Result<Vec<JsonValue>, DeltaError> {
        guard(path)?;
        let array = resolve_array(&self.target, path)?;
        let before = array.len();
        let index = index.min(before);
        let remove = remove.min(before - index);
        if remove > 0 || !items.is_empty() {
            if index == 0 && remove == before {
                // a splice that clears the whole array is a replacement of it
                if path.is_empty() {
                    self.record(Op::Replace(JsonValue::Array(items.clone())));
                } else {
                    self.record(Op::Set {
                        path: path.to_owned(),
                        value: JsonValue::Array(items.clone()),
                    });
                }
            } else {
                self.record(Op::Splice {
                    path: path.to_owned(),
                    index,
                    remove,
                    items: items.clone(),
                });
            }
        }
        let array = resolve_array_mut(&mut self.target, path)?;
        let removed: Vec<JsonValue> = array.splice(index..(index + remove), items).collect();
        self.collapse_pending();
        Ok(removed)
    }

    /// The default-mutator branch (`delta/index.ts:953-962`): `sort`,
    /// `reverse`, `fill` and `copyWithin` permute rather than shift, so the
    /// whole value is re-recorded as a set (or a root replacement). The port
    /// exposes the permutation itself as a closure over the array.
    pub fn reorder<F>(&mut self, path: &[Seg], permute: F) -> Result<(), DeltaError>
    where
        F: FnOnce(&mut Vec<JsonValue>),
    {
        guard(path)?;
        {
            let array = resolve_array_mut(&mut self.target, path)?;
            permute(array);
        }
        if path.is_empty() {
            self.record(Op::Replace(self.target.clone()));
        } else {
            let array = resolve_array(&self.target, path)?;
            self.record(Op::Set {
                path: path.to_owned(),
                value: JsonValue::Array(array.clone()),
            });
        }
        self.collapse_pending();
        Ok(())
    }

    /// `sort` with the default JS comparator (elements compared by their
    /// UTF-16 string form). Convenience over [`Tracker::reorder`].
    pub fn sort_default(&mut self, path: &[Seg]) -> Result<(), DeltaError> {
        self.reorder(path, |array| array.sort_by_key(js_string_key))
    }

    /// `reverse` (`delta/index.ts:953-962` default branch).
    pub fn reverse(&mut self, path: &[Seg]) -> Result<(), DeltaError> {
        self.reorder(path, |array| array.reverse())
    }

    /// The `length` set trap (`delta/index.ts:1023-1045`): truncation records
    /// a removal splice (or a clearing set/replacement at zero); growth
    /// records explicit null values.
    pub fn set_length(&mut self, path: &[Seg], next: usize) -> Result<(), DeltaError> {
        guard(path)?;
        let before = resolve_array(&self.target, path)?.len();
        if next < before {
            if next == 0 {
                if path.is_empty() {
                    self.record(Op::Replace(JsonValue::Array(Vec::new())));
                } else {
                    self.record(Op::Set {
                        path: path.to_owned(),
                        value: JsonValue::Array(Vec::new()),
                    });
                }
            } else {
                self.record(Op::Splice {
                    path: path.to_owned(),
                    index: next,
                    remove: before - next,
                    items: Vec::new(),
                });
            }
        } else if next > before {
            self.record(Op::Splice {
                path: path.to_owned(),
                index: before,
                remove: 0,
                items: vec![JsonValue::Null; next - before],
            });
        } else {
            return Ok(());
        }
        let array = resolve_array_mut(&mut self.target, path)?;
        if next < array.len() {
            array.truncate(next);
        } else {
            array.resize(next, JsonValue::Null);
        }
        self.collapse_pending();
        Ok(())
    }

    // ── Log machinery (delta/index.ts:313-757) ──────────────────────────────

    fn clear_pending(&mut self) {
        self.log.clear();
        self.slots.clear();
        self.nodes.clear();
        self.nodes.push(LogNode::default());
        self.next_order = 0;
        self.tombstones = 0;
        self.live_slots = 0;
        self.node_count = 1;
        self.last_added_slot = None;
        self.has_pending = false;
    }

    /// `logNode` (`delta/index.ts:349-362`): walk to the node for `path`,
    /// creating missing children.
    fn log_node(&mut self, path: &[Seg]) -> usize {
        let mut at = 0usize;
        for segment in path {
            let next = self.nodes[at].kids.get(segment).copied();
            let next = match next {
                Some(next) => next,
                None => {
                    let created = self.nodes.len();
                    self.nodes.push(LogNode::default());
                    self.node_count += 1;
                    self.nodes[at].kids.insert(segment.clone(), created);
                    created
                }
            };
            at = next;
        }
        at
    }

    /// `findLogNode` (`delta/index.ts:364-372`).
    fn find_log_node(&self, path: &[Seg]) -> Option<usize> {
        let mut at = 0usize;
        for segment in path {
            let next = self.nodes[at].kids.get(segment).copied()?;
            at = next;
        }
        Some(at)
    }

    /// `compactLog` (`delta/index.ts:374-384`).
    fn compact_log(&mut self) {
        if self.tombstones < 1_024 || self.tombstones * 2 < self.log.len() {
            return;
        }
        let mut compacted: Vec<Option<usize>> = Vec::with_capacity(self.log.len());
        for entry in std::mem::take(&mut self.log) {
            let Some(id) = entry else { continue };
            if let Some(slot) = self.slots[id].as_mut() {
                slot.index = compacted.len();
            }
            compacted.push(Some(id));
        }
        self.log = compacted;
        self.tombstones = 0;
    }

    /// `killSlot` (`delta/index.ts:386-394`).
    fn kill_slot(&mut self, id: usize) {
        let Some(slot) = self.slots[id].as_mut() else {
            return;
        };
        if slot.dead {
            return;
        }
        slot.dead = true;
        self.live_slots -= 1;
        let index = slot.index;
        if self.log.get(index) == Some(&Some(id)) {
            self.log[index] = None;
            self.tombstones += 1;
        }
    }

    /// `liveSlot` (`delta/index.ts:396-405`): drop dead tail slots and return
    /// the newest live slot at the node.
    fn live_slot(&mut self, node: usize) -> Option<usize> {
        while let Some(&last) = self.nodes[node].slots.last() {
            if self.slots[last].as_ref().is_some_and(|slot| slot.dead) {
                self.nodes[node].slots.pop();
            } else {
                break;
            }
        }
        self.nodes[node].slots.last().copied()
    }

    /// `killHere` (`delta/index.ts:407-411`).
    fn kill_here(&mut self, node: usize) {
        for id in std::mem::take(&mut self.nodes[node].slots) {
            self.kill_slot(id);
        }
    }

    /// `addSlot` (`delta/index.ts:413-423`).
    fn add_slot(&mut self, node: usize, mut slot: Slot) {
        self.compact_log();
        slot.order = self.next_order;
        self.next_order += 1;
        slot.index = self.log.len();
        self.nodes[node].last_order = Some(slot.order);
        let id = self.slots.len();
        self.slots.push(Some(slot));
        self.nodes[node].slots.push(id);
        self.log.push(Some(id));
        self.live_slots += 1;
        self.last_added_slot = Some(id);
    }

    /// `collapsePending` (`delta/index.ts:425-435`): fall back to a complete
    /// snapshot once either history dimension exceeds the bounded coalescing
    /// window.
    fn collapse_pending(&mut self) {
        if self.force_base || (self.live_slots <= 4_096 && self.node_count <= 4_096) {
            return;
        }
        let value = self.target.clone();
        self.clear_pending();
        self.has_pending = true;
        self.add_slot(
            0,
            Slot {
                op: Op::Replace(value),
                dead: false,
                order: 0,
                index: 0,
                str: None,
            },
        );
    }

    /// `killSubtree` (`delta/index.ts:437-449`).
    fn kill_subtree(&mut self, node: usize) {
        self.kill_here(node);
        for (_, child) in std::mem::take(&mut self.nodes[node].kids) {
            self.kill_subtree(child);
        }
        for generation in std::mem::take(&mut self.nodes[node].retired_kids) {
            for (_, child) in generation {
                self.kill_subtree(child);
            }
        }
    }

    /// `retireKids` (`delta/index.ts:451-456`): splices preserve earlier
    /// writes but form a barrier for later folding.
    fn retire_kids(&mut self, node: usize) {
        if self.nodes[node].kids.is_empty() {
            return;
        }
        let kids = std::mem::take(&mut self.nodes[node].kids);
        self.nodes[node].retired_kids.push(kids);
    }

    /// `foldTarget` (`delta/index.ts:461-491`): the deepest live ancestor op
    /// carrying a payload we can fold a later write into. `s`/`r` carry the
    /// whole subtree; `p` carries the items it inserted.
    fn fold_target(&mut self, path: &[Seg]) -> Option<FoldTarget> {
        let mut at = 0usize;
        let mut found: Option<(usize, usize, Option<usize>)> = None; // (slot, depth, item)
        let mut ancestor_max: Option<u64> = None;
        for depth in 0..path.len() {
            if let Some((slot, _, _)) = found {
                let slot_order = self.slots[slot].as_ref().map(|s| s.order).unwrap_or(0);
                if self.nodes[at]
                    .last_order
                    .is_some_and(|order| order > slot_order)
                {
                    found = None;
                }
            }
            let slot = self.live_slot(at);
            if let Some(slot) = slot {
                let slot_order = self.slots[slot].as_ref().map(|s| s.order).unwrap_or(0);
                // A fold is sound only if nothing has been recorded at this
                // path or above it since (delta/index.ts:469-475). Writes to
                // other branches are irrelevant, which is why this is not
                // "the most recent op".
                if ancestor_max.is_none_or(|max| slot_order >= max)
                    && self.nodes[at].last_order == Some(slot_order)
                {
                    let slot_op = self.slots[slot].as_ref().map(|s| &s.op);
                    match slot_op {
                        Some(Op::Set { .. }) | Some(Op::Replace(_)) => {
                            found = Some((slot, depth, None));
                        }
                        Some(Op::Splice { index, items, .. }) => {
                            if let Some(Seg::Index(at_index)) = path.get(depth) {
                                if *at_index >= *index && *at_index < index + items.len() {
                                    found = Some((slot, depth + 1, Some(at_index - index)));
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            if self.nodes[at]
                .last_order
                .is_some_and(|order| ancestor_max.is_none_or(|max| order > max))
            {
                ancestor_max = self.nodes[at].last_order;
            }
            let next = self.nodes[at].kids.get(&path[depth]).copied();
            let Some(next) = next else { break };
            at = next;
        }
        let (slot, depth, item) = found?;
        Some(FoldTarget {
            slot,
            rest: path[depth..].to_vec(),
            item,
        })
    }

    /// `foldInto` (`delta/index.ts:493-535`): write `op` into a pending
    /// payload at `rest`. Returns false when the fold does not apply.
    fn fold_into(container: &mut JsonValue, rest: &[Seg], op: &Op) -> bool {
        if rest.is_empty() {
            return false;
        }
        let mut target = container;
        for segment in &rest[..rest.len() - 1] {
            if !target.is_object() && !target.is_array() {
                return false;
            }
            let next = match segment {
                Seg::Key(key) => target.as_object_mut().and_then(|o| o.get_mut(key)),
                Seg::Index(index) => target.as_array_mut().and_then(|a| a.get_mut(*index)),
            };
            let Some(next) = next else { return false };
            target = next;
        }
        if !target.is_object() && !target.is_array() {
            return false;
        }
        let Some(key) = rest.last() else { return false };
        if let Some(object) = target.as_object_mut() {
            let Seg::Key(key) = key else { return false };
            return fold_into_object(object, key, op);
        }
        if let Some(array) = target.as_array_mut() {
            let Seg::Index(index) = key else { return false };
            return fold_into_array(array, *index, op);
        }
        false
    }

    /// `recordString` (`delta/index.ts:537-590`).
    fn record_string(&mut self, path: &[Seg], previous: String, value: String) {
        if self.force_base {
            return;
        }
        self.has_pending = true;
        // a string inside a pending payload belongs in that payload, as for
        // any write
        if let Some(fold) = self.fold_target(path) {
            let op = Op::Set {
                path: path.to_owned(),
                value: JsonValue::String(value.clone()),
            };
            if let Some(item) = fold.item {
                if fold.rest.is_empty() {
                    if let Some(Op::Splice { items, .. }) = as_op_mut(&mut self.slots[fold.slot]) {
                        items[item] = JsonValue::String(value);
                    }
                    return;
                }
                if let Some(Op::Splice { items, .. }) = as_op_mut(&mut self.slots[fold.slot]) {
                    if Self::fold_into(&mut items[item], &fold.rest, &op) {
                        return;
                    }
                }
            } else {
                let payload = payload_mut(&mut self.slots[fold.slot]);
                if let Some(payload) = payload {
                    if Self::fold_into(payload, &fold.rest, &op) {
                        return;
                    }
                }
            }
        }
        let at = self.log_node(path);
        let live = self.live_slot(at);
        if let Some(live) = live {
            let anchored = self.slots[live].as_ref().is_some_and(|s| s.str.is_some());
            if anchored {
                if let Some(slot) = self.slots[live].as_mut() {
                    if let Some(str_slot) = &mut slot.str {
                        str_slot.value = value;
                    }
                }
                return;
            }
            let verb = self.slots[live].as_ref().map(|s| s.op.verb());
            match verb {
                // a pending set or delete at this path already replaced the
                // value; keep that op and carry the new value in it rather
                // than anchoring to it (delta/index.ts:562-578)
                Some("s") => {
                    if let Some(slot) = self.slots[live].as_mut() {
                        if let Op::Set {
                            value: existing, ..
                        } = &mut slot.op
                        {
                            *existing = JsonValue::String(value);
                        }
                    }
                    return;
                }
                Some("r") => {
                    if let Some(slot) = self.slots[live].as_mut() {
                        slot.op = Op::Replace(JsonValue::String(value));
                    }
                    return;
                }
                Some("d") => {
                    self.kill_here(at);
                    self.add_slot(
                        at,
                        Slot {
                            op: Op::Set {
                                path: path.to_owned(),
                                value: JsonValue::String(value.clone()),
                            },
                            dead: false,
                            order: 0,
                            index: 0,
                            str: None,
                        },
                    );
                    return;
                }
                // a truncate/append pair from an earlier string diff: both
                // must go
                Some(_) => self.kill_here(at),
                None => {}
            }
        }
        self.kill_subtree(at);
        self.add_slot(
            at,
            Slot {
                op: Op::Set {
                    path: path.to_owned(),
                    value: JsonValue::String(value.clone()),
                },
                dead: false,
                order: 0,
                index: 0,
                str: Some(StrSlot {
                    anchor: previous,
                    value,
                }),
            },
        );
    }

    /// `record` (`delta/index.ts:592-709`).
    fn record(&mut self, op: Op) {
        if self.force_base {
            return;
        }
        self.has_pending = true;
        let path: Path = match &op {
            Op::Replace(_) => Vec::new(),
            other => other.path().cloned().unwrap_or_default(),
        };
        if let Some(existing) = self.find_log_node(&path) {
            if let Some(anchored) = self.live_slot(existing) {
                let is_str = self.slots[anchored]
                    .as_ref()
                    .is_some_and(|s| s.str.is_some());
                if is_str {
                    match &op {
                        Op::Append { text, .. } => {
                            if let Some(slot) = self.slots[anchored].as_mut() {
                                if let Some(str_slot) = &mut slot.str {
                                    str_slot.value.push_str(text);
                                }
                            }
                            return;
                        }
                        Op::Truncate { count, .. } => {
                            if let Some(slot) = self.slots[anchored].as_mut() {
                                if let Some(str_slot) = &mut slot.str {
                                    let cut = slice_utf16_from(&str_slot.value, *count).to_owned();
                                    str_slot.value = cut;
                                }
                            }
                            return;
                        }
                        Op::Set { value, .. } if value.is_string() => {
                            if let Some(slot) = self.slots[anchored].as_mut() {
                                if let Some(str_slot) = &mut slot.str {
                                    str_slot.value =
                                        value.as_str().expect("checked above").to_owned();
                                }
                            }
                            return;
                        }
                        _ => {}
                    }
                    self.kill_subtree(existing);
                } else if matches!(op.verb(), "s" | "d" | "r") {
                    // A replacement absorbed into an ancestor payload must
                    // still invalidate operations already recorded at and
                    // below its destination (delta/index.ts:613-617).
                    self.kill_subtree(existing);
                }
            } else if matches!(op.verb(), "s" | "d" | "r") {
                self.kill_subtree(existing);
            }
        }

        if !path.is_empty() {
            let fold = self.fold_target(&path);
            if let Some(fold) = fold {
                if let Some(item) = fold.item {
                    if fold.rest.is_empty() {
                        if let Op::Set { value, .. } = &op {
                            if let Some(Op::Splice { items, .. }) =
                                as_op_mut(&mut self.slots[fold.slot])
                            {
                                items[item] = clone_json(value);
                                return;
                            }
                        }
                    } else if let Some(Op::Splice { items, .. }) =
                        as_op_mut(&mut self.slots[fold.slot])
                    {
                        if Self::fold_into(&mut items[item], &fold.rest, &op) {
                            return;
                        }
                    }
                } else {
                    let payload = payload_mut(&mut self.slots[fold.slot]);
                    if let Some(payload) = payload {
                        if Self::fold_into(payload, &fold.rest, &op) {
                            return;
                        }
                    }
                }
            }
        }

        let at = self.log_node(&path);
        let live = self.live_slot(at);
        if let Some(live) = live {
            let previous_verb = self.slots[live].as_ref().map(|s| s.op.verb());
            match &op {
                Op::Append { text, .. } => match previous_verb {
                    Some("a") => {
                        if let Some(slot) = self.slots[live].as_mut() {
                            if let Op::Append { text: existing, .. } = &mut slot.op {
                                existing.push_str(text);
                            }
                        }
                        return;
                    }
                    Some("s") => {
                        if let Some(slot) = self.slots[live].as_mut() {
                            if let Op::Set { value, .. } = &mut slot.op {
                                if value.is_string() {
                                    let merged = format!(
                                        "{}{}",
                                        value.as_str().expect("checked above"),
                                        text
                                    );
                                    *value = JsonValue::String(merged);
                                    return;
                                }
                            }
                        }
                    }
                    Some("r") => {
                        if let Some(slot) = self.slots[live].as_mut() {
                            if let Op::Replace(value) = &mut slot.op {
                                if value.is_string() {
                                    let merged = format!(
                                        "{}{}",
                                        value.as_str().expect("checked above"),
                                        text
                                    );
                                    *value = JsonValue::String(merged);
                                    return;
                                }
                            }
                        }
                    }
                    _ => {}
                },
                Op::Truncate { count, .. } => match previous_verb {
                    Some("s") => {
                        if let Some(slot) = self.slots[live].as_mut() {
                            if let Op::Set { value, .. } = &mut slot.op {
                                if value.is_string() {
                                    let cut = slice_utf16_from(
                                        value.as_str().expect("checked above"),
                                        *count,
                                    )
                                    .to_owned();
                                    *value = JsonValue::String(cut);
                                    return;
                                }
                            }
                        }
                    }
                    Some("r") => {
                        if let Some(slot) = self.slots[live].as_mut() {
                            if let Op::Replace(value) = &mut slot.op {
                                if value.is_string() {
                                    let cut = slice_utf16_from(
                                        value.as_str().expect("checked above"),
                                        *count,
                                    )
                                    .to_owned();
                                    *value = JsonValue::String(cut);
                                    return;
                                }
                            }
                        }
                    }
                    _ => {}
                },
                Op::Splice { .. }
                    if previous_verb == Some("p") && self.coalesce_splices(live, &op) =>
                {
                    return;
                }
                _ => {}
            }
            if matches!(op.verb(), "s" | "d" | "r") {
                self.kill_here(at);
            }
        }
        if matches!(op.verb(), "s" | "r" | "d") {
            // Replacements dominate all earlier descendants, including
            // generations detached by array splices (delta/index.ts:700-703).
            self.kill_subtree(at);
        } else if matches!(op.verb(), "p") {
            self.retire_kids(at);
        }
        self.add_slot(
            at,
            Slot {
                op,
                dead: false,
                order: 0,
                index: 0,
                str: None,
            },
        );
    }

    /// The `p`+`p` coalescing cases (`delta/index.ts:660-697`). Sound only
    /// for adjacent recorded operations: a tombstoned operation remains a
    /// barrier through `lastAddedSlot`.
    fn coalesce_splices(&mut self, live: usize, op: &Op) -> bool {
        let Op::Splice {
            index: op_index,
            remove: op_remove,
            items: op_items,
            ..
        } = op
        else {
            return false;
        };
        let Some((previous_index, previous_remove, previous_len)) =
            self.slots[live].as_ref().and_then(|s| match &s.op {
                Op::Splice {
                    index,
                    remove,
                    items,
                    ..
                } => Some((*index, *remove, items.len())),
                _ => None,
            })
        else {
            return false;
        };
        let last_added = self.last_added_slot == Some(live);
        if previous_remove == 0
            && *op_remove == 0
            && previous_index + previous_len == *op_index
            && last_added
        {
            if let Some(Op::Splice { items, .. }) = as_op_mut(&mut self.slots[live]) {
                items.extend(op_items.iter().cloned());
            }
            return true;
        }
        if previous_remove == 0
            && last_added
            && *op_index >= previous_index
            && op_index + op_remove <= previous_index + previous_len
        {
            let at = op_index - previous_index;
            let now_empty = {
                let Some(Op::Splice { items, .. }) = as_op_mut(&mut self.slots[live]) else {
                    return false;
                };
                splice_clamped(items, at, *op_remove, op_items);
                items.is_empty()
            };
            if now_empty && previous_remove == 0 {
                self.kill_slot(live);
            }
            return true;
        }
        if *op_remove > 0
            && op_items.is_empty()
            && previous_len > 0
            && last_added
            && *op_index >= previous_index
        {
            let from = op_index - previous_index;
            if from + op_remove == previous_len {
                let new_len = from;
                let now_empty = {
                    let Some(Op::Splice { items, .. }) = as_op_mut(&mut self.slots[live]) else {
                        return false;
                    };
                    items.truncate(new_len);
                    items.is_empty()
                };
                if now_empty && previous_remove == 0 {
                    self.kill_slot(live);
                }
                return true;
            }
        }
        false
    }

    /// `diffInto` (`delta/index.ts:717-757`): local diff used when a whole
    /// container is assigned; string leaves go through
    /// [`Tracker::record_string`]. Note: upstream iterates object keys in
    /// insertion order, the port in sorted order — value-equivalent, and the
    /// oracle scenarios build multi-key objects in sorted order (M6 report D1).
    fn diff_into(&mut self, before: JsonValue, after: JsonValue, at: &mut Vec<Seg>) {
        if self.force_base {
            return;
        }
        self.has_pending = true;
        if before == after {
            return;
        }
        match (&before, &after) {
            (JsonValue::String(before), JsonValue::String(after)) => {
                self.record_string(at, before.clone(), after.clone());
                return;
            }
            (JsonValue::Array(before), JsonValue::Array(after)) if before.len() == after.len() => {
                for (index, item) in after.iter().enumerate() {
                    let previous = before[index].clone();
                    at.push(Seg::Index(index));
                    self.diff_into(previous, item.clone(), at);
                    at.pop();
                }
                return;
            }
            (JsonValue::Object(before), JsonValue::Object(after)) => {
                if before
                    .keys()
                    .chain(after.keys())
                    .any(|key| is_reserved(key))
                {
                    self.record(Op::Set {
                        path: at.clone(),
                        value: JsonValue::Object(after.clone()),
                    });
                    return;
                }
                for (key, value) in after {
                    at.push(Seg::Key(key.clone()));
                    match before.get(key) {
                        Some(previous) => self.diff_into(previous.clone(), value.clone(), at),
                        None => self.record(Op::Set {
                            path: at.clone(),
                            value: value.clone(),
                        }),
                    }
                    at.pop();
                }
                for key in before.keys() {
                    if !after.contains_key(key) {
                        let mut path = at.clone();
                        path.push(Seg::Key(key.clone()));
                        self.record(Op::Delete { path });
                    }
                }
                return;
            }
            _ => {}
        }
        // arrays of differing length, and everything else: chord's own diff
        let mut out = Vec::new();
        diff_value(Some(&before), Some(&after), at, self.scan, &mut out);
        for op in out {
            self.record(op);
        }
    }
}

struct FoldTarget {
    slot: usize,
    rest: Path,
    item: Option<usize>,
}

fn as_op_mut(slot: &mut Option<Slot>) -> Option<&mut Op> {
    slot.as_mut().map(|slot| &mut slot.op)
}

/// The payload a fold writes into: an `r` value or an `s` value
/// (`delta/index.ts:552,631`); `p` slots carry no single payload, so their
/// folds go through the item branch.
fn payload_mut(slot: &mut Option<Slot>) -> Option<&mut JsonValue> {
    slot.as_mut().and_then(|slot| match &mut slot.op {
        Op::Replace(value) => Some(value),
        Op::Set { value, .. } => Some(value),
        _ => None,
    })
}

fn fold_into_object(object: &mut serde_json::Map<String, JsonValue>, key: &str, op: &Op) -> bool {
    match op {
        Op::Set { value, .. } => {
            if key == "__proto__" {
                return false;
            }
            object.insert(key.to_owned(), value.clone());
            true
        }
        Op::Delete { .. } => {
            object.shift_remove(key);
            true
        }
        Op::Append { text, .. } => match object.get(key).and_then(JsonValue::as_str) {
            Some(current) => {
                object.insert(
                    key.to_owned(),
                    JsonValue::String(format!("{current}{text}")),
                );
                true
            }
            None => false,
        },
        Op::Truncate { count, .. } => match object.get(key).and_then(JsonValue::as_str) {
            Some(current) => {
                let cut = slice_utf16_from(current, *count).to_owned();
                object.insert(key.to_owned(), JsonValue::String(cut));
                true
            }
            None => false,
        },
        Op::Splice {
            index,
            remove,
            items,
            ..
        } => match object.get_mut(key).and_then(JsonValue::as_array_mut) {
            Some(array) => {
                splice_clamped(array, *index, *remove, items);
                true
            }
            None => false,
        },
        Op::Replace(_) => false,
    }
}

fn fold_into_array(array: &mut Vec<JsonValue>, index: usize, op: &Op) -> bool {
    match op {
        Op::Set { value, .. } => {
            if index > array.len() {
                return false;
            }
            if index == array.len() {
                array.push(value.clone());
            } else {
                array[index] = value.clone();
            }
            true
        }
        Op::Delete { .. } => {
            if index >= array.len() {
                return false;
            }
            array.remove(index);
            true
        }
        Op::Append { text, .. } => match array.get(index).and_then(JsonValue::as_str) {
            Some(current) => {
                array[index] = JsonValue::String(format!("{current}{text}"));
                true
            }
            None => false,
        },
        Op::Truncate { count, .. } => match array.get(index).and_then(JsonValue::as_str) {
            Some(current) => {
                let cut = slice_utf16_from(current, *count).to_owned();
                array[index] = JsonValue::String(cut);
                true
            }
            None => false,
        },
        Op::Splice {
            index: at,
            remove,
            items,
            ..
        } => {
            splice_clamped(array, *at, *remove, items);
            true
        }
        Op::Replace(_) => false,
    }
}

/// `guard` (`delta/index.ts:759-763`): reject reserved path segments. Symbols
/// have no Rust representation; the typed [`Seg`] rules them out.
fn guard(path: &[Seg]) -> Result<(), DeltaError> {
    for segment in path {
        if let Seg::Key(key) = segment {
            if is_reserved(key) {
                return Err(DeltaError::UnsafePath {
                    segment: key.clone(),
                });
            }
        }
    }
    Ok(())
}

/// Immutable walk to the container at `path` (the root for an empty path).
fn read_container<'a>(target: &'a JsonValue, path: &[Seg]) -> Result<&'a JsonValue, DeltaError> {
    let mut node = target;
    for seg in path {
        node = match (node, seg) {
            (JsonValue::Object(object), Seg::Key(key)) => object
                .get(key)
                .ok_or_else(|| unresolvable_container(path))?,
            (JsonValue::Array(array), Seg::Index(index)) => array
                .get(*index)
                .ok_or_else(|| unresolvable_container(path))?,
            _ => return Err(unresolvable_container(path)),
        };
    }
    Ok(node)
}

/// Own-property read over a container (the `Object.hasOwn` guards upstream).
fn read_own<'b>(parent: &'b JsonValue, key: &Seg) -> Option<&'b JsonValue> {
    match (parent, key) {
        (JsonValue::Object(object), Seg::Key(key)) => object.get(key),
        (JsonValue::Array(array), Seg::Index(index)) => array.get(*index),
        _ => None,
    }
}

/// Own-property write over a container.
fn write_own(parent: &mut JsonValue, key: &Seg, value: JsonValue) {
    match (parent, key) {
        (JsonValue::Object(object), Seg::Key(key)) => {
            object.insert(key.clone(), value);
        }
        (JsonValue::Array(array), Seg::Index(index)) => {
            if *index == array.len() {
                array.push(value);
            } else {
                array[*index] = value;
            }
        }
        _ => {}
    }
}

/// Mutable variant of [`read_container`].
fn read_container_mut<'a>(
    target: &'a mut JsonValue,
    path: &[Seg],
) -> Result<&'a mut JsonValue, DeltaError> {
    if path.is_empty() {
        return Ok(target);
    }
    super::resolve_container(target, path)
}

fn unresolvable_container(path: &[Seg]) -> DeltaError {
    DeltaError::UnresolvablePath {
        path: serde_json::to_string(&super::path_to_json(path))
            .expect("path JSON serialization cannot fail"),
    }
}

fn resolve_array<'a>(
    target: &'a JsonValue,
    path: &[Seg],
) -> Result<&'a Vec<JsonValue>, DeltaError> {
    read_container(target, path)?
        .as_array()
        .ok_or_else(|| unresolvable_container(path))
}

fn resolve_array_mut<'a>(
    target: &'a mut JsonValue,
    path: &[Seg],
) -> Result<&'a mut Vec<JsonValue>, DeltaError> {
    read_container_mut(target, path)?
        .as_array_mut()
        .ok_or_else(|| unresolvable_container(path))
}

/// Upstream `isObj` (`delta/index.ts:129`): objects or arrays.
fn is_obj(value: &JsonValue) -> bool {
    value.is_object() || value.is_array()
}

/// `cloneJson` (`delta/index.ts:130-150`) is a plain deep copy over owned
/// trees.
fn clone_json(value: &JsonValue) -> JsonValue {
    value.clone()
}

/// JS default `Array.prototype.sort` comparator: elements compared by their
/// UTF-16 string form.
fn js_string_key(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "null".to_owned(),
        JsonValue::Bool(true) => "true".to_owned(),
        JsonValue::Bool(false) => "false".to_owned(),
        JsonValue::Number(number) => number.to_string(),
        JsonValue::String(text) => text.clone(),
        other => serde_json::to_string(other).expect("JSON serialization cannot fail"),
    }
}
