//! Port of `packages/server/src/types.ts` (64 lines, SHA256
//! `cdec325901d0035ab381069e2dec9771027bde80025f4443c7fb87b145e46404`): the
//! server option surface and the routing capability traits the host
//! application supplies.
//!
//! The upstream interfaces become Rust traits with `'static` boxed futures;
//! `MaybePromise<T>` becomes `Result<T, OperationError>` futures. Disclosed
//! substitutions:
//!
//! - **S-A (metadata identity)** — upstream `ServerHost<TMetadata>` is
//!   generic over the metadata record and hands the *same object* back to
//!   `openSession`; the port carries the concrete
//!   [`agent_core::harness::session::types::SessionMetadata`] value, so the
//!   "passes concrete repository metadata" guarantee becomes value
//!   equality.
//! - **S-B (context)** — upstream `Context`/`BACKGROUND_CONTEXT`/
//!   `TODO_CONTEXT` are the existing `agent_core::chord_support` port;
//!   `AbortSignal` is the repo's `tokio_util::sync::CancellationToken`
//!   convention.

use std::sync::Arc;

use futures::future::BoxFuture;
use serde_json::Value as ChordJson;

use crate::agent_core::chord_support::Context;
use crate::chord::types::{ServiceCall, ServiceProviderUpdate};
use crate::protocol::protocol::SessionTarget;

use super::errors::OperationError;
use super::listener::ServerListenerHandle;

/// The chord-side JSON value tree (`@earendil-works/chord`'s `JsonValue`).
pub type ChordValue = ChordJson;

/// Upstream `publish` callback (`types.ts:29-31`, `types.ts:44-46`):
/// delivers one provider update for a subscription.
pub type PublishCallback = Arc<
    dyn Fn(String, ServiceProviderUpdate, Context) -> BoxFuture<'static, Result<(), OperationError>>
        + Send
        + Sync,
>;

/// Upstream `onConnectionCountChanged` (`types.ts:14`).
pub type ConnectionCountHandler = Arc<dyn Fn(usize) + Send + Sync>;

/// Upstream `onError` (`types.ts:15`): an observer for otherwise-unreported
/// errors. Rust closures cannot throw, so the upstream try/catch around the
/// observer (S4 in the client slice) has no producer side.
pub type ErrorObserver = Arc<dyn Fn(&OperationError) + Send + Sync>;

/// Upstream `ServerOptions` (`types.ts:10-17`).
pub struct ServerOptions {
    /// Upstream `listeners: readonly ServerListener[]` — the Rust `Vec` is
    /// always an array, so the upstream `TypeError` for non-arrays is
    /// unreachable (disclosed divergence D-A).
    pub listeners: Vec<ServerListenerHandle>,
    /// Stable logical server identity supplied by the installation or
    /// profile.
    pub server_id: String,
    pub max_frame_length: Option<u64>,
    pub handshake_timeout_ms: Option<u64>,
    pub on_connection_count_changed: Option<ConnectionCountHandler>,
    pub on_error: Option<ErrorObserver>,
}

impl ServerOptions {
    pub fn new(
        listeners: Vec<ServerListenerHandle>,
        server_id: impl Into<String>,
    ) -> ServerOptions {
        ServerOptions {
            listeners,
            server_id: server_id.into(),
            max_frame_length: None,
            handshake_timeout_ms: None,
            on_connection_count_changed: None,
            on_error: None,
        }
    }

    pub fn max_frame_length(mut self, max_frame_length: Option<u64>) -> Self {
        self.max_frame_length = max_frame_length;
        self
    }

    pub fn handshake_timeout_ms(mut self, handshake_timeout_ms: Option<u64>) -> Self {
        self.handshake_timeout_ms = handshake_timeout_ms;
        self
    }

    pub fn on_connection_count_changed(mut self, handler: ConnectionCountHandler) -> Self {
        self.on_connection_count_changed = Some(handler);
        self
    }

    pub fn on_error(mut self, observer: ErrorObserver) -> Self {
        self.on_error = Some(observer);
        self
    }
}

