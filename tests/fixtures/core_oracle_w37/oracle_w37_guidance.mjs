// Oracle capture: upstream coding-agent src/core/auth-guidance.ts under node
// (--experimental-strip-types). The docs path comes from config.ts
// getDocsPath() -> resolve(join(getPackageDir(), "docs")); getPackageDir
// honors the upstream PI_PACKAGE_DIR env override, which the capture pins to
// a fixed drive-rooted value so the texts are cwd-independent. Path
// normalization/join/resolve run with host (win32) semantics — the capture is
// the Windows platform pin (same convention as keybindings_win32.oracle.json).
process.env.PI_PACKAGE_DIR = "/pi-oracle-w37-pkg";

const { getProviderLoginHelp, formatNoModelsAvailableMessage, formatNoModelSelectedMessage, formatNoApiKeyFoundMessage } =
  await import(new URL("./src/core/auth-guidance.ts", import.meta.url));

const out = {
  provider_login_help: getProviderLoginHelp(),
  no_models_available: formatNoModelsAvailableMessage(),
  no_model_selected: formatNoModelSelectedMessage(),
  no_api_key: formatNoApiKeyFoundMessage("anthropic"),
  no_api_key_unknown: formatNoApiKeyFoundMessage("unknown"),
};

const target = new URL("./auth_guidance.oracle.json", import.meta.url);
const { writeFileSync } = await import("node:fs");
writeFileSync(target, JSON.stringify(out, null, 1) + "\n", "utf-8");
console.log("wrote", String(target));
