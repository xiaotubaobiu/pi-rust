console.log("env:", JSON.stringify(process.env["=C:"]));
console.log("resolve(C:):", require("node:path").win32.resolve("C:"));
console.log("resolve(C:x):", require("node:path").win32.resolve("C:x"));
