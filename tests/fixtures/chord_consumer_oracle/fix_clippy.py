import re

# ── consumer.rs ──────────────────────────────────────────────────────────────
p = "src/chord/consumer.rs"
s = open(p, encoding="utf8").read()

# type aliases for the complex closure signatures
old = """/// `(error) => void` reporter (upstream `ErrorReporter`).
pub type ErrorReporter = Arc<dyn Fn(&ChordError) + Send + Sync>;"""
new = """/// Upstream `MemberSlot#invoke` closure shape.
pub type MemberInvoker = dyn Fn(&[JsonValue], &Context) -> Result<Option<JsonValue>, ChordError>
    + Send
    + Sync;

/// `(error) => void` reporter (upstream `ErrorReporter`).
pub type ErrorReporter = Arc<dyn Fn(&ChordError) + Send + Sync>;"""
assert old in s
s = s.replace(old, new)
s = s.replace(
    """    invoke: Box<
        dyn Fn(&[JsonValue], &Context) -> Result<Option<JsonValue>, ChordError> + Send + Sync,
    >,""",
    """    invoke: Box<MemberInvoker>,""",
)
s = s.replace(
    """        invoke: Box<
            dyn Fn(&[JsonValue], &Context) -> Result<Option<JsonValue>, ChordError>
                + Send
                + Sync,
        >,""",
    """        invoke: Box<MemberInvoker>,""",
)

# pump loop: while-let + drop the unused binding
old = """        std::thread::spawn(move || loop {
            match receiver.recv() {
                Ok(PumpMessage::Update(update, context)) => {
                    let _ = listener(&update, &context);
                }
                Ok(PumpMessage::Close) | Err(_) => break,
            }
        });"""
new = """        std::thread::spawn(move || {
            while let Ok(message) = receiver.recv() {
                match message {
                    PumpMessage::Update(update, context) => {
                        let _ = listener(&update, &context);
                    }
                    PumpMessage::Close => break,
                }
            }
        });"""
assert old in s
s = s.replace(old, new)
old = """        let snapshot = subscription.snapshot().clone();
        let pump_subscription = subscription.clone();
        std::thread::spawn"""
new = """        let snapshot = subscription.snapshot().clone();
        std::thread::spawn"""
assert old in s
s = s.replace(old, new)

# remove the stray blank line after the doc comment block (around line 1113)
s = s.replace("""// ── the binding itself (upstream `RemoteServiceBindingImpl`) ────────────────

struct SingletonShared {""", """// ── the binding itself (upstream `RemoteServiceBindingImpl`) ────────────────
struct SingletonShared {""")

# slot-target member() unused Result warning at ~652: `(self.assert)()` inside
# remote_facade Remote arm — keep; that one was already `?`. Check the Slot arm.
open(p, "w", encoding="utf8", newline="\n").write(s)
print("consumer ok")
