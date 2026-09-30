// Re-export layer: the verbatim components under test plus the coding-agent
// KeybindingsManager (the subclass the upstream tests instantiate), resolved
// after deps.ts has fully evaluated (avoids the ESM TDZ on `extends Container`).
export { TreeSelectorComponent } from "./tree_selector_verbatim.ts";
export type { FilterMode } from "./tree_selector_verbatim.ts";
export { SessionSelectorComponent } from "./session_selector_verbatim.ts";
export { KeybindingsManager } from "./core_keybindings_verbatim.ts";
export type { SessionTreeNode, SessionInfo } from "./session_manager_types.ts";
