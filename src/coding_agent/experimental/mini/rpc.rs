//! Port of upstream `mini/shared/rpc.ts`: the whole protocol (call, result,
//! error, cancel, event, ping) plus named services and the forward routing
//! rule, over an embedder-owned [`Connection`] transport (D18).

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use super::protocol::DEFAULT_DEAD_MS;

/// Upstream `Connection` face.
pub trait Connection {
    /// `send(message)`.
    fn send(&self, message: &Value);
    /// `close()`.
    fn close(&self);
}

/// Upstream `Frame` faces (outgoing).
#[derive(Debug, Clone, PartialEq)]
pub enum OutgoingFrame {
    Call {
        id: u64,
        method: String,
        args: Vec<Value>,
    },
    Result {
        id: u64,
        result: Value,
    },
    Error {
        id: u64,
        error: String,
    },
    Cancel {
        id: u64,
    },
    Event {
        service: String,
        payload: Value,
        to: Option<String>,
    },
    Announce {
        services: Vec<String>,
    },
    Ping,
}

impl OutgoingFrame {
    /// Upstream `JSON.stringify` key order per variant.
    pub fn to_json(&self) -> Value {
        match self {
            OutgoingFrame::Call { id, method, args } => json!({
                "kind": "call",
                "id": id,
                "method": method,
                "args": args,
            }),
            OutgoingFrame::Result { id, result } => json!({
                "kind": "result",
                "id": id,
                "result": result,
            }),
            OutgoingFrame::Error { id, error } => json!({
                "kind": "error",
                "id": id,
                "error": error,
            }),
            OutgoingFrame::Cancel { id } => json!({
                "kind": "cancel",
                "id": id,
            }),
            OutgoingFrame::Event {
                service,
                payload,
                to,
            } => match to {
                Some(to) => json!({
                    "kind": "event",
                    "service": service,
                    "payload": payload,
                    "to": to,
                }),
                None => json!({
                    "kind": "event",
                    "service": service,
                    "payload": payload,
                }),
            },
            OutgoingFrame::Announce { services } => json!({
                "kind": "announce",
                "services": services,
            }),
            OutgoingFrame::Ping => json!({ "kind": "ping" }),
        }
    }
}

/// Incoming frame faces (the embedder parses and dispatches).
#[derive(Debug, Clone, PartialEq)]
pub enum IncomingFrame {
    Call {
        id: u64,
        method: String,
        args: Vec<Value>,
    },
    Result {
        id: u64,
        result: Value,
    },
    Error {
        id: u64,
        error: String,
    },
    Cancel {
        id: u64,
    },
    Event {
        service: String,
        payload: Value,
        to: Option<String>,
    },
    Announce {
        services: Vec<String>,
    },
    Ping,
}

/// Upstream dispatch decision: split at the first dot, look up the local
/// service, else forward. Exact upstream error strings.
pub fn dispatch_decision(method: &str, forward_available: bool) -> DispatchDecision {
    match method.split_once('.') {
        Some((service, _member)) if !service.is_empty() => {
            if forward_available {
                DispatchDecision::Forward
            } else {
                DispatchDecision::NoService(format!("No service provides {method}"))
            }
        }
        _ => DispatchDecision::NoService(format!("No service provides {method}")),
    }
}

/// Upstream dispatch decision face.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchDecision {
    Forward,
    NoService(String),
}

/// Upstream member lookup failure.
pub fn unknown_method_error(method: &str) -> String {
    format!("Unknown method: {method}")
}

/// Upstream `callWith` timeout message.
pub fn timeout_error(method: &str, timeout_ms: u64) -> String {
    format!("{method} timed out after {timeout_ms}ms")
}

/// Upstream call abandon messages.
pub const CALL_CANCELLED: &str = "Call cancelled";
/// Upstream close rejection message.
pub const CONNECTION_CLOSED: &str = "Connection closed";
/// Upstream cancel-frame abort reason.
pub const CANCELLED_BY_CALLER: &str = "Cancelled by caller";

/// Upstream event handler face (`on`/`onEvent`).
pub type EventHandler = Box<dyn Fn(&str, &Value, Option<&str>) + Send>;

/// Upstream `Forward` face.
pub type ForwardFn = Box<dyn Fn(&str, &[Value]) -> Result<Value, String> + Send>;

/// Upstream service-object invoke face.
pub type InvokeFn = Box<dyn Fn(&str, &str, &[Value]) -> Result<Option<Value>, String> + Send>;

