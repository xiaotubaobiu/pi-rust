# One-off fixer for focus-scenario wiring in tui_tests.rs (scratch tool).
import io

p = r"C:/Users/13063/Desktop/code/agent work/pi-rust/src/tui/tui_tests.rs"
src = io.open(p, encoding="utf-8").read()
print("CRLF in file:", "\r\n" in src)

probe = 'fx.show_scripted(\n            "REPLACEMENT",'
print("probe count:", src.count(probe))
probe2 = 'fx.show_scripted(\r\n            "REPLACEMENT",'
print("probe2 count:", src.count(probe2))
