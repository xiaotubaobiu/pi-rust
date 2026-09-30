// Oracle stub so the verbatim upstream `experimental/radius-auth.ts` can run
// under `node --experimental-strip-types`. The function body is copied
// verbatim from upstream packages/coding-agent/src/cli/auth-command.ts
// (getAuthCredential); only the module's unrelated exports are dropped.
export function getAuthCredential(auth) {
  if (auth?.auth.apiKey) return auth.auth.apiKey;
  const authorization = Object.entries(auth?.auth.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "authorization",
  )?.[1];
  return typeof authorization === "string" ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1] : undefined;
}
