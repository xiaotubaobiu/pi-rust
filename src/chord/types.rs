//! Chord data types. Port of the value shapes in
//! `packages/chord/src/types.ts` (upstream sha256
//! `885283da0e2a60274e3bdfcd503ca15bd66a8a485e0963816684c1ab3586e2be`) that
//! the deterministic services surface needs: service identity, catalogue
//! entries, instance addresses, member/instance/subscription snapshots,
//! provider updates, service calls, and replicated-state deliveries.
//!
//! Each type exposes [`to_json`](::serde_json::Value) producing the upstream
//! wire field names (`serviceId`, `mode`, `instances`, ...) so canonical
//! serialization is byte-comparable with the upstream oracle. `JsonValue` is
//! `serde_json::Value` (see the delta module docs for the key-ordering note);
//! the TS-only type-level machinery (`JsonRepresentation<T>`,
//! `RemoteServiceContract<T>`, `SERVICE_TYPE`) is expressed by Rust's type
//! system and the typed [`InstanceMember`] enum instead.

use serde_json::{json, Number};

use crate::chord::delta::{op_to_json, wire_op_to_json, Op, WireOp};

/// Upstream `JsonValue` (`types.ts:21`).
pub type JsonValue = serde_json::Value;

/// Upstream `ServiceMode` (`types.ts:60`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceMode {
    Singleton,
    Keyed,
}

impl ServiceMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ServiceMode::Singleton => "singleton",
            ServiceMode::Keyed => "keyed",
        }
    }

    pub fn to_json(&self) -> JsonValue {
        JsonValue::String(self.as_str().to_owned())
    }
}

/// Upstream `Service<T>` (`types.ts:63-68`): stable identity for one shared
/// service contract. The `[SERVICE_TYPE]` phantom is Rust's type parameter on
/// call sites; the runtime value carries only `id` and `local`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Service {
    pub id: String,
    /// Process-local services accept unrestricted object contracts and are
    /// never published remotely (`types.ts:65`).
    pub local: bool,
}

impl Service {
    pub fn to_json(&self) -> JsonValue {
        json!({ "id": self.id, "local": self.local })
    }
}

/// Upstream `ServiceCatalogueEntry` (`types.ts:124-127`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceCatalogueEntry {
    pub service_id: String,
    pub mode: ServiceMode,
}

impl ServiceCatalogueEntry {
    pub fn to_json(&self) -> JsonValue {
        json!({ "serviceId": self.service_id, "mode": self.mode.as_str() })
    }
}

/// Upstream `ServiceInstanceAddress` (`types.ts:129-132`).
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
pub struct ServiceInstanceAddress {
    pub key: String,
    pub generation: u64,
}

impl ServiceInstanceAddress {
    pub fn to_json(&self) -> JsonValue {
        json!({ "key": self.key, "generation": Number::from(self.generation) })
    }
}

/// Upstream `ServiceMemberSnapshot` (`types.ts:134-136`).
#[derive(Clone, Debug, PartialEq)]
pub enum ServiceMemberSnapshot {
    Method {
        name: String,
    },
    State {
        name: String,
        sequence: u64,
        ops: Vec<Op>,
    },
}

impl ServiceMemberSnapshot {
    pub fn name(&self) -> &str {
        match self {
            ServiceMemberSnapshot::Method { name } | ServiceMemberSnapshot::State { name, .. } => {
                name
            }
        }
    }

    pub fn to_json(&self) -> JsonValue {
        match self {
            ServiceMemberSnapshot::Method { name } => {
                json!({ "name": name, "kind": "method" })
            }
            ServiceMemberSnapshot::State {
                name,
                sequence,
                ops,
            } => {
                json!({
                    "name": name,
                    "kind": "state",
                    "sequence": Number::from(*sequence),
                    "ops": ops.iter().map(op_to_json).collect::<Vec<_>>(),
                })
            }
        }
    }
}

