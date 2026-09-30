// Shim for `config.ts`: the keybindings verbatim only needs getAgentDir; the
// oracle keeps user config out of the picture (matches `new KeybindingsManager()`
// with no config path — upstream's constructor skips disk reads without one).
export function getAgentDir(): string {
	return process.env.PI_ORACLE_AGENT_DIR ?? ".";
}
