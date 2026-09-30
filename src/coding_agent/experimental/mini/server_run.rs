//! Port of upstream `mini/server/run.ts` + `server/entry.ts`: the session
//! server's routing state (one worker per session, subscriber moves,
//! last-subscriber stop, idle retirement) and forward rule. Process spawns
//! and sockets are embedder-owned (D18).

use std::collections::HashMap;

use super::protocol::{SessionSummary, IDLE_SHUTDOWN_MS};
use super::rpc::{no_host_provides_error, NOT_ATTACHED_ERROR};

/// Upstream `Route`.
#[derive(Default)]
pub struct Route {
    pub session_id: String,
    /// Attached presentations by id (insertion order matters for fan-out).
    pub subscribers: Vec<String>,
    pub stopped: bool,
}

impl Route {
    /// Upstream `route.stop()`.
    pub fn stop(&mut self) {
        self.stopped = true;
    }
}

/// Upstream `runServer`'s routing state.
#[derive(Default)]
pub struct MiniServer {
    routes: HashMap<String, Route>,
    spawning: HashMap<String, ()>,
    presentations: usize,
    retired: bool,
}

/// Upstream `ensureRoute` decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnsureRouteOutcome {
    Existing,
    Spawn,
    JoinSpawn,
}

impl MiniServer {
    /// Upstream `considerRetiring` (idle decision without a timer).
    pub fn consider_retiring(&self) -> RetireDecision {
        if self.presentations > 0 || !self.routes.is_empty() {
            return RetireDecision::Hold;
        }
        RetireDecision::ScheduleAfter(IDLE_SHUTDOWN_MS)
    }

    /// Upstream idle timer fire: retire only when still empty.
    pub fn idle_timer_fired(&mut self, still_empty: bool) -> bool {
        if still_empty && self.routes.is_empty() && self.presentations == 0 {
            self.retired = true;
            true
        } else {
            false
        }
    }

    pub fn is_retired(&self) -> bool {
        self.retired
    }

    /// Upstream `ensureRoute`: reuse the live route, join an in-flight spawn,
    /// or spawn a new worker.
    pub fn ensure_route(
        &mut self,
        session_id: Option<&str>,
    ) -> (EnsureRouteOutcome, Option<String>) {
        match session_id {
            None => (EnsureRouteOutcome::Spawn, None),
            Some(session_id) => {
                if self.routes.contains_key(session_id) {
                    return (EnsureRouteOutcome::Existing, Some(session_id.to_string()));
                }
                if self.spawning.contains_key(session_id) {
                    return (EnsureRouteOutcome::JoinSpawn, Some(session_id.to_string()));
                }
                self.spawning.insert(session_id.to_string(), ());
                (EnsureRouteOutcome::Spawn, Some(session_id.to_string()))
            }
        }
    }

    /// Upstream spawn completion: register the route and clear the in-flight
    /// marker (`.finally(() => spawning.delete(sessionId))`).
    pub fn route_spawned(&mut self, session_id: &str) -> &mut Route {
        self.spawning.remove(session_id);
        self.routes.entry(session_id.to_string()).or_insert(Route {
            session_id: session_id.to_string(),
            ..Default::default()
        })
    }

    /// Upstream worker close: drop the route and consider retiring.
    pub fn worker_closed(&mut self, session_id: &str) -> RetireDecision {
        self.routes.remove(session_id);
        self.consider_retiring()
    }

    /// Upstream `sessions.attach` on a presentation connection: move the
    /// subscriber slot, ensure the route, register the subscriber and answer
    /// the route's session id. `resolved_session_id` is the id after
    /// `ensureRoute` (existing route, joined spawn, or the spawned worker's
    /// `describe()` answer).
    pub fn attach(
        &mut self,
        resolved_session_id: &str,
        presentation_id: &str,
    ) -> Result<(String, usize, RetireDecision), String> {
        let route = self.route_spawned(resolved_session_id);
        // `route?.subscribers.delete(attachedAs ?? "")` — the presentation
        // moves between routes/attachments.
        route
            .subscribers
            .retain(|subscriber| subscriber != presentation_id);
        route.subscribers.push(presentation_id.to_string());
        Ok((
            resolved_session_id.to_string(),
            route.subscribers.len(),
            self.consider_retiring(),
        ))
    }

    /// Upstream subscriber detach: drop the slot; the worker stops when the
    /// last presentation leaves.
    pub fn detach(&mut self, session_id: &str, presentation_id: &str) -> Option<bool> {
        let route = self.routes.get_mut(session_id)?;
        route
            .subscribers
            .retain(|subscriber| subscriber != presentation_id);
        let last = route.subscribers.is_empty();
        if last {
            route.stop();
        }
        Some(last)
    }

    pub fn route(&self, session_id: &str) -> Option<&Route> {
        self.routes.get(session_id)
    }

    /// Upstream `forward` guard: the service must be announced by the worker.
    pub fn forward_decision(
        &self,
        session_id: Option<&str>,
        method: &str,
        server_provides: &[String],
        worker_announced: &[String],
    ) -> Result<(), String> {
        let Some(session_id) = session_id else {
            return Err(NOT_ATTACHED_ERROR.to_string());
        };
        if self.route(session_id).is_none() {
            return Err(NOT_ATTACHED_ERROR.to_string());
        }
        let service = method.split('.').next().unwrap_or(method);
        if worker_announced
            .iter()
            .any(|announced| announced == service)
        {
            return Ok(());
        }
        let mut server_has = server_provides.to_vec();
        server_has.sort();
        let mut worker_has = worker_announced.to_vec();
        worker_has.sort();
        Err(no_host_provides_error(service, &server_has, &worker_has))
    }

    /// Upstream event fan-out: addressed events go to one presentation,
    /// others to every subscriber.
    pub fn route_event_targets<'a>(&'a self, session_id: &str, to: Option<&str>) -> Vec<&'a str> {
        let Some(route) = self.route(session_id) else {
            return Vec::new();
        };
        match to {
            Some(to) => route
                .subscribers
                .iter()
                .filter(|subscriber| subscriber.as_str() == to)
                .map(String::as_str)
                .collect(),
            None => route.subscribers.iter().map(String::as_str).collect(),
        }
    }

    pub fn presentations(&self) -> usize {
        self.presentations
    }

    pub fn connect_presentation(&mut self) {
        self.presentations += 1;
    }

    /// Upstream connection close bookkeeping.
    pub fn disconnect_presentation(&mut self) {
        self.presentations = self.presentations.saturating_sub(1);
    }

    /// Upstream `listSessions`: JSONL metadata to summaries.
    pub fn summarize(metadata: (String, String, String, i64)) -> SessionSummary {
        SessionSummary {
            id: metadata.0,
            path: metadata.1,
            cwd: metadata.2,
            created_at: metadata.3,
        }
    }
}

/// Upstream retire decision face.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetireDecision {
    Hold,
    ScheduleAfter(u64),
}

/// Upstream `worker/run.ts` `systemPrompt`.
pub fn system_prompt(cwd: &str) -> String {
    [
        "You are a coding agent working in a terminal.".to_string(),
        format!("Working directory: {cwd}"),
        "Use the read, write, edit, and bash tools to inspect and change files.".to_string(),
        "Keep answers short and technical.".to_string(),
    ]
    .join("\n")
}

/// Upstream `openSession` lookup failure.
pub fn unknown_session_error(session_id: &str) -> String {
    format!("Unknown session: {session_id}")
}
