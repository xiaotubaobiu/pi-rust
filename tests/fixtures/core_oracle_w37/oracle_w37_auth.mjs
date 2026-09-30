// Oracle capture: upstream coding-agent src/core/auth-storage.ts under node
// (--experimental-strip-types, with the oracle proper-lockfile stub — file
// content is the observable, lock contention is not exercised). Pins:
// - auth.json wire bytes after modify/delete (JSON.stringify(…, null, 2),
//   provider insertion order: `{...current, [provider]: next}` semantics),
// - credential resolution ($ENV, credential-scoped env), list order,
// - readStoredCredential raw output,
// - the fixed validation/mutation error strings of the read-only store.
// V8 JSON.parse message texts (Failed to read auth.json: …) are intentionally
// NOT captured beyond their fixed prefix (serde_json wording differs).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { AuthStorage, FileAuthStorageBackend, ReadOnlyAuthStorage, readStoredCredential } = await import(
  new URL("./src/core/auth-storage.ts", import.meta.url)
);

const out = { values: {}, errors: {}, bytes: {} };

const tempDir = join(tmpdir(), `pi-oracle-w37-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(tempDir, { recursive: true });
const authJsonPath = join(tempDir, "auth.json");

const writeAuthJson = (data) => writeFileSync(authJsonPath, JSON.stringify(data));
const bytes = () => readFileSync(authJsonPath, "utf-8");
const json = (value) => JSON.parse(JSON.stringify(value ?? null));

// ---- 1. env-resolved api key ---------------------------------------------
{
  const original = process.env.PI_ORACLE_AUTH_KEY;
  process.env.PI_ORACLE_AUTH_KEY = "environment-key";
  try {
    writeAuthJson({ anthropic: { type: "api_key", key: "$PI_ORACLE_AUTH_KEY" } });
    const storage = AuthStorage.create(authJsonPath);
    out.values.env_resolved = json(await storage.read("anthropic"));
    out.values.read_stored_raw = json(readStoredCredential("anthropic", authJsonPath));
    out.values.read_stored_missing = json(readStoredCredential("missing", authJsonPath));
  } finally {
    if (original === undefined) delete process.env.PI_ORACLE_AUTH_KEY;
    else process.env.PI_ORACLE_AUTH_KEY = original;
  }
}

// ---- 2. oauth unchanged + credential-scoped env ---------------------------
{
  const credential = {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: 1735689600000,
  };
  const storage = AuthStorage.inMemory({ anthropic: credential });
  out.values.oauth_unchanged = json(await storage.read("anthropic"));

  writeAuthJson({
    anthropic: {
      type: "api_key",
      key: "$SCOPED_KEY",
      env: { SCOPED_KEY: "scoped-value", REGION: "test-region" },
    },
  });
  const storage2 = AuthStorage.create(authJsonPath);
  out.values.scoped_env = json(await storage2.read("anthropic"));
}

// ---- 3. modify preserves unrelated external edits (bytes) -----------------
{
  writeAuthJson({ anthropic: { type: "api_key", key: "old" } });
  const storage = AuthStorage.create(authJsonPath);
  writeAuthJson({
    anthropic: { type: "api_key", key: "old" },
    openai: { type: "api_key", key: "external" },
  });
  await storage.modify("anthropic", async () => ({ type: "api_key", key: "new" }));
  out.bytes.modify_preserves_external = bytes();

  // New provider appended after existing ones.
  await storage.modify("zeta", async () => ({ type: "api_key", key: "zeta-key" }));
  out.bytes.modify_appends = bytes();

  // OAuth credential write keeps the callback's construction order; the
  // canonical stored order (what upstream saveAuth writes, and what the port
  // serializes) is type, refresh, access, expires.
  await storage.modify("google", async () => ({
    type: "oauth",
    refresh: "g-refresh",
    access: "g-access",
    expires: 1735689600001,
  }));
  out.bytes.modify_oauth = bytes();

  // api_key with credential-scoped env.
  await storage.modify("scoped", async () => ({
    type: "api_key",
    key: "$K",
    env: { K: "v", OTHER: "w" },
  }));
  out.bytes.modify_scoped_env = bytes();
}

// ---- 4. modify with undefined leaves unchanged ----------------------------
{
  writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
  const storage = AuthStorage.create(authJsonPath);
  out.values.modify_undefined_result = json(await storage.modify("anthropic", async () => undefined));
  out.values.modify_undefined_read = json(await storage.read("anthropic"));
}

// ---- 5. delete ------------------------------------------------------------
{
  writeAuthJson({
    anthropic: { type: "api_key", key: "a" },
    openai: { type: "api_key", key: "o" },
  });
  const storage = AuthStorage.create(authJsonPath);
  writeAuthJson({
    anthropic: { type: "api_key", key: "a" },
    openai: { type: "api_key", key: "o" },
    google: { type: "api_key", key: "external" },
  });
  await storage.delete("anthropic");
  out.bytes.delete_remaining = bytes();
  out.values.delete_list = json(await storage.list());
  out.values.delete_read_missing = json(await storage.read("anthropic"));
  out.values.delete_read_openai = json(await storage.read("openai"));
  out.values.delete_read_google = json(await storage.read("google"));

  await storage.delete("google");
  await storage.delete("openai");
  out.bytes.delete_to_empty = bytes();
}

// ---- 6. list order --------------------------------------------------------
{
  writeAuthJson({ zebra: { type: "api_key", key: "z" }, alpha: { type: "oauth", access: "a", refresh: "r", expires: 1 } });
  const storage = AuthStorage.create(authJsonPath);
  out.values.list_document_order = json(await storage.list());
}

// ---- 7. in-memory store behavior ------------------------------------------
{
  const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "initial" } });
  out.values.inmem_initial = json(await storage.read("anthropic"));
  await storage.modify("anthropic", async () => ({ type: "api_key", key: "updated" }));
  out.values.inmem_updated = json(await storage.read("anthropic"));
  await storage.delete("anthropic");
  out.values.inmem_after_delete_list = json(await storage.list());
  out.values.inmem_empty = json(await AuthStorage.inMemory().list());
}

// ---- 8. malformed file is not overwritten ---------------------------------
{
  writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
  const storage = AuthStorage.create(authJsonPath);
  writeFileSync(authJsonPath, "{invalid-json", "utf8");
  let modifyError = null;
  try {
    await storage.modify("openai", async () => ({ type: "api_key", key: "new" }));
  } catch (error) {
    modifyError = error.constructor.name;
  }
  out.errors.malformed_modify_throws = modifyError !== null;
  out.bytes.malformed_file_unchanged = bytes();
}

// ---- 9. read-only store validation ----------------------------------------
{
  const readonly = () => new ReadOnlyAuthStorage(authJsonPath);
  writeAuthJson([1, 2]);
  try {
    await readonly().read("anthropic");
    out.errors.readonly_not_object = null;
  } catch (error) {
    out.errors.readonly_not_object = error.message;
  }
  writeAuthJson({ anthropic: { type: "api_key", key: 42 } });
  try {
    await readonly().read("anthropic");
    out.errors.readonly_bad_api_key = null;
  } catch (error) {
    out.errors.readonly_bad_api_key = error.message;
  }
  writeAuthJson({ anthropic: "nope" });
  try {
    await readonly().read("anthropic");
    out.errors.readonly_bad_credential = null;
  } catch (error) {
    out.errors.readonly_bad_credential = error.message;
  }
  writeAuthJson({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: "nope" } });
  try {
    await readonly().read("anthropic");
    out.errors.readonly_bad_oauth = null;
  } catch (error) {
    out.errors.readonly_bad_oauth = error.message;
  }
  writeAuthJson({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: 5 } });
  out.values.readonly_oauth_ok = json(await readonly().read("anthropic"));
  writeAuthJson({ anthropic: { type: "api_key" } });
  out.values.readonly_api_key_no_key = json(await readonly().read("anthropic"));
  writeAuthJson({ anthropic: { type: "api_key", key: "k", env: { A: "1" } } });
  out.values.readonly_list = json(await readonly().list());
  try {
    await readonly().modify("anthropic", async () => undefined);
    out.errors.readonly_modify = null;
  } catch (error) {
    out.errors.readonly_modify = error.message;
  }
  try {
    await readonly().delete("anthropic");
    out.errors.readonly_delete = null;
  } catch (error) {
    out.errors.readonly_delete = error.message;
  }
  // Read failure prefix (message text itself is V8-specific, not captured).
  rmSync(authJsonPath, { force: true });
  writeFileSync(join(tempDir, "dir-block"), "", "utf8");
  try {
    // auth.json is a directory -> read fails with a non-ENOENT error.
    rmSync(authJsonPath, { force: true });
    mkdirSync(authJsonPath);
    await readonly().read("anthropic");
    out.errors.readio_prefix = null;
  } catch (error) {
    out.errors.readio_prefix = error.message.startsWith("Failed to read auth.json: ");
  } finally {
    rmSync(authJsonPath, { recursive: true, force: true });
  }
}

// ---- 10. resolved value is a clone (mutating result does not leak) --------
{
  writeAuthJson({ anthropic: { type: "api_key", key: "k", env: { A: "1" } } });
  const storage = AuthStorage.create(authJsonPath);
  const first = await storage.read("anthropic");
  first.env.A = "mutated";
  const second = await storage.read("anthropic");
  out.values.clone_semantics = json(second);
}

// ---- 11. FileAuthStorageBackend ensures the file exists -------------------
{
  const freshPath = join(tempDir, "fresh-auth.json");
  const backend = new FileAuthStorageBackend(freshPath);
  await backend.withLockAsync(async () => ({ result: 1 }));
  out.bytes.fresh_file_content = readFileSync(freshPath, "utf-8");
}

rmSync(tempDir, { recursive: true, force: true });

const target = new URL("./auth_storage.oracle.json", import.meta.url);
writeFileSync(target, JSON.stringify(out, null, 1) + "\n", "utf-8");
console.log("wrote", String(target));