/// Upstream `ServiceInstanceSnapshot` (`types.ts:138-141`).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ServiceInstanceSnapshot {
    pub instance: Option<ServiceInstanceAddress>,
    pub members: Vec<ServiceMemberSnapshot>,
}

impl ServiceInstanceSnapshot {
    pub fn to_json(&self) -> JsonValue {
        let mut value = json!({
            "members": self.members.iter().map(ServiceMemberSnapshot::to_json).collect::<Vec<_>>(),
        });
        if let Some(instance) = &self.instance {
            value["instance"] = instance.to_json();
        }
        value
    }
}

/// Upstream `ServiceSubscriptionSnapshot` (`types.ts:143-147`).
#[derive(Clone, Debug, PartialEq)]
pub struct ServiceSubscriptionSnapshot {
    pub service_id: String,
    pub mode: ServiceMode,
    pub instances: Vec<ServiceInstanceSnapshot>,
}

impl ServiceSubscriptionSnapshot {
    pub fn to_json(&self) -> JsonValue {
        json!({
            "serviceId": self.service_id,
            "mode": self.mode.as_str(),
            "instances": self.instances.iter().map(ServiceInstanceSnapshot::to_json).collect::<Vec<_>>(),
        })
    }
}

/// Upstream `ServiceProviderUpdate` (`types.ts:149-160`).
#[derive(Clone, Debug, PartialEq)]
pub enum ServiceProviderUpdate {
    State {
        instance: Option<ServiceInstanceAddress>,
        member: String,
        sequence: u64,
        ops: Vec<Op>,
    },
    Unavailable,
    Replaced {
        snapshot: ServiceInstanceSnapshot,
    },
    Spawned {
        instance: ServiceInstanceSnapshot,
    },
    Closed {
        instance: ServiceInstanceAddress,
    },
}

impl ServiceProviderUpdate {
    pub fn to_json(&self) -> JsonValue {
        match self {
            ServiceProviderUpdate::State {
                instance,
                member,
                sequence,
                ops,
            } => {
                let mut value = json!({
                    "type": "state",
                    "member": member,
                    "sequence": Number::from(*sequence),
                    "ops": ops.iter().map(op_to_json).collect::<Vec<_>>(),
                });
                if let Some(instance) = instance {
                    value["instance"] = instance.to_json();
                }
                value
            }
            ServiceProviderUpdate::Unavailable => json!({ "type": "unavailable" }),
            ServiceProviderUpdate::Replaced { snapshot } => {
                json!({ "type": "replaced", "snapshot": snapshot.to_json() })
            }
            ServiceProviderUpdate::Spawned { instance } => {
                json!({ "type": "spawned", "instance": instance.to_json() })
            }
            ServiceProviderUpdate::Closed { instance } => {
                json!({ "type": "closed", "instance": instance.to_json() })
            }
        }
    }
}

/// Upstream `ServiceCall` (`types.ts:162-168`).
#[derive(Clone, Debug, PartialEq)]
pub struct ServiceCall {
    pub service_id: String,
    pub instance: Option<ServiceInstanceAddress>,
    pub member: String,
    pub args: Vec<JsonValue>,
}

impl ServiceCall {
    pub fn to_json(&self) -> JsonValue {
        let mut value = json!({
            "serviceId": self.service_id,
            "member": self.member,
            "args": self.args,
        });
        if let Some(instance) = &self.instance {
            value["instance"] = instance.to_json();
        }
        value
    }
}

/// Upstream `ReplicatedStateDelivery` (`types.ts:38-41`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReplicatedStateDelivery {
    pub kind: ReplicatedStateDeliveryKind,
    pub sequence: u64,
}

/// The `kind` field of upstream `ReplicatedStateDelivery`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplicatedStateDeliveryKind {
    Hydrate,
    Update,
}

impl ReplicatedStateDelivery {
    pub fn to_json(&self) -> JsonValue {
        json!({
            "kind": match self.kind {
                ReplicatedStateDeliveryKind::Hydrate => "hydrate",
                ReplicatedStateDeliveryKind::Update => "update",
            },
            "sequence": Number::from(self.sequence),
        })
    }
}

