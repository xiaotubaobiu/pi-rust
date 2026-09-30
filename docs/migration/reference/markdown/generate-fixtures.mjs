// Markdown differential fixture generator (offline).
// Runs the ACTUAL upstream markdown.ts (pi @ 590144609) under Node 25 with
// marked 18.0.5 from the npm cache (upstream pin 18.0.11 unavailable offline —
// deviation disclosed in docs/migration/TUI_COMPATIBILITY.md).
// Output: byte-exact render fixtures consumed by src/tui/tests/markdown.rs.

import { writeFileSync } from "node:fs";
import { Chalk } from "chalk";
import { Lexer as MarkedLexer } from "marked";
import { Markdown } from "./src/components/markdown.ts";
import { setCapabilities, resetCapabilitiesCache } from "./src/terminal-image.ts";
import { visibleWidth, wrapTextWithAnsi } from "./src/utils.ts";

const chalk = new Chalk({ level: 3 });

const defaultMarkdownTheme = {
	heading: (text) => chalk.bold.cyan(text),
	link: (text) => chalk.blue(text),
	linkUrl: (text) => chalk.dim(text),
	code: (text) => chalk.yellow(text),
	codeBlock: (text) => chalk.green(text),
	codeBlockBorder: (text) => chalk.dim(text),
	quote: (text) => chalk.italic(text),
	quoteBorder: (text) => chalk.dim(text),
	hr: (text) => chalk.dim(text),
	listBullet: (text) => chalk.cyan(text),
	bold: (text) => chalk.bold(text),
	italic: (text) => chalk.italic(text),
	strikethrough: (text) => chalk.strikethrough(text),
	underline: (text) => chalk.underline(text),
};

// Probe each theme fn so the Rust port can hardcode chalk's exact sequences.
const themeProbe = {};
for (const [name, fn] of Object.entries(defaultMarkdownTheme)) themeProbe[name] = fn("T");
themeProbe.dimItalic = chalk.dim.italic("T");
themeProbe.bgBlue = chalk.bgBlue("T");
themeProbe.grayText = chalk.gray("T");

const cases = [];
function caseOf(name, md, width, opts = {}) {
	const paddingX = opts.paddingX ?? 0;
	const paddingY = opts.paddingY ?? 0;
	const style = opts.style ?? "none";
	const theme = { ...defaultMarkdownTheme };
	let defaultTextStyle;
	if (style === "grayItalic") {
		defaultTextStyle = {
			color: (t) => chalk.dim(t),
			italic: true,
		};
	} else if (style === "bold") {
		defaultTextStyle = { bold: true };
	} else if (style === "unitCount") {
        defaultTextStyle = { color: (t) => `{${t.length}:${t}}` };
    } else if (style === "reverseUnits") {
        defaultTextStyle = { color: (t) => t.split('').reverse().join('') };
    } else if (style === "bgBlue") {
		defaultTextStyle = { bgColor: (t) => chalk.bgBlue(t) };
	}
	setCapabilities({ hyperlinks: opts.hyperlinks ?? false, images: null, trueColor: true });
	const md2 = new Markdown(md, paddingX, paddingY, theme, defaultTextStyle, {
		preserveOrderedListMarkers: opts.preserveMarkers,
		preserveBackslashEscapes: opts.preserveEscapes,
		renderLatex: opts.renderLatex,
	});
	const lines = md2.render(width);
	cases.push({
		name,
		md,
		width,
		paddingX,
		paddingY,
		style,
		preserveMarkers: opts.preserveMarkers === true,
		preserveEscapes: opts.preserveEscapes === true,
		renderLatex: opts.renderLatex !== false,
		hyperlinks: opts.hyperlinks === true,
		expected: lines,
	});
	resetCapabilitiesCache();
}

// --- Headings / paragraphs / spacing -----------------------------------
caseOf("heading1_paragraph", "# Title\n\nBody text here.", 80);
caseOf("heading2_paragraph", "## Section\n\nBody.", 80);
caseOf("heading3_prefix", "### Deep heading\nText", 80);
caseOf("heading_last_block", "# Only heading", 80);
caseOf("two_paragraphs", "First para.\n\nSecond para.", 80);
caseOf("paragraph_last_block", "Only one paragraph.", 40);
caseOf("paragraph_wraps", "This is a fairly long paragraph that will definitely need to wrap at the narrow width given.", 30);

// --- Code blocks --------------------------------------------------------
caseOf("code_fence_lang", "```rust\nfn main() {}\nlet x = 1;\n```", 80);
caseOf("code_fence_plain", "```\nplain code\n```", 80);
caseOf("code_then_paragraph", "```\ncode\n```\n\nAfter paragraph.", 80);
caseOf("code_last_block", "```\ncode only\n```", 80);
caseOf("code_with_tilde", "~~~js\nvar x = 2;\n~~~", 80);

// --- Lists --------------------------------------------------------------
caseOf("list_simple", "- Item 1\n- Item 2", 80);
caseOf("list_nested", "- Item 1\n  - Nested 1.1\n  - Nested 1.2\n- Item 2", 80);
caseOf("list_deep_nested", "- Level 1\n  - Level 2\n    - Level 3\n      - Level 4", 80);
caseOf("list_ordered_nested", "1. First\n   1. Inner A\n   2. Inner B\n2. Second", 80);
caseOf("list_ordered_markers_normalized", "3. Third\n4. Fourth", 80, { preserveMarkers: false });
caseOf("list_ordered_markers_preserved", "3. Third\n4. Fourth", 80, { preserveMarkers: true });
caseOf("list_mixed_ordered_unordered", "1. One\n   - Bullet A\n   - Bullet B\n2. Two", 80);
caseOf("list_loose_blank_lines", "- Alpha\n\n- Beta\n\n- Gamma", 80);
caseOf("list_task", "- [ ] beep\n- [x] boop", 80);
caseOf("list_code_not_indented", "1. First item\n\n```js\nconsole.log(1);\n```\n\n2. Second item", 80);
caseOf("list_wrapped_unordered", "- This item text is long enough that it will wrap when rendered at a narrow width", 30);
caseOf("list_wrapped_ordered", "1. This ordered item text is long enough that it wraps at the narrow width", 30);
caseOf("list_wrapped_multidigit", "10. This ordered item text is long enough that it wraps when rendered narrow", 30);
caseOf("list_wrapped_nested", "- Parent with a fairly long text line that wraps\n  - Child with a fairly long text line that wraps too", 40);
caseOf("list_blockquote_inside", "- Quoted:\n  > Inner quote line", 60);
caseOf("list_code_inside", "- Code:\n  ```\n  fenced\n  ```", 60);
caseOf("list_last_block", "- only", 80);

