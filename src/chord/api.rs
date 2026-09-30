//! Chord public API surface (deterministic core). Port of the subset of
//! `packages/chord/src/api.ts` (upstream sha256
//! `769a04a5f903bb53cc5b66e7353c69b02f12159d82f196a7894ceea5800ac201`) that
//! this slice covers:
//!
//! - [`define_service`] — `defineService` (`api.ts:70-82`), including the
//!   empty-ID and reserved `$chord.` namespace checks and the `local` flag.
//! - [`replicated_state`] — `replicatedState` (`api.ts:88-90`).
//!
//! Deferred with the facet seam (M6 report, S2): `createFacetHost`,
//! `createStaticFacetLoader`, `combineFacetLoaders` (they wrap
//! `facets/host.ts` and `facets/loader.ts`), and `createRemoteServiceBinding`
//! (wraps `services/consumer.ts`). [`crate::chord::services::provider`]
//! covers the provider side of the binding surface.

use std::sync::Arc;

use crate::chord::services::state::MutableReplicatedState;
use crate::chord::types::{JsonValue, Service};

/// `defineService(id)` (`api.ts:70-82`): remotable by default.
pub fn define_service(id: &str) -> Result<Service, crate::chord::services::errors::ChordError> {
    define_service_with(id, false)
}

/// `defineService(id, { local: true })` (`api.ts:70-82`).
pub fn define_service_local(
    id: &str,
) -> Result<Service, crate::chord::services::errors::ChordError> {
    define_service_with(id, true)
}

fn define_service_with(
    id: &str,
    local: bool,
) -> Result<Service, crate::chord::services::errors::ChordError> {
    if id.is_empty() {
        return Err(crate::chord::services::errors::ChordError::Type(
            "Service ID must not be empty".to_owned(),
        ));
    }
    // TODO(upstream): check if the reserved namespace should be part of Chord.
    if id.starts_with("$chord.") {
        return Err(crate::chord::services::errors::ChordError::Type(
            "Service IDs beginning with $chord. are reserved".to_owned(),
        ));
    }
    Ok(Service {
        id: id.to_owned(),
        local,
    })
}

/// `replicatedState(initial)` (`api.ts:88-90`).
pub fn replicated_state(initial: JsonValue) -> Arc<MutableReplicatedState> {
    MutableReplicatedState::new(initial)
}
