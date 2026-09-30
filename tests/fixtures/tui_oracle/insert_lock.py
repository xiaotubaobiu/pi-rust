# Insert the module-wide test lock into every #[test] in tui_tests.rs.
import io
import re

p = r"C:/Users/13063/Desktop/code/agent work/pi-rust/src/tui/tui_tests.rs"
src = io.open(p, encoding="utf-8").read()

helper = """/// The terminal-image capabilities cache is process-global; serialize the
/// tests in this module so capability-mutating scenarios cannot pollute the
/// byte-level write assertions of concurrent ones.
fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn rgb_oracle_json("""
src = src.replace("\nfn rgb_oracle_json(", "\n" + helper, 1)

pattern = re.compile(r"(#\[test\]\nfn \w+\(\) \{\n)")
src, count = pattern.subn(r"\1    let _tui_test_lock = test_lock();\n", src)
print("tests patched:", count)

io.open(p, "w", encoding="utf-8", newline="").write(src)
