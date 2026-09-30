// Oracle capture: upstream coding-agent src/core/models-store.ts under node
// (with the oracle proper-lockfile stub — file content is the observable).
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { FileModelsStore, InMemoryCodingAgentModelsStore } = await import(
  new URL("./src/core/models-store.ts", import.meta.url)
);

const dir = mkdtempSync(join(tmpdir(), "pi-models-store-oracle-"));
const sharedModelsPath = join(dir, "models-store.json");

function model(provider, id) {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
}

const snapshots = {};

// Sequential write/read/delete flows against a shared path.
{
  const store = new FileModelsStore(sharedModelsPath);
  await store.write("one", { models: [model("one", "m1")], checkedAt: 100 });
  snapshots.after_write_one = readFileSync(sharedModelsPath, "utf-8");
  await store.write("two", { models: [model("two", "m2")], checkedAt: 200 });
  snapshots.after_write_two = readFileSync(sharedModelsPath, "utf-8");
  const one = await store.read("one");
  const two = await store.read("two");
  const missing = await store.read("missing");
  snapshots.reads = { one, two, missing: missing ?? null };
  // Reloaded instance sees the same data.
  const reloaded = new FileModelsStore(sharedModelsPath);
  const oneAgain = await reloaded.read("one");
  snapshots.reloaded_read_one = oneAgain;
  await reloaded.delete("one");
  snapshots.after_delete_one = readFileSync(sharedModelsPath, "utf-8");
  snapshots.read_one_after_delete = (await reloaded.read("one")) ?? null;
  snapshots.read_two_after_delete = await reloaded.read("two");
}

// Entry with metadata fields present.
{
  const metaPath = join(dir, "meta-models-store.json");
  const store = new FileModelsStore(metaPath);
  await store.write("p", {
    models: [],
    lastModified: 4,
    checkedAt: 5,
    etag: '"abc"',
  });
  snapshots.after_write_meta = readFileSync(metaPath, "utf-8");
  const readBack = await store.read("p");
  snapshots.read_meta = readBack;
}

// In-memory store clone semantics.
{
  const store = new InMemoryCodingAgentModelsStore();
  await store.write("p", { models: [model("p", "m")], checkedAt: 1 });
  const first = await store.read("p");
  first.models[0].id = "mutated";
  snapshots.in_memory_after_mutation = await store.read("p");
  await store.delete("p");
  snapshots.in_memory_after_delete = (await store.read("p")) ?? null;
}

// JSONC/BOM is NOT stripped here (raw JSON.parse via stripBom only).
{
  const bomPath = join(dir, "bom-models-store.json");
  writeFileSync(bomPath, "\uFEFF{\"p\": {\"models\": []}}", "utf-8");
  const store = new FileModelsStore(bomPath);
  snapshots.bom_read = (await store.read("p")) ?? null;
}

const out = { snapshots };
const target = new URL("./models_store.oracle.json", import.meta.url);
const { writeFileSync: writeFile } = await import("node:fs");
writeFile(target, JSON.stringify(out, null, 1) + "\n", "utf-8");
rmSync(dir, { recursive: true, force: true });
console.log("wrote", target);
