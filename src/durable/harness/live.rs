//! Port of `src/harness/live.ts`: the built-in `pi.live` conversation state —
//! run control and the presentation of the current generation attempt and
//! tool round.
//!
//! Divergences (structural, disclosed): upstream mutates the typed
//! `Draft<LiveState>` document value; the port mutates the same JSON through
//! `serde_json` maps, so key deletion (`delete live.run`) maps to map
//! removal. `settleSchedulerOutcome` is deferred with the scheduler slice
//! (it consumes `convertPartial` from `generation.ts` and `SchedulerOutcome`
//! from `scheduler.ts`).

use std::sync::Arc;

use serde_json::{Map, Value};

use super::super::documents::{define_doc, DefinitionScope, DocToken};
use super::super::errors::PlainError;
use super::super::ids::{EntryId, SubmissionId, TaskId};
use super::super::session::transaction::DocumentDraft;
use super::super::types::{DocumentFork, DocumentHistory, JsonObject, SubmissionSettlement};

/// Presentation of one tool call of the current round (`live.ts`
/// `ToolSlot`). Wire order `{callId, name, taskId?, status, output?,
/// droppedBytes?, droppedLines?, details?, diagnostics?, entry?}`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ToolSlot {
    pub call_id: String,
    pub name: String,
    /// Absent for a call not started yet (sequential round) and for a call
    /// its request did not offer.
    pub task_id: Option<TaskId>,
    pub status: SlotStatus,
    /// Retained running output and what the bounds dropped.
    pub output: Option<String>,
    pub dropped_bytes: Option<f64>,
    pub dropped_lines: Option<f64>,
    /// Last `details()` value.
    pub details: Option<Value>,
    /// Diagnostics recorded through `api.diagnostic()`.
    pub diagnostics: Option<Vec<Value>>,
    /// Result entry once done; absent when the tool task faulted or was
    /// orphaned.
    pub entry: Option<EntryId>,
}

/// `ToolSlot.status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SlotStatus {
    #[default]
    Pending,
    Running,
    Done,
}

impl SlotStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            SlotStatus::Pending => "pending",
            SlotStatus::Running => "running",
            SlotStatus::Done => "done",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "pending" => Some(SlotStatus::Pending),
            "running" => Some(SlotStatus::Running),
            "done" => Some(SlotStatus::Done),
            _ => None,
        }
    }
}

impl ToolSlot {
    /// Parse one stored slot; unknown fields keep their JSON values through
    /// the raw map.
    pub fn from_json(value: &Value) -> Option<ToolSlot> {
        let object = value.as_object()?;
        Some(ToolSlot {
            call_id: object.get("callId").and_then(Value::as_str)?.to_string(),
            name: object.get("name").and_then(Value::as_str)?.to_string(),
            task_id: object.get("taskId").and_then(Value::as_i64),
            status: SlotStatus::parse(object.get("status").and_then(Value::as_str)?)?,
            output: object
                .get("output")
                .and_then(Value::as_str)
                .map(str::to_string),
            dropped_bytes: object.get("droppedBytes").and_then(Value::as_f64),
            dropped_lines: object.get("droppedLines").and_then(Value::as_f64),
            details: object.get("details").cloned(),
            diagnostics: object.get("diagnostics").and_then(Value::as_array).cloned(),
            entry: object.get("entry").and_then(Value::as_i64),
        })
    }

    /// Serialize in the upstream construction order.
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert(String::from("callId"), Value::from(self.call_id.clone()));
        map.insert(String::from("name"), Value::from(self.name.clone()));
        if let Some(task_id) = self.task_id {
            map.insert(String::from("taskId"), Value::from(task_id));
        }
        map.insert(String::from("status"), Value::from(self.status.as_str()));
        if let Some(output) = &self.output {
            map.insert(String::from("output"), Value::from(output.clone()));
        }
        if let Some(dropped_bytes) = self.dropped_bytes {
            map.insert(
                String::from("droppedBytes"),
                super::usage::js_number_value(dropped_bytes),
            );
        }
        if let Some(dropped_lines) = self.dropped_lines {
            map.insert(
                String::from("droppedLines"),
                super::usage::js_number_value(dropped_lines),
            );
        }
        if let Some(details) = &self.details {
            map.insert(String::from("details"), details.clone());
        }
        if let Some(diagnostics) = &self.diagnostics {
            map.insert(
                String::from("diagnostics"),
                Value::Array(diagnostics.clone()),
            );
        }
        if let Some(entry) = self.entry {
            map.insert(String::from("entry"), Value::from(entry));
        }
        Value::Object(map)
    }
}

