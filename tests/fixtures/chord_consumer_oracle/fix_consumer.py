import re
p = "src/chord/consumer.rs"
s = open(p, encoding="utf8").read()

# 1) Replace the bogus `impl dyn RemoteServiceTransport` block with a proper trait default method.
old = """/// Upstream `RemoteServiceTransport` (`types.ts`). The async surface is
/// flattened to the synchronous closure convention (divergence D2).
pub trait RemoteServiceTransport: Send + Sync {
    fn invoke(
        &self,
        call: &ServiceCall,
        context: &Context,
    ) -> Result<Option<JsonValue>, ChordError>;
    fn subscribe(
        &self,
        service_id: &str,
        mode: ServiceMode,
        listener: UpdateListener,
    ) -> Result<TransportSubscription, ChordError>;
}

impl dyn RemoteServiceTransport {
    /// Keyed subscriptions may deliver to observers that re-enter the
    /// provider; transports that need a delivery pump can override this
    /// (default delegates to []).
    fn subscribe_keyed_default(
        &self,
        service_id: &str,
        listener: UpdateListener,
    ) -> Result<TransportSubscription, ChordError> {
        self.subscribe(service_id, ServiceMode::Keyed, listener)
    }
}"""
new = """/// Upstream `RemoteServiceTransport` (`types.ts`). The async surface is
/// flattened to the synchronous closure convention (divergence D2).
pub trait RemoteServiceTransport: Send + Sync {
    fn invoke(
        &self,
        call: &ServiceCall,
        context: &Context,
    ) -> Result<Option<JsonValue>, ChordError>;
    fn subscribe(
        &self,
        service_id: &str,
        mode: ServiceMode,
        listener: UpdateListener,
    ) -> Result<TransportSubscription, ChordError>;
    /// Keyed subscriptions deliver to observers that may re-enter the
    /// provider (upstream JS reentrancy); transports override this when their
    /// delivery path needs a pump thread (divergence D11). The default is a
    /// plain subscription.
    fn subscribe_keyed(
        &self,
        service_id: &str,
        listener: UpdateListener,
    ) -> Result<TransportSubscription, ChordError> {
        self.subscribe(service_id, ServiceMode::Keyed, listener)
    }
}"""
assert old in s, "trait block not found"
s = s.replace(old, new)

# 2) Rename the loopback's keyed-pump helper to be the trait override.
old = """    fn subscribe_keyed(
        &self,
        service_id: &str,
        listener: UpdateListener,
    ) -> Result<TransportSubscription, ChordError> {
        // Keyed deliveries run the observer inline under the provider lock in
        // the synchronous port; observers may re-enter the provider (upstream
        // JS reentrancy), so deliveries are pumped on a dedicated thread that
        // does not hold the provider lock (divergence D11)."""
new = """    /// Keyed deliveries run the observer inline under the provider lock in
    /// the synchronous port; observers may re-enter the provider (upstream
    /// JS reentrancy), so deliveries are pumped on a dedicated thread that
    /// does not hold the provider lock (divergence D11).
    fn subscribe_keyed(
        &self,
        service_id: &str,
        listener: UpdateListener,
    ) -> Result<TransportSubscription, ChordError> {"""
assert old in s, "loopback keyed helper not found"
s = s.replace(old, new)

# 3) Route KeyedBinding::start through subscribe_keyed.
old = """        let subscription = self
            .transport
            .subscribe(&self.service_id, ServiceMode::Keyed, listener)?;"""
assert old in s
s = s.replace(old, """        let subscription = self.transport.subscribe_keyed(&self.service_id, listener)?;""")

open(p, "w", encoding="utf8", newline="\n").write(s)
print("ok")
