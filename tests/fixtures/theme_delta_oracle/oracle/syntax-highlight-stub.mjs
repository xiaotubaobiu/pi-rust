// syntax-highlight seam: `highlightCode`/`getMarkdownTheme` styling is not
// oracle-compared (cli-highlight is a native dependency); the capture stubs
// the seam so the import resolves. `supportsLanguage` returning false routes
// every highlight call to the theme's plain `mdCodeBlock` path.
export function supportsLanguage() {
	return false;
}

export function highlight() {
	throw new Error("highlight is stubbed in the capture harness");
}