// --- Blockquotes --------------------------------------------------------
caseOf("blockquote_simple", "> Quoted line one\n> Quoted line two", 80);
caseOf("blockquote_paragraph_after", "> quote\n\nAfter.", 80);
caseOf("blockquote_wraps", "> This quote line is long enough that it will need to wrap at this width", 30);

// --- HR ------------------------------------------------------------------
caseOf("hr_paragraph", "---\n\nAfter divider.", 40);
caseOf("hr_last_block", "---", 40);
caseOf("hr_wide_clamped", "---", 100);

// --- HTML ----------------------------------------------------------------
caseOf("html_block", "<div>\n  raw html\n</div>\n\nAfter.", 80);
caseOf("html_inline", "Text with <b>inline html</b> inside.", 80);

// --- Links / inline styles ------------------------------------------------
caseOf("link_no_hyperlinks", "See [the docs](https://example.com/a) for details.", 80, { hyperlinks: false });
caseOf("link_autolink_text_eq", "Go to [https://example.com](https://example.com) now.", 80, { hyperlinks: false });
caseOf("link_hyperlinks_on", "See [the docs](https://example.com/a) for details.", 80, { hyperlinks: true });
caseOf("inline_styles", "This is **bold**, *italic*, ~~deleted~~, and `coded`.", 80);
caseOf("inline_hard_break", "line one\nline two", 80);
caseOf("style_prefix_restored_after_code", "*italic `code` tail*", 80);

// --- Tables ---------------------------------------------------------------
caseOf("table_simple", "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |", 80);
caseOf("table_row_dividers", "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |", 80);
caseOf("table_alignment", "| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |", 60);
caseOf("table_varying_widths", "| X | YYYY |\n| --- | --- |\n| 1 | 2 |", 80);
caseOf("table_cell_wrap", "| Column A | Column B |\n| --- | --- |\n| This cell has a lot of text that must wrap inside the column | short |", 40);
caseOf("table_link_no_leak", "| Link |\n| --- |\n| [example site](https://example.com/long) |", 40, { hyperlinks: false });
caseOf("table_inline_code", "| Code |\n| --- |\n| Use `npm run build` daily |", 40);
caseOf("table_narrow_fallback", "| VeryLongHeaderName | AnotherVeryLongHeaderName |\n| --- | --- |\n| a | b |", 16);
caseOf("table_fits_naturally", "| id | name |\n| --- | --- |\n| 1 | alice |", 80);
caseOf("table_paddingX", "| A |\n| --- |\n| b |", 40, { paddingX: 3 });
caseOf("table_last_block", "| A |\n| --- |\n| b |", 80);
caseOf("list_then_table", "- item\n\n| H |\n| --- |\n| v |", 60);

// --- LaTeX ------------------------------------------------------------------
caseOf("latex_inline_dollar", "Energy is $E = mc^2$ indeed.", 80);
caseOf("latex_inline_paren", "Also \\(a + b\\) works.", 80);
caseOf("latex_display_dollar", "$$\nx = \\frac{1}{2}\n$$\n\nAfter.", 80);
caseOf("latex_display_bracket", "\\[\n\\sum_{i=1}^{n} i\n\\]\nAfter.", 80);
caseOf("latex_matrix_display", "$$\n\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\n$$", 80);
caseOf("latex_lower_limit", "\\[\n\\lim_{x \\to 0} f(x)\n\\]", 80);
caseOf("latex_in_list", "- Math: $x^2 + y^2 = z^2$ inline", 80);
caseOf("latex_currency_not_math", "It costs $5 and $10 total.", 80);
caseOf("latex_shell_var_not_math", "Use $HOME variable here.", 80);
caseOf("latex_unsupported_preserved", "$\\unknowncmd{x}$ stays raw.", 80);
caseOf("latex_pending_stream", "Streaming \\(x +", 80);
caseOf("latex_pending_dollar", "Streaming $x +", 80);
caseOf("latex_disabled", "$E = mc^2$ raw please.", 80, { renderLatex: false });
caseOf("latex_in_code_fence_ignored", "```\n$E = mc^2$\n```", 80);
caseOf("latex_escaped_dollars", "Price: \\$100 and \\$200.", 80);

// --- Escapes -------------------------------------------------------------------
caseOf("escapes_normalized", "Symbols \\* \\_ \\# appear literally.", 80);
caseOf("escapes_preserved", "Symbols \\* \\_ \\# appear literally.", 80, { preserveEscapes: true });

// --- Padding / background / default styles --------------------------------------
caseOf("padding_xy", "Hello **world**.", 40, { paddingX: 2, paddingY: 1 });
caseOf("bg_blue", "Hello with background.", 30, { style: "bgBlue", paddingX: 1, paddingY: 1 });
caseOf("default_gray_italic", "Plain text with *emphasis* and `code`.", 60, { style: "grayItalic" });
caseOf("default_bold", "Bold body text.", 60, { style: "bold" });

// --- Empty ------------------------------------------------------------------------
caseOf("empty_input", "", 40);
caseOf("whitespace_input", "   \n  \n", 40);

// --- Image line passthrough -----------------------------------------------------
caseOf("image_line_kitty", "\x1b_Gf=100;\x1b\\\nAfter image.", 40);
caseOf("image_line_iterm2", "\x1b]1337;File=inline=1\x07\nAfter image.", 40);

