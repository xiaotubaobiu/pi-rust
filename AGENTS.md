# Working instructions

## Mission and scope
- Port the sibling `pi` project into `pi-rust` with upstream observable behavior preserved. Read `docs/ROADMAP.md` for the full compatibility contract.
- Do not change the sibling `pisper` project. Treat `pi` as a read-only reference for this migration.
- AUTHORIZATION UPDATED 2026-09-28: the user explicitly permits subagents/delegation to accelerate the full migration. The prior ban is historical and superseded. Assign disjoint write scopes; the coordinator owns shared documentation, Cargo metadata, integration and whole-tree gates. No automatic Git writes. Preserve portable handoff evidence for other applications.
- RESUMED 2026-09-28: latest user requests accelerated full migration after a simple time estimate. Previous stop handoffs and the 2026-09-24 11:30 cutoff are historical; no new deadline. See docs/migration/PARALLEL_EXECUTION_2026-09-28.md for current ownership. Do not narrow scope or mark the full migration complete prematurely.

## Continuity
- Before editing, read `HANDOFF.md`, `docs/migration/MIGRATION_STATUS.md`, and the latest entries of `docs/migration/WORK_LOG.md`.
- Update these portable Markdown files after each validated checkpoint and before stopping. Record exact commands, outcomes, limitations, modified files, and the next concrete step.
- Preserve pre-existing uncommitted work. The 2026-09-23 baseline is backed up in the workspace's `.migration-handoff/baseline-2026-09-23/`.
- No automatic commits, pushes, resets, cleans, or stashes. Do not stage unrelated files.

## Implementation and validation
- Upstream source and its tests are the behavior authority. Read the relevant files before editing; port regression tests alongside behavior changes.
- Keep scope cuts explicit. Passing tests are not proof that an entire upstream module or milestone is complete.
- Use offline mock/faux-provider tests. Do not use real credentials or paid model calls during validation.
- Gates: `cargo fmt --all -- --check`, `cargo clippy --offline --all-targets -- -D warnings`, `cargo test --offline --all-targets`, and doc tests when relevant.
- Preserve full command output under `docs/migration/validation/`; summarize it in the work log. No unsafe Rust.
