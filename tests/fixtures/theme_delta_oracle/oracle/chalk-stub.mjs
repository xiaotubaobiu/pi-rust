// Chalk seam: upstream `chalk.bold`/`italic`/… depend on the process color
// level. The capture pins the enabled-level (level 3) ANSI codes — the same
// codes the Rust port fixes (D2 in `interactive/mod.rs`).
const wrap = (open, close) => (text) => `${open}${text}${close}`;

export default {
	level: 3,
	bold: wrap("\x1b[1m", "\x1b[22m"),
	italic: wrap("\x1b[3m", "\x1b[23m"),
	underline: wrap("\x1b[4m", "\x1b[24m"),
	inverse: wrap("\x1b[7m", "\x1b[27m"),
	strikethrough: wrap("\x1b[9m", "\x1b[29m"),
};
