// Supplementary 18.0.11 semantics oracle (offline).
// Runs the ACTUAL upstream markdown.ts (pi @ 590144609) under Node 25 with
// marked 18.0.11 for inputs that discriminate the 18.0.5 -> 18.0.11 lexer
// deltas which the stored corpora do not cover. Output shape matches
// markdown_fixtures.json so src/tui/tests/markdown.rs can consume it.
import { writeFileSync } from "node:fs";
import { Chalk } from "chalk";
import { Markdown } from "./src/components/markdown.ts";
import { setCapabilities, resetCapabilitiesCache } from "./src/terminal-image.ts";

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

const cases = [];
function caseOf(name, md, width, opts = {}) {
	const paddingX = opts.paddingX ?? 0;
	const paddingY = opts.paddingY ?? 0;
	const style = opts.style ?? "none";
	const theme = { ...defaultMarkdownTheme };
	let defaultTextStyle;
	if (style === "grayItalic") {
		defaultTextStyle = { color: (t) => chalk.dim(t), italic: true };
	}
	setCapabilities({ hyperlinks: opts.hyperlinks ?? false, images: null, trueColor: true });
	const component = new Markdown(md, paddingX, paddingY, theme, defaultTextStyle, {
		preserveOrderedListMarkers: opts.preserveMarkers,
		preserveBackslashEscapes: opts.preserveEscapes,
		renderLatex: opts.renderLatex,
	});
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
		expected: component.render(width),
	});
	resetCapabilitiesCache();
}

// Nested links: a link may not contain another link; images are exempt.
caseOf("v11_nested_link_outer_text", "[outer [inner](/inside)](/outside)", 60);
caseOf("v11_nested_link_hyperlinks", "[outer [inner](/inside)](/outside)", 60, { hyperlinks: true });
caseOf("v11_nested_link_in_em", "[text **bold [in](/y)**][ref]\n\n[ref]: /t", 60);
caseOf("v11_nested_reflink_em_label", "[**b [x](/y)**][ref]\n\n[ref]: /t", 60);
caseOf("v11_image_holding_link", "![alt [x](/y)](/z)", 60);
caseOf("v11_image_reflink_holding_link", "![![a](/i)](ref)\n\n[ref]: /t", 60);

// Escaped-astral punctuation mask keeps length (anyPunctuation '+++' fix).
caseOf("v11_mask_escape_pair_em", "*before \\😀\\* after* tail\n\n[id]: /target", 60);
caseOf("v11_mask_escape_pair_strong", "**before \\😀\\* after** tail\n\n[id]: /target", 60);
caseOf("v11_mask_after_escape", "*a* \\😀 tail\n\n[id]: /target", 60);
caseOf("v11_mask_em_high_link", "lead *[😀](/x)*😀 \\😀 \\😀 ", 30, { hyperlinks: true });
caseOf("v11_mask_em_low", "lead *a*😀 \\😀", 30);

// emStrong mid-run opener (`**a*b*c` = `**a<em>b</em>c`).
caseOf("v11_em_mid_run", "**a*b*c", 40);
caseOf("v11_em_mid_run_long", "**a*b*c** d", 40);
caseOf("v11_em_mid_run_underscore", "__a_b_c__ d", 40);

// Blockquote continuation: restated marker after a lazy line must not become
// a spurious deeper blockquote.
caseOf("v11_quote_lazy_restated_marker", "> a\n> > b\nlazy\nlazy2\n> c\n", 60);
caseOf("v11_quote_lazy_restated_deep", "> x\n> > y\nz\n> w\n> > v\n", 60);
caseOf("v11_quote_setext_continuation", "> a\n> > b\ntext\n> ===\n", 60);

// List: loose is finalized before checkboxes are placed (two passes).
caseOf("v11_task_then_loose", "- [ ] task\n- x\n  \n  y\n", 60);
caseOf("v11_task_checked_then_loose", "- [x] done\n- x\n\n  y\n", 60);
caseOf("v11_task_loose_two_tasks", "- [ ] a\n- [x] b\n- c\n\n  d\n", 60);
caseOf("v11_task_tight_unchanged", "- [ ] task\n- plain\n", 60);

// lheading: ATX-heading-shaped line (no space) no longer blocks a setext tail.
caseOf("v11_lheading_hash_interrupt", "text\n#abc\n===\n", 60);
caseOf("v11_lheading_hash_space_still_interrupts", "text\n# abc\n===\n", 60);

// Paragraph continuation: a tab-only line now ends the paragraph.
caseOf("v11_paragraph_tab_blank_line", "text\n\t\nmore\n", 60);

// Fences interrupt a paragraph at EOF without a trailing newline.
caseOf("v11_fence_eof_interrupt", "para\n```js", 60);
caseOf("v11_fence_eof_tilde", "para\n~~~", 60);
caseOf("v11_fence_backtick_info_eof", "para\n```a`b", 60);

// HTML blocks (3)/(4)/(5) swallow the rest of their closing line.
caseOf("v11_html_pi_tail", "<?x?>tail\n\nafter\n", 60);
caseOf("v11_html_decl_tail", "<!A X>tail\n\nafter\n", 60);
caseOf("v11_html_cdata_tail", "<![CDATA[x]]>tail\n\nafter\n", 60);
caseOf("v11_html_script_tail", "<script>a</script>tail\n\nafter\n", 60);

writeFileSync("extra-fixtures.json", JSON.stringify({ cases }, null, 1) + "\n");
console.log("extra cases:", cases.length);
