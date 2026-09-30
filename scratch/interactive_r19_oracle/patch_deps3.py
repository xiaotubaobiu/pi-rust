import io

p = "deps.ts"
lines = io.open(p, encoding="utf-8").read().split("\n")

# Remove the two patch lines (and their preceding comment lines) from the early position.
early_idx = None
for i, line in enumerate(lines):
    if "(deps_base_theme as AnyRec).underline" in line:
        early_idx = i
        break
assert early_idx is not None
# comment block is the two lines before the underline line
del lines[early_idx - 2 : early_idx + 2]

# Insert after the deps_base_theme const declaration.
anchor = None
for i, line in enumerate(lines):
    if line.startswith("const deps_base_theme = deps_base_module2.theme;"):
        anchor = i
        break
assert anchor is not None
insert = [
    "",
    "// The r17-verified theme machinery exposes bold/italic; the r19 components",
    "// additionally use underline/inverse (chalk-enabled fixed codes).",
    '(deps_base_theme as AnyRec).underline = (text: string): string => `\\x1b[4m${text}\\x1b[24m`;',
    '(deps_base_theme as AnyRec).inverse = (text: string): string => `\\x1b[7m${text}\\x1b[27m`;',
]
lines[anchor + 1 : anchor + 1] = insert

io.open(p, "w", encoding="utf-8", newline="").write("\n".join(lines))
print("moved ok")