// --- Long unbroken tokens --------------------------------------------------------
caseOf("long_unbroken_word", "Supercalifragilisticexpialidocious-and-even-more-letters-here-yes", 20);
caseOf("cjk_paragraph", "这是一个相当长的中文段落，需要在较窄的宽度下换行渲染测试。Second part.", 20);

// --- Deviation checks: exact literals transcribed from markdown.test.ts ----------

// Resumed-session regressions: masking progress, delimiter offsets, UTF-8 boundaries.
caseOf("resume_codespan_single", "Before `x` after.", 80);
caseOf("resume_codespan_unicode", "Before `中` after.", 80);
caseOf("resume_codespan_multitick", "Before ``one ` two`` after.", 80);
caseOf("resume_codespan_unmatched", "Before `open and more", 80);
caseOf("resume_codespan_mismatched", "Before ``no` after.", 80);
caseOf("resume_underscore_em", "Before _italic_ and __bold__.", 80);
caseOf("resume_nested_em", "Before ***bold italic*** and **one *two* three**.", 80);
caseOf("resume_unicode_em", "中文 **粗体** and *😀*.", 80);
caseOf("resume_many_codespans", "`one` then `two` and **three**.", 80);
caseOf("resume_cjk_inline_start", "中文$not math here", 80);
caseOf("resume_em_orphan_ast", "*foo __bar* baz__", 80);
caseOf("resume_em_orphan_und", "_foo **bar_ baz**", 80);

// Separate corpus: raw UTF-16 remains the oracle authority through wrapping and
// padding; Buffer encoding happens only after upstream Markdown.render returns.
// The historical 94-case fixture bytes must remain unchanged.
const utf16Cases = [];
const unitArray = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
function utf16CaseOf(name, md, width, opts = {}) {
	caseOf(name, md, width, opts);
	const item = cases.pop();
	item.expectedUtf16 = item.expected.map(unitArray);
	item.expectedWidths = item.expected.map(visibleWidth);
	item.expected = item.expected.map((line) => Buffer.from(line, 'utf8').toString('utf8'));
	utf16Cases.push(item);
}
const formulas = [
	String.raw`\sqrt😀`, String.raw`\hat😀`, String.raw`\frac😀x`,
	String.raw`x^😀`, String.raw`\frac1😀`, String.raw`\sqrt{😀}`,
];
const contexts = [
	['inline', f => `$${f}$`],
	['paragraph', f => `a $${f}$ z`],
	['strong', f => `**a $${f}$ z**`],
	['italic', f => `*a $${f}$ z*`],
	['heading', f => `# a $${f}$ z`],
	['quote', f => `> a $${f}$ z`],
	['list', f => `- a $${f}$ z`],
	['table', f => `| a $${f}$ | z |\n| --- | --- |\n| $${f}$ | end |`],
	['display', f => `$$\n${f}\n$$`],
	['link', f => `[a $${f}$ z](https://example.invalid)`],
];
for (const [fi, formula] of formulas.entries()) {
	for (const [context, wrap] of contexts) {
		for (const width of [1, 2, 3, 4, 5, 8, 14, 30]) {
			for (const style of ['none', 'bold', 'grayItalic', 'bgBlue', 'unitCount', 'reverseUnits']) {
				utf16CaseOf(`utf16_${fi}_${context}_w${width}_${style}`, wrap(formula), width, {
					style, paddingX: width >= 8 ? 1 : 0, paddingY: width === 14 ? 1 : 0,
					hyperlinks: context === 'link',
				});
			}
		}
	}
}
writeFileSync('utf16-fixtures.json', JSON.stringify({ cases: utf16Cases }, null, 1) + '\n');
console.log('UTF-16 Markdown cases:', utf16Cases.length);


// Direct utility sweep includes invalid units inside OSC URLs and malformed CSI
// codes, which the Markdown formula corpus does not itself synthesize.
const wrapCases = [];
function addWrap(source, width, name) {
    const expected = wrapTextWithAnsi(source, width);
    wrapCases.push({ name, source: unitArray(source), width, expected: expected.map(unitArray) });
}
const rawPayloads = ['', '\ud800', '\udfff', '\ud83d\ude00', '\ude00\ud83d', '�',
    '\ud800\u0301', '\ud800\u093e', '\u0600\ud800', '\ud800\u200d',
    '\ud800中', 'ก\ud800ำ', '\ud800\t\udfff', '\ud800\ufeff\udfff',
    '\ud800\r\udfff', '\ud800\n\udfff', '\ud800\r\n\udfff', '\ue000\ud800\u{f0000}'];
const rawContexts = [
    s => s, s => `a${s}bc`, s => ` a ${s} bc `, s => `中${s}中文`,
    s => `\x1b[4;31m${s}abc def\x1b[0m`,
    s => `\x1b[44m${s}a\n${s}bc\x1b[49m`,
    s => `\x1b]8;id=${s};https://example.invalid/${s}\x1b\\${s}abcdef\x1b]8;;\x1b\\`,
    s => `\x1b]8;;${s}\x07${s}abcdef\x1b]8;;\x07`,
    s => `\x1b[${s}m${s}abcdef`,
    s => `\x1b]title${s}\x07${s}ab cd`,
    s => `${s}\x1b[4mab\r\ncd${s}\x1b[24m`,
    s => `\x1b]8;${s}\x07${s}abc`,
];
for (const [pi, payload] of rawPayloads.entries()) {
    for (const [ci, wrap] of rawContexts.entries()) {
        for (const width of [0, 1, 2, 3, 4, 7, 12]) addWrap(wrap(payload), width, `raw_${pi}_${ci}_${width}`);
    }
}
let seed = 0x6c617465;
const choices = ['a',' ', '中', '😀', '\ud800', '\udfff', '\u0301', '\u093e', '\u0600', '\r', '\n', '\t', '\x1b[4m', '\x1b[24m', '\x1b[0m', '\x1b]8;;x\x07', '\x1b]8;;\x07'];
for (let i = 0; i < 128; i++) {
    let source = '';
    for (let j = 0; j < 12; j++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        source += choices[seed % choices.length];
    }
    for (const width of [0, 1, 2, 4, 7]) addWrap(source, width, `seed_${i}_${width}`);
}
writeFileSync('utf16-wrap-fixtures.json', JSON.stringify({ cases: wrapCases }, null, 1) + '\n');
console.log('UTF-16 wrapping cases:', wrapCases.length);


