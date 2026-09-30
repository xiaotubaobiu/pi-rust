// Quick probe: list exports of the copied keybindings module.
const mod = await import(new URL("./src/core/keybindings.ts", import.meta.url));
console.log(Object.keys(mod).join("\n"));