/// Upstream `RpcPeer` deterministic state. `send` goes through the
/// [`Connection`]; timers/cancellation are embedder-driven via
/// [`RpcPeer::on_timeout`] / [`RpcPeer::cancel`].
pub struct RpcPeer<C: Connection> {
    connection: C,
    services: HashSet<String>,
    provided: Vec<String>,
    announced: HashSet<String>,
    next_id: u64,
    pending: HashMap<u64, PendingKind>,
    inflight: HashMap<u64, ()>,
    event_handlers: Vec<EventHandler>,
    forward: Option<ForwardFn>,
    /// Upstream service objects: `(service, member, args) -> result`. The
    /// embedder supplies the actual method table (D18); returning `None`
    /// models an `undefined` result.
    invoke: InvokeFn,
}

enum PendingKind {
    Timeout { method: String, timeout_ms: u64 },
    Plain,
}

impl<C: Connection> RpcPeer<C> {
    /// Upstream `createPeer(connection, options)`.
    pub fn new(connection: C, forward: Option<ForwardFn>, invoke: InvokeFn) -> Self {
        Self {
            connection,
            services: HashSet::new(),
            provided: Vec::new(),
            announced: HashSet::new(),
            next_id: 1,
            pending: HashMap::new(),
            inflight: HashMap::new(),
            event_handlers: Vec::new(),
            forward,
            invoke,
        }
    }

    /// Upstream `provide`: register and announce (announce lists every
    /// provided service, insertion-ordered).
    pub fn provide(&mut self, name: &str) {
        if !self.services.contains(name) {
            self.provided.push(name.to_string());
        }
        self.services.insert(name.to_string());
        let frame = OutgoingFrame::Announce {
            services: self.provided.clone(),
        };
        self.connection.send(&frame.to_json());
    }

    pub fn provided(&self) -> &[String] {
        &self.provided
    }

    pub fn announced(&self) -> Vec<&str> {
        let mut announced: Vec<&str> = self.announced.iter().map(String::as_str).collect();
        announced.sort_unstable();
        announced
    }

    /// Upstream `use`/`call`: issue a call frame and record the pending
    /// waiter. Returns the call id.
    pub fn call_with(
        &mut self,
        method: &str,
        args: &[Value],
        timeout_ms: Option<u64>,
    ) -> Result<u64, String> {
        let id = self.next_id;
        self.next_id += 1;
        let frame = OutgoingFrame::Call {
            id,
            method: method.to_string(),
            args: args.to_vec(),
        };
        self.connection.send(&frame.to_json());
        self.pending.insert(
            id,
            match (timeout_ms, method) {
                (Some(timeout_ms), _) => PendingKind::Timeout {
                    method: method.to_string(),
                    timeout_ms,
                },
                (None, _) => PendingKind::Plain,
            },
        );
        Ok(id)
    }

    /// Upstream `callWith` timeout fire: abandon with the exact message and
    /// tell the peer to stop.
    pub fn on_timeout(&mut self, id: u64) -> Result<(), String> {
        let Some(PendingKind::Timeout { method, timeout_ms }) = self.pending.remove(&id) else {
            return Ok(());
        };
        let frame = OutgoingFrame::Cancel { id };
        self.connection.send(&frame.to_json());
        Err(timeout_error(&method, timeout_ms))
    }

    /// Upstream `onAbort`/`abandon` with a cancelled call.
    pub fn abandon(&mut self, id: u64) -> Result<(), String> {
        if self.pending.remove(&id).is_none() {
            return Ok(());
        }
        let frame = OutgoingFrame::Cancel { id };
        self.connection.send(&frame.to_json());
        Err(CALL_CANCELLED.to_string())
    }

    /// Upstream incoming `result` frame: `waiter.resolve(frame.result)`.
    pub fn on_result(&mut self, id: u64) -> Result<(), String> {
        match self.pending.remove(&id) {
            Some(_) => Ok(()),
            None => Ok(()),
        }
    }

    /// Upstream incoming `error` frame: `waiter.reject(new Error(frame.error))`.
    pub fn on_error(&mut self, id: u64, error: &str) -> Result<(), String> {
        if self.pending.remove(&id).is_some() {
            return Err(error.to_string());
        }
        Ok(())
    }

    /// Upstream incoming `call` frame: register the inflight controller and
    /// dispatch. Returns the outbound response frame. The inflight marker
    /// stays until the embedder's async dispatch settles
    /// (`.finally(() => inflight.delete(id))`) — see [`RpcPeer::settle_call`].
    pub fn on_call(&mut self, id: u64, method: &str, args: &[Value]) -> OutgoingFrame {
        self.inflight.insert(id, ());
        let outcome = self.dispatch(method, args);
        match outcome {
            Ok(result) => {
                // `undefined` vanishes through JSON: absent results go as null.
                let result = result.unwrap_or(Value::Null);
                OutgoingFrame::Result { id, result }
            }
            Err(error) => OutgoingFrame::Error { id, error },
        }
    }

