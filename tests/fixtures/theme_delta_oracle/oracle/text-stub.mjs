// text seam: verbatim bodies of upstream `splitBom`/`stripBom`
// (`packages/coding-agent/src/utils/text.ts`).
export function splitBom(content) {
	return content.startsWith("\uFEFF")
		? { bom: "\uFEFF", text: content.slice(1) }
		: { bom: "", text: content };
}

export function stripBom(content) {
	return splitBom(content).text;
}
