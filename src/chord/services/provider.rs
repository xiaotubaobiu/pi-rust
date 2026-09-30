//! Remote service provider: hosts implementations for one remote consumer and
//! owns that consumer's subscriptions. Port of
//! `packages/chord/src/services/provider.ts` (upstream sha256
//! `fe810eaa1eb8418025b2dd0d16bb049c8641fd1b864fbd31c8f8de031c563fcc`).
//!
//! # Implementation members
//!
//! Upstream `provide` receives a plain object and *classifies* it: own data
//! properties (sorted by name) become methods when functions and replicated
//! states when they are `MutableReplicatedState` instances
//! (`provider.ts:544-570`). The port's [`InstanceMember`] enum is that
//! classification expressed in the type system: a [`BTreeMap`] of members
//! plays the role of the plain object (BTreeMap iteration is the upstream's
//! `Object.keys(...).sort()`), and the data-property / `not remotely
//! exposable` checks are unrepresentable — a member is either a method or a
//! state by construction.
//!
//! # Threading and delivery
//!
//! Provider state sits behind a mutex shared through `Arc`. Each state member
//! registers a source listener (`state-internals.ts`) that routes published
//! operation batches to [`RemoteServiceProvider::emit_update`]; the mutex is
//! never held while state members publish, which reproduces the upstream
//! event-loop reentrancy without reentrant locks. Subscriber listeners return
//! `Result`, standing in for the upstream `try`/`catch` collection of
//! listener failures; buffered updates replay on activation.
//!
//! Async method execution and the consumer-side binding
//! (`services/consumer.ts`) are a deferred seam (M6 report, S1): methods here
//! are synchronous closures, which is sufficient for the deterministic
//! provider/endpoint surface the server package consumes.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, Weak};

use crate::chord::context::Context;
use crate::chord::delta::Op;
use crate::chord::types::{
    JsonValue, ServiceCall, ServiceCatalogueEntry, ServiceInstanceAddress, ServiceInstanceSnapshot,
    ServiceMemberSnapshot, ServiceMode, ServiceProviderUpdate, ServiceSubscriptionSnapshot,
};

use super::errors::{ChordError, RemoteServiceErrorCode};
use super::state::{service_delivery_context, MutableReplicatedState};
use super::wire::{decode_service_control_call, ServiceControlCall};

/// One member of a remote service implementation. See the module docs.
pub type RemoteMethod =
    dyn Fn(&[JsonValue], &Context) -> Result<Option<JsonValue>, ChordError> + Send + Sync;

/// The classified members of a remote service implementation.
#[derive(Clone)]
pub enum InstanceMember {
    Method(Arc<RemoteMethod>),
    State(Arc<MutableReplicatedState>),
}

impl std::fmt::Debug for InstanceMember {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstanceMember::Method(_) => f.write_str("InstanceMember::Method"),
            InstanceMember::State(state) => {
                write!(f, "InstanceMember::State(sequence={})", state.sequence())
            }
        }
    }
}

/// An implementation to provide: member name → classified member.
pub type Implementation = BTreeMap<String, InstanceMember>;

type UpdateListener =
    dyn Fn(&ServiceProviderUpdate, &Context) -> Result<(), ChordError> + Send + Sync;

struct ProviderInstance {
    address: Option<ServiceInstanceAddress>,
    members: BTreeMap<String, InstanceMember>,
    /// Source-listener unsubscribe tokens (upstream `removeMemberListeners`).
    remove_member_tokens: Vec<Box<dyn Fn() + Send + Sync>>,
}

#[derive(Debug)]
enum SubscriberState {
    /// Buffering until `activate` (upstream `active: false`).
    Buffering(Vec<(ServiceProviderUpdate, Context)>),
    /// Delivering as updates arrive (upstream `active: true`).
    Active,
    /// Closed; receives nothing (upstream `closed`).
    Closed,
}

struct Subscriber {
    listener: Arc<UpdateListener>,
    state: SubscriberState,
    /// Upstream `terminated`: disposed while buffering; a later `activate`
    /// still replays the buffer and then closes.
    terminated: bool,
}

impl Subscriber {
    fn new(listener: Arc<UpdateListener>) -> Subscriber {
        Subscriber {
            listener,
            state: SubscriberState::Buffering(Vec::new()),
            terminated: false,
        }
    }
}

struct Registration {
    service_id: String,
    mode: ServiceMode,
    singleton: Option<ProviderInstance>,
    /// Member name → kind, preserved across singleton replacements
    /// (`singletonShape`).
    singleton_shape: Option<BTreeMap<String, &'static str>>,
    /// Key → (instance, generation); BTreeMap gives the key-sorted snapshot
    /// order of upstream `#snapshot`.
    instances: BTreeMap<String, ProviderInstance>,
    generations: HashMap<String, u64>,
    /// Insertion-ordered subscribers (upstream `Set`).
    subscribers: Vec<(u64, Subscriber)>,
}

