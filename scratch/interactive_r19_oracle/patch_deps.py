import io

p = "deps.ts"
src = io.open(p, encoding="utf-8").read()

anchor = 'import { theme } from "./deps_base.ts";'
addition = anchor + '''

// The r17-verified theme machinery exposes bold/italic; the r19 components
// additionally use underline/inverse (chalk-enabled fixed codes).
(deps_base_theme as AnyRec).underline = (text: string): string => `\\x1b[4m${text}\\x1b[24m`;
(deps_base_theme as AnyRec).inverse = (text: string): string => `\\x1b[7m${text}\\x1b[27m`;'''
assert anchor in src and "deps_base_theme as AnyRec).underline" not in src
src = src.replace(anchor, addition, 1)

old_input = '''	handleInput(data: string): void {
		// Stub editor: printable characters append; backspace deletes; the full
		// input widget is the separately-verified tui slice.
		if (data === "\\x7f") {
			this.value = this.value.slice(0, -1);
		} else if (data.length >= 1 && !data.startsWith("\\x1b") && data !== "\\r" && data !== "\\n") {
			for (const ch of data) this.value += ch;
		}
	}'''
new_input = '''	handleInput(data: string): void {
		// Stub editor: printable characters append; backspace deletes; Enter fires
		// onSubmit; the full input widget is the separately-verified tui slice.
		if (data === "\\x7f") {
			this.value = this.value.slice(0, -1);
		} else if (data === "\\r" || data === "\\n") {
			this.onSubmit?.();
		} else if (data.length >= 1 && !data.startsWith("\\x1b")) {
			for (const ch of data) this.value += ch;
		}
	}'''
assert old_input in src, "input stub not found"
src = src.replace(old_input, new_input, 1)

src = src.replace(
	"const deps_base_Markdown = deps_base_module2.Markdown;",
	"const deps_base_Markdown = deps_base_module2.Markdown;\nconst deps_base_theme = deps_base_module2.theme;",
	1,
)

io.open(p, "w", encoding="utf-8", newline="").write(src)
print("patched")
