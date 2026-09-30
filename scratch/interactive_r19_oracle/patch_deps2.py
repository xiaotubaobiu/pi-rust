import io
p = "deps.ts"
src = io.open(p, encoding="utf-8").read()
block = '''
// The r17-verified theme machinery exposes bold/italic; the r19 components
// additionally use underline/inverse (chalk-enabled fixed codes).
(deps_base_theme as AnyRec).underline = (text: string): string => `\x1b[4m${text}\x1b[24m`;
(deps_base_theme as AnyRec).inverse = (text: string): string => `\x1b[7m${text}\x1b[27m`;'''
assert block in src
src = src.replace(block, "", 1)
anchor = "const deps_base_theme = deps_base_module2.theme;"
assert anchor in src
src = src.replace(anchor, anchor + block, 1)
io.open(p, "w", encoding="utf-8", newline="").write(src)
print("moved")