struct ProviderInner {
    registrations: BTreeMap<String, Registration>,
    /// Subscribers detached by `dispose` while still buffering; a later
    /// `activate` replays their buffer and closes them (upstream keeps the
    /// `subscriber` object alive in the returned subscription closure).
    detached: Vec<(String, u64, Subscriber)>,
    disposed: bool,
    next_subscriber: u64,
}

/// The provider's catalogue definition entry (upstream
/// `ServiceProviderDefinition | { id }`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderEntry {
    pub id: String,
    pub mode: ServiceMode,
    pub local: bool,
}

impl ProviderEntry {
    pub fn singleton(id: &str) -> ProviderEntry {
        ProviderEntry {
            id: id.to_owned(),
            mode: ServiceMode::Singleton,
            local: false,
        }
    }

    pub fn keyed(id: &str) -> ProviderEntry {
        ProviderEntry {
            id: id.to_owned(),
            mode: ServiceMode::Keyed,
            local: false,
        }
    }

    /// Build a catalogue definition from a [`Service`]; `local: true`
    /// services are rejected by [`RemoteServiceProvider::new`]
    /// (`provider.ts:86-90`).
    pub fn from_service(
        service: &crate::chord::types::Service,
        mode: ServiceMode,
    ) -> ProviderEntry {
        ProviderEntry {
            id: service.id.clone(),
            mode,
            local: service.local,
        }
    }
}

/// The upstream `RemoteServiceProvider` (`provider.ts:77-500`).
pub struct RemoteServiceProvider {
    inner: Mutex<ProviderInner>,
}