// Source/lexer corpus, separate from the immutable historical and raw-layout
// corpora. Every expected line still comes from actual upstream Markdown.
const sourceSeeds = [
 ['ref_full', '[see][target]\n\n[target]: https://example.invalid/a "title"'],
 ['ref_shortcut', '[target]\n\n[target]: /dest'],
 ['ref_collapsed', '[target][]\n\n[target]: /dest'],
 ['ref_case', '[SEE][TaRgEt]\n\n[target]: /dest'],
 ['ref_space', '[see][ a   b ]\n\n[ a b ]: /dest'],
 ['ref_newline', '[see][a\nb]\n\n[a b]: /dest'],
 ["ref_escaped", "[see][a\\]b]\n\n[a\\]b]: /dest"],
 ['ref_nested', '[**bold** *italic*][target]\n\n[target]: /dest'],
 ['ref_image', '![an *image*][target]\n\n[target]: /image "title"'],
 ['ref_duplicate', '[a]\n\n[a]: /first\n[a]: /second'],
 ['ref_before', '[a]: /dest\n\n[a] and [a][]'],
 ['ref_in_quote', '> [a]\n\n[a]: /dest'],
 ['ref_in_list', '- [a]\n- [b]\n\n[a]: /one\n[b]: /two'],
 ['ref_in_table', '| [a] | b |\n| --- | --- |\n| c | [a][] |\n\n[a]: /dest'],
 ['ref_title_next_line', '[a]\n\n[a]: /dest\n  "title"'],
 ['ref_href_next_line', '[a]\n\n[a]:\n  /dest "title"'],
 ['ref_angle', '[a]\n\n[a]: <a b> "title"'],
 ['ref_empty_angle', '[a]\n\n[a]: <> "title"'],
 ['ref_title_parens', '[a]\n\n[a]: /dest (a title)'],
 ['ref_title_escape', '[a]\n\n[a]: /dest "a\\"b"'],
 ['ref_empty_label', '[ ]\n\n[ ]: /dest'],
 ['ref_missing', '[a][missing] and [unmatched'],
 ['ref_defs_in_paragraph', 'before\n[a]: /dest\n\n[a]'],
 ['link_inline', '[a](/dest "a title")'],
 ['link_angle', '[a](<a b> "title")'],
 ["link_escape_angle", "[a](<a\\>b> \"title\")"],
 ['link_parentheses', '[a](foo(bar(baz)) "title")'],
 ['link_extra_parenthesis', '[a](foo(bar))end)'],
 ['link_multiline_title', '[a](/dest "a\nb")'],
 ['link_escaped_title', '[a](/dest "a\\"b")'],
 ['link_newline', '[a](\n /dest\n "title"\n)'],
 ['link_image', '![a *b*](pic "title")'],
 ['link_nested', '[outer [inner](/inside)](/outside)'],
 ['link_raw_html', '<a href="/x">www.example.invalid</a> after www.example.invalid'],
 ['link_unicode', '[中文😀](https://example.invalid/中文😀 "中文😀")'],
 ['link_entities', '[a &amp; b](x?a=1&amp;b=2 "&quot;title&quot;")'],
 ['html_block', '<div class="x">\n*not italic*\n</div>\n\nafter'],
 ['html_inline', 'before <span title="a > b">*yes*</span> after'],
 ['html_custom', '<custom a="b">\n*text*\n</custom>\n\nafter'],
 ['html_comment', 'before <!-- *hidden* --> after'],
 ['html_comment_block', '<!--\n*text*\n-->\n\nafter'],
 ['html_comment_unclosed', '<!-- *text*\nmore'],
 ['html_processing', '<?pi *text* ?>\n\nafter'],
 ['html_cdata', '<![CDATA[*text*]]>\n\nafter'],
 ['html_declaration', '<!DOCTYPE html>\n\nafter'],
 ['html_script', '<script>\n*text*\n</script>\nafter'],
 ['html_pre', 'before <pre>*text*</pre> after'],
 ['html_code', 'before <code>*text*</code> after'],
 ['html_close', '</div>\n\nafter'],
 ['html_incomplete', 'before <span title="abc after'],
 ['html_attr_bare', '<span a=b c=d>*text*</span>'],
 ['html_attr_newline', '<span\na="b">text</span>'],
 ['heading_closing', '# hello #\n\n## hello##\n\n### hello ###'],
 ['heading_empty', '#\n\n##   \n\n### #'],
 ['heading_setext', 'title 😀\n---\n\nbody'],
 ['em_astral', '*😀* **😀** _😀_ __😀__ ***a😀b***'],
 ['em_punctuation', 'a*😀*b a_😀_b 😀**x**😀'],
 ['em_cross_nested', '*a **b* c** and _a __b_ c__'],
 ["code_entities", "`&amp;` and &amp; and \\&amp;"],
 ['code_astral', 'a``😀 ` 中``b'],
 ['del_strict', '~~a~~ ~a~ ~~~a~~~ ~~ a~~ ~~a ~~'],
 ["hardbreaks", "a  \nb\\\nc\nd"],
 ['math_shell_const', '$HOME$tail $AB_CD9$tail $A!$tail $AB!$tail'],
 ["math_pending_command", "before $hello \\alpha"],
 ['math_pending_plain', 'before $hello words'],
];
const sourceSpaces = [0x20,0x09,0x0b,0x0c,0xa0,0x1680,0x2000,0x2009,0x2028,0x2029,0x202f,0x205f,0x3000,0xfeff,0x85,0x180e,0x200b];
for (const cp of sourceSpaces) {
 const w=String.fromCodePoint(cp), id=cp.toString(16);
 sourceSeeds.push(
  [`space_${id}_only`,w+w],
  [`space_${id}_math_open`,`$${w}x+1$ end`],
  [`space_${id}_math_close`,`$x+1${w}$ end`],
  [`space_${id}_ref_label`,`[see][a${w}b]\n\n[a${w}b]: /dest`],
  [`space_${id}_ref_href`,`[a]\n\n[a]: /x${w}/y`],
  [`space_${id}_ref_title`,`[a]\n\n[a]: /x ${w}"title"`],
  [`space_${id}_link`,`[a](/x${w}"title")`],
  [`space_${id}_html`,`before <span${w}a="b">*x*</span> after`],
  [`space_${id}_heading`,`#${w}heading\n\nbody`],
  [`space_${id}_em`,`*${w}a* *a${w}*`],
 );
}

