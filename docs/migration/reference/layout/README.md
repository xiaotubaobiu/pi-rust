# Viewport layout / ScrollView / Kitty actual-source oracle

Authority: read-only pi HEAD `5901446094988aa5cd8e11efdaa131c3949106f1`.
This runs the actual upstream modules, not a reimplemented layout/compositor,
Container, ScrollView, Text, scrollbar or image-cropping reference.

## Reproduction (Rust repository root)
```powershell
& C:/Users/13063/anaconda3/node.exe docs/migration/reference/layout/run.mjs
& C:/Users/13063/anaconda3/python.exe docs/migration/tools/verify_layout_oracle.py --previous ../.migration-handoff/checkpoint-2026-09-24-stack-direct
cargo test --offline --lib tui::tests::layout:: -- --nocapture
```

- Node v25.8.2 native TypeScript stripping, offline get-east-asian-width1.6.0.
  No marked, network, credentials or OS terminal.
- Bootstrap copies12 complete source modules plus the actual layout.test.ts to
  target/layout-oracle and first executes all15 native upstream tests, including
  the real async scrollbar timer test and billion-line sparse scroll test.
- Fixture generation uses virtual setTimeout/clearTimeout plumbing solely for
  deterministic clock advancement. ScrollView's timer logic itself is unchanged.
  Render leaves record calls; actual Text is used wherever the input says text.
- The fixture and source-manifest are installed once after oracle generation;
  reproduction writes scratch only. The read-only verifier byte-compares both,
  checks sizes/counts/hashes, generator and12 source/1 test hashes, plus optional
  previous fixture prefixes. No expected output is derived from Rust.

## Coverage
- 346 layout cases,1289 operation steps. Original342 cases/1285 steps retained
  exactly when4 offscreen carried-image cases were appended.
- Cases include12 shapes×4 widths×3 heights,12 alignment scenarios,18 lifecycle
  sequences,background/reset/runtime resize,billion-line sparse transcripts,
  timer numeric edges,proportional thumbs,128 deterministic nested trees,24 image
  scroll cases and4 offscreen-image array-growth cases.
- Exact frame lines (including missing/null array slots),rect/clip/parent trees,
  line offsets,rendered source lines,scroll-content lines,primary selection,
  visible/hidden-auto geometry,all sampled visual/scroll hit paths,old-frame live
  geometry,scroll states and render/visible/style/requestRender trace compared.
- 108 Kitty cases:18 ASCII-base64 encodings across chunk boundaries and90 crops.
- Six Rust test functions:layout differential,Kitty differential,native timer,
  deterministic timer cancellation/drop/reentrant callback,distinct zero-sized
  component identities,and1000-entry metadata eviction/generation. These counts
  are corpus cases,not thousands of new Rust test functions.

## Rust API and compatibility boundaries
- Component gains default sparse-capable render_layout_lines,mutable
  layout_node_mut and optional layout_cache_id; existing Vec render remains.
- LayoutFrame uses an owned arena (indices for parent/children) and original
  component paths. No unsafe/raw component pointer keys. Shared leaf adapters
  can explicitly share ComponentCacheId; distinct ZST components do not collide.
  Path IDs are frame/tree-local,not persistent handles after structural edits.
  Arbitrary JS object aliasing of mutable containers/direct children mutation
  or live mutable JS node references are not promised by Box ownership.
- RenderedLines is immutable Dense/Sparse,used for sources and frame output.
  Paint and backward image lookup avoid scanning absent billion-line rows.
  Upstream's surprising offscreen carried-image assignment can extend returned
  screen lines beyond the viewport and leave holes; these are preserved,not
  silently clipped/padded away. The final terminal screen clamp is separate.
- ScrollHandle is live shared state; geometry sees later changes even on an old
  frame. Follow suppression,unused deltas,callbacks,style hooks,reserved/overlay
  scrollbar toggles and timer expiry/cancellation are implemented. Number-based
  scroll methods truncate finite inputs and preserve upstream nonfinite rules;
  legacy usize/i64 convenience methods remain.
- The default timer uses weak state ownership and generation cancellation on
  worker threads. It is functional without host polling,not Node's single-thread
  event loop:cross-thread ordering/concurrent rendering,thread-per-activity
  resource cost and arbitrary reentrant user callbacks remain host-integration
  concerns. Hosts can inject an event-loop scheduler; fixtures use a manual one.
- Component strings remain UTF-8; dimensions/metadata are representable integer
  cells/pixels. Arbitrary JS-number dimensions,raw UTF-16 boundary,invalid sparse
  cursor-search exceptions,resource-exhausting dense/direct-stack renders and
  arbitrary callback/tree mutation are not exhaustive compatibility claims.
- Kitty scope is ASCII-base64 encode,bounded registry,crop. Pixel/image loading,
  placement/retransmission caches,deletion,iTerm2 and OS negotiation remain open.
- This is viewport-core evidence,not full TUI/OS mouse/focus/main-screen wiring.

## Evidence
- Initial actual upstream execution and corpus:
  validation/2026-09-24-1551-layout-oracle-initial.log.
- First compile/check:validation/2026-09-24-1600-layout-first-compile.log.
- Initial342 differential cases and six tests pass:
  validation/2026-09-24-1604-layout-first-differential.log.
- Four actual offscreen-image behaviors and exact old-prefix protection:
  validation/2026-09-24-1607-layout-offscreen-oracle.log and
  validation/2026-09-24-1606-layout-offscreen-prefix-audit.log.
- Final346 focused and strict Clippy:
  validation/2026-09-24-1606-layout-focused-clippy.log.
- Final whole-project gates/reproduction/checkpoint are recorded in HANDOFF and
  WORK_LOG; source-manifest contains authoritative artifact hashes/counts.

## Final checkpoint evidence (2026-09-24T16:20:19+09:00)

2026-09-24 16:09:46–16:11:00 +09:00: all four strict gates PASS. `cargo fmt --all -- --check` and `cargo clippy --offline --all-targets -- -D warnings` exit0; all-targets **2384 passed = 2348 lib +27 generate-models +9 pirs,0 failed,2 historical CJK ignored**; doctests **5 passed,0 failed,1 historical ignored**. Full output:`validation/2026-09-24-1610-layout-full-gates.log`. This is the whole-project total,not2384 new tests; the viewport slice adds6 Rust test functions. At16:14:39–16:15:44 all16 artifacts (2 Layout+2 Stack+7 Markdown+5 LaTeX) reproduce byte-identically; all15 actual upstream layout tests pass,12 layout source+1 upstream test hashes are verified. The30 independent ANSI-width probes match the previous checkpoint. Logs:`validation/2026-09-24-1615-layout-oracle-repro.log` and `2026-09-24-1617-layout-protection-audit.log` (actual audit16:16:33).

Fixture8,663,022 bytes SHA-256 `d8cce79f73622e928bfcf7c31dfdae396c141ef36389a24296a3e377e69da57e`;source-manifest1,913 bytes SHA-256 `4eb93e35859f93dd981abab6f6c4a2a738bd1fd7c216cbd0166c47c7a6006de5`.
Protection audit verifies all376 previous files,153 unrelated inherited source/build files,empty Git index and append-only WORK_LOG. Immutable checkpoint `checkpoint-2026-09-24-layout-viewport`,previous `checkpoint-2026-09-24-stack-direct`; exact snapshot count/hash are stored externally in manifest/verification. This does not mark M4 complete.