impl RemoteServiceProvider {
    /// `new RemoteServiceProvider(entries)` (`provider.ts:82-105`).
    pub fn new(entries: &[ProviderEntry]) -> Result<Arc<Self>, ChordError> {
        let mut registrations = BTreeMap::new();
        for entry in entries {
            if entry.local {
                return Err(ChordError::Type(format!(
                    "Local service {} cannot be published remotely",
                    entry.id
                )));
            }
            if entries.iter().filter(|other| other.id == entry.id).count() > 1 {
                return Err(ChordError::Type(
                    "Remote service catalogue contains duplicate IDs".to_owned(),
                ));
            }
            registrations.insert(
                entry.id.clone(),
                Registration {
                    service_id: entry.id.clone(),
                    mode: entry.mode,
                    singleton: None,
                    singleton_shape: None,
                    instances: BTreeMap::new(),
                    generations: HashMap::new(),
                    subscribers: Vec::new(),
                },
            );
        }
        Ok(Arc::new(RemoteServiceProvider {
            inner: Mutex::new(ProviderInner {
                registrations,
                detached: Vec::new(),
                disposed: false,
                next_subscriber: 0,
            }),
        }))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ProviderInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn assert_active(inner: &ProviderInner) -> Result<(), ChordError> {
        if inner.disposed {
            return Err(ChordError::Type(
                "Remote service provider is disposed".to_owned(),
            ));
        }
        Ok(())
    }

    /// `get catalogue` (`provider.ts:107-109`).
    pub fn catalogue(&self) -> Vec<ServiceCatalogueEntry> {
        self.lock()
            .registrations
            .values()
            .map(|registration| ServiceCatalogueEntry {
                service_id: registration.service_id.clone(),
                mode: registration.mode,
            })
            .collect()
    }

    /// `#registration` (`provider.ts:327-339`).
    fn registration<'a>(
        inner: &'a mut ProviderInner,
        service_id: &str,
        mode: ServiceMode,
    ) -> Result<&'a mut Registration, ChordError> {
        let Some(registration) = inner.registrations.get_mut(service_id) else {
            return Err(ChordError::remote(
                RemoteServiceErrorCode::ServiceNotFound,
                format!("Unknown remote service {service_id}"),
            ));
        };
        if registration.mode != mode {
            return Err(ChordError::remote(
                RemoteServiceErrorCode::ServiceModeMismatch,
                format!(
                    "Remote service {service_id} is {}, not {}",
                    registration.mode.as_str(),
                    mode.as_str()
                ),
            ));
        }
        Ok(registration)
    }

    /// `#assertRemotable` (`provider.ts:487-489`).
    fn assert_remotable(service: &crate::chord::types::Service) -> Result<(), ChordError> {
        if service.local {
            return Err(ChordError::remote(
                RemoteServiceErrorCode::ServiceNotAllowed,
                format!("Service {} is process-local", service.id),
            ));
        }
        Ok(())
    }

    /// `#assertAllowed` (`provider.ts:491-495`).
    fn assert_allowed(inner: &ProviderInner, service_id: &str) -> Result<(), ChordError> {
        if !inner.registrations.contains_key(service_id) {
            return Err(ChordError::remote(
                RemoteServiceErrorCode::ServiceNotAllowed,
                format!("Remote service {service_id} is not allowlisted"),
            ));
        }
        Ok(())
    }

    /// `provide` (`provider.ts:111-124`).
    pub fn provide(
        self: &Arc<Self>,
        service: &crate::chord::types::Service,
        implementation: Implementation,
    ) -> Result<(), ChordError> {
        let mut inner = self.lock();
        Self::assert_active(&inner)?;
        Self::assert_remotable(service)?;
        Self::assert_allowed(&inner, &service.id)?;
        let classified = classify_implementation(&service.id, implementation)?;
        let shape = member_shape(&classified);
        let registration = Self::registration(&mut inner, &service.id, ServiceMode::Singleton)?;
        if registration.singleton.is_some() {
            return Err(ChordError::remote(
                RemoteServiceErrorCode::ServiceModeMismatch,
                format!("Remote service {} already has a provider", service.id),
            ));
        }
        let instance = create_instance(self, registration.service_id.clone(), None, &classified)?;
        registration.singleton = Some(instance);
        registration.singleton_shape = Some(shape);
        Ok(())
    }

    /// `withdraw` (`provider.ts:127-138`): disconnect one singleton while
    /// preserving active subscriptions and remote facades.
    pub fn withdraw(&self, service: &crate::chord::types::Service) -> Result<(), ChordError> {
        let mut inner = self.lock();
        Self::assert_active(&inner)?;
        Self::assert_remotable(service)?;
        Self::assert_allowed(&inner, &service.id)?;
        let previous = {
            let registration = Self::registration(&mut inner, &service.id, ServiceMode::Singleton)?;
            let previous = registration.singleton.take();
            let Some(previous) = previous else {
                return Ok(());
            };
            for token in &previous.remove_member_tokens {
                token();
            }
            previous
        };
        drop(previous);
        emit(
            &mut inner,
            &service.id,
            ServiceProviderUpdate::Unavailable,
            &service_delivery_context(),
        )
    }

    /// `validateReplacement` (`provider.ts:141-148`).
    pub fn validate_replacement(
        &self,
        service: &crate::chord::types::Service,
        implementation: &Implementation,
    ) -> Result<(), ChordError> {
        let mut inner = self.lock();
        Self::assert_active(&inner)?;
        Self::assert_remotable(service)?;
        Self::assert_allowed(&inner, &service.id)?;
        let classified = classify_implementation(&service.id, implementation.clone())?;
        let shape = member_shape(&classified);
        let registration = Self::registration(&mut inner, &service.id, ServiceMode::Singleton)?;
        assert_singleton_shape(registration, &shape)
    }

    /// `replace` (`provider.ts:151-168`): replace one singleton without
    /// making its stable remote facade unavailable.
    pub fn replace(
        self: &Arc<Self>,
        service: &crate::chord::types::Service,
        implementation: Implementation,
    ) -> Result<(), ChordError> {
        let mut inner = self.lock();
        Self::assert_active(&inner)?;
        Self::assert_remotable(service)?;
        Self::assert_allowed(&inner, &service.id)?;
        let classified = classify_implementation(&service.id, implementation)?;
        let shape = member_shape(&classified);
        let replacement = {
            let registration = Self::registration(&mut inner, &service.id, ServiceMode::Singleton)?;
            assert_singleton_shape(registration, &shape)?;
            let replacement =
                create_instance(self, registration.service_id.clone(), None, &classified)?;
            if let Some(previous) = registration.singleton.take() {
                for token in &previous.remove_member_tokens {
                    token();
                }
            }
            registration.singleton = Some(replacement);
            registration.singleton_shape = Some(shape);
            snapshot_instance(registration.singleton.as_ref().expect("just assigned"))
        };
        emit(
            &mut inner,
            &service.id,
            ServiceProviderUpdate::Replaced {
                snapshot: replacement,
            },
            &service_delivery_context(),
        )
    }

    /// `spawn` (`provider.ts:181-210`): returns the close handle (upstream
    /// returns `() => void`).
    pub fn spawn(
        self: &Arc<Self>,
        service: &crate::chord::types::Service,
        key: &str,
        implementation: Implementation,
    ) -> Result<SpawnHandle, ChordError> {
        let mut inner = self.lock();
        Self::assert_active(&inner)?;
        Self::assert_remotable(service)?;
        if key.is_empty() {
            return Err(ChordError::Type(
                "Remote service instance key must not be empty".to_owned(),
            ));
        }
        Self::assert_allowed(&inner, &service.id)?;
        let (snapshot, address) = {
            let registration = Self::registration(&mut inner, &service.id, ServiceMode::Keyed)?;
            if registration.instances.contains_key(key) {
                return Err(ChordError::remote(
                    RemoteServiceErrorCode::ServiceModeMismatch,
                    format!(
                        "Remote service {} already has a live instance with key {key}",
                        service.id
                    ),
                ));
            }
            let generation = registration.generations.get(key).copied().unwrap_or(0) + 1;
            registration.generations.insert(key.to_owned(), generation);
            let address = ServiceInstanceAddress {
                key: key.to_owned(),
                generation,
            };
            let classified = classify_implementation(&service.id, implementation)?;
            let instance = create_instance(
                self,
                registration.service_id.clone(),
                Some(address.clone()),
                &classified,
            )?;
            registration.instances.insert(key.to_owned(), instance);
            let snapshot =
                snapshot_instance(registration.instances.get(key).expect("just inserted"));
            (snapshot, address)
        };
        emit(
            &mut inner,
            &service.id,
            ServiceProviderUpdate::Spawned { instance: snapshot },
            &service_delivery_context(),
        )?;
        Ok(SpawnHandle {
            provider: Arc::downgrade(self),
            service_id: service.id.clone(),
            key: key.to_owned(),
            generation: address.generation,
        })
    }

    /// `invoke` (`provider.ts:212-235`).
    pub fn invoke(
        &self,
        call: &ServiceCall,
        context: &Context,
    ) -> Result<Option<JsonValue>, ChordError> {
        let mut inner = self.lock();
        Self::assert_active(&inner)?;
        Self::assert_allowed(&inner, &call.service_id)?;
        let registration = inner
            .registrations
            .get_mut(&call.service_id)
            .expect("checked above");
        let instance = resolve_instance(registration, call.instance.as_ref())?;
        let Some(member) = instance.members.get(&call.member) else {
            return Err(ChordError::remote(
                RemoteServiceErrorCode::ServiceMemberNotFound,
                format!(
                    "Unknown remote service member {}.{}",
                    call.service_id, call.member
                ),
            ));
        };
        let InstanceMember::Method(method) = member else {
            return Err(ChordError::remote(
                RemoteServiceErrorCode::ServiceMemberMismatch,
                format!(
                    "Remote service member {}.{} is not a method",
                    call.service_id, call.member
                ),
            ));
        };
        let method = method.clone();
        drop(inner);
        // Upstream awaits the method with no provider state held; the port
        // releases the mutex so a method that publishes state (routing back
        // through `emit_update`) cannot deadlock.
        method(&call.args, context)
    }

    /// `subscribe` (`provider.ts:237-284`): flushes the registration's state
    /// members, attaches the (initially buffering) subscriber, and returns the
    /// subscription whose snapshot hydrates the consumer.
    pub fn subscribe<F>(
        self: &Arc<Self>,
        service_id: &str,
        mode: ServiceMode,
        listener: F,
    ) -> Result<ServiceSubscription, ChordError>
    where
        F: Fn(&ServiceProviderUpdate, &Context) -> Result<(), ChordError> + Send + Sync + 'static,
    {
        let mut inner = self.lock();
        Self::assert_active(&inner)?;
        Self::assert_allowed(&inner, service_id)?;
        let registration = Self::registration(&mut inner, service_id, mode)?;
        if registration.mode == ServiceMode::Singleton && registration.singleton.is_none() {
            return Err(ChordError::remote(
                RemoteServiceErrorCode::ServiceNotFound,
                format!("Remote service {service_id} has no provider"),
            ));
        }
        // `#publishPending` runs before the subscriber is attached, so the
        // flush reaches only the subscribers that already exist. The state
        // members publish outside the provider lock because their source
        // listeners route back into `emit_update`.
        let states: Vec<Arc<MutableReplicatedState>> = match registration.mode {
            ServiceMode::Singleton => registration
                .singleton
                .iter()
                .flat_map(|instance| instance.members.values())
                .filter_map(|member| match member {
                    InstanceMember::State(state) => Some(state.clone()),
                    InstanceMember::Method(_) => None,
                })
                .collect(),
            ServiceMode::Keyed => registration
                .instances
                .values()
                .flat_map(|instance| instance.members.values())
                .filter_map(|member| match member {
                    InstanceMember::State(state) => Some(state.clone()),
                    InstanceMember::Method(_) => None,
                })
                .collect(),
        };
        drop(inner);
        for state in &states {
            state.publish(&service_delivery_context());
        }

        let mut inner = self.lock();
        let token = inner.next_subscriber;
        inner.next_subscriber += 1;
        let registration = inner
            .registrations
            .get_mut(service_id)
            .expect("checked above");
        registration
            .subscribers
            .push((token, Subscriber::new(Arc::new(listener))));
        let snapshot = snapshot(registration);
        drop(inner);
        Ok(ServiceSubscription {
            provider: Arc::downgrade(self),
            service_id: service_id.to_owned(),
            token,
            snapshot,
        })
    }

    /// `dispose` (`provider.ts:286-325`).
    pub fn dispose(&self) -> Result<(), ChordError> {
        let mut inner = self.lock();
        if inner.disposed {
            return Ok(());
        }
        inner.disposed = true;
        let service_ids: Vec<String> = inner.registrations.keys().cloned().collect();
        let mut errors: Vec<ChordError> = Vec::new();
        for service_id in &service_ids {
            let lifecycle: Vec<ServiceProviderUpdate> = {
                let Some(registration) = inner.registrations.get_mut(service_id) else {
                    continue;
                };
                let mut lifecycle = Vec::new();
                if let Some(singleton) = registration.singleton.take() {
                    for token in &singleton.remove_member_tokens {
                        token();
                    }
                    lifecycle.push(ServiceProviderUpdate::Unavailable);
                }
                let keys: Vec<String> = registration.instances.keys().cloned().collect();
                for key in &keys {
                    if let Some(instance) = registration.instances.remove(key) {
                        for token in &instance.remove_member_tokens {
                            token();
                        }
                        if let Some(address) = &instance.address {
                            lifecycle.push(ServiceProviderUpdate::Closed {
                                instance: address.clone(),
                            });
                        }
                    }
                }
                lifecycle
            };
            for update in lifecycle {
                if let Err(error) =
                    emit(&mut inner, service_id, update, &service_delivery_context())
                {
                    errors.push(error);
                }
            }
            let Some(registration) = inner.registrations.get_mut(service_id) else {
                continue;
            };
            for (at, subscriber) in std::mem::take(&mut registration.subscribers) {
                match subscriber.state {
                    // Active subscribers close with their buffer dropped
                    // (provider.ts:312-315); buffering ones terminate and
                    // stay replayable through their subscription handle.
                    SubscriberState::Active | SubscriberState::Closed => {}
                    SubscriberState::Buffering(_) => {
                        let mut terminated = subscriber;
                        terminated.terminated = true;
                        inner.detached.push((service_id.clone(), at, terminated));
                    }
                }
            }
        }
        inner.registrations.clear();
        if errors.len() == 1 {
            return Err(errors.remove(0));
        }
        if errors.len() > 1 {
            return Err(ChordError::Aggregate {
                message: "Failed to dispose remote service provider".to_owned(),
                errors,
            });
        }
        Ok(())
    }

    /// `#emit` equivalent used by state source listeners
    /// (`provider.ts:467-485`).
    fn emit_update(
        &self,
        service_id: &str,
        update: ServiceProviderUpdate,
        context: &Context,
    ) -> Result<(), ChordError> {
        let mut inner = self.lock();
        emit(&mut inner, service_id, update, context)
    }

    fn activate_subscription(&self, service_id: &str, token: u64) -> Result<(), ChordError> {
        let mut inner = self.lock();
        if let Some(registration) = inner.registrations.get_mut(service_id) {
            if let Some((_, subscriber)) = registration
                .subscribers
                .iter_mut()
                .find(|(at, _)| *at == token)
            {
                return Self::activate_one(subscriber);
            }
        }
        // A buffering subscriber detached by dispose: the buffer still
        // replays, then the subscriber closes (upstream `terminated`).
        if let Some(position) = inner
            .detached
            .iter()
            .position(|(at_service, at, _)| at_service == service_id && *at == token)
        {
            let result = Self::activate_one(&mut inner.detached[position].2);
            inner.detached.remove(position);
            return result;
        }
        Ok(())
    }

    /// The `activate` closure (`provider.ts:260-276`): replay every buffered
    /// update, collecting listener failures, then report them.
    fn activate_one(subscriber: &mut Subscriber) -> Result<(), ChordError> {
        if matches!(
            subscriber.state,
            SubscriberState::Closed | SubscriberState::Active
        ) {
            return Ok(());
        }
        let SubscriberState::Buffering(buffer) =
            std::mem::replace(&mut subscriber.state, SubscriberState::Active)
        else {
            unreachable!("checked above");
        };
        let listener = subscriber.listener.clone();
        let terminated = subscriber.terminated;
        let mut errors: Vec<ChordError> = Vec::new();
        for (update, context) in buffer {
            if let Err(error) = listener(&update, &context) {
                errors.push(error);
            }
        }
        if terminated {
            subscriber.state = SubscriberState::Closed;
        }
        if errors.is_empty() {
            return Ok(());
        }
        if errors.len() == 1 {
            return Err(errors.remove(0));
        }
        Err(ChordError::Aggregate {
            message: "Failed to activate remote service subscription".to_owned(),
            errors,
        })
    }

    fn close_subscription(&self, service_id: &str, token: u64) {
        let mut inner = self.lock();
        let Some(registration) = inner.registrations.get_mut(service_id) else {
            return;
        };
        registration.subscribers.retain(|(at, _)| *at != token);
    }
}