// Follow-up probes for the scanner branches exposed by the first red corpus.
// Keep the first 235 seeds stable; append new authority-generated expectations.
sourceSeeds.push(
 ['paragraph_three', 'one\n\ntwo\n\nthree'],
 ['paragraph_trailing', 'one\n\n'],
 ['paragraph_spaced_blank', 'one\n \n two'],
 ['paragraph_tabs_blank', 'one\n\t\ntwo'],
 ['ref_label_nested_brackets', '[a [b]][r]\n\n[r]: /x'],
 ['ref_empty_text', '[][r]\n\n[r]: /x'],
 ['ref_shortcut_image', '![r]\n\n[r]: /x'],
 ['ref_collapsed_image', '![r][]\n\n[r]: /x'],
 ['ref_unicode', '[😀中][ΚΈΙ]\n\n[κέι]: /😀中'],
 ['ref_escaped_unicode', '[a\\😀][r]\n\n[r]: /x'],
 ['ref_code_label', '[a `x]y` z][r]\n\n[r]: /x'],
 ['ref_multi_tick_label', '[a ``x]y`` z][r]\n\n[r]: /x'],
 ['ref_missing_before_defined', '[missing][r] and [unknown]\n\n[r]: /x'],
 ['ref_definition_quote', '> [r]: /x\n\n[r]'],
 ['ref_definition_list', '- [r]: /x\n\n[r]'],
 ['ref_definition_title_blank', '[r]\n\n[r]: /x\n\n"not title"'],
 ['ref_definition_double_multiline', '[r]\n\n[r]: /x "first\n\nlast"'],
 ['ref_definition_single_multiline', "[r]\n\n[r]: /x 'first\n\nlast'"],
 ['ref_definition_single_escaped', "[r]\n\n[r]: /x 'first\\'last'"],
 ['ref_definition_paren_nested', '[r]\n\n[r]: /x (first (middle) last)'],
 ['ref_definition_paren_escaped', '[r]\n\n[r]: /x (first\\)last)'],
 ['ref_definition_href_escape', '[r]\n\n[r]: <a\\*b>'],
 ['ref_definition_href_unclosed', '[r]\n\n[r]: <a'],
 ['ref_definition_backslash_title', '[r]\n\n[r]: /x "a\\z"'],
 ['ref_definition_later', '[r]: /x\n\ntext\n\n[r]'],
 ['ref_definition_indent_three', '[r]\n\n   [r]: /x'],
 ['ref_definition_indent_four', '[r]\n\n    [r]: /x'],
 ['link_angle_empty', '[a](<>)'],
 ['link_angle_unclosed', '[a](<x) after'],
 ['link_angle_escaped_end', '[a](<x\\>) after'],
 ['link_angle_double_escape_end', '[a](<x\\\\>) after'],
 ['link_angle_bracket_inside', '[a](<x<y>) after'],
 ['link_angle_linebreak', '[a](<x\ny>) after'],
 ['link_backslash_newline', '[a](<x\\\ny>) after'],
 ['link_single_escaped', "[a](/x 'first\\'last')"],
 ['link_single_backslash', "[a](/x 'first\\z')"],
 ['link_parenthesized_escaped', '[a](/x (first\\)last))'],
 ['link_parenthesized_nested', '[a](/x (first (middle) last))'],
 ['link_escaped_label_astral', '[a\\😀](/x) after'],
 ['link_astral_extra_paren', '[😀](x😀(y))tail)'],
 ['link_astral_leading_space', '[😀]( x😀(y))tail)'],
 ['link_extra_leading_spaces', '[a](  foo(bar))tail)'],
 ['link_extra_inline_title', '[a](foo(bar))tail "not title")'],
 ['link_short_code_label', '[`a]b`](/x)'],
 ['link_double_tick_label', '[``a]b``](/x)'],
 ['link_label_backticks_before_end', '[a``](/x)'],
 ['link_label_nested_bracket', '[a[b]c](/x)'],
 ['link_label_escape_bracket', '[a\\]b](/x)'],
 ['html_upper_block', '<DIV>\n*text*\n</DIV>\n\nafter'],
 ['html_upper_inline', 'before <SPAN title="😀">text</SPAN> after'],
 ['html_short_script', '<script>'],
 ['html_short_pre', '<pre>'],
 ['html_short_style', '<style>'],
 ['html_short_textarea', '<textarea>'],
 ['html_immediate_script_close', '<script></script>\n\n*after*'],
 ['html_script_unicode', '<script>İ😀</script>\n\n*after*'],
 ['html_script_close_eof', '<script>one</script>'],
 ['html_script_close_tail', '<script>one</script>tail\n\n*after*'],
 ['html_processing_unclosed', '<?thing\n*text*'],
 ['html_declaration_unclosed', '<!DOCTYPE\n*text*'],
 ['html_cdata_unclosed', '<![CDATA[\n*text*'],
 ['html_declaration_block', '<!DOCTYPE html>\n*text*\n\nafter'],
 ['html_comment_short', 'a <!--> b <!---> c'],
 ['html_comment_blank', '<!--x-->\n\n\nafter'],
 ['html_custom_tab_blank', '<custom>\ntext\n\t\n*after*'],
 ['html_custom_indent_blank', '<custom>\ntext\n \n  *after*'],
 ['html_custom_many_blank', '<custom>\ntext\n\n\n*after*'],
 ['html_custom_quoted_newline', '<custom a="b\nc">\n*text*'],
 ['html_inline_quoted_newline', 'before <span a="b\nc">*text*</span>'],
 ['html_inline_single_newline', "before <span a='b\nc'>*text*</span>"],
 ['html_unquoted_tab', 'before <span a=x\tb=y>*text*</span>'],
 ['html_unquoted_newline', 'before <span a=x\nb=y>*text*</span>'],
 ['html_unquoted_empty', 'before <span a=>*text*</span>'],
 ['html_empty_quoted', 'before <span a="">*text*</span>'],
 ['html_attr_boolean', 'before <span selected>*text*</span>'],
 ['html_attr_underscore', 'before <span _a="b">*text*</span>'],
 ['html_namespace_close', 'before </x:y> after'],
 ['html_self_closing', 'before <x a=b/> after'],
 ['html_nested_anchor', '<a href="/x">www.a.invalid <a href="/y">www.b.invalid</a> www.c.invalid</a>'],
 ['html_kbd_closed', 'before <kbd>one</kbd> www.example.invalid'],
 ['heading_hash_tab', '# heading\t###'],
 ['heading_seven', '####### text'],
 ['heading_separator_inside', '# first\u2028second'],
 ['heading_three_blank', '# text\n\n\nafter'],
 ['code_indented_three_blank', '    code\n\n\nafter'],
 ['hr_three_blank', '---\n\n\nafter'],
 ['setext_three_blank', 'title\n---\n\n\nafter'],
 ['math_const_astral', '$AB😀$tail $A😀$tail $_X!$tail'],
 ['math_const_lowercase', '$Ab$tail $ABa$tail $9AB$tail'],
 ['math_pending_command_later', 'before $words \\alpha more'],
 ['math_pending_display_later', '$$\nwords \\alpha'],
 ['math_block_whitespace', '$$\n\ufeffx+1\ufeff\n$$'],
);
for (const cp of sourceSpaces) {
 const w=String.fromCodePoint(cp), id=cp.toString(16);
 sourceSeeds.push(
  [`extra_space_${id}_empty_ref`,`[${w}]\n\n[${w}]: /dest`],
  [`extra_space_${id}_inline_before`,`[a](${w}/x) after`],
  [`extra_space_${id}_inline_after`,`[a](/x${w}) after`],
  [`extra_space_${id}_inline_title_tail`,`[a](/x "t"${w}) after`],
  [`extra_space_${id}_heading_tail`,`# text${w}###`],
  [`extra_space_${id}_setext`,`${w}text${w}\n---`],
  [`extra_space_${id}_table`,`| ${w}a${w} | b |\n| --- | --- |\n| c | ${w}d${w} |`],
  [`extra_space_${id}_list`,`- one\n  ${w}\n  two\n- three`],
  [`extra_space_${id}_code_lang`,`\`\`\`${w}js${w}\nx\n\`\`\``],
  [`extra_space_${id}_math_block`,`$$\n${w}x+1${w}\n$$`],
  [`extra_space_${id}_html_close`,`before </span${w}> after`],
  [`extra_space_${id}_html_bare`,`before <span a=x${w}b=y>*x*</span> after`],
  [`extra_space_${id}_url`,`https://example.invalid/x${w}after`],
 );
}

