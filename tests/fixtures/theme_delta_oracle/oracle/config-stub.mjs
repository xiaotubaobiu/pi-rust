// Config seam: upstream `getThemesDir()`/`getCustomThemesDir()` read the
// installed package layout. The capture pins the themes dir to this oracle
// directory (the byte-identical dark.json / light.json copies) and points the
// custom-themes dir at a path that does not exist.
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export function getThemesDir() {
	return here.replace(/[\\/]+$/, "");
}

export function getCustomThemesDir() {
	return here + "custom-themes-nonexistent";
}