/// A keyed instance close handle (the closure returned by upstream `spawn`,
/// `provider.ts:200-209`).
#[derive(Debug)]
pub struct SpawnHandle {
    provider: Weak<RemoteServiceProvider>,
    service_id: String,
    key: String,
    generation: u64,
}

impl SpawnHandle {
    /// Close the instance; a second close is a no-op, and closing after the
    /// key was re-spawned does not touch the new instance.
    pub fn close(&self) -> Result<(), ChordError> {
        let Some(provider) = self.provider.upgrade() else {
            return Ok(());
        };
        let mut inner = provider.lock();
        if inner.disposed {
            return Ok(());
        }
        let Some(registration) = inner.registrations.get_mut(&self.service_id) else {
            return Ok(());
        };
        match registration.instances.get(&self.key) {
            Some(instance)
                if instance.address.as_ref().map(|a| a.generation) != Some(self.generation) =>
            {
                // The key was re-spawned: the live instance is not this one.
                return Ok(());
            }
            None => return Ok(()),
            _ => {}
        }
        let Some(instance) = registration.instances.remove(&self.key) else {
            return Ok(());
        };
        for token in &instance.remove_member_tokens {
            token();
        }
        let address = ServiceInstanceAddress {
            key: self.key.clone(),
            generation: self.generation,
        };
        emit(
            &mut inner,
            &self.service_id,
            ServiceProviderUpdate::Closed { instance: address },
            &service_delivery_context(),
        )
    }
}