// Audit the block-vs-inline quoted-attribute newline boundary. The block
// regex requires an actual closing quote, never a newline standing in for it.
for (const [kind,quote] of [['dq','"'],['sq',"'"]]) {
 const tails=['one\n>', 'one\n y=z>', 'one\nx>', 'one\nx'+quote+'>', '\n>', '😀\n>'];
 for (const [index,tail] of tails.entries()) {
  sourceSeeds.push([
   'html_attr_newline_'+kind+'_'+index,
   '<custom x='+quote+tail+'\n*body*\n\n*after*',
  ]);
 }
}

// Inline-link source consumption, emphasis/reflink masking and raw-tag context.
// Keep earlier seeds as a stable prefix; all expectations come from upstream.
for (const [wsName,ws] of [['space',' '],['double','  '],['tab','\t'],['ideographic','\u3000'],['mixed',' \u3000']]) {
 for (const [labelName,label] of [['ascii','a'],['astral','😀'],['em','*😀*']]) {
  for (const [hrefName,href] of [['ascii','xy'],['astral','😀'],['astralTail','a😀'],['cjk','中文']]) {
   for (const prefix of ['', '!']) {
    sourceSeeds.push(['consume_'+wsName+'_'+labelName+'_'+hrefName+(prefix?'_image':''),prefix+'['+label+']('+ws+href+')tail) *after*']);
   }
  }
 }
}
for (const [refName,ref] of [['lower','id'],['upper','ID'],['mixed','Id'],['spaces','i  d'],['unicode','😀']]) {
 for (const [patternName,pattern] of [
  ['inside','*before [a*][REF] after*'],
  ['insideStrong','**before [a**][REF] after**'],
  ['insideUnd','_before [a_][REF] after_'],
  ['insideTriple','***before [a***][REF] after***'],
  ['outside','*before [*a][REF] after*'],
  ['astral','*😀 [😀*][REF] 😀*'],
  ['escaped','*before [a\\*][REF] after*'],
  ['image','*before ![a*][REF] after*'],
 ]) {
  const body=pattern.replace('REF',ref);
  const def=ref==='i  d'?'i d':ref.toLowerCase();
  sourceSeeds.push(['mask_'+refName+'_'+patternName,body+'\n\n['+def+']: /target']);
 }
}
for (const tag of ['a','A','code','CODE','pre','script','style','textarea']) {
 for (const [name,body] of [
  ['autolinks','www.one.invalid '+ '<'+tag+'>'+ 'www.two.invalid &amp; *text*'+ '</'+tag+'>' +' www.three.invalid'],
  ['nested','<'+tag+'><'+tag+'>www.one.invalid</'+tag+'> www.two.invalid</'+tag+'> www.three.invalid'],
  ['markdownLink','<'+tag+'>[a](/x) www.two.invalid</'+tag+'> www.three.invalid'],
  ['markdownImage','<'+tag+'>![a](/x) www.two.invalid</'+tag+'> www.three.invalid'],
  ['selfClose','<'+tag+'/>www.two.invalid *text* &amp;'],
  ['spaceClose','<'+tag+'>www.two.invalid</'+tag+' >www.three.invalid'],
 ]) sourceSeeds.push(['context_'+tag+'_'+name,'before '+body+' after']);
}

