// Token-tree oracle for the marked 18.0.11 lexer (offline).
// Dumps the ACTUAL marked 18.0.11 Lexer.lex token trees for a battery of
// inputs covering the 18.0.5 -> 18.0.11 deltas (nested links, linkEmitted,
// reflink masking, escaped-astral mask, emStrong mid-run, blockquote
// continuation, list loose/checkbox two-pass, lheading/paragraph/fence/html
// rule changes). Consumed by src/tui/markdown_lexer.rs tests.
import { writeFileSync } from "node:fs";
import { Lexer as MarkedLexer } from "marked";

const inputs = [
	// nested links (CommonMark: links may not contain links; images exempt)
	"[outer [inner](/inside)](/outside)",
	"[text **bold [in](/y)**][ref]\n\n[ref]: /t",
	"[**b [x](/y)**][ref]\n\n[ref]: /t",
	"![alt [x](/y)](/z)",
	"![![a](/i)](ref)\n\n[ref]: /t",
	"[![alt](/i)][ref]\n\n[ref]: /t",
	"a [x [y](/b)](/c) z",
	// escaped-astral punctuation mask (length-preserving '+++')
	"*before \\😀\\* after* tail\n\n[id]: /target",
	"**before \\😀\\* after** tail\n\n[id]: /target",
	"*a* \\😀 tail\n\n[id]: /target",
	"lead *[😀](/x)*😀 \\😀 \\😀 ",
	"lead *a*😀 \\😀",
	"lead _a_😀 \\😀",
	"*a* \\😀\\😀\\* *b* tail\n\n[id]: /target",
	// emStrong mid-run opener
	"**a*b*c",
	"**a*b*c** d",
	"__a_b_c__ d",
	"*a **b** c*",
	"***a**b*",
	// blockquote continuation with restated markers after lazy lines
	"> a\n> > b\nlazy\nlazy2\n> c\n",
	"> a\n> > b\nlazy\n\n> c\n",
	"> > b\nlazy\n> c\n",
	"> x\n> > y\nz\n> w\n",
	"> a\n>  > b\nlazy\n> c\n",
	"> a\n> > b\ntext\n> ===\n",
	// list loose finalized before checkbox placement (two passes)
	"- [ ] task\n- x\n  \n  y\n",
	"- [x] done\n- x\n\n  y\n",
	"- [ ] a\n- [x] b\n- c\n\n  d\n",
	"1. [ ] task\n2. x\n   \n   y\n",
	"- x\n\n  y\n- [ ] task\n",
	"- [ ] tight\n- plain\n",
	// lheading: ATX-shaped line without space no longer blocks setext
	"text\n#abc\n===\n",
	"text\n# abc\n===\n",
	"a\n####### x\n===\n",
	// paragraph continuation: tab-only line ends the paragraph
	"text\n\t\nmore\n",
	"text\n \nmore\n",
	// fences interrupt a paragraph at EOF / fence info rules
	"para\n```js",
	"para\n~~~",
	"para\n```a`b",
	"para\n```\nx\n",
	// html blocks swallow the rest of the closing line (3)/(4)/(5)/(1)
	"<?x?>tail\n\nafter\n",
	"<!A X>tail\n\nafter\n",
	"<![CDATA[x]]>tail\n\nafter\n",
	"<script>a</script>tail\n\nafter\n",
	// tables / general regression battery
	"| a | b |\n| --- | ---: |\n| 1 | 2 |\n",
	"- item\n\n  second para\n",
	"> quote\n> lazy\n\nafter",
	"    code\n\nafter",
	"a***b***c",
	"a_ b _c",
	"**bold* tail",
	"[ref] [ref2]\n\n[ref]: /r 'ti'\n[ref2]: (/two)",
	"\\*not em\\* and \\\\\\` weird",
	"<https://auto.link> and www.plain.example",
	"*em [link](/x) em* and tail",
];

const units = (s) => { const out = []; for (let i = 0; i < (s ?? "").length; i++) out.push(s.charCodeAt(i)); return out; };

function snap(t) {
	const out = {
		kind: t.type,
		raw: units(t.raw),
		text: units(t.text),
		href: t.type === "def" ? [] : units(t.href),
		depth: t.depth ?? 0,
		ordered: t.ordered === true,
		start: t.start === "" || t.start === undefined ? 0 : t.start,
		loose: t.loose === true,
		task: t.task === true,
		checked: t.checked === true ? true : t.checked === false ? false : null,
		lang: typeof t.lang === "string" && t.lang !== "" ? t.lang : null,
		tokens: [],
		items: [],
		header: [],
		rows: [],
		align: [],
	};
	if (t.type === "table") {
		out.align = t.align.map((a) => (a ? a[0] : null));
		out.header = t.header.map(cellSnap);
		out.rows = t.rows.map((row) => row.map(cellSnap));
		return out;
	}
	// def tokens: the port stores the link in Lexer::links, not on the token
	out.tokens = (t.tokens ?? []).map(snap);
	out.items = (t.items ?? []).map(snap);
	return out;
}

function cellSnap(c) {
	return {
		kind: "tablecell",
		raw: units(c.text),
		text: units(c.text),
		tokens: (c.tokens ?? []).map(snap),
	};
}

const cases = inputs.map((src, i) => ({
	name: "tok_" + String(i).padStart(3, "0"),
	source: src,
	expected: new MarkedLexer().lex(src).map(snap),
}));
writeFileSync("tokens-fixtures.json", JSON.stringify({ cases }, null, 1) + "\n");
console.log("token cases:", cases.length);