/// The upstream `ServiceSubscription` (`types.ts:170-174`).
#[derive(Debug)]
pub struct ServiceSubscription {
    provider: Weak<RemoteServiceProvider>,
    service_id: String,
    token: u64,
    snapshot: ServiceSubscriptionSnapshot,
}

impl ServiceSubscription {
    /// `get snapshot` (`types.ts:171`).
    pub fn snapshot(&self) -> &ServiceSubscriptionSnapshot {
        &self.snapshot
    }

    /// `activate()` (`provider.ts:260-276`).
    pub fn activate(&self) -> Result<(), ChordError> {
        let Some(provider) = self.provider.upgrade() else {
            return Ok(());
        };
        provider.activate_subscription(&self.service_id, self.token)
    }

    /// `close(context?)` (`provider.ts:277-282`).
    pub fn close(&self) {
        let Some(provider) = self.provider.upgrade() else {
            return;
        };
        provider.close_subscription(&self.service_id, self.token);
    }
}

// ── classification, snapshots, emit ─────────────────────────────────────────

impl std::fmt::Debug for ProviderInstance {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderInstance")
            .field("address", &self.address)
            .field("members", &self.members)
            .field("remove_member_tokens", &self.remove_member_tokens.len())
            .finish()
    }
}

impl std::fmt::Debug for Subscriber {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Subscriber")
            .field("state", &self.state)
            .field("terminated", &self.terminated)
            .finish()
    }
}