/// Upstream `MaybePromise<T>` (`types.ts:20`) — folded into the boxed
/// futures below.
pub type MaybePromiseFuture<T> = BoxFuture<'static, Result<T, OperationError>>;

/// Upstream `RoutedSessionAttachment` (`types.ts:23-34`): one presentation
/// connection's live capability for a hosted Session.
pub trait RoutedSessionAttachment: Send + Sync + 'static {
    /// Routes one contract-agnostic service operation to the attached
    /// Session endpoint.
    fn invoke_service(
        &self,
        call: ServiceCall,
        publish: PublishCallback,
        context: Context,
    ) -> BoxFuture<'static, Result<Option<ChordValue>, OperationError>>;
    fn release(&self, context: Context) -> MaybePromiseFuture<()>;
}

/// Upstream `RoutedServerPresentation` (`types.ts:37-43`):
/// presentation-scoped routing capabilities available to server service
/// implementations.
pub trait RoutedServerPresentation: Send + Sync + 'static {
    fn attach_session(
        &self,
        session_id: String,
        context: Context,
    ) -> BoxFuture<'static, Result<(), OperationError>>;
    fn detach_session(&self, context: Context) -> BoxFuture<'static, Result<(), OperationError>>;
    /// Release routed attachments and handles before the application deletes
    /// durable metadata.
    fn prepare_session_removal(
        &self,
        session_id: String,
        context: Context,
    ) -> BoxFuture<'static, Result<(), OperationError>>;
}

/// Upstream `RoutedServerServiceAttachment` (`types.ts:46-53`): one
/// connection's server-scoped service endpoint.
pub trait RoutedServerServiceAttachment: Send + Sync + 'static {
    fn invoke_service(
        &self,
        call: ServiceCall,
        publish: PublishCallback,
        context: Context,
    ) -> BoxFuture<'static, Result<Option<ChordValue>, OperationError>>;
    fn release(&self, context: Context) -> MaybePromiseFuture<()>;
}

/// Upstream `RoutedServerServiceHost` (`types.ts:56-58`).
pub trait RoutedServerServiceHost: Send + Sync + 'static {
    fn attach_client(
        &self,
        presentation: Arc<dyn RoutedServerPresentation>,
        context: Context,
    ) -> MaybePromiseFuture<Arc<dyn RoutedServerServiceAttachment>>;
}

/// The termination signal of a routed Session handle (upstream
/// `terminated?: Promise<Error | undefined>`, `types.ts:65`): resolves with
/// an error for unexpected termination, or `None` after an expected close.
pub type TerminatedSignal = futures::future::Shared<BoxFuture<'static, Option<OperationError>>>;

/// Upstream `RoutedSessionHandle` (`types.ts:60-68`): a process-safe handle
/// that acquires presentation-scoped Session capabilities.
pub trait RoutedSessionHandle: Send + Sync + 'static {
    fn attach_client(
        &self,
        context: Context,
    ) -> BoxFuture<'static, Result<Arc<dyn RoutedSessionAttachment>, OperationError>>;
    /// The upstream optional `terminated` promise; `None` when the handle
    /// cannot terminate unexpectedly.
    fn terminated(&self) -> Option<TerminatedSignal>;
    fn close(&self, context: Context) -> BoxFuture<'static, Result<(), OperationError>>;
}

/// Upstream `ServerHost` (`types.ts:71-76`): application capabilities used
/// by server-wide management and Session routing.
pub trait ServerHost: Send + Sync + 'static {
    fn server_services(&self) -> Arc<dyn RoutedServerServiceHost>;
    /// Resolve one durable Session ID or fail with a bounded routing error.
    fn resolve_session(
        &self,
        session_id: String,
        context: Context,
    ) -> BoxFuture<
        'static,
        Result<crate::agent_core::harness::session::types::SessionMetadata, OperationError>,
    >;
    fn open_session(
        &self,
        metadata: crate::agent_core::harness::session::types::SessionMetadata,
        context: Context,
    ) -> BoxFuture<'static, Result<Arc<dyn RoutedSessionHandle>, OperationError>>;
}

/// Re-export of the attachment target carried by the attachment frame.
pub type AttachmentTarget = SessionTarget;