    fn dispatch(&self, method: &str, args: &[Value]) -> Result<Option<Value>, String> {
        let local = method
            .split_once('.')
            .filter(|(service, _)| !service.is_empty())
            .filter(|(service, _)| self.services.contains(*service));
        let Some((service, member)) = local else {
            // Upstream: an unmatched method goes to `forward`, which is what
            // makes the server transparent.
            return match &self.forward {
                Some(forward) => forward(method, args).map(Some),
                None => Err(format!("No service provides {method}")),
            };
        };
        // Member dispatch through the embedder's service object; an unknown
        // member fails with the exact upstream text.
        (self.invoke)(service, member, args)
    }

    /// Upstream `.finally(() => inflight.delete(frame.id))`: the embedder
    /// calls this when its async dispatch settles.
    pub fn settle_call(&mut self, id: u64) {
        self.inflight.remove(&id);
    }

    /// Upstream incoming `cancel` frame: abort the inflight controller.
    pub fn on_cancel(&mut self, id: u64) -> Option<&'static str> {
        if self.inflight.remove(&id).is_some() {
            return Some(CANCELLED_BY_CALLER);
        }
        None
    }

    /// Upstream `emit`.
    pub fn emit(&self, service: &str, payload: &Value) {
        let frame = OutgoingFrame::Event {
            service: service.to_string(),
            payload: payload.clone(),
            to: None,
        };
        self.connection.send(&frame.to_json());
    }

    /// Upstream `emitTo`.
    pub fn emit_to(&self, service: &str, payload: &Value, to: &str) {
        let frame = OutgoingFrame::Event {
            service: service.to_string(),
            payload: payload.clone(),
            to: Some(to.to_string()),
        };
        self.connection.send(&frame.to_json());
    }

    /// Upstream `emitRaw`.
    pub fn emit_raw(&self, service: &str, payload: &Value, to: Option<&str>) {
        let frame = OutgoingFrame::Event {
            service: service.to_string(),
            payload: payload.clone(),
            to: to.map(str::to_string),
        };
        self.connection.send(&frame.to_json());
    }

    /// Upstream `onEvent`/`on` handler registration + delivery.
    pub fn on_event(&mut self, handler: EventHandler) {
        self.event_handlers.push(handler);
    }

    /// Upstream incoming `event` frame: fan out to handlers.
    pub fn on_incoming_event(&self, service: &str, payload: &Value, to: Option<&str>) {
        for handler in &self.event_handlers {
            handler(service, payload, to);
        }
    }

    /// Upstream incoming `announce` frame: replace the announced set.
    pub fn on_announce(&mut self, services: &[String]) {
        self.announced.clear();
        for service in services {
            self.announced.insert(service.clone());
        }
    }

    /// Upstream liveness tick with `deadMs` (0 disables): close when silent
    /// past the deadline, else ping.
    pub fn liveness_tick(&self, dead_ms: u64, ms_since_last_frame: u64) -> LivenessAction {
        if dead_ms == 0 {
            return LivenessAction::Disabled;
        }
        if ms_since_last_frame > dead_ms {
            self.connection.close();
            LivenessAction::Closed
        } else {
            let frame = OutgoingFrame::Ping;
            self.connection.send(&frame.to_json());
            LivenessAction::Pinged
        }
    }

    /// Upstream liveness interval period: `Math.floor(deadMs / 3)`.
    pub fn liveness_interval_ms(dead_ms: u64) -> u64 {
        if dead_ms == 0 {
            0
        } else {
            dead_ms / 3
        }
    }

    /// Upstream default `deadMs`.
    pub fn default_dead_ms() -> u64 {
        DEFAULT_DEAD_MS
    }

    /// Upstream `onClose`: reject every pending waiter and abort inflight.
    pub fn on_connection_closed(&mut self) -> Vec<String> {
        let pending = self.pending.drain().collect::<Vec<_>>();
        let inflight = self.inflight.drain().collect::<Vec<_>>();
        let mut errors = Vec::new();
        for _ in pending {
            errors.push(CONNECTION_CLOSED.to_string());
        }
        let _ = inflight;
        errors
    }

    /// Upstream `close`.
    pub fn close(&self) {
        self.connection.close();
    }

    /// The underlying connection (for embedders/tests observing sends).
    pub fn connection(&self) -> &C {
        &self.connection
    }
}

/// Upstream liveness tick outcomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LivenessAction {
    Disabled,
    Pinged,
    Closed,
}

/// Upstream forward-rule error text (`server/run.ts`).
pub fn no_host_provides_error(
    service: &str,
    server_has: &[String],
    worker_has: &[String],
) -> String {
    format!(
        "No host provides {service}: server has [{}], worker has [{}]",
        server_has.join(", "),
        worker_has.join(", ")
    )
}

/// Upstream `server/run.ts` "not attached" error.
pub const NOT_ATTACHED_ERROR: &str = "Not attached to a session";