impl std::fmt::Debug for Registration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Registration")
            .field("service_id", &self.service_id)
            .field("mode", &self.mode)
            .field("has_singleton", &self.singleton.is_some())
            .field("instances", &self.instances.len())
            .field("subscribers", &self.subscribers.len())
            .finish()
    }
}

impl std::fmt::Debug for RemoteServiceProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.inner.fmt(f)
    }
}

impl std::fmt::Debug for ProviderInner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderInner")
            .field("registrations", &self.registrations)
            .field("detached", &self.detached.len())
            .field("disposed", &self.disposed)
            .field("next_subscriber", &self.next_subscriber)
            .finish()
    }
}

fn classify_implementation(
    service_id: &str,
    implementation: Implementation,
) -> Result<Implementation, ChordError> {
    if implementation.is_empty() {
        return Err(ChordError::Type(format!(
            "Remote service {service_id} has no members"
        )));
    }
    Ok(implementation)
}

fn member_kind(member: &InstanceMember) -> &'static str {
    match member {
        InstanceMember::Method(_) => "method",
        InstanceMember::State(_) => "state",
    }
}

fn member_shape(members: &Implementation) -> BTreeMap<String, &'static str> {
    members
        .iter()
        .map(|(name, member)| (name.clone(), member_kind(member)))
        .collect()
}

fn assert_singleton_shape(
    registration: &Registration,
    replacement: &BTreeMap<String, &'static str>,
) -> Result<(), ChordError> {
    let Some(current) = &registration.singleton_shape else {
        return Ok(());
    };
    if current.len() == replacement.len()
        && current
            .iter()
            .all(|(name, kind)| replacement.get(name) == Some(kind))
    {
        return Ok(());
    }
    Err(ChordError::remote(
        RemoteServiceErrorCode::ServiceMemberMismatch,
        format!(
            "Remote service {} replacement must preserve its member shape",
            registration.service_id
        ),
    ))
}

