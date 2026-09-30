//! Replicated state: tracked mutable source state, published as immutable
//! revisions, and the cold read-only replica consumers hold. Port of
//! `packages/chord/src/services/state.ts` (upstream sha256
//! `4605021d763b5b82b99ebab783769640e61b19fb8f64082953b3d0c1be717319`) plus
//! the internals registry of `state-internals.ts` (sha256
//! `61eddd39040760d06b6ce1562e7a07a46ca09b311e1785d99c3c058329a74fd5`).

use std::sync::{Arc, Mutex, Weak};

use crate::chord::context::Context;
use crate::chord::delta::{apply_immutable, is_base, track, DeltaError, Op, Tracker};
use crate::chord::types::{JsonValue, ReplicatedStateDelivery, ReplicatedStateDeliveryKind};

use super::errors::ChordError;

type ValueListener = dyn Fn(&JsonValue, &Context, &ReplicatedStateDelivery) + Send + Sync;
type SourceListener = dyn Fn(&[Op], u64, &Context) + Send + Sync;

struct MutableInner {
    tracker: Tracker,
    published_value: JsonValue,
    sequence: u64,
    listeners: Vec<(u64, Arc<ValueListener>)>,
    source_listeners: Vec<(u64, Arc<SourceListener>)>,
}

/// Port of `MutableReplicatedStateImpl` (`state.ts:6-57`). Writes go through
/// the typed tracker mutators (the port of the upstream proxy surface);
/// `publish` flushes the pending operations, advances the sequence and
/// delivers the new immutable revision. Cloned handles share one state;
/// listeners unsubscribe by token, like the upstream `() => void` returns.
pub struct MutableReplicatedState {
    inner: Mutex<MutableInner>,
    next_listener: std::sync::atomic::AtomicU64,
}

/// `serviceDeliveryContext()` (`state.ts:131-135`): the synthetic context for
/// service deliveries without a caller.
pub fn service_delivery_context() -> Context {
    Context::background()
}

impl std::fmt::Debug for MutableReplicatedState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MutableReplicatedState")
            .field("sequence", &self.sequence())
            .finish()
    }
}

impl std::fmt::Debug for ReplicatedStateReplica {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReplicatedStateReplica").finish()
    }
}

impl MutableReplicatedState {
    /// `replicatedState(initial)` (`api.ts:88-90`, `state.ts:13-30`). The
    /// constructor flushes the base batch to seed the published value.
    pub fn new(initial: JsonValue) -> Arc<Self> {
        let mut tracker = track(initial);
        let published_value =
            apply_immutable(None, &tracker.flush()).expect("a fresh base batch always applies");
        Arc::new(MutableReplicatedState {
            inner: Mutex::new(MutableInner {
                tracker,
                published_value,
                sequence: 0,
                listeners: Vec::new(),
                source_listeners: Vec::new(),
            }),
            next_listener: std::sync::atomic::AtomicU64::new(0),
        })
    }