// Unequal UTF-8/scalar/UTF-16 lengths inside masked spans.
for (const [bodyName,body] of [
 ['link','[😀](/x)'],['linkCjk','[中文](/x)'],['code','\x60😀\x60'],
 ['html','<span title="😀">'],['reference','[😀][id]'],['escape','\\😀'],
 ['escapePair','\\😀\\*'],['escapeRepeated','\\😀\\😀'],
]) {
 for (const [prefixName,prefix] of [['none',''],['emoji','😀 '],['cjk','中 ']]) {
  for (const delim of ['*','**','_']) {
   sourceSeeds.push(['maskUnits_'+bodyName+'_'+prefixName+'_'+delim.length+(delim==='_'?'u':''),prefix+delim+'before '+body+' after'+delim+' tail\n\n[id]: /target']);
  }
 }
}
for (const [name,body] of [
 ['collapsed','[id][]'],['collapsedParen','[id][]('],['escapedBracket','[a\\[b][id]'],
 ['labelDelimiter','[a*][]'],['missing','[a*][missing]'],['upperShortcut','[ID]'],
]) sourceSeeds.push(['maskBoundary_'+name,'*before '+body+' after*\n\n[id]: /target\n[a*]: /another']);

// Mask spans after the closing delimiter expose byte/scalar/unit coordinate drift.
// Keep all 846 historical source seeds unchanged and append actual-upstream cases.
for (const [maskName,mask] of [
 ['linkEmoji','[😀](/x)'],['linkCjk','[中文](/x)'],['linkHref','[a](/😀)'],
 ['codeEmoji','\x60😀\x60'],['codeCjk','\x60中文\x60'],
 ['htmlEmoji','<span title="😀">'],['htmlCjk','<span title="中文">'],
 ['refEmoji','[😀][id]'],['refCjk','[中文][id]'],
 ['collapsedEmoji','[😀][]'],['collapsedCjk','[中文][]'],
 ['escapeEmoji','\\😀'],['escapePair','\\😀\\*'],['escapeRepeated','\\😀\\😀'],
]) {
 for (const [prefixName,prefix] of [['none',''],['emoji','😀 lead ']]) {
  for (const [bodyName,body] of [['ascii','a'],['emoji','😀'],['cjk','中']]) {
   for (const delim of ['*','**','_','__']) {
    sourceSeeds.push(['maskAfter_'+maskName+'_'+prefixName+'_'+bodyName+'_'+(delim[0]==='*'?'a':'u')+delim.length,
     prefix+delim+body+delim+' '+mask+' tail\n\n[id]: /target\n[😀]: /emoji\n[中文]: /cjk']);
   }
  }
 }
}
for (const [name,body] of [
 ['collapsedParen','[id][]('],['collapsedParenClose','[id][]()'],
 ['collapsedEmojiParen','[😀][]('],['codeLabel','[\x60a*\x60][id]'],
 ['unevenCodeLabel','[\x60\x60a*\x60][id]'],['codeLink','[\x60😀*\x60](/x)'],
 ['escapeLabel','[a\\😀*](/x)'],['codeUneven','\x60\x60😀*\x60'],
 ['codeUnevenLong','\x60😀*\x60\x60'],['codeInsideLabel','[a\x60😀*\x60b](/x)'],
 ['astralPair','\\😀\\😀\\*'],['astralTriple','\\😀\\😀\\😀'],
]) {
 for (const delim of ['*','**','_']) {
  sourceSeeds.push(['maskAudit_'+name+'_'+(delim[0]==='*'?'a':'u')+delim.length,
   delim+'a'+delim+' '+body+' '+delim+'b'+delim+' tail\n\n[id]: /target\n[😀]: /emoji']);
 }
}

// Actual marked probes demonstrate source and recursive text cuts through a pair.
const emphasisUnitSeeds = [
 [
  "emHigh0",
  "lead *[😀](/x)*😀 \\😀 \\😀 "
 ],
 [
  "emHigh1",
  "lead *[😀](/x)*😀 \\😀 \\😀 \\😀 \\😀 \\😀 \\😀 "
 ],
 [
  "emHigh2",
  "lead *[😀](/x)*😀 \\😀 \\😀 \\😀 \\😀 \\😀 \\😀 \\😀 \\😀 \\😀 \\😀 "
 ],
 [
  "emHigh3",
  "lead *[😀](/x)*$x+😀 \\😀 \\😀 \\😀 \\😀 \\😀 "
 ],
 [
  "emHigh4",
  "lead *[😀](/x)*$x+😀 \\😀 \\😀 \\😀 \\😀 \\😀 \\😀 \\😀 \\😀 \\😀 "
 ],
 [
  "emHigh5",
  "lead *[😀](/x)*_x_😀 \\😀 \\😀 "
 ],
 [
  "emHigh6",
  "lead *[😀](/x)*_x_😀 \\😀 \\😀 \\😀 \\😀 \\😀 "
 ],
 [
  "emHigh7",
  "lead *[😀](/x)*_x_😀 \\😀 \\😀 \\😀 \\😀 \\😀 \\😀 \\😀 \\😀 \\😀 "
 ],
 [
  "emHigh8",
  "lead *[😀](/x)**x*😀 \\😀 \\😀 "
 ],
 [
  "emHigh9",
  "lead *[😀](/x)*\\(x😀 \\😀 \\😀 \\😀 \\😀 \\😀 "
 ],
 [
  "emHigh10",
  "lead *[😀](/x)*\\(x😀 \\😀 \\😀 \\😀 \\😀 \\😀 \\😀 \\😀 \\😀 \\😀 "
 ],
 [
  "emLowa1",
  "lead *a*😀 \\😀"
 ],
 [
  "emLowa2",
  "lead **a**😀 \\😀"
 ],
 [
  "emLowa3",
  "lead ***a***😀 \\😀"
 ],
 [
  "emLowu1",
  "lead _a_😀 \\😀"
 ],
 [
  "emLowu2",
  "lead __a__😀 \\😀"
 ]
];
sourceSeeds.push(...emphasisUnitSeeds);

