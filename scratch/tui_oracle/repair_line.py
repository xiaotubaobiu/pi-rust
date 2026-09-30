# Repair the mangled comparison line produced by the previous shell-quoted patch.
import io

p = r"C:/Users/13063/Desktop/code/agent work/pi-rust/src/tui/tui_tests.rs"
src = io.open(p, encoding="utf-8", newline="").read()

broken = '            if data == \\r {\n'
fixed = '            if data == "' + chr(92) + 'r" {\n'
count = src.count(broken)
print("broken lines:", count)
src = src.replace(broken, fixed)

# Ensure the rewritten block also has the quotes restored on the editor target.
io.open(p, "w", encoding="utf-8", newline="").write(src)
print("repaired")