    fn next_token(&self) -> u64 {
        self.next_listener
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    /// `get value` (`state.ts:32-34`): the latest published revision.
    /// Upstream hands out an immutable shared value; the port's clone is the
    /// ownership equivalent.
    pub fn value(&self) -> JsonValue {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .published_value
            .clone()
    }

    /// Upstream `get state` reads. Writes use the mutator helpers below.
    pub fn state(&self) -> JsonValue {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .tracker
            .state()
            .clone()
    }

    /// `publish(context)` (`state.ts:40-48`).
    pub fn publish(&self, context: &Context) {
        let (ops, sequence, value, source_listeners, listeners) = {
            let mut inner = self.lock();
            let ops = inner.tracker.flush();
            if ops.is_empty() {
                return;
            }
            inner.sequence += 1;
            inner.published_value = apply_immutable(Some(&inner.published_value), &ops)
                .expect("replicated updates always apply");
            (
                ops,
                inner.sequence,
                inner.published_value.clone(),
                inner.source_listeners.clone(),
                inner.listeners.clone(),
            )
        };
        for (_, listener) in &source_listeners {
            listener(&ops, sequence, context);
        }
        let delivery = ReplicatedStateDelivery {
            kind: ReplicatedStateDeliveryKind::Update,
            sequence,
        };
        for (_, listener) in &listeners {
            listener(&value, context, &delivery);
        }
    }

    /// `subscribe(listener)` (`state.ts:50-56`): flushes pending mutations
    /// first, then delivers the current revision as a hydrate. Returns the
    /// unsubscribe closure (upstream `() => void`).
    pub fn subscribe<F>(self: &Arc<Self>, listener: F) -> Box<dyn Fn() + Send + Sync>
    where
        F: Fn(&JsonValue, &Context, &ReplicatedStateDelivery) + Send + Sync + 'static,
    {
        let delivery_context = service_delivery_context();
        // `this.publish(context)` runs BEFORE the listener is registered
        // (state.ts:51-55): the flush reaches only the existing listeners,
        // then the new listener receives the hydrate directly.
        self.publish(&delivery_context);
        let token = self.next_token();
        let listener: Arc<ValueListener> = Arc::new(listener);
        {
            let mut inner = self.lock();
            inner.listeners.push((token, listener.clone()));
        }
        let value = self.value();
        let sequence = self.sequence();
        listener(
            &value,
            &delivery_context,
            &ReplicatedStateDelivery {
                kind: ReplicatedStateDeliveryKind::Hydrate,
                sequence,
            },
        );
        let weak: Weak<MutableReplicatedState> = Arc::downgrade(self);
        Box::new(move || {
            if let Some(state) = weak.upgrade() {
                state.remove_listener(token);
            }
        })
    }

    // Provider-side internals (state-internals.ts `ReplicatedStateInternals`).

    /// `get sequence` (`state-internals.ts:5`).
    pub fn sequence(&self) -> u64 {
        self.lock().sequence
    }

    /// `subscribe(listener)` over raw operation batches
    /// (`state-internals.ts:8`). Returns the unsubscribe closure.
    pub fn subscribe_source<F>(self: &Arc<Self>, listener: F) -> Box<dyn Fn() + Send + Sync>
    where
        F: Fn(&[Op], u64, &Context) + Send + Sync + 'static,
    {
        let token = self.next_token();
        let listener: Arc<SourceListener> = Arc::new(listener);
        self.lock().source_listeners.push((token, listener));
        let weak: Weak<MutableReplicatedState> = Arc::downgrade(self);
        Box::new(move || {
            if let Some(state) = weak.upgrade() {
                state.remove_source_listener(token);
            }
        })
    }

    // ── Tracked mutation surface (the upstream `state.state` proxy) ────────

    /// `state.state.seg = value` through the set trap.
    pub fn set(
        &self,
        path: &[crate::chord::delta::Seg],
        value: JsonValue,
    ) -> Result<(), DeltaError> {
        self.lock().tracker.set(path, value)
    }

    /// `delete state.state.seg` through the deleteProperty trap.
    pub fn delete(&self, path: &[crate::chord::delta::Seg]) -> Result<(), DeltaError> {
        self.lock().tracker.delete(path)
    }

    /// `state.state.array.push(...)`.
    pub fn push(
        &self,
        path: &[crate::chord::delta::Seg],
        items: Vec<JsonValue>,
    ) -> Result<usize, DeltaError> {
        self.lock().tracker.push(path, items)
    }

    /// `state.state.array.pop()`.
    pub fn pop(&self, path: &[crate::chord::delta::Seg]) -> Result<Option<JsonValue>, DeltaError> {
        self.lock().tracker.pop(path)
    }

    /// `state.state.array.shift()`.
    pub fn shift(
        &self,
        path: &[crate::chord::delta::Seg],
    ) -> Result<Option<JsonValue>, DeltaError> {
        self.lock().tracker.shift(path)
    }

    /// `state.state.array.unshift(...)`.
    pub fn unshift(
        &self,
        path: &[crate::chord::delta::Seg],
        items: Vec<JsonValue>,
    ) -> Result<usize, DeltaError> {
        self.lock().tracker.unshift(path, items)
    }

    /// `state.state.array.splice(...)`.
    pub fn splice(
        &self,
        path: &[crate::chord::delta::Seg],
        index: usize,
        remove: usize,
        items: Vec<JsonValue>,
    ) -> Result<Vec<JsonValue>, DeltaError> {
        self.lock().tracker.splice(path, index, remove, items)
    }

    /// `state.state.array.reverse()`.
    pub fn reverse(&self, path: &[crate::chord::delta::Seg]) -> Result<(), DeltaError> {
        self.lock().tracker.reverse(path)
    }

    /// `state.state.array.length = n`.
    pub fn set_length(
        &self,
        path: &[crate::chord::delta::Seg],
        next: usize,
    ) -> Result<(), DeltaError> {
        self.lock().tracker.set_length(path, next)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, MutableInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn remove_listener(&self, token: u64) {
        self.lock().listeners.retain(|(at, _)| *at != token);
    }

    fn remove_source_listener(&self, token: u64) {
        self.lock().source_listeners.retain(|(at, _)| *at != token);
    }
}

struct ReplicaInner {
    value: Option<JsonValue>,
    sequence: Option<u64>,
    listeners: Vec<(u64, Arc<ValueListener>)>,
}

/// Port of `ReplicatedStateReplica` (`state.ts:60-129`): a cold read-only
/// state used by service consumers until a complete snapshot arrives.
pub struct ReplicatedStateReplica {
    inner: Mutex<ReplicaInner>,
    next_listener: std::sync::atomic::AtomicU64,
}

impl ReplicatedStateReplica {
    /// `new ReplicatedStateReplica(reportError)` (`state.ts:66-68`).
    pub fn new() -> Arc<Self> {
        Arc::new(ReplicatedStateReplica {
            inner: Mutex::new(ReplicaInner {
                value: None,
                sequence: None,
                listeners: Vec::new(),
            }),
            next_listener: std::sync::atomic::AtomicU64::new(0),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ReplicaInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// `get value` (`state.ts:72-74`).
    pub fn value(&self) -> Option<JsonValue> {
        self.lock().value.clone()
    }

    /// `subscribe(listener)` (`state.ts:76-83`).
    pub fn subscribe<F>(self: &Arc<Self>, listener: F) -> Box<dyn Fn() + Send + Sync>
    where
        F: Fn(&JsonValue, &Context, &ReplicatedStateDelivery) + Send + Sync + 'static,
    {
        let token = self
            .next_listener
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let listener: Arc<ValueListener> = Arc::new(listener);
        let delivery = {
            let mut inner = self.lock();
            inner.listeners.push((token, listener.clone()));
            inner.value.as_ref().map(|value| {
                (
                    value.clone(),
                    inner.sequence.expect("value implies sequence"),
                )
            })
        };
        if let Some((value, sequence)) = delivery {
            listener(
                &value,
                &service_delivery_context(),
                &ReplicatedStateDelivery {
                    kind: ReplicatedStateDeliveryKind::Hydrate,
                    sequence,
                },
            );
        }
        let weak: Weak<ReplicatedStateReplica> = Arc::downgrade(self);
        Box::new(move || {
            if let Some(replica) = weak.upgrade() {
                replica.lock().listeners.retain(|(at, _)| *at != token);
            }
        })
    }

    /// `hydrate(sequence, ops, context)` (`state.ts:85-91`).
    pub fn hydrate(&self, sequence: u64, ops: &[Op], context: &Context) -> Result<(), ChordError> {
        if !is_base(ops) {
            return Err(ChordError::Type(
                "Replicated state snapshot is not a base operation batch".to_owned(),
            ));
        }
        let value = apply_immutable(None, ops).map_err(delta)?;
        {
            let mut inner = self.lock();
            inner.sequence = Some(sequence);
            inner.value = Some(value);
        }
        self.deliver_all(context, ReplicatedStateDeliveryKind::Hydrate, sequence);
        Ok(())
    }

    /// `update(sequence, ops, context)` (`state.ts:93-105`): a sequence gap
    /// clears the replica and fails, exactly like upstream.
    pub fn update(&self, sequence: u64, ops: &[Op], context: &Context) -> Result<(), ChordError> {
        let current = {
            let inner = self.lock();
            match (inner.sequence, inner.value.as_ref()) {
                (Some(current), Some(_)) => current,
                _ => {
                    return Err(ChordError::Type(
                        "Replicated state received an update before hydration".to_owned(),
                    ))
                }
            }
        };
        if sequence != current + 1 {
            self.clear();
            return Err(ChordError::Type(
                "Replicated state update sequence has a gap".to_owned(),
            ));
        }
        let value = {
            let inner = self.lock();
            apply_immutable(inner.value.as_ref(), ops).map_err(delta)?
        };
        {
            let mut inner = self.lock();
            inner.sequence = Some(sequence);
            inner.value = Some(value);
        }
        self.deliver_all(context, ReplicatedStateDeliveryKind::Update, sequence);
        Ok(())
    }

    /// `clear()` (`state.ts:107-110`).
    pub fn clear(&self) {
        let mut inner = self.lock();
        inner.value = None;
        inner.sequence = None;
    }

    fn deliver_all(&self, context: &Context, kind: ReplicatedStateDeliveryKind, sequence: u64) {
        let delivery = ReplicatedStateDelivery { kind, sequence };
        let listeners = self.lock().listeners.clone();
        let Some(value) = self.lock().value.clone() else {
            return;
        };
        for (_, listener) in listeners {
            listener(&value, context, &delivery);
        }
    }
}

fn delta(error: DeltaError) -> ChordError {
    ChordError::Type(error.message().to_owned())
}
