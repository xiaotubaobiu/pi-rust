// r19 oracle addendum: tui-renderer.ts deterministic stylers (verbatim bodies).
import { writeFileSync } from "node:fs";
import { theme } from "./deps.ts";
// Real upstream theme.ts bgAnsi emits standard 48;2 background codes; the
// r19 deps theme machine renders bg names as 38;2 + 49 (disclosed stub), so
// the two bg-backed stylers here use the faithful 48;2 form. searchMatchBg
// and selectedBg both resolve to selectedBg #3a3a4a in dark.json.
const BG_ANSI: Record<string, string> = {
	searchMatchBg: "[48;2;58;58;74m",
	selectedBg: "[48;2;58;58;74m",
};
const bg48 = (color: string, text: string) => `${BG_ANSI[color]}${text}[49m`;
import { keyDisplayText } from "./keybinding_hints_verbatim.ts";

const styleSearchMatch = (text: string) => bg48("searchMatchBg", theme.fg("searchMatchText", text));
const searchMatchStyle = (text: string) => theme.underline(styleSearchMatch(text));
const searchCurrentMatchStyle = (text: string) => theme.bold(theme.inverse(styleSearchMatch(text)));
const searchNavigationButtonStyle = (text: string, hovered: boolean) => (hovered ? theme.underline(text) : text);
const scrollToEndIndicator = () => {
	const shortcut = keyDisplayText("tui.altScreen.bottom");
	const label = ` ↓ Jump to latest message${shortcut ? ` · ${shortcut}` : ""} `;
	return bg48("selectedBg", theme.fg("text", label));
};

const probes = ["match", "", "multi word match", "↑"];
const out = {
	searchMatchStyle: probes.map(searchMatchStyle),
	searchCurrentMatchStyle: probes.map(searchCurrentMatchStyle),
	searchNavigationButtonStyle: probes.flatMap((t) => [searchNavigationButtonStyle(t, false), searchNavigationButtonStyle(t, true)]),
	scrollToEndIndicator: scrollToEndIndicator(),
};
writeFileSync(new URL("./tui_renderer_oracle.json", import.meta.url), JSON.stringify(out, null, "\t"));
console.log("wrote tui_renderer_oracle.json");