/// Upstream `WireServiceMemberSnapshot` (`services/wire.ts:11-13`).
#[derive(Clone, Debug, PartialEq)]
pub enum WireServiceMemberSnapshot {
    Method {
        name: String,
    },
    State {
        name: String,
        sequence: u64,
        ops: Vec<WireOp>,
    },
}

impl WireServiceMemberSnapshot {
    pub fn to_json(&self) -> JsonValue {
        match self {
            WireServiceMemberSnapshot::Method { name } => {
                json!({ "name": name, "kind": "method" })
            }
            WireServiceMemberSnapshot::State {
                name,
                sequence,
                ops,
            } => {
                json!({
                    "name": name,
                    "kind": "state",
                    "sequence": Number::from(*sequence),
                    "ops": ops.iter().map(wire_op_to_json).collect::<Vec<_>>(),
                })
            }
        }
    }
}

/// Upstream `WireServiceInstanceSnapshot` (`services/wire.ts:15-18`).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct WireServiceInstanceSnapshot {
    pub instance: Option<ServiceInstanceAddress>,
    pub members: Vec<WireServiceMemberSnapshot>,
}

impl WireServiceInstanceSnapshot {
    pub fn to_json(&self) -> JsonValue {
        let mut value = json!({
            "members": self.members.iter().map(WireServiceMemberSnapshot::to_json).collect::<Vec<_>>(),
        });
        if let Some(instance) = &self.instance {
            value["instance"] = instance.to_json();
        }
        value
    }
}

/// Upstream `WireServiceSubscriptionSnapshot` (`services/wire.ts:20-24`).
#[derive(Clone, Debug, PartialEq)]
pub struct WireServiceSubscriptionSnapshot {
    pub service_id: String,
    pub mode: ServiceMode,
    pub instances: Vec<WireServiceInstanceSnapshot>,
}

impl WireServiceSubscriptionSnapshot {
    pub fn to_json(&self) -> JsonValue {
        json!({
            "serviceId": self.service_id,
            "mode": self.mode.as_str(),
            "instances": self.instances.iter().map(WireServiceInstanceSnapshot::to_json).collect::<Vec<_>>(),
        })
    }
}

/// Upstream `WireServiceProviderUpdate` (`services/wire.ts:26-37`).
#[derive(Clone, Debug, PartialEq)]
pub enum WireServiceProviderUpdate {
    State {
        instance: Option<ServiceInstanceAddress>,
        member: String,
        sequence: u64,
        ops: Vec<WireOp>,
    },
    Unavailable,
    Replaced {
        snapshot: WireServiceInstanceSnapshot,
    },
    Spawned {
        instance: WireServiceInstanceSnapshot,
    },
    Closed {
        instance: ServiceInstanceAddress,
    },
}

impl WireServiceProviderUpdate {
    pub fn to_json(&self) -> JsonValue {
        match self {
            WireServiceProviderUpdate::State {
                instance,
                member,
                sequence,
                ops,
            } => {
                let mut value = json!({
                    "type": "state",
                    "member": member,
                    "sequence": Number::from(*sequence),
                    "ops": ops.iter().map(wire_op_to_json).collect::<Vec<_>>(),
                });
                if let Some(instance) = instance {
                    value["instance"] = instance.to_json();
                }
                value
            }
            WireServiceProviderUpdate::Unavailable => json!({ "type": "unavailable" }),
            WireServiceProviderUpdate::Replaced { snapshot } => {
                json!({ "type": "replaced", "snapshot": snapshot.to_json() })
            }
            WireServiceProviderUpdate::Spawned { instance } => {
                json!({ "type": "spawned", "instance": instance.to_json() })
            }
            WireServiceProviderUpdate::Closed { instance } => {
                json!({ "type": "closed", "instance": instance.to_json() })
            }
        }
    }
}
