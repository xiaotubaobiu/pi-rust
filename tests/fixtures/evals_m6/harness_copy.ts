export function resolveModelSelection(
	explicitModel: PiCodingAgentModelSelection | undefined,
	environment: { PI_PROVIDER?: string; PI_MODEL?: string } = process.env,
): PiCodingAgentModelSelection {
	const provider = (explicitModel?.provider ?? environment.PI_PROVIDER)?.trim();
	const id = (explicitModel?.id ?? environment.PI_MODEL)?.trim();
	if (!provider || !id) {
		throw new Error("Select a harness model explicitly or set both PI_PROVIDER and PI_MODEL as defaults.");
	}
	return { provider, id };
}
export function verifySystemPrompt(
	systemPrompt: string,
	options: Pick<PiCodingAgentHarnessOptions, "name" | "expectedPiDocumentation">,
): string {
	if (options.expectedPiDocumentation === undefined) return systemPrompt;
	if (!systemPrompt.includes("\n<rules>\n")) {
		throw new Error(`Pi system prompt lost its rules in the ${options.name} eval variant.`);
	}
	const hasDocumentation = systemPrompt.includes("\n<docs>\nPi documentation (read only");
	if (hasDocumentation !== options.expectedPiDocumentation) {
		throw new Error(`Pi system prompt does not match the ${options.name} eval variant.`);
	}
	return systemPrompt;
}
/** Documentation evals intentionally exclude shell and unrestricted network tools. */
export const DOCUMENTATION_EVAL_TOOLS = ["read", "write", "edit", "grep", "find", "ls"] as const;

export function resolveDocumentationVariant(
	value: string | undefined = process.env.PI_EVAL_VARIANT,
): DocumentationVariant {
	if (value === "without_docs" || value === "with_docs") return value;
	throw new TypeError('PI_EVAL_VARIANT must be "without_docs" or "with_docs".');
}

export function excludePiDocumentation(defaultPrompt: string): string {
	const documentationStartMarker = "\n<docs>\n";
	const documentationEndMarker = "\n</docs>";
	const documentationStart = defaultPrompt.indexOf(documentationStartMarker);
	if (documentationStart === -1) throw new Error("Default Pi system prompt has no Pi documentation section.");
	const documentationEnd = defaultPrompt.indexOf(documentationEndMarker, documentationStart);
	if (documentationEnd === -1) throw new Error("Default Pi system prompt has no complete Pi documentation section.");
	const cwdStart = defaultPrompt.lastIndexOf("\n<cwd>\n");
	if (cwdStart < documentationEnd) throw new Error("Default Pi system prompt has no working-directory section.");
	return (
		defaultPrompt.slice(0, documentationStart) + defaultPrompt.slice(documentationEnd + documentationEndMarker.length)
	);
}