const sourceCases=[];
for (const [name,md] of sourceSeeds) {
 for (const [width,style,hyperlinks] of [[12,'none',false],[40,'grayItalic',false],[24,'none',true]]) {
  caseOf(`source_${name}_w${width}`,md,width,{style,hyperlinks});
  const item=cases.pop();
  item.expected=item.expected.map(line=>Buffer.from(line,'utf8').toString('utf8'));
  sourceCases.push(item);
 }
}
writeFileSync('source-fixtures.json',JSON.stringify({seeds:sourceSeeds.length,cases:sourceCases},null,1)+'\n');
console.log('Markdown source/lexer cases:',sourceCases.length,'seeds:',sourceSeeds.length);

const sourceUnitSeeds = [
 ['low','[a](  😀)tail)'],['lowImage','![a](  😀)tail)'],
 ['lowMerged','[a](  😀)bad[missing] _after_)'],
 ['lowBeforeEm','[a](  😀*a*)tail)'],
 ['wideSpace','[😀](\u3000xy)tail)'],['cjkCut','[a](  中文)tail)'],
];
// Force the raw cutoff between the emoji's units immediately before different
// inline token starts; the omitted whitespace count is the href's JS length.
for (const [name,tail] of [
 ['em','*a*'],['underscore','_a_'],['math','$x$'],['code','\x60a\x60'],
 ['missingRef','[missing]'],['reference','[id]'],
]) {
 const href='😀'+tail;
 sourceUnitSeeds.push(['lowNext_'+name,'[a]('+' '.repeat(href.length)+href+')tail)\n\n[id]: /target']);
}
sourceUnitSeeds.push(...emphasisUnitSeeds);
const sourceUnitContexts = [
 ['plain',s=>s],['strong',s=>'**'+s+'**'],['quote',s=>'> '+s],
 ['list',s=>'- '+s],['heading',s=>'# '+s],
 ['table',s=>'| '+s+' | end |\n| --- | --- |\n| x | y |'],
];
const sourceUnitCases=[];
for (const [seedName,seed] of sourceUnitSeeds) {
 for (const [context,wrap] of sourceUnitContexts) {
  for (const width of [1,2,12,40]) {
   for (const style of ['none','bgBlue','unitCount','reverseUnits']) {
    caseOf('sourceUnits_'+seedName+'_'+context+'_w'+width+'_'+style,wrap(seed),width,{style,hyperlinks:true});
    const item=cases.pop();
    item.expectedUtf16=item.expected.map(unitArray);
    item.expectedWidths=item.expected.map(visibleWidth);
    item.expected=item.expected.map(line=>Buffer.from(line,'utf8').toString('utf8'));
    sourceUnitCases.push(item);
   }
  }
 }
}
writeFileSync('source-utf16-fixtures.json',JSON.stringify({cases:sourceUnitCases},null,1)+'\n');
console.log('Markdown source-unit cases:',sourceUnitCases.length);

// Internal recursive source representation: valid prefix plus one high unit.
// These are lexer-token expectations, not public arbitrary-UTF-16 source support.
const inlineTailCases=[];
const tailPrefixes=["","a","*a*","_a_","**a**","__a__","*","_","\\","`x`","[x](/a)","<b>","http://a","http://a?","http://a&copy;","http://a(b)","http://a(b","www.a","a@b.c","<http://a>","[id]","[","😀","\\😀"];
const tokenUnits=t=>({kind:t.type,raw:unitArray(t.raw),text:unitArray(t.text??''),href:unitArray(t.href??''),tokens:(t.tokens??[]).map(tokenUnits)});
for(const [i,prefix] of tailPrefixes.entries()) {
 for(const high of [0xd800,0xdbff]) {
  const raw=prefix+String.fromCharCode(high);
  inlineTailCases.push({name:'inlineTail_'+i+'_'+high,source:unitArray(raw),expected:MarkedLexer.lexInline(raw).map(tokenUnits)});
 }
}
writeFileSync('inline-tail-fixtures.json',JSON.stringify({cases:inlineTailCases},null,1)+"\n");
console.log('Markdown internal inline-tail cases:',inlineTailCases.length);

const deviationChecks = [];
function checkLiteral(name, md, width, expectedPlain) {
	const m = new Markdown(md, 0, 0, defaultMarkdownTheme);
	const plain = m.render(width).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
	const ok = JSON.stringify(plain) === JSON.stringify(expectedPlain);
	deviationChecks.push({ name, ok });
}
checkLiteral("task list", "- [ ] beep\n- [x] boop", 80, ["- [ ] beep", "- [x] boop"]);
checkLiteral("code/paragraph single blank", "```\ncode\n```\n\nAfter.", 80, ["```", "  code", "```", "", "After."]);
checkLiteral("hr spacing", "---\n\nAfter.", 40, ["─".repeat(40), "", "After."]);
checkLiteral("simple nested list shape", "- Item 1\n  - Nested 1.1\n  - Nested 1.2\n- Item 2", 80,
	["- Item 1", "    - Nested 1.1", "    - Nested 1.2", "- Item 2"]);

writeFileSync("fixtures.json", JSON.stringify({ themeProbe, deviationChecks, cases }, null, 1));
console.log("cases:", cases.length);
console.log("deviation checks:", JSON.stringify(deviationChecks));
