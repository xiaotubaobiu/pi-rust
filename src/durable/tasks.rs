//! Port of `src/tasks.ts`: `defineTask`, the executable-task constructor
//! registered in a [`crate::durable::harness`] registry so a Harness can run
//! tasks of its kind.
//!
//! Divergence (structural, disclosed): upstream `defineTask` is the identity
//! constructor of the `Task<I, S, R, H>` token (`{ definition }`), with
//! TypeScript inferring the phase-state `S extends { phase: string }`; the
//! port's [`TaskToken`] carries the erased definition and the phase
//! discriminant is the `phase` string of the stored checkpoint, so the
//! constructor is likewise a bare wrapper.

use std::collections::BTreeMap;
use std::sync::Arc;

/// A phase handler of a task definition (`types.ts`
/// `TaskDefinition.phases`). The erased runtime (`harness/scheduler.ts`
/// `TaskRuntime`) is supplied by the scheduler; the checkpoint carries the
/// phase name that selects the handler.
pub type PhaseFn = Arc<dyn Fn(&PhaseArgs) -> Result<(), PlainFailure> + Send + Sync>;

/// Arguments a phase handler receives: the running record, the erased
/// runtime, and the invocation context, in upstream order
/// `(task, runtime, context)`.
pub struct PhaseArgs {
    /// `runtime.context` of the invocation.
    pub context: crate::agent_core::chord_support::context::Context,
}

/// A phase handler failure that is not an abort (`scheduler.ts` rule 4).
#[derive(Debug, Clone)]
pub struct PlainFailure {
    pub message: String,
}

impl std::fmt::Display for PlainFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// `migrate(input, checkpoint, version)` (`types.ts`
/// `TaskDefinition.migrate`): convert a stored older task to the current
/// definition version.
pub type MigrateFn = Arc<
    dyn Fn(
            &serde_json::Value,
            &serde_json::Map<String, serde_json::Value>,
            i64,
        ) -> Result<
            (
                serde_json::Value,
                serde_json::Map<String, serde_json::Value>,
            ),
            PlainFailure,
        > + Send
        + Sync,
>;

/// Erased executable task definition stored in the registry (`harness/types.ts`
/// `AnyTask.definition`).
#[derive(Clone)]
pub struct TaskDefinition {
    /// Registered task kind; the persisted record's `kind`.
    pub name: String,
    /// Definition version used to migrate live input and checkpoints.
    pub version: i64,
    /// `initial()`: first checkpoint of a fresh task.
    pub initial: Arc<dyn Fn() -> serde_json::Map<String, serde_json::Value> + Send + Sync>,
    /// Phase handlers by phase name.
    pub phases: BTreeMap<String, PhaseFn>,
    /// `abort(task, runtime, context)`: the abort handler.
    pub abort: Option<PhaseFn>,
    /// `migrate(input, checkpoint, version)`: convert a stored older task.
    pub migrate: Option<MigrateFn>,
}

/// `Task<I, S, R, H>` (`types.ts`): the token `defineTask` returns.
#[derive(Clone)]
pub struct TaskToken {
    pub definition: TaskDefinition,
}

/// `defineTask(definition)` (`tasks.ts:4-9`): define an executable task.
/// Register it in the registry so a Harness can run tasks of its kind.
pub fn define_task(definition: TaskDefinition) -> TaskToken {
    TaskToken { definition }
}