/// Built-in live conversation state (`live.ts` `LiveState`).
pub fn live_doc() -> DocToken {
    define_doc(super::super::documents::DocDefinition {
        kind: String::from("pi.live"),
        version: 1,
        scope: DefinitionScope::Conversation,
        history: Some(DocumentHistory::Latest),
        fork: Some(DocumentFork::Initial),
        family: false,
        initial: Arc::new(|_| Map::new()),
        migrate: None,
        // REMINDER (upstream note): a complete base whenever nothing runs
        // (spec §8.2): no generation and no running tool slot. Do not add a
        // delta-count bound; the tool output benchmark checks this rule.
        // Absent (`undefined`) and JSON-`null` generations both read as "no
        // generation", like the upstream `=== undefined` check reads a
        // deleted or never-set property.
        checkpoint_when: Some(Arc::new(|value, _, _| {
            let generation_idle = value
                .get("generation")
                .is_none_or(|generation| generation.is_null());
            let slots_idle = !value
                .get("tools")
                .and_then(Value::as_array)
                .is_some_and(|slots| {
                    slots
                        .iter()
                        .any(|slot| slot.get("status").and_then(Value::as_str) == Some("running"))
                });
            generation_idle && slots_idle
        })),
    })
    .expect("the built-in live document definition is valid")
}

/// Read the live state out of a draft.
pub fn read_live(draft: &DocumentDraft) -> Result<JsonObject, PlainError> {
    Ok(draft
        .read(&[])
        .map_err(|error| PlainError::new(error.message().to_string()))?
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default())
}

/// The stored `run` of a live state (`{taskId, inputs}`), if present.
pub fn run_of(live: &JsonObject) -> Option<(TaskId, Vec<SubmissionId>)> {
    let run = live.get("run").and_then(Value::as_object)?;
    let task_id = run.get("taskId").and_then(Value::as_i64)?;
    let inputs = run
        .get("inputs")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default();
    Some((task_id, inputs))
}

/// The stored `generation.attempt`, if present.
pub fn generation_attempt(live: &JsonObject) -> Option<f64> {
    live.get("generation")
        .and_then(Value::as_object)
        .and_then(|generation| generation.get("attempt"))
        .and_then(Value::as_f64)
}

/// End the run owned by `taskId` (`live.ts` `endRun`): settle each of its
/// inputs and remove `run`. Always removes `generation` and `tools`, whose
/// presentation belongs to the ending run.
pub fn end_run(
    tx: &super::super::session::transaction::Transaction,
    live: &JsonObject,
    task_id: TaskId,
    settlement: SubmissionSettlement,
) -> Result<(), PlainError> {
    if let Some((run_task_id, inputs)) = run_of(live) {
        if run_task_id == task_id {
            for id in inputs {
                tx.settle_submission(id, settlement.clone())?;
            }
        }
    }
    Ok(())
}

/// Remove one key of a mutable live map (`delete live.<key>`).
pub fn delete_key(live: &mut JsonObject, key: &str) {
    live.shift_remove(key);
}

/// The slot of tool task `taskId` in the current round (`live.ts`
/// `toolSlot`), if the round still lists it.
pub fn tool_slot(tools: &[ToolSlot], task_id: TaskId) -> Option<&ToolSlot> {
    tools.iter().find(|slot| slot.task_id == Some(task_id))
}

/// Mark a slot done (`live.ts` `finishSlot`): the result entry, if any, now
/// carries its running output, details, and diagnostics.
pub fn finish_slot(slot: &mut ToolSlot, entry: Option<EntryId>) {
    slot.status = SlotStatus::Done;
    if let Some(entry) = entry {
        slot.entry = Some(entry);
    }
    clear_progress(slot);
}

/// Remove what a tool published while running (`live.ts` `clearProgress`);
/// its result entry or a rerun replaces it.
pub fn clear_progress(slot: &mut ToolSlot) {
    slot.output = None;
    slot.dropped_bytes = None;
    slot.dropped_lines = None;
    slot.details = None;
    slot.diagnostics = None;
}

/// Parse the `tools` array of a live state.
pub fn tools_of(live: &JsonObject) -> Vec<ToolSlot> {
    live.get("tools")
        .and_then(Value::as_array)
        .map(|slots| slots.iter().filter_map(ToolSlot::from_json).collect())
        .unwrap_or_default()
}

/// Write the `tools` array back into a live map.
pub fn set_tools(live: &mut JsonObject, tools: Vec<ToolSlot>) {
    live.insert(
        String::from("tools"),
        Value::Array(tools.iter().map(ToolSlot::to_json).collect()),
    );
}