/// `#createInstance` (`provider.ts:341-374`): wire each state member's source
/// listener so publications flow to subscribers.
fn create_instance(
    provider: &Arc<RemoteServiceProvider>,
    service_id: String,
    address: Option<ServiceInstanceAddress>,
    members: &Implementation,
) -> Result<ProviderInstance, ChordError> {
    let mut instance = ProviderInstance {
        address: address.clone(),
        members: members.clone(),
        remove_member_tokens: Vec::new(),
    };
    let provider_weak = Arc::downgrade(provider);
    for (name, member) in &instance.members {
        let InstanceMember::State(state) = member else {
            continue;
        };
        let member_name = name.clone();
        let instance_address = address.clone();
        let service_id = service_id.clone();
        let provider_weak = provider_weak.clone();
        let token = state.subscribe_source(move |ops: &[Op], sequence: u64, context: &Context| {
            let Some(provider) = provider_weak.upgrade() else {
                return;
            };
            let update = ServiceProviderUpdate::State {
                instance: instance_address.clone(),
                member: member_name.clone(),
                sequence,
                ops: ops.to_vec(),
            };
            // `instance.active` upstream; the token removal keeps this from
            // firing after deactivation.
            let _ = provider.emit_update(&service_id, update, context);
        });
        instance.remove_member_tokens.push(token);
    }
    Ok(instance)
}

fn resolve_instance<'a>(
    registration: &'a mut Registration,
    address: Option<&ServiceInstanceAddress>,
) -> Result<&'a ProviderInstance, ChordError> {
    if registration.mode == ServiceMode::Singleton {
        if address.is_some() {
            return Err(ChordError::remote(
                RemoteServiceErrorCode::ServiceModeMismatch,
                format!("Remote service {} is singleton", registration.service_id),
            ));
        }
        return match registration.singleton.as_ref() {
            Some(instance) => Ok(instance),
            None => Err(ChordError::remote(
                RemoteServiceErrorCode::ServiceNotFound,
                format!("Remote service {} has no provider", registration.service_id),
            )),
        };
    }
    let Some(address) = address else {
        return Err(ChordError::remote(
            RemoteServiceErrorCode::ServiceModeMismatch,
            format!("Remote service {} is keyed", registration.service_id),
        ));
    };
    let Some(instance) = registration.instances.get(&address.key) else {
        return Err(ChordError::remote(
            RemoteServiceErrorCode::ServiceInstanceNotFound,
            format!(
                "Remote service {} has no instance {}",
                registration.service_id, address.key
            ),
        ));
    };
    let generation = instance
        .address
        .as_ref()
        .map(|instance_address| instance_address.generation);
    if generation != Some(address.generation) {
        return Err(ChordError::remote(
            RemoteServiceErrorCode::ServiceStaleInstance,
            format!(
                "Remote service {} instance {} is stale",
                registration.service_id, address.key
            ),
        ));
    }
    Ok(instance)
}

/// `#snapshot` (`provider.ts:435-445`).
fn snapshot(registration: &Registration) -> ServiceSubscriptionSnapshot {
    let instances: Vec<ServiceInstanceSnapshot> = match registration.mode {
        ServiceMode::Singleton => match &registration.singleton {
            Some(singleton) => vec![snapshot_instance(singleton)],
            None => Vec::new(),
        },
        // BTreeMap order == upstream's key-sorted instance list.
        ServiceMode::Keyed => registration
            .instances
            .values()
            .map(snapshot_instance)
            .collect(),
    };
    ServiceSubscriptionSnapshot {
        service_id: registration.service_id.clone(),
        mode: registration.mode,
        instances,
    }
}

/// `#snapshotInstance` (`provider.ts:447-465`).
fn snapshot_instance(instance: &ProviderInstance) -> ServiceInstanceSnapshot {
    let members = instance
        .members
        .iter()
        .map(|(name, member)| match member {
            InstanceMember::Method(_) => ServiceMemberSnapshot::Method { name: name.clone() },
            InstanceMember::State(state) => ServiceMemberSnapshot::State {
                name: name.clone(),
                sequence: state.sequence(),
                ops: vec![Op::Replace(state.value())],
            },
        })
        .collect();
    ServiceInstanceSnapshot {
        instance: instance.address.clone(),
        members,
    }
}

