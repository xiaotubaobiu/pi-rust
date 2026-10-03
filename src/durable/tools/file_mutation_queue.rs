//! Port of `src/tools/file-mutation-queue.ts`: serialize file mutations
//! targeting the same environment and canonical path.
//!
//! Upstream chains a promise queue per `(env, canonicalPath)` key behind a
//! serialized registration step; the port keeps the two-phase shape —
//! registration (which resolves the canonical key) holds a fair lock, and the
//! operation then runs under the key's own lock — see divergence D33 for the
//! release-side difference.

use std::collections::HashMap;
use std::future::{poll_fn, Future};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::task::Poll;

use tokio::sync::Mutex as AsyncMutex;

use crate::agent_core::chord_support::context::Context;
use crate::durable::env::{ExecutionEnv, FileErrorCode};
use crate::durable::errors::PlainError;

#[derive(Default)]
struct QueueState {
    /// Serializes registrations, like the upstream `state.registration`
    /// promise tail.
    registration: AsyncMutex<()>,
    /// Live per-key queues; entries drop out weakly (D33).
    paths: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
}

/// The upstream `WeakMap<ExecutionEnv, MutationQueueState>`: per-object state
/// keyed by weak env identity.
struct EnvQueue {
    env: Weak<dyn ExecutionEnv>,
    state: Arc<QueueState>,
}

fn state_for(env: &Arc<dyn ExecutionEnv>) -> Arc<QueueState> {
    static STATES: OnceLock<Mutex<Vec<EnvQueue>>> = OnceLock::new();
    let mut states = STATES.get_or_init(Mutex::default).lock().unwrap();
    states.retain(|entry| entry.env.strong_count() > 0);
    let weak = Arc::downgrade(env);
    if let Some(entry) = states.iter().find(|entry| entry.env.ptr_eq(&weak)) {
        return entry.state.clone();
    }
    let state = Arc::new(QueueState::default());
    states.push(EnvQueue {
        env: weak,
        state: state.clone(),
    });
    state
}

/// `getMutationQueueKey(env, path, context)` (`tools/file-mutation-queue.ts`):
/// the canonical path, or the absolute path when the file does not exist yet.
fn get_mutation_queue_key(
    env: &dyn ExecutionEnv,
    path: &str,
    context: &Context,
) -> Result<String, PlainError> {
    let absolute_path = env
        .absolute_path(path, context)
        .map_err(|error| PlainError::new(error.message))?;
    match env.canonical_path(&absolute_path, context) {
        Ok(canonical_path) => Ok(canonical_path),
        Err(error)
            if matches!(
                error.code,
                FileErrorCode::NotFound | FileErrorCode::NotSupported
            ) =>
        {
            Ok(absolute_path)
        }
        Err(error) => Err(PlainError::new(error.message)),
    }
}

/// `withFileMutationQueue(env, path, fn, context)` (`tools/file-mutation-queue.ts`).
pub async fn with_file_mutation_queue<T, F, Fut>(
    env: &Arc<dyn ExecutionEnv>,
    path: &str,
    operation: F,
    context: &Context,
) -> Result<T, PlainError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, PlainError>>,
{
    let state = state_for(env);
    let registration = state.registration.lock().await;
    let key = get_mutation_queue_key(env.as_ref(), path, context)?;
    let lock = {
        let mut paths = state.paths.lock().unwrap();
        paths.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = paths.get(&key).and_then(Weak::upgrade) {
            lock
        } else {
            let lock = Arc::new(AsyncMutex::new(()));
            paths.insert(key, Arc::downgrade(&lock));
            lock
        }
    };
    let mut waiting = Box::pin(lock.lock_owned());
    // Poll once while holding the registration lock, so this waiter joins
    // Tokio's FIFO before another caller can register an alias of the same
    // file (the upstream `currentQueue.then(() => nextQueue)` chaining).
    let acquired = poll_fn(|cx| {
        Poll::Ready(match waiting.as_mut().poll(cx) {
            Poll::Ready(guard) => Some(guard),
            Poll::Pending => None,
        })
    })
    .await;
    drop(registration);
    let _guard = match acquired {
        Some(guard) => guard,
        None => waiting.await,
    };
    // The upstream `finally` releases the queue even when `fn` throws; the
    // guard's drop covers both outcomes here.
    operation().await
}
