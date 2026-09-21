# M2e models 集合/模型目录/图像 API 移植 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the models layer — Models collection (models.ts 966), catalog flatten + manifest (model-catalog.ts 27 + models-store.ts 45), provider factories (providers/*.ts 2411), the embedded catalog data snapshot (assets/model-data/, 37 providers + manifest, 740KB), the faux provider (faux.ts 708), and the images side (images-models.ts 275 + registry 53 + image-models.ts 42 + image-models.generated 819 + openrouter-images API 196) — completing packages/ai.

**Architecture:** `src/ai/models/` module tree. Catalog data ships as embedded JSON (include_str! of `assets/model-data/*.json` via an include-list generated from the manifest) deserialized into the wire-compatible `Model` type (M2a round-trip proven). Provider factories wire id/name/baseUrl/auth (M2d building blocks) + catalog + API impl (M2b/c). `Models` collection routes stream/getAuth through owning providers.

**Tech Stack:** Existing deps. RS256 decision (carried from M2d): **defer to M2f with a commitment** — ADC service-account token minting stays a named error; adding an RSA dep is a deliberate M2f task, not M2e scope creep. Config cost knob lands in T7 (integration).

**Spec:** `docs/superpowers/specs/2026-09-19-m2-pi-ai-full-port.md` (§1 M2e row)

**Port style:** upstream + oracles models-runtime / model-catalog-types / model-data-validation / images-models / images / openrouter-images / image-model-data test files.

**Data provenance (ledger):** assets/model-data/ generated 2026-09-21 via a patched copy of upstream `generate-models.ts --data-only` (untracked temp files in the upstream tree, removed after use) against live models.dev; kimi-coding absent from the live source (snapshot drift, disclosed) — kimi models come from config-declared models until regeneration. Upstream's generator itself remains TS; a Rust generator port is an M2f follow-up (upstream equally ships data as regenerable artifacts).

## Global Constraints

- Edition 2021, no unsafe; gates per task: cargo test / clippy -D warnings / fmt; CI green at push.
- Catalog data files must deserialize into `Model` (serde) unmodified — never edit the JSON.
- Commit messages: `{feat,fix,docs,chore}: <message>`.

---

### Task 1: model-catalog + manifest + embedded data loading

**Files:** Create `src/ai/models/catalog.rs` (+ `assets/model-data/` committed); Test: in file.
**Oracle:** model-catalog-types.test.ts, model-data-validation.test.ts (data halves). Port flattenModelCatalog (27 lines: `{api: {modelId: Model}}` → sorted Model list) + manifest read + `include_dir`-style loading via a generated include-list (build.rs or a small macro — choose, disclose). Every embedded provider must deserialize (validation test iterates all).
- [ ] Failing tests → implement → gates → commit `feat(ai): model catalog flatten + embedded data loading`

### Task 2: Models collection reads + createProvider

**Files:** Create `src/ai/models/mod.rs`, `provider.rs`.
**Oracle:** models-runtime.test.ts (read halves). Port: Provider struct (id/name/baseUrl/auth/catalog/api impl ref), Models collection (createModels options, setProvider, getProviders/getModels/getModel sync reads incl. per-provider filtering), MutableModels.
- [ ] Failing tests → implement → gates → commit `feat(ai): models collection reads and createProvider`

### Task 3: auth resolution + stream routing

**Files:** Modify `src/ai/models/`; Test: in file.
**Oracle:** models-runtime.test.ts (getAuth/stream halves) + oauth-auth.test.ts getAuth halves (M2d carry). Port: Models.getAuth (through owning provider; model.headers merge; source strings), Models.stream/streamSimple (resolve auth → route to owning ApiImpl with resolved key/headers), complete/completeSimple.
- [ ] Failing wire tests → implement → gates → commit `feat(ai): models getAuth and stream routing`

### Task 4: refresh + dynamic providers + models-store

**Files:** Create `src/ai/models/store.rs`.
**Oracle:** models-runtime.test.ts (refresh halves). Port: refresh (per-provider fetchModels for dynamic providers, concurrent best-effort, aborted/refreshed/errors result), ModelsStore trait + in-memory (models-store.ts), publish/persist semantics.
- [ ] Failing tests → implement → gates → commit `feat(ai): models refresh, dynamic providers, store`

### Task 5: provider factories

**Files:** Create `src/ai/models/providers.rs` (or per-factory files).
**Oracle:** models-runtime.test.ts + per-provider catalog spot-checks. Port the 36 provider factories' distinct logic (most are thin: id/name/baseUrl/envKeyAuth/catalog/api; the special ones: anthropic oauth+auth-token resolve, cloudflare account/gateway placeholders, github-copilot oauth, bedrock ambient, vertex ADC, openrouter, azure resolution chain, zai/cn variants) + all.ts builtin_models()/builtin_providers().
- [ ] Tests (every factory builds; auth resolution spot-checks; catalog counts match manifest) → implement → gates → commit `feat(ai): provider factories and builtin registry`

### Task 6: faux provider + images side

**Files:** Create `src/ai/models/faux.rs`, `src/ai/images/` (models.rs, registry.rs, openrouter_images.rs).
**Oracle:** images-models.test.ts, images.test.ts, openrouter-images.test.ts, image-model-data.test.ts. Port faux.ts (scripted responses, tokensPerSecond, callCount), ImagesModels collection + registry + openrouter-images API impl + image-models.generated data.
- [ ] Failing tests → implement → gates → commit `feat(ai): faux provider and images side`

### Task 7: integration — config cost knob, RS256 decision, cli wiring

**Files:** Modify `src/config.rs` (optional `cost` table feeding build_model — closes the M2b final-review carry), `src/main.rs` (`--models` catalog toggle? keep default config-only; document), RS256: record M2f commitment (named error stays), README.
- [ ] cost config parse + build_model wiring + tests; RS256 ruling ledgered; gates; push; CI green; commit `feat(ai): config cost knob, m2e integration (M2e complete)`

---

## Self-Review Notes

- kimi-coding catalog absence: disclosed data-provenance issue; provider factory still ports (empty catalog + config-declared models work).
- RS256: M2f commitment recorded here and in the m2d ledger.
- Test trajectory: 1114 → ~1250+ by T7.