fn emit(
    inner: &mut ProviderInner,
    service_id: &str,
    update: ServiceProviderUpdate,
    context: &Context,
) -> Result<(), ChordError> {
    let Some(registration) = inner.registrations.get_mut(service_id) else {
        return Ok(());
    };
    if registration.subscribers.is_empty() {
        return Ok(());
    }
    let delivery_context = context.clone();
    let mut errors: Vec<ChordError> = Vec::new();
    let mut listeners: Vec<Arc<UpdateListener>> = Vec::new();
    for (_, subscriber) in &mut registration.subscribers {
        match &mut subscriber.state {
            SubscriberState::Closed => continue,
            SubscriberState::Buffering(buffer) => {
                buffer.push((update.clone(), delivery_context.clone()));
            }
            SubscriberState::Active => listeners.push(subscriber.listener.clone()),
        }
    }
    for listener in listeners {
        if let Err(error) = listener(&update, &delivery_context) {
            errors.push(error);
        }
    }
    if errors.len() == 1 {
        return Err(errors.remove(0));
    }
    if errors.len() > 1 {
        return Err(ChordError::Aggregate {
            message: format!("Failed to publish remote service {service_id} update"),
            errors,
        });
    }
    Ok(())
}

/// `validateRemoteServiceImplementation` (`provider.ts:540-542`).
pub fn validate_remote_service_implementation(
    service_id: &str,
    implementation: &Implementation,
) -> Result<(), ChordError> {
    classify_implementation(service_id, implementation.clone()).map(|_| ())
}

/// `createRemoteServiceEndpoint` (`provider.ts:502-538`): hosts one provider
/// for one remote consumer and owns that consumer's control-channel
/// subscriptions.
pub struct RemoteServiceEndpoint {
    provider: Arc<RemoteServiceProvider>,
    inner: Mutex<EndpointInner>,
}

#[derive(Debug, Default)]
struct EndpointInner {
    subscriptions: HashMap<String, ServiceSubscription>,
    disposed: bool,
}

/// The endpoint's update publisher (`ServiceUpdatePublisher`,
/// `provider.ts:65-69`); publish failures are swallowed by the endpoint.
type Publisher = Arc<dyn Fn(&str, &ServiceProviderUpdate, &Context) + Send + Sync>;

/// `createRemoteServiceEndpoint(provider)` (`provider.ts:502-506`).
pub fn create_remote_service_endpoint(
    provider: Arc<RemoteServiceProvider>,
) -> RemoteServiceEndpoint {
    RemoteServiceEndpoint::new(provider)
}

impl RemoteServiceEndpoint {
    pub fn new(provider: Arc<RemoteServiceProvider>) -> Self {
        RemoteServiceEndpoint {
            provider,
            inner: Mutex::new(EndpointInner::default()),
        }
    }

    /// `invoke(call, publish, context)` (`provider.ts:507-530`). The
    /// publisher receives subscription updates; failures to publish are
    /// swallowed upstream (`Promise.resolve(...).catch(() => {})`), so the
    /// publisher here returns nothing.
    pub fn invoke(
        &self,
        call: &ServiceCall,
        publish: Publisher,
        context: &Context,
    ) -> Result<Option<JsonValue>, ChordError> {
        let disposed = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .disposed;
        if disposed {
            return Err(ChordError::Type(
                "Remote service endpoint is disposed".to_owned(),
            ));
        }
        match decode_service_control_call(call) {
            Some(ServiceControlCall::Catalogue) => {
                let catalogue = self.provider.catalogue();
                return Ok(Some(
                    serde_json::to_value(
                        catalogue
                            .iter()
                            .map(ServiceCatalogueEntry::to_json)
                            .collect::<Vec<_>>(),
                    )
                    .expect("catalogue serialization cannot fail"),
                ));
            }
            Some(ServiceControlCall::Subscribe {
                subscription_id,
                service_id,
                mode,
            }) => {
                let mut inner = self.lock();
                if inner.subscriptions.contains_key(&subscription_id) {
                    return Err(ChordError::Type(
                        "Service subscription ID is already active".to_owned(),
                    ));
                }
                let subscription_id_for_listener = subscription_id.clone();
                let subscription =
                    self.provider
                        .subscribe(&service_id, mode, move |update, update_context| {
                            publish(&subscription_id_for_listener, update, update_context);
                            Ok(())
                        })?;
                let snapshot = subscription.snapshot().clone();
                subscription.activate()?;
                inner
                    .subscriptions
                    .insert(subscription_id.clone(), subscription);
                return Ok(Some(snapshot.to_json()));
            }
            Some(ServiceControlCall::Unsubscribe { subscription_id }) => {
                let mut inner = self.lock();
                let Some(subscription) = inner.subscriptions.remove(&subscription_id) else {
                    return Err(ChordError::Type(
                        "Service subscription was not found".to_owned(),
                    ));
                };
                subscription.close();
                return Ok(None);
            }
            None => {}
        }
        self.provider.invoke(call, context)
    }

    /// `dispose()` (`provider.ts:531-537`).
    pub fn dispose(&self) {
        let mut inner = self.lock();
        if inner.disposed {
            return;
        }
        inner.disposed = true;
        for (_, subscription) in inner.subscriptions.drain() {
            subscription.close();
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, EndpointInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
