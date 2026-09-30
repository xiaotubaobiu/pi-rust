# TUI (packages/tui) port compatibility ledger

Upstream: `590144609`, `packages/tui` (42 source files, 18,114 lines; tests 18,647 lines).
Rust target: `src/tui`. This is a scope ledger, not a completion claim.

Current mouse/focus/selection API status: real Component/layout/ScrollView/Gesture/Overlay/Focus/Selection/paint/clipboard/flash/indicator and search index are retained; AltScreenSearchComponent now drives real Input with focus, query callbacks, navigation hover/hit geometry and style callbacks. Shared VS16 width corrected. Full TuiAltScreen search host/eventloop/native suite integration remains incomplete. PAUSE_REQUESTED after this validated slice; no next implementation without explicit resume.


## Slices ported (resumed checkpoint 2026-09-24; limitations explicit)

| Upstream surface | Rust source | Evidence / limitations |
|---|---|---|
| `src/terminal-colors.ts` | `src/tui/terminal_colors.rs` | `parse_osc11_background_color` (hex + 16-bit rgb), `parse_terminal_color_scheme_report`, `is_osc11_background_color_response`. Upstream describe blocks ported 1:1; the TUI-integration cases (OSC 11 query round-trip) wait for the renderer core. |
| `src/utils.ts` | `src/tui/utils.rs` | `visible_width`, `strip_terminal_sequences`, `extract_ansi_code`, `get_grapheme_cell_range`, `get_osc8_link_at_column`, `normalize_terminal_output`, `truncate_to_width`, `slice_by_column`/`slice_with_width`, `wrap_text_with_ansi`, `apply_background_to_line`, `get_active_background_ansi`, `extract_segments`, `AnsiCodeTracker`, `is_whitespace_char`, `is_punctuation_char`. |
| `get-east-asian-width@1.6.0` (npm) | `src/tui/utils/east_asian_width.rs` | Generated range tables (fullwidth/wide) ported from the package's `lookup-data.js`; `eastAsianWidth(cp)` default-options semantics (F/W = 2, else 1). |
| JS `\p{Spacing_Mark}` | `src/tui/utils/spacing_mark.rs` | Generated exact code-point ranges captured from the generating Node's `\p{Spacing_Mark}` property. ICU4X 2.3.0's `GraphemeClusterBreak` enumerated data disagrees with the UCD here (e.g. U+09BE reports `Extend` instead of `SpacingMark`), so the ICU route was rejected. The three regex exceptions (U+1734, U+302E, U+302F) and the explicit legacy-wcwidth additions remain in `is_terminal_spacing_mark_char`. |
| JS `\p{RGI_Emoji}` | `src/tui/utils/rgi_emoji.rs` | Generated sequence table (3,331 sequences) enumerated from the actual `\p{RGI_Emoji}` regex of the generating Node build (v25.8.2), including ZWJ grammar seeds (family couples, handshake, kiss) needed because RGI prefixes are not always themselves RGI. Sorted by code points so Rust `binary_search` applies directly. |
| `src/stdin-buffer.ts` | `src/tui/stdin_buffer.rs` | Full port: sequence-completion classes (CSI/OSC/DCS/APC/SS3/old-style mouse), bracketed paste, Kitty press-echo dedup, WezTerm ESC+ESC+CSI split. Substitutions: EventEmitter + setTimeout become returned `StdinEvent`s with a `flush_after_ms` hint and explicit `flush_emit()`; process(Buffer) high-byte rule is `process_bytes`. Whole stdin-buffer.test.ts ported (32 tests). |
| `src/keys.ts` | `src/tui/keys.rs` | `matches_key`, `parse_key`, `decode_kitty_printable`, `decode_printable_key`, `is_key_release`, `is_key_repeat`, Kitty protocol state (AtomicBool), legacy/SS3/rxvt tables, xterm modifyOtherKeys, CSI-u with alternate keys/event types, Windows Terminal raw-0x08 heuristic via `WT_SESSION`/`SSH_*` env. |
| `src/terminal.ts` (pure + state machine) | `src/tui/terminal.rs` | `parse_keyboard_protocol_negotiation_sequence`, prefix check, `resolve_escape_timeout_ms` (PI_TUI_ESC_TIMEOUT/SSH), Shift+Enter normalizers, `Terminal` trait, `MemoryTerminal` (test double), `TerminalCore` — Kitty/DA negotiation with fragment buffering (150ms hint), modifyOtherKeys fallback, StdinBuffer wiring, paste re-wrap, drain/stop teardown writes; negotiation describes of terminal.test.ts ported (17 tests). OS shell (raw mode, resize, Windows VT input, SIGWINCH refresh) NOT ported — needs unsafe FFI or a new dependency; joins M5 CLI integration. |
| `src/keybindings.ts` | `src/tui/keybindings.rs` | KeybindingsManager (ordered rebuild, user overrides without default eviction, conflicts), TUI_KEYBINDINGS in insertion order, global accessor; declaration-merging typing is a TS feature (ids are strings). keybindings.test.ts ported (7). |
| `src/fuzzy.ts` | `src/tui/fuzzy.rs` | fuzzyMatch scoring (f64, char indices), swapped alpha-numeric tokens, fuzzyFilter token sorting (stable). fuzzy.test.ts ported (14). |
| `src/word-navigation.ts`, `src/kill-ring.ts`, `src/undo-stack.ts` | `src/tui/word_navigation.rs`, `src/tui/undo_stack.rs` | findWordBackward/Forward with punctuation-run and in-word punctuation logic; KillRing; UndoStack. Substitutions: word segmentation via unicode-segmentation (UAX #29) — ICU's CJK dictionary breaking is not available, so CJK parity goes through the upstream `segment` option escape hatch (default path treats a Han run as one segment); cursors are byte offsets. word-navigation.test.ts ported (19) with the CJK case on the explicit segmenter. |
| `src/tui.ts` (lines 21-168: Component/Focusable/CURSOR_MARKER/mouse types) | `src/tui/component.rs` | Trait-based Component (`render(&mut)`), mouse-event vocabulary with render-request defaults, CURSOR_MARKER. The TUI class is a later slice. |
| `src/tui.ts` dispatch/retarget + TuiAltScreen mouse helpers | `src/tui/mouse_dispatch.rs`, signed/numeric `component.rs` event | 8 tests/4390 actual-source entries; generic stable-handle contract, nested forwarding, saved geometry, click count and render decision; live registry/Container/layout routing/full gestures/focus/OS not integrated. SelectList zero/NaN wheel truthiness corrected. |
| `src/components/text.ts` | `src/tui/components/text.rs` | Wrap + padding + background painter + cache. Basic pinning tests (no dedicated upstream file). |
| `src/components/input.ts` | `src/tui/components/input.rs` | Full port: grapheme cursor ops, kill ring, undo coalescing, bracketed paste, Kitty printable decode, horizontal scroll, mouse cursor placement, placeholder styling. input.test.ts ported (37 tests, 2 `#[ignore]`: ICU CJK dictionary breaking unavailable — documented). |
| `runtime/lane.test.ts` (12 acceptance cases) | `src/agent_core/harness/runtime/tests/lane.rs` | All 12 pass against the rescued Lane: config replace/queue-derive, pending-value line release, expected rejection, bounded reads + commit metadata, sync materialize, event-failure memory preservation, seal-vs-admitted commit, memory-after-durable-commit, commit-failure preservation, settle-vs-cancelled-control, queued planner freshness. `ControlledMemoryStorage` reproduces upstream `beforeNextCommit` gates. |
| `src/components/editor.ts` (core editing) | `src/tui/components/editor.rs` | EditorState/Snapshot undo (incl. paste registry), paste-marker atomic segmentation + renumbering, wordWrapLine with CJK breaks, grapheme cursor ops, delete/kill/yank variants, history with draft, character jump, page scroll, sticky-column vertical nav with atomic snapping, scroll borders, submit with marker expansion. NOT yet: autocomplete (select-list/autocomplete.ts) and TUI constructor integration (injectable closures instead). editor.test.ts core describes ported (70 tests); autocomplete + remaining widget cases join with the select-list slice. |
| `tui-main-screen.ts` doRender (differential frame planning) | `src/tui/renderer.rs` | First-render/no-change/partial-range/appends/width-height-full-clear/clear-on-shrink decisions as a testable WriteOp frame plan (8 tests). Hardware cursor, Kitty image reservations and the OS write sink join the ProcessTerminal slice. |
| `tui-alt-screen.ts` doRender + enter/exit | `src/tui/alt_screen.rs` | Fixed-height viewport row-diff planner (changed rows repaint in place, full clear on first/resize, sync markers, cursor positioning show/hide, tail clamp) plus the enter/exit sequences. 7 tests. Kitty/ITerm2 images, search highlight, flash and selection overlays join their component slices. |
| `tui.ts` TuiBase input dispatch/focus (handleTerminalInput + Container) | `src/tui/screen.rs` | Listener chain (consume/rewrite), key-release filtering with wantsKeyRelease opt-in, index-based focus routing with focused flags, container render concat, pollable render-request. 7 tests. Overlay focus-restore state machine joins the overlay slice. |
| `src/components/scroll-view.ts` | `src/tui/components/scroll_view.rs` | Live ScrollHandle state,follow suppression/remainder,numeric scroll rules,runtime scrollbar/styles/render callback,injectable scheduler+working asynchronous timer. Included in346 viewport cases/1289 steps and timer tests. Former host-polled flag/full-port claim superseded; default worker-thread timer is not Node event-loop/host scheduling parity. |
| `src/components/settings-list.ts` | `src/tui/components/settings_list.rs` | SettingsList port: selection wrap, value cycling + onChange, search (Input+fuzzy), description wrap, hints; submenu component delegation points provided. Widget tests ported (11 combined). |
| `src/components/box.ts` / `spacer.ts` / `truncated-text.ts` | `src/tui/components/layout_widgets.rs` | Box (padding+background+child passthrough/clear), Spacer, TruncatedText (newline stop + width truncation + full-width padding). 4 pinning tests. Standalone Stack allocation/render now has a separate row below; viewport core has a separate row below; full host integration remains pending. |
| `src/components/stack.ts`, `h-stack.ts`, `v-stack.ts`; `tui.ts` compositeTuiLine | `src/tui/components/stack.rs`, `src/tui/overlay.rs` |5 differential tests:4169 allocations,49 normalizations,952 direct render/trace cases,2691 byte-exact composites,48 lifecycle sequences×20 steps. Ordered grow/shrink,alignment/visibility/nesting/stateful render/invalidation/add-remove-clear. Shared compositor resets SGR/OSC8 and pads exact total width. Standalone behavior differs from viewport measurement. Box/index identity does not reproduce arbitrary JS alias/mutation. Mutable trait discovery and viewport core are now covered separately below; full mouse/host integration remains pending. |
| `src/layout.ts`, `layout-node.ts` | `src/tui/layout.rs`, `layout_node.rs`, `rendered_lines.rs` | Actual-source346 cases/1289 steps:frame identity+width cache,mutable discovery,arena rect/clip/path,measure/layout/paint,cursor/scroll,OSC133 zones,image crop,scrollbar and hit helpers. Dense/Sparse preserves billion-line storage and offscreen image holes. ComponentPath safe routing to live host/alt-screen is not yet integrated. |
| `src/tui-alt-screen.ts` wheel/scrollbar helpers | `src/tui/viewport_mouse.rs` | Signed raw UTF-16 SGR/X10,normalization/Alt,wheel chain/primary fallback,hover/track/drag over live frame;4 tests,1800+99+145 scenarios/6692 steps.20 complete-source oracle;native alt-screen tests NOT run. Does not integrate component dispatch/focus/selection/OS. |
| `src/components/select-list.ts` | `src/tui/components/select_list.rs` | Full SelectList port; select-list.test.ts ported (5 tests). |
| `src/autocomplete.ts` | `src/tui/autocomplete.rs` | Provider trait (synchronous — async/AbortSignal/debounce is a Node-event-loop guard, disclosed), CombinedAutocompleteProvider slash filtering + applyCompletion slash/attachment/path forms + filesystem suggestions; fd(1) fuzzy search reserved (unused `fd_path`). autocomplete.test.ts provider core cases ported (4) + editor integration (3). |

| `src/components/markdown.ts` | `src/tui/components/markdown.rs` |16 component tests plus1 lexer test:94 original,2880 raw/encoded,3702 source/1234 seeds,2688 raw-source,48 internal-tail tokens. Real UTF-16 lines/styles/layout/cache. Pending-LaTeX/link-href internal tails retained. Source/transform/highlight still UTF-8; not full marked or whole-TUI equivalence. |
| `marked@18.0.5` lexer (substitute for upstream pin18.0.11) | `src/tui/markdown_lexer.rs` | UTF-16 masking/delimiter/raw cuts; reference case/global punctuation cursor retained. Raw/text/href unit overrides; private prefix+high-tail representation and default-compatible tail-aware hook. Old corpus prefixes unchanged; arbitrary raw-source/unknown hooks/full grammar/pinned-version parity remain unproven. |
| `src/latex.ts` | `src/tui/latex.rs` | Parser/layout engine and 15 source-derived tables ported: symbols/scripts, fractions/roots/accents, operators/limits, equation/alignment/cases/matrices and baseline-aware composition. Real Vec<u16> representation and raw public API. Seven Rust tests cover 2763 original fixtures (all 149 assertions/111 original blocks), all 22 original UTF-16 regressions, 3278 raw render and 12415 raw width cases; overlapping corpora, not unique-input totals. Markdown now consumes the raw API through its own layout; broader Component/OS boundaries remain UTF-8. No all-None stub or Markdown skip whitelist remains. |
| `src/terminal-image.ts` subset | `src/tui/terminal_image.rs`, `terminal_image/kitty.rs` | OSC8 links,image detection,explicit capability cache plus ASCII-base64 Kitty encode (4096 chunks),bounded1000 registry/generation and y/h/r crop.108 differential cases plus registry test. Pixel/image loading,placement/cache/deletion,iTerm2,image component and full capability negotiation remain open. |

All generated files carry `@generated` headers with the source SHA-256 and are
reproducible via `docs/migration/reference/generate-tui-width-tables.mjs`
(offline: npm-cache tarballs unpacked read-only under
`.migration-handoff/reference-deps/`; upstream `utils.ts` is copied to a
scratch dir with `node_modules/get-east-asian-width` so the bare import
resolves without touching the read-only `pi` checkout; the copy is
SHA-256-checked before use).

## Differential oracles

`src/tui/fixtures/width-oracles.json` — expected values produced by running the
ACTUAL upstream `utils.ts` under Node 25.8.2:

- `visibleWidth`: **128,360 cases** — full code-point sweep 0x0000–0x32000
  (surrogates and private-use excluded on both sides: Rust strings cannot hold
  lone surrogates) plus astral samples (tags, variation selectors, plane-4+)
  and every RGI sequence.
- `wrap` / `truncate` / `slice` / `extractSegments` / `cellRange` / `osc8` /
  `normalize` / `strip` / `activeBg`: curated cases including every upstream
  unit-test scenario plus ANSI/OSC-8/tabs/wide-grapheme combinations;
  byte-exact comparisons.
- One test function sweeps all `visibleWidth` cases; per-function tests cover
  the rest.

## Ported upstream tests

- `test/terminal-colors.test.ts` pure-function describes → `src/tui/tests/terminal_colors.rs`.
- `test/truncate-to-width.test.ts`, `test/wrap-ansi.test.ts`, pure-function
  parts of `test/tab-width.test.ts` → `src/tui/tests/utils.rs`.
- `test/keys.test.ts` (all describes; the three raw-0x08 environment scenarios
  serialized into one test because they mutate process env) → `src/tui/tests/keys.rs`.

## Deliberate substitutions

- Most public text/component APIs remain UTF-8 with byte offsets on char
  boundaries; scalar ANSI scanning matches ASCII delimiters. LaTeX and Markdown
  rendered-line pipelines now retain actual UTF-16 units, including lone
  surrogates, with public lossless result APIs. Markdown style callbacks use
  Utf16Text; source/transform/highlight hooks and Component still use UTF-8.
  The upstream UTF-16 length
  expressions are reproduced exactly where they matter: `couldBeEmoji`'s
  `segment.length > 2` uses UTF-16 units; the terminal-spacing-mark branch
  returns `[...segment].length`, which counts CODE POINTS (verified by the
  sweep: astral spacing marks are width 1).
- `Intl.Segmenter` grapheme segmentation → `unicode-segmentation` 1.13.3
  (UAX #29); v-flag Unicode properties → ICU4X 2.3.0 (`GeneralCategory`,
  `Default_Ignorable_Code_Point`, `Script_Extensions` via `has_script`) and
  generated tables where ICU data diverges (Spacing_Mark, RGI_Emoji) or the
  upstream dependency ships its own tables (East Asian Width).
- The shared 512-entry `widthCache` is an optimization, not observable
  behavior; not ported.
- JS `String.prototype.trim`/`trimEnd` whitespace (includes U+FEFF, excludes
  U+0085) and `\s` are implemented explicitly.
- Upstream `_lastEventType` is written but never read; not ported. The `Key`
  helper object and the `KeyId` template-literal union are typing sugar over
  strings; Rust callers use the same strings (constants provided in
  `key_names`).
- Editor support files above have been ported in prior slices; default CJK dictionary segmentation remains a disclosed gap (two ignored tests).

## Remaining M4 work (not a completion percentage)

Remaining Markdown source/transform/highlight/Component UTF-16 boundaries,complete capability negotiation,image loading/component/placement/cache/deletion/iTerm2,real OS terminal shell,overlay focus/mouse routing,host consumption of the new viewport arena,loaders,native platform/clipboard,main-screen integration,alt-screen search/selection/image handling and public exports. The viewport core and live ScrollView are now covered separately; worker-thread timers do not establish Node single-event-loop scheduling equivalence. Existing pure renderer/components are not full terminal/interactive parity.

Next concrete independent slice:safe ComponentPath/identity and signed normalized component-mouse dispatch/capture/focus oracle;wheel/scrollbar consumer is now evidenced separately below,full host scheduling remains pending. Do not rewrite the validated Stack allocator/compositor/viewport core. Arbitrary raw-source input,transform/highlighter/Component boundaries and full raw-tag/reference/backtick grammar remain separate work. Neither94 original,2880 rendered-line,3702 source,2688 raw-source nor48 internal-tail token cases constitute the full upstream marked compliance suite.

## Resumed Markdown oracle

`docs/migration/reference/markdown/run.mjs` runs four actual upstream TS sources offline, stores input hashes and uses marked 18.0.5/chalk 5.6.2/get-east-asian-width 1.6.0. Original 82 fixtures regenerated byte-identically; 12 added focused regressions make 94. Four upstream literal assertions pass. Separate corpora add2880 Markdown raw-unit/encoded-output cases,2152 direct raw-wrap cases and3702 source/lexer cases (1234 seeds × three configurations),2688 raw-source cases (28 seeds × six contexts × four widths × four styles) and48 internal-tail token cases; the original94 fixture bytes remain unchanged. New manifest records generator/artifact hashes and counts plus dependency versions. Exact marked 18.0.11 is still unavailable in the supplied offline cache; no exact-version parity claim. See README and retained licenses in that directory.

## Historical validation (2026-09-24 09:30 +09:00; not resumed WIP)

- `cargo fmt --all -- --check`: pass.
- `cargo clippy --offline --all-targets -- -D warnings`: pass.
- `cargo test --offline --all-targets`: **2306 lib + 27 generate-models + 9 pirs = 2342 passed, 0 failed, 2 ignored** (baseline 2012 lib before this session: +294 lib test functions; the 2 ignored are the documented CJK-dictionary word-boundary cases). Includes the 12/12 runtime Lane acceptance cases, the text/input/editor components with autocomplete integration, and the fix of a command-deadlocking double-lock in the rescued lane.rs.
- `cargo test --offline --doc`: 5 passed (4 compile-fail guards + the new
  `LaneCommand` synchronous-materialize doctest), 1 historical ignored.
- Log: `docs/migration/validation/2026-09-24-layoutwidgets-gates.log` (prior slice: `2026-09-24-tui-slice1-gates.log`).
- The differential sweep also ran standalone during development
  (`target/tui-standalone`, git-ignored scratch crate) — same results.

## Resumed verification

2026-09-24 15:27:43–15:29:14 +09:00: all four strict gates PASS. `cargo fmt --all -- --check` and `cargo clippy --offline --all-targets -- -D warnings` exit0; all-targets **2378 passed = 2342 lib +27 generate-models +9 pirs,0 failed,2 historical CJK ignored**; doctests **5 passed,0 failed,1 historical ignored**. Full output:`validation/2026-09-24-152743-stack-direct-full-gates.log`. This is the whole-project total, not2378 new tests; this slice adds5 test functions. Stack corpus:4169 allocations,49 normalizations,952 direct renders with exact render/visible/invalidate traces,2691 composites and48 mutable lifecycles×20 steps. At15:29:10–15:29:13 all14 artifacts (2 Stack+7 Markdown+5 LaTeX) reproduce byte-identically; 9 Stack source hashes verified;30 independent ANSI-width probes reproduce. Log:`validation/2026-09-24-152910-stack-oracle-repro.log`. Markdown/LaTeX implementation and all12 existing reference artifacts remain byte-identical to the previous checkpoint; no Cargo/dependency/marked version change. Standalone Stack rendering is not the viewport layout engine.

## LaTeX oracle / UTF-16 boundary (2026-09-24 continuation)

`reference/latex/run.mjs` executes read-only upstream code, checks all original literal assertions, and extracts tables. Node v25.8.2 + get-east-asian-width 1.6.0; no marked substitution in this independent oracle. All five output artifacts are byte-reproducible (14:14:58–14:15:00 combined oracle log above). `reference/latex/README.md` records runtime, commands, hashes, licensing and scope.

JS splits unbraced astral operands into lone UTF-16 surrogates. The Rust parser/layout now retains actual units throughout, and `render_latex_utf16` returns them. `render_latex` shares that implementation and encodes lossily only at its public UTF-8 return boundary. All 22 historical cases match both raw units and encoded strings; no expectation normalization, private-use sentinel or special-case patch. Width segmentation uses a temporary replacement view with a raw-point mapping; rendered content retains original units. Grapheme-break, Indic-conjunct and ExtendedPictographic property equivalence is checked separately from width semantics.

## Markdown raw-unit integration (2026-09-24 13:06 +09:00)

The earlier risk is now an observed red regression and a verified fix. For
`$\sqrt😀$` at width1, early UTF-8 conversion yielded five encoded lines
`["√", "(", "�", ")", "�"]` rather than upstream's three
`["√", "(�", ")�"]`. The red log is
`validation/2026-09-24-123958-markdown-utf16-red.log`.

- `Utf16Text` retains real units, has no Display implementation, and explicitly
  exposes checked/lossy encoding. Raw helper operations and wrap/ANSI trackers
  do not substitute private-use sentinels. OSC8 params/URLs stay raw, including
  malformed units. A mapped segmentation view never becomes output storage.
- `Markdown::render_utf16` retains units through inline/block rendering,
  quotes/lists/tables, wrapping, padding/background and cache. Existing render
  performs lossy UTF-8 encoding only after Markdown layout. No claim about
  every other TUI component or the OS terminal boundary follows from this.
- Deliberate public Rust API change: Markdown StyleFn now takes &Utf16Text and
  returns Utf16Text. Theme/default-style callbacks receive actual units;
  unitCount and reverseUnits oracle styles independently exercise inspection
  and transformation. Other components' distinct style aliases are unchanged.
- Fixed an existing table bug: implicit default styling must not be restored
  as if it were an explicitly supplied enclosing table-cell styleContext.
  Also corrected raw wrap trim to reuse the exact JS whitespace predicate,
  including ASCII tab and U+FEFF (not only Unicode separator categories).
- Two new helper tests, one raw-wrap test and three Markdown tests add six Rust
  test functions.2880 Markdown fixture rows cover six formulas,10 contexts,
  eight widths and six styles, with padding/background/OSC8 and raw-width/cache
  assertions.2152 direct utility rows cover malformed units,ANSI/OSC URLs,
  JS trim,newlines,CJK/private-use and deterministic compositions.

Still pending: malformed raw source inputs, source transform/highlighter raw
interfaces, arbitrary callback invocation order and the wider marked/lexer
compliance surface. Expected output always comes from actual upstream, never
from the Rust implementation. All earlier failures and corrected gate runs
remain in WORK_LOG/validation; no pending whitelist or expectation rewrite.

## Markdown source/lexer slice (2026-09-24 13:48 +09:00)

- Corpus grew235→548→560 seeds (705→1644→1680 cases), always retaining the preceding expectations. Three configurations per seed:width12/plain/no OSC8;40/grayItalic/no OSC8;24/plain/OSC8. Expected final strings are upstream Node Buffer UTF-8 encoding of rendered lines.
- Initial red:209 mismatches across81 seeds; expanded red:115 mismatches plus21 per-case panics across54 seeds; final quoted-attribute audit:24 mismatches across8 seeds. The failures were fixed, not excluded. Logs and exact source paths are in WORK_LOG.
- Blank paragraph continuation/raw token consumption, reference label normalization/offsets, angle destinations/title grammar, HTML blank-line/case/EOF/attribute matching, Unicode-safe URL slicing, JS whitespace/dot behavior, pending math and shell-variable guard were corrected against actual sources.
- Module docs now distinguish hand scanners from the two title regexes. No new Cargo dependency, raw source API, whole-marked compliance claim or LaTeX source edit.
- Added a read-only ten-artifact verification tool with historical comparison to avoid hand-written path mappings. Full gates and all ten artifacts pass; unchanged original corpora and marked18.0.5 substitution remain explicit.

## Markdown link-source units / masking slice (2026-09-24T14:21:44+09:00)

- Source corpus560→768→846 seeds,1680→2304→2538 cases; preceding case objects unchanged. First expansion added120 link-cut,40 reference-mask and48 raw-tag-context seeds; second added78 Unicode-mask/edge seeds.
- Red1:216 caught per-case panics plus60 output mismatches (276 cases/92 seeds). Inline link raw cuts now use UTF-16 lengths. Real raw/text token-unit overrides preserve the high/low halves without flooring the cut or replacing text before layout. Continuation text merges preserve exact units; JS prevChar retains its final unit.
- Literal case-sensitive reference masking now matches Lexer.ts, while link resolution still uses normalized lowercase labels. Red2:18 differences from adjacent escaped astral punctuation. Preserve global regex lastIndex at the old UTF-16 match end after the replacement changes length.
- Added1152 raw-source cases (12 seeds × six contexts × widths1/2/12/40 × four styles); exact units/widths/UTF-8/cache/invalidate and raw-token source reconstruction checked. Only one Rust test function added; previous Markdown15→16, whole-project2369→2370.
- Four full gates and six Markdown/five LaTeX artifact reproduction pass; inherited corpora/prefixes unchanged. No Cargo or LaTeX source edits. Full evidence and next mixed-coordinate masking audit remain explicitly scoped above.

## Markdown mask/emphasis coordinates and raw-width normalization (2026-09-24T14:59:28+09:00)

- Source2538→3654→3702 cases (846→1234 final seeds); raw-source1152→2688 (28×6×4×4); new48 internal-tail token cases from actual marked. All prior prefixes and original artifacts retained.
- Red909 output differences/303 seeds came from byte-length Unicode masks after closing emphasis delimiters. Masks/cursors, source slicing and delimiter scan now use UTF-16 units; pair decoding only classifies Unicode atoms. Lone units are not classified as U+FFFD.
- Upstream emphasis can cut a high unit into recursive text/raw boundaries. Private valid-prefix+high-tail representation preserves it; low continuation text remains exact. Pending LaTeX and URL/backpedal/href/styles preserve these units. New hook defaults to old UTF-8 API; unknown extensions/raw-source are not universally compatible.
- Raw-source all-case red uncovered30 width/table differences. Strip ANSI on raw units before decoding to re-form adjacent pairs; share the recognizer with raw wrap. Tabs expand before the one-pass strip, and segmentation never strips a second time.30 actual-upstream width checks cover pairs/CSI/OSC/APC/tabs/newly formed ESC sequences. Two utility test functions added.
- Full gates 2026-09-24-145723-markdown-mask-coordinates-full-gates.log:2373 pass (2337+27+9),0 fail,2 historical CJK ignored;5 doctests pass/1 historical ignored. Seven Markdown +five LaTeX artifacts and30 independent width probes reproduce;8 old artifacts and2538/1152 prefixes unchanged. No Cargo/dependency/LaTeX source changes.
- Next independent slice: missing stack/h-stack flex allocation. Remaining source/hook/Component raw boundaries and terminal/image/mouse/OS/main-screen/M5/M6 gaps are still explicit.

## Stack direct rendering and shared line compositing (2026-09-24T15:33:59+09:00)

- Actual-source oracle uses9 complete upstream modules, Node25.8.2 and get-east-asian-width1.6.0 only; no Container/compositor stand-in or marked dependency. See reference/stack/README.md and source-manifest.json.
- Corpus:4169 allocator cases (4096 seeded+3 explicit+70 number edges),49 constructor normalizations,952 direct render scenarios (17×2 directions×4 aligns×7 widths),2691 compositing cases,48 lifecycle sequences×20 actions. Five Rust test functions compare exact lines and callback order/arguments,not just display width.
- Initial2691 compositor byte differences fixed with upstream resets/padding/image bypass/slice widths. Three old smoke expectations were corrected to the actual oracle's first3 cases,without changing oracle bytes.
- HStack directly measures all visible children,then renders nonzero allocated widths; fixed-basis viewport measurement intentionally differs. VStack direct render has no available height. Allocation is the upstream ordered remainder algorithm,not CSS flexbox.
- Limitations: Component remains UTF-8/usize widths; unsupported non-finite/huge render dimensions; Box-owned children/index deletion,not arbitrary JS identity aliases/direct children mutation/live mutable node references. Concrete borrowed metadata only; trait-object discovery,mouse routing,viewport cache/scroll/clipping/image integration pending.
- Whole-project2378 pass,0 fail,2 historical ignored;5 doctests pass/1 historical ignored. All14 generated artifacts reproduce; prior Markdown/LaTeX implementation/12 artifacts unchanged. New checkpoint stack-direct,previous markdown-mask-coordinates; no Cargo/dependency edits.

## Viewport layout,live scroll and Kitty crop (2026-09-24T16:20:19+09:00)

- Prior Stack-only section above is historical: Component now exposes mutable layout discovery and optional cache ID. Owned frame arena IDs are not component identities; root need not be0; component paths retain hidden-child indexes. RenderedLines Dense/Sparse preserves holes without billion-line allocation/scanning.
- Actual12 complete upstream modules+layout.test.ts run offline;15 upstream tests pass (including native timer and sparse billion lines).346 layout cases/1289 steps compare exact lines/holes,rect/clip/parent/path,lineOffset/content,scrollbar/hit geometry,live old frames and callback traces.108 Kitty cases cover18 encode and90 crop. Six new Rust test functions; no skipped fixture cases.
- Four later offscreen carried-image cases preserve source behavior that can extend frame.lines past viewport height and leave holes. Original342 cases/1285 steps and all108 Kitty preserved. Do not silently clip/fill this behavior at layout level.
- Component仍UTF-8，尺寸/坐标限可表示的整数；任意JS number/非有限尺寸、原始UTF-16、JS重复object/container外部变更、无效sparse cursor-search异常及资源耗尽输入不宣称完全等价。默认scrollbar timer是worker线程+weak state+generation cancellation，不是Node单线程event loop；跨线程顺序/并发render、每次activity一个线程及任意重入callback仍需host整合。Kitty仅ASCII-base64 encode/1000项registry/crop；像素加载、placement/retransmission/deletion、iTerm2和完整capability probing未做。
- 2026-09-24 16:09:46–16:11:00 +09:00: all four strict gates PASS. `cargo fmt --all -- --check` and `cargo clippy --offline --all-targets -- -D warnings` exit0; all-targets **2384 passed = 2348 lib +27 generate-models +9 pirs,0 failed,2 historical CJK ignored**; doctests **5 passed,0 failed,1 historical ignored**. Full output:`validation/2026-09-24-1610-layout-full-gates.log`. This is the whole-project total,not2384 new tests; the viewport slice adds6 Rust test functions. At16:14:39–16:15:44 all16 artifacts (2 Layout+2 Stack+7 Markdown+5 LaTeX) reproduce byte-identically; all15 actual upstream layout tests pass,12 layout source+1 upstream test hashes are verified. The30 independent ANSI-width probes match the previous checkpoint. Logs:`validation/2026-09-24-1615-layout-oracle-repro.log` and `2026-09-24-1617-layout-protection-audit.log` (actual audit16:16:33).
- Fixture8,663,022 bytes SHA-256 d8cce79f73622e928bfcf7c31dfdae396c141ef36389a24296a3e377e69da57e. Current immutable checkpoint layout-viewport,previous stack-direct. No Cargo/dependency/unrelated source changes; full M4 remains open.

## Viewport wheel/scrollbar consumer (2026-09-24T16:49:41+09:00)
- Uses existing live LayoutFrame/ScrollHandle;no core layout/Stack/scroll implementation changes. Signed raw SGR/X10,normalization,Alt factor5,wheel chain/primary fallback,auto hover/expiry and track/thumb captured dragging.
- Preserve upstream quirk:overscroll contain breaks hit-chain only;unvisited primary still receives remainder. route_wheel called only after overlay/component rejection;has_overlay controls hover lookup,not a global wheel block. It requests render even when no scroll occurs.
- Capture retains live handle across resize/overlay/geometry disappearance/outside screen;release consumes and ends drag. Selection-clear callback runs before hover/scroll callbacks on new capture. Outer hover scheduling remains explicit.
- 1800 parse+99 numeric+145 stateful cases/6692 steps,four Rust test functions;full20 actual-source modules/real TuiAltScreen,inert terminal and controlled runtime seams. Native alt-screen tests read/hashed,NOT executed:offline @xterm/headless absent. No xterm/OS/E2E assertion. Full original corpus prefixes preserved after25 additions.
- Finite safe-integer SGR fields only;larger decimal fields rejected (Rust boundary,not upstream behavior). Legacy TuiMouseEvent unsigned coordinates and safe component path/capture identity still need integration. Focus-out/stop/selection fields/event-loop cleanup are host-owned;no complete component/overlay/search/paste dispatcher here.
- 2026-09-24 16:42:50–16:43:42 +09:00: four strict gates PASS. `cargo fmt --all -- --check`, `cargo clippy --offline --all-targets -- -D warnings` exit0; all-targets **2388 passed = 2352 lib +27 generate-models +9 pirs,0 failed,2 historical CJK ignored**; doctests **5 passed,0 failed,1 historical ignored**. Full output:`validation/2026-09-24-1643-viewport-mouse-full-gates.log`. Whole-project total,not2388 new tests;this slice adds4 test functions.
- At16:44:09–16:45:18 all18 artifacts (2 Mouse+2 Layout+2 Stack+7 Markdown+5 LaTeX) reproduce byte-identically;20 mouse source+3 consulted native-test hashes verified;all15 actual upstream layout tests pass. Native full alt-screen tests were NOT executed (@xterm/headless unavailable offline). New verify_viewport_mouse_oracle.py was actually run. Log:`validation/2026-09-24-1647-viewport-mouse-oracle-repro.log`. At16:46:13–16:46:14 protection audit verified prior398 files/evidence/supplemental,163 unrelated inherited source/build files,HEADs,empty index and old WORK_LOG prefix;30 independent ANSI-width probes unchanged. Log:`validation/2026-09-24-1648-viewport-mouse-protection-audit.log`.
- Fixture SHA2568064e2b06c05345296ad9a1941070471c52e59ea59c926f7d1b6338cc0f8ac78,6,566,877 bytes;manifest f80b25f49d07aad3fe4e3accaab314b48d3230e576488bf00348301275c97440,3,021 bytes. Current checkpoint viewport-mouse,previous layout-viewport;two inherited registration paths only. Full M4 and migration remain open. Earlier dated sections are historical,not current completion claims.

## Component mouse dispatch foundations (2026-09-24T17:17:02+09:00)

- Actual-source oracle copies21 full modules and invokes actual tui.ts dispatchMouseEvent/retargetMouseEvent,TuiAltScreen createMouseEvent/handleMouseEvent/getComponentClickCount/applyMouseDispatchResult,Input and SelectList. Native3 reference-test files are read/hashed,NOT executed;@xterm/headless unavailable offline. Controlled focus seams prove render decisions only,not focus/capture side-effect integration.
- 4390 entries:3096 create+512 raw+158 dispatch(including12 forwarding)+216 retarget+72 render+180 sequential click actions+108 Input+48 SelectList. Eight Rust tests:7 differential groups+1 owning-handle/i64-overflow Rust-domain test (not JS parity claim). Input compares cursor prefixes,not incompatible UTF16/UTF8 indices.
- Signed i64 x/screen_x/screen_y replace old unsigned fields;y was already signed. wheel_delta now Option<f64>,including fraction/NaN/Infinity. Input negative columns clamp;SelectList now rejects0/NaN wheel values per JS truthiness,fixing a pre-existing discrepancy. Event is PartialEq,not Eq.
- dispatch callback exactly once;render-only is not handled;capture/focus imply handled;already dispatched nested results pass through unchanged. retarget keeps saved origin/bounds and metadata. Click tracker500ms inclusive,same identity/cell,1/2/3/1,injected wall clock including backward time. Explicit render=false overrides defaults/focus changes.
- Generic T is a host-supplied stable cloneable handle,NOT automatic identity registry. Paths/indices/unowned addresses are not identity. Owning handles can keep removed targets alive;actual live ComponentPath resolution,Container delegation,visited-identity routing,capture/press/move/release/click/focus/overlay/search/selection/paste/OS loop remain unintegrated. i64 overflow saturation is a safety policy,not JS extreme-number parity;bool flags merge absent/false and cannot retain arbitrary extra JS fields. Prior UTF8/timer/Kitty/marked and host limitations remain.
- 2026-09-24 17:03:39–17:04:30 +09:00：四项严格门禁全部exit0。`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`通过；all-targets **2396 passed = 2360 lib +27 generate-models +9 pirs，0 failed，2项历史CJK ignored**；doctests **5 passed，0 failed，1项历史ignored**。完整输出：`validation/2026-09-24-1710-mouse-dispatch-full-gates.log`。这是全项目总数，本轮新增8个测试函数，不是2396个新测试。
- 17:09:39–17:10:45全部20产物（2 Dispatch+2 Mouse+2 Layout+2 Stack+7 Markdown+5 LaTeX）逐字节复现，前18产物未变；新验证器实际执行，21 dispatch源文件+3参考测试哈希通过；实际layout.test.ts的15个测试通过。完整alt-screen原生终端测试未执行（离线缺@xterm/headless）。30个独立ANSI-width probes与前快照一致。日志：`validation/2026-09-24-1712-mouse-dispatch-oracle-repro.log`。
- 17:12:22–17:12:23保护审计核验前415个归档文件及evidence/supplemental、163个无关继承source/build、原WORK_LOG的117062字节前缀、两个HEAD及空index；历史markdown_debug.rs删除保留，新/变更源码未引入unsafe。日志：`validation/2026-09-24-1714-mouse-dispatch-protection-audit.log`。
- fixture 1,937,126 bytes SHA256 `5e85b83e9e121d42bd11e47c5a55798eb4e41714a8cdbe60f24600b2d7f10fde`；manifest 3,230 bytes SHA256 `6c7b2a3708a83fcb4ca2b4aa504e95f8b0024338c133b3234847a182861def43`。Both initial failures kept:generator newline escape before installing fixtures;JSON0.0-vs-0 test equality fixed only in new serializer,not oracle/expected/production behavior.17:02:44 focused8/8;17:03:21 strictClippy passed.
- Immutable target checkpoint-2026-09-24-mouse-dispatch-foundations,previous viewport-mouse;5 inherited source allow-list in HANDOFF,163 unrelated inherited source/build protected. Full M4 and migration remain open. Next:先做安全live组件身份/registry与ComponentPath解析，再以actual-source oracle验证dispatchMouseToLayout命中顺序/identity去重/跳过layout-node继承Container handler，以及Container嵌套转发/父级focus target。之后组合已验证scrollbar控制器，接入capture/press-point/moved/release/click和focus-out/stop清理。路径不是身份，捕获对象移除后生命期仍须正确；不要重写已验证layout/Stack/wheel或本轮primitive。

## Owning component / Container / layout mouse routing — 2026-09-24T18:00:32+09:00

This dated section supersedes earlier statements that live identity/Container routing are not yet implemented;older sections remain historical,not full host-completion claims.

- 新 `ComponentHandle` / weak handle：Rc<RefCell> owning身份、单调ID、typed共享构造、Box解包/完整hook转发；当前live path包含hidden children。布局box保留实际handle，zero-width也保留；旧frame/saved target不按新路径重找，移除后生命周期和最终释放有测试。
- 新Container：render缓存owning child/height；add/remove/clear/invalidate不清缓存；width mismatch先量测全部当前children且不改旧缓存；只裁剪y，不裁剪x，命中child拒绝也不找后续兄弟；concrete target不变，父input存在时只替换focus target。MouseRegion child-first、decline后fallback，自身不暴露layout node。
- Component companion mouse_action在转发child前释放父RefCell借用；父focus delegation在child callback之后重新读取。Stack/ScrollView interactive children按需安全包装；direct继承Container行为量测全部children/event.width；layout路由按真实盒命中顺序、identity去重，跳过layout-node的继承Container handler但不跳过custom override。旧layout/Stack分配算法及显式render cache ID语义保留。
- Actual-source oracle复制22完整上游模块；实际调用Container/MouseRegion/Stack/ScrollView/layout/TuiAltScreen布局和saved-target派发。77场景/1587步（676+728+70+60+53），五差分测试逐步比对返回值与有序trace；另八个Rust生命周期/borrow/path/cache/sparse边界测试。显式重叠clip/layer是输入，不冒称自然布局。三native测试文件仅读/哈希，完整alt-screen测试未执行。

2026-09-24 17:51:00–17:51:56 +09:00四项门禁全部exit0：`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`、`cargo test --offline --all-targets`、`cargo test --offline --doc`。all-targets **2409 passed = 2373 lib +27 generate-models +9 pirs，0 failed，2历史CJK ignored**；doctests **5 passed，0 failed，1历史ignored**。本轮新增13个函数，不是2409个新测试。日志：`validation/2026-09-24-1752-component-routing-full-gates.log`。

17:53:48–17:54:55：全部22产物（2 ComponentRouting+2 Dispatch+2 Mouse+2 Layout+2 Stack+7 Markdown+5 LaTeX）逐字节复现，旧20产物不变，30 ANSI-width probes一致；实际layout.test.ts的15测试通过。新verifier已实际运行，22源文件+3参考测试哈希核验。完整native alt-screen测试未执行（离线缺@xterm/headless）。日志：`validation/2026-09-24-1756-component-routing-oracle-repro.log`。

17:56:12保护审计通过：前432个归档文件及evidence/supplemental未改；164个allow-list之外继承source/build保留；WORK_LOG前128257字节SHA256 `bc967c8cc03d94504b8b3a6cb349e385928e092a77488dc7abb806c33d4eebe5`完整；HEAD不变、index空、markdown_debug.rs历史删除保留，新/变更源码没有unsafe。命令`python docs/migration/tools/audit_component_routing.py`；日志：`validation/2026-09-24-1758-component-routing-protection-audit.log`。

新fixture 1,364,696 bytes SHA256 `2079388a65d6abfe560f036151c08e90d2499eecd1e28057715da5da15ae411e`；source-manifest 3,338 bytes SHA256 `2b25cf0362c0df1ac3d21b10fd2e2639f737f15c6e0075f4e2250814e7310ef8`。详细来源与API边界见`reference/component-routing/README.md`。

- **这不是完整TuiAltScreen/OS事件循环。** 已实现可用的分布式owning身份与live path解析，不是全局registry；旧index-based screen/flag-only host尚未接入composite API。interactive frame应传ComponentHandle root；bare借用组件box的handle为None，路由跳过。鼠标必须走ComponentHandle::dispatch保留nested target，不能用旧flag-only结果假装等价。
- 返回focus/capture flags但不执行host副作用；完整capture/press-point/moved/release/click/focus/overlay/search/selection/paste/OS循环尚待整合。ComponentHandle单线程、非Send/Sync，不可塞进ScrollView worker callback，仍需host event queue/scheduler。
- 已测child mouse callback修改父容器、并在返回后重新检查父input；不支持当前已借用组件的自身callback/render重入，RefCell会panic。强引用循环由host避免，back-link用weak；不是任意JS getter/动态prototype行为等价。当前Stack身份编辑可用remove_child_handle，旧index编辑仍保留。
- signed/i64坐标差超界saturate是Rust安全策略，不是JS极值等价。bool flags合并absent/false，任意额外字段未建模；Component仍UTF-8，任意非有限尺寸、无效sparse cursor-search异常、资源耗尽输入不宣称兼容。已覆盖的alias和树变动不等于任意JS mutation/reentrancy。
- wheel contain仅中断命中链，未访问primary仍收余量；新scrollbar capture先clearSelection，active drag跨overlay/geometry消失仍消费。这些已验证原语未改，host仍负责hover/selection/focus-out/stop。SGR超过MAX_SAFE_INTEGER主动拒绝的边界保留。
- 默认ScrollView timer为worker线程+weak/generation cancellation，不是Node单线程event loop；跨线程顺序、每次activity一线程仍有整合成本。Kitty仅ASCII-base64/1000项registry/crop，像素加载/placement/retransmission/deletion/iTerm2/full capability probing未做；marked18.0.5替代不可用18.0.11，source/transform/highlight/raw Component/full grammar仍有缺口。

- 初始oracle bootstrap scope残留上一切片说明：17:35:22–17:35:23在安装fixture前只更正scope并重新生成；完整记录`2026-09-24-1736-component-routing-oracle-scope.log`。
- 首次cargo check 17:40:41–17:41:13因layout cached调用同时可变借用与读取cache ID触发E0502。先读取ID再调用即可修复；日志`2026-09-24-1750-component-routing-check.log`。没有改oracle/expected迎合编译器。
- 17:43:58–17:45:12初始四组70case/1534step通过；17:46:42仅追加directLayouts七场景，逐组核验旧四数组全等；17:48:59–17:49:44十三专项全过；17:50:02–17:50:40fmt/严格Clippy通过。日志文件名中的时分有部分预留名，**实际时间以内容为准**。两个探索性读取路径猜错返回not-found，无文件写入，随后通过目录/现有模块定位。

Immutable target checkpoint-2026-09-24-component-routing,previous checkpoint-2026-09-24-mouse-dispatch-foundations;seven inherited source paths and exact reproduction commands in HANDOFF. Next:下一切片接组件gesture状态机：复读实际上游tui-alt-screen.ts:651–656、810–939及focus-out/stop，串行组合owning目标与既有dispatch/click/scrollbar原语。优先验证capture优先于pressTarget、移动清click history、release+click的顺序/OR-render/最后clear、press selection清理及保存目标。用实际handleMouseEvent的受控host seam记录效果顺序，不重写layout/Stack/wheel，也不冒称focus/overlay/OS已整合。路径不是身份；被移除目标仍用保留对象及旧geometry。细化验收见NEXT_SLICE_PLAN.md。


## Owning component gesture controller — 2026-09-24T18:32:07+09:00

- 新 `ComponentGesture` 保存 owning capture、press target/point/moved 和 component click history；必需同步 `ComponentGestureHost` trait 即时执行效果，没有默认空实现、不是只返回动作清单。
- 活动gesture先于search/overlay/indicator/scrollbar；capture优先pressTarget。目标移除/换frame仍用保留对象和旧geometry，不以路径/index重找。坐标变化置sticky moved并清click history，移回原点仍不click。
- release先dispatch，再计数/构造click并dispatch；即使release需要render也必须执行click的focus/capture。两者render OR；最后clear gesture，再requestRender。release改capture不改变本次click开始时保留的目标。总是先resolve focus，只有focus flag为true才读取/设置current focus，再保存capture；explicit render=false压制focus/default render。
- 常规顺序：search → overlay；无overlay hit才尝试indicator/scrollbar并按当前drag状态更新hover；随后layout → paste → selection。overlay hit+decline不落到layout，但仍到paste/selection。wheel由独立viewport入口处理。
- 三个生命周期方法仅投影鼠标状态：focus-out/start清gesture和click history；**stop只清gesture，保留click history**，不是完整terminal生命周期。
- Actual-source oracle复制22完整上游模块，实际执行TuiAltScreen handleMouseEvent/apply/dispatch/click/lifecycle状态与Container/layout。157场景/553步：gestures70/227、routes66/181、clicks8/75、retained9/43、lifecycle4/27。5个差分测试逐步比对返回值、完整gesture状态与有序trace；4个Rust独立契约覆盖移除目标寿命、capture-only释放、controller drop和child callback修改父容器。初始143/498已通过，再追加14场景并核验旧五数组全等前缀。

2026-09-24 18:20:10–18:21:02 +09:00四门禁全部exit0：`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`、`cargo test --offline --all-targets`、`cargo test --offline --doc`。all-targets **2418 passed = 2382 lib +27 generate-models +9 pirs，0 failed，2历史CJK ignored**；doctests **5 passed，0 failed，1历史ignored**。本切片新增9测试函数，不是2418个新测试。完整日志：`docs/migration/validation/2026-09-24-1821-component-gesture-full-gates.log`。

18:21:53–18:23:01，16串行命令exit0，全部**24产物**（2 Gesture+2 ComponentRouting+2 Dispatch+2 Mouse+2 Layout+2 Stack+7 Markdown+5 LaTeX）逐字节复现，旧22产物不变；30 ANSI-width probes一致，实际layout.test.ts的15测试通过。完整native alt-screen tests未执行，离线缺@xterm/headless；三native测试文件仅读/哈希，不算执行。日志：`docs/migration/validation/2026-09-24-1823-component-gesture-oracle-repro.log`。

18:24:21–18:24:22保护审计PASS：前456归档/evidence/supplemental未变，174个allow-list之外继承source/build不变，两个HEAD不变、index空、历史删除保留，新/变更源码无unsafe。WORK_LOG前143371字节SHA256 `a0b27e696293ff779dd9003328c89d7ec045ada505a178e6fa8d28194c958953`完整；只能binary append。命令`python docs/migration/tools/audit_component_gesture.py`；日志`docs/migration/validation/2026-09-24-1826-component-gesture-protection-audit.log`。文档收尾后会再次审计，最新真实时间读取日志内容。

新fixture 905040 bytes，SHA256 `62ee97d24e8c9be1d376cab4059bb63f342f5b9dc744c8801d485c1ebb3f0024`；source-manifest 3363 bytes，SHA256 `fff2dee64e4d2e195fa780ff394d87c2427cdb0a8542183ef14b0fe7154e3a03`。来源/范围见docs/migration/reference/component-gesture/README.md。

- **不是完整TuiAltScreen/OS事件循环。** 现有owning ComponentHandle、Container/MouseRegion、layout和本轮gesture已实现，不重复重做。旧index-based screen/flag-only host尚未接到composite API；interactive frame需handle root，bare借用box没有handle会跳过路由。
- focus/overlay/search/selection/paste/viewport是必需host callbacks，但测试中仍受控，不冒充这些功能的真实实现。一个故意hit=false+result输入仅检验流程，不声称自然overlay能产生该状态。实际focus setter还有blocked/resume/ancestor/preFocus/visible/mounted等状态；selection-release负责click-only控件的click合成（tui-alt-screen.ts:1303–1347），本切片尚未做该回退、drag-to-copy、URL/clipboard。
- ComponentHandle单线程Rc/RefCell、非Send/Sync，不可塞进ScrollView worker，须host event queue/scheduler。允许child mouse callback修改父容器并在返回后重查input；不支持当前借用组件自身callback/render重入。避免强引用循环，back-link用weak；不宣称任意JS getters/prototype/mutable target aliasing等价。
- wheel contain仅中断hit chain，未访问primary还收余量。scrollbar helper被调用时，active drag跨overlay/geometry消失仍消费；**实际handleMouseEvent若overlay.hit为true则跳过scrollbar helper**，不能扩大helper契约到整个host。capture先clearSelection的既有原语保留。
- i64坐标差超界saturate、SGR超过MAX_SAFE_INTEGER主动拒绝是明确安全边界；bool合并absent/false，任意额外字段未建模。Component仍UTF-8；非有限/无界尺寸、无效sparse cursor异常、任意重入不宣称等价。
- ScrollView默认timer是worker+weak/generation cancellation，不等于Node单线程loop；Kitty仍限ASCII-base64/1000项registry/crop，无完整像素/placement/retransmission/deletion/iTerm2/capability probing。marked18.0.5替代不可用18.0.11；source/transform/highlight/raw Component/full grammar仍有缺口。
- M4全包、M5/M6及完整AgentHarness/dispatcher/MemorySessionRepo/Facade未完成；旧Lane12已实现。早期“无live identity/gesture仅flags”仅是历史记录，不是当前状态。

Checkpoint target component-gesture;previous component-routing. Full scope/allow-list/reproduction commands in HANDOFF. 下一切片先移植owning overlay hit/focus-owner helpers，再逐项接真实host。复读pi/packages/tui/src/tui.ts:550–679、813–855和show/hide/remove/render路径。containsComponent只递归Container实例；MouseRegion不是Container，不能用任意mouse_child替代结构containment。focus owner按当前visible overlayStack逆序，hit按最后rendered layouts逆序；命中decline不穿透，concrete target/geometry不变。完整setFocus需独立状态机，不把测试seam升级为实现。随后接selection-release click-only回退。细化验收见docs/migration/NEXT_SLICE_PLAN.md。


## Owning component-overlay mouse helpers — 2026-09-24T19:03:11+09:00

- 新 `ComponentOverlay` 保留当前owning组件、hidden及可选visibility predicate；`RenderedComponentOverlay` 独立保留上次渲染组件与signed row/col、width/height。公开contains_component、resolve_mouse_focus_target、dispatch_mouse_to_overlay。
- **当前visible overlay stack逆序决定focus owner；上次rendered rectangles逆序决定hit。** hidden短路predicate，否则每次以当前terminal尺寸调用，先visibility再contains。nonCapturing/focusOrder不影响这两个helpers；真正compositor需另行按visual order提供矩形。
- 命中即返回：无handler或decline也不穿透下层；不重查当前hidden/removal/visibility，stale frame仍能派发。只有focus=true才把focusTarget换成overlay组件；concrete target/capture/geometry不变。
- 新 `Component::is_container_component` 独立表达结构Container身份，不等同mouse override或layout node。Container/HStack/VStack/ScrollView opt-in，Box/ComponentHandle完整转发；MouseRegion/任意只暴露mouse_child的wrapper不自动成为Container。containment查live树及hidden children、不render，递归前释放父borrow。
- Actual-source bootstrap复制22完整模块，执行真实TuiBase四个helpers，并与真实TuiAltScreen gesture流程组合。67场景/1507步：ownership13/310、visibility8/75、hits29/958、mutations7/86、gestures10/78。5差分函数比较逐步值/状态/有序trace，另5 Rust契约覆盖adapter marker、current/frame/capture分离寿命、child移除自身、hidden Stack/Scroll不render、极值矩形安全。
- 初始63场景/1461步已通过，之后只追加4场景，五旧数组均核验为完全相等前缀。旧gesture157/553及其余既有oracle未改。

2026-09-24 18:53:29–18:54:16 +09:00四门禁全部exit0：`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`、`cargo test --offline --all-targets`、`cargo test --offline --doc`。all-targets **2428 passed =2392 lib+27 generate-models+9 pirs，0 failed，2历史CJK ignored**；doctests **5 passed，0 failed，1历史ignored**。本切片新增10函数，不是2428个新测试。完整日志：`docs/migration/validation/2026-09-24-1853-component-overlay-full-gates.log`。

18:55:06–18:56:13，18串行命令全部exit0，**26产物**（2 Overlay+2 Gesture+2 ComponentRouting+2 Dispatch+2 Mouse+2 Layout+2 Stack+7 Markdown+5 LaTeX）逐字节复现，旧24产物与component-gesture快照字节不变；30 ANSI-width probes一致，实际layout.test.ts的15测试通过。完整native alt-screen tests仍未执行，离线缺@xterm/headless；3个参考测试文件只读/哈希不算执行。日志：`docs/migration/validation/2026-09-24-1856-component-overlay-oracle-repro.log`；文件名部分为预留时分，真实时间以内容为准。

18:56:42–18:56:43保护审计PASS：前473 archive/evidence/supplemental不变，172个allow-list之外继承source/build不变，两个HEAD不变、index空、历史删除保留，新/变更源码无unsafe。WORK_LOG前155716字节SHA256 `edc687f392f90972602231e855dae8aca82aae6afa7dac2c0bd9dce51058a516`完整，只能binary append。命令`python docs/migration/tools/audit_component_overlay.py`；日志`docs/migration/validation/2026-09-24-1859-component-overlay-protection-audit.log`。文档收尾后再次审计、独立核验快照，不以旧allow-list检查新切片。

新fixture 2279777 bytes，SHA256 `d547a421bfd80848858d4599066809c11af42834bb4fb7af757ab70f734b4063`；source-manifest 3354 bytes，SHA256 `4438e92588c5b295586840373a332c07de9b8cecd757717dfd8d38cadd665a25`。来源/边界见docs/migration/reference/component-overlay/README.md。

开发失败如实保留：18:40:12新oracle harness把dispatchMouseToTarget(event,target)参数写反，TypeError/exit1；修正调用顺序后18:40:39–40重跑exit0，失败时未安装任何expected。18:43:40–18:44:01新Rust测试HashMap类型推断E0282/exit101；只补Objects类型后18:44:29–18:45:24 fmt及5专项通过，没有改production/expected迎合测试。18:48:08追加4case并验证prefix；18:48:36–18:49:45 fmt/strict Clippy/10专项全部通过。完整first/retry/append/focused日志均保留。

- **不是完整TuiAltScreen/OS host。** owning identity、Container/MouseRegion路由、layout、gesture和本轮overlay helpers已实现，不要重写。测试Host真实调用新helpers，但生产旧index-based screen/flag-only host仍未接线；interactive frame需handle root，bare借用box无handle会跳过路由。
- 当前entries/矩形/visual order/visibility输入受控，不是完整show/hide/unfocus/compositor。组合测试的setFocus仍只是赋值+trace，尚无eligible/blocked/resume/ancestor/preFocus/visible/mounted状态机。search/viewport/layout fallback/paste/selection/render scheduling/clock仍是明确seams。selection-release click-only合成(tui-alt-screen.ts:1303–1347)、drag-to-copy/URL/clipboard未做。
- 继承gesture契约不退化：active gesture先于search/overlay/indicator/scrollbar；capture优先pressTarget；移除/换frame保留目标与旧geometry；moved sticky且清click history；release后仍执行click副作用，render OR不短路；最后clear再requestRender。focus-out/start清history，**stop只清gesture保留history**。生命周期hooks不是完整terminal生命周期。
- wheel是独立viewport入口；contain只中断hit chain，未访问primary仍接余量。scrollbar helper被调用时active drag跨geometry消失仍消费，capture先clearSelection；但真实handleMouseEvent在overlay.hit时跳过该helper，不能扩大为整个host无条件优先scrollbar。
- ComponentHandle单线程Rc/RefCell、非Send/Sync，不能塞入ScrollView worker，须host queue/scheduler。支持child callback修改父树；不支持自身callback/render重入、强引用环、任意JS getters/prototype/array mutation或mutable entry.component aliasing。结构树不可循环。
- 有限整数cell几何；bounds用i128防overflow，不宣称JS极值安全整数外等价；retarget沿用i64 saturation，过大SGR仍主动拒绝。Component仍UTF-8；bool合并absent/false、额外字段/非有限无界尺寸等边界保留。
- ScrollView worker timer不等于Node event loop；Kitty仍有限ASCII-base64/1000项registry/crop，完整像素/placement/retransmission/deletion/iTerm2/capability probing未做；marked18.0.5替代不可用18.0.11，source/transform/highlight/raw Component/full grammar仍有缺口。
- M4全包、M5/M6及完整AgentHarness/dispatcher/MemorySessionRepo/Facade未完成。旧Lane12已实现；早期“无owning identity/gesture仅flags/无overlay helpers”只是历史记录。

Checkpoint target component-overlay;previous component-gesture. Scope/allow-list/reproduction in HANDOFF. 下一切片优先owning focus/overlay restore状态机，再绑定真实host，不重复本轮helpers或gesture。复读tui.ts:550–679、685–870、1042–1080以及overlay-non-capturing.test.ts的focus/blocked/unfocus/visibility/cyclic preFocus场景。overlay entry身份不能合并为component身份；getVisibleOverlayFocusRestore返回inactive不等于擦除保存状态；最高focusOrder capturing候选不等于stack最后一项。随后实现selection-release click-only回退。详见NEXT_SLICE_PLAN.md；这些仍是计划，不是完成声明。


### 2026-09-24T19:05:22+09:00 文档审计wrapper更正
19:04:43–44内层audit_component_overlay.py再次PASS，但新外层文档审计在比较SOURCE-SCOPE行时把subprocess原始CRLF与read_text规范化LF直接比较，触发AssertionError/exit1；不是source hash改变。失败输出/traceback补全保存在2026-09-24-1905-component-overlay-final-audit.log。只将临时wrapper比较改为splitlines()；production/tests/fixtures不变。后续新命名retry日志为最终文档审计依据，不覆盖失败日志。


Final document/source protection audit PASS 2026-09-24T19:06:29+09:00; wrapper corrected by splitlines(), all 10 source-scope hashes unchanged. UTF-8/history/root-path checks passed; log: docs/migration/validation/2026-09-24-1906-component-overlay-final-audit-retry.log. Only this audit receipt is appended below the preceding log prefix; no production/test/fixture changes. Close this log, create component-overlay checkpoint without tee, then independently verify archive/live/evidence/supplemental/root/HEAD/index. Manifest/verification files remain the checkpoint authority; full migration incomplete, goal active.


## Owning focus / overlay lifecycle controller — 2026-09-24T19:51:12+09:00

- 新 `ComponentFocus` owning控制器和独立 `ComponentOverlayHandle` entry身份，保存focused、insertion stack、preFocus、hidden/nonCapturing、f64 focusOrder、last bounds、raw restore。组件身份不替代entry身份，同一组件可有多个entry。
- 已移植setFocus、show/hide/hideOverlay/setHidden/focus/unfocus、isFocused/getBounds/hasOverlay/isOverlayFocused、cycle-safe ancestry、mounted树查找、直接preFocus retarget、eligible/blocked与restore-overlay/focus-target(含显式null)。same-target仍按old=false→new=true执行setter；highest focusOrder capturing候选不等于reverse insertion mouse owner。
- visibility有predicate才按columns→rows→predicate执行；hidden或无predicate不读尺寸。临时不可见的inactive投影不擦除raw restore。foreign controller在effects前拒绝；同owner removed handle按不同方法保留源码语义，不统一拒绝。
- `restore_before_input`只移植tui.ts:1042–1068焦点块，返回owning target。测试host额外重现TuiAltScreen plain-input viewport listener的isOverlayFocused查询；随后释放组件borrow再同步执行scripted input commands，最后immediate-render。不是完整keyboard filters或任意self-reentrant callback支持。
- 必需同步 `ComponentFocusHost` 提供terminal尺寸、mounted roots、hideCursor、requestRender，没有默认空实现。组合测试真实连接Gesture/Overlay/Focus，不再只赋值模拟focus。set_rendered_bounds只是发布值的seam，不是compositor。
- Actual-source bootstrap复制22完整模块，调用真实TuiBase/TuiAltScreen methods；104场景/1768步：lifecycle23/198、restore25/189、visibility14/132、identity8/86、composed10/94、sequences24/1069。逐步比较value、focused flags、所有retained entries(含removed)、preFocus、raw restore、counter、bounds、gesture、有序trace。
- 6差分函数+4 Rust契约（foreign-owner/stale、脱离registry的owning寿命、setter借用顺序、mounted查树释放父borrow/不render）共10项。初始98/1702通过后仅追加6场景；6组旧数组均为相等前缀，旧26产物未改。

2026-09-24 19:38:22–19:39:54 +09:00四门禁全部exit0：`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`、`cargo test --offline --all-targets`、`cargo test --offline --doc`。all-targets **2438 passed =2402 lib+27 generate-models+9 pirs，0 failed，2历史CJK ignored**；doctests **5 passed，0 failed，1历史ignored**。本切片新增10函数，不是2438个新测试。日志：`docs/migration/validation/2026-09-24-193822-component-focus-full-gates.log`。

19:41:07–19:42:16，20串行命令全部exit0；**28产物**（2 Focus+2 Overlay+2 Gesture+2 ComponentRouting+2 Dispatch+2 Mouse+2 Layout+2 Stack+7 Markdown+5 LaTeX）逐字节复现，旧26与component-overlay快照字节不变。30 ANSI-width probes一致，真实layout.test.ts的15测试通过。完整native overlay/alt-screen tests仍未执行，离线缺@xterm/headless；4个focus参考测试文件只读/哈希不算运行。日志：`docs/migration/validation/2026-09-24-194107-component-focus-oracle-repro.log`。

19:42:46–19:42:47新focus-specific保护审计PASS：前493 archive/evidence/supplemental不变，180个非allow-list继承source/build不变，两个HEAD不变、index空、历史删除保留，新/变更源码无unsafe。两项继承源码diff严格只有module declaration；旧26产物、6个passed前缀证明、失败/重试日志均核验。命令`python docs/migration/tools/audit_component_focus.py`；日志`docs/migration/validation/2026-09-24-194246-component-focus-protection-audit.log`。文档收尾后再审计，以最终收据和快照verification为准。

19:28:25–19:29:35最初6个差分函数失败：真实TuiAltScreen constructor安装的viewport input listener比测试host多一次isOverlayFocused查询。只在新Rust测试host的restore_before_input之前补该查询；production/generator/expected未因此改动。19:31:20–19:32:01全部10项通过；随后6case追加先核验旧prefix再安装，19:37:51–19:38:09 verifier及10项再次通过。失败`2026-09-24-192825-component-focus-initial-tests.log`、重试`2026-09-24-193120-component-focus-tests-retry.log`、追加`2026-09-24-193751-component-focus-append-install-verify.log`均保留。19:47:53还记录了一次文档writer传输层Python嵌套引号SyntaxError；发生在解析阶段，未修改源码或文档；改直接here-string后重试。

- **不是完整TuiAltScreen/OS host。** 新Focus/Overlay/Gesture及owning Container/MouseRegion/layout路由不要重写；旧index-based screen、legacy overlay策略、真实输入队列/调度器、compositor仍未接线。frame发布需owning handle root，bare借用box无handle仍跳过路由。
- full input prefilters、key release/handler presence、search、viewport、paste、selection、render scheduling仍是host seams；selection-release click-only回退(tui-alt-screen.ts:1303–1347)、drag-to-copy/URL/clipboard未做。返回focused target不代表整个输入分发已移植。
- 当前visible insertion stack逆序决定mouse focus owner，上次rendered rectangles逆序决定hit。hit+decline不穿透，不复查当前hidden/removal；only focus=true改focusTarget，concrete capture target/geometry不变。compositor需日后发布真实visual order矩形。
- active gesture先于search/overlay/indicator/scrollbar；capture优先pressTarget，移动sticky清click history；release后click副作用仍执行，render OR不短路，最后clear再render。focus-out/start清history；stop只清gesture、保留history。wheel独立viewport；overlay.hit时真实host跳过scrollbar helper，不能声称scrollbar全局绝对优先。
- ComponentHandle/entry为单线程Rc/RefCell、非Send/Sync，ScrollView worker需要host queue/scheduler。支持安全child-to-parent树修改，不支持自身callback/render/visibility重入、强引用环、cyclic child trees、任意JS options-object alias/getter/array mutation；preFocus循环有防护。
- 有限整数cell几何；bounds防overflow不代表无界JS数值等价；retarget沿用i64 saturation，过大SGR主动拒绝，Component为UTF-8等边界未变。f64 counter保留JS increment/comparison选型，不把fixture有限数列称作所有极值已测试。
- ScrollView worker timer不等于Node event loop；Kitty仍有限ASCII-base64/registry/crop，完整像素/placement/retransmission/deletion/iTerm2/capability probing未做；marked18.0.5替代不可用18.0.11，source/transform/highlight/raw Component/full grammar仍有缺口。
- M4全包、M5/M6、完整AgentHarness/dispatcher/MemorySessionRepo/Facade未完成。旧Lane12已实现；旧“无owning focus/gesture/overlay”是历史描述，不是当前重做清单。

Fixture3348312bytes SHA256894955edbb0bbcf3b627bacd45c4a4c0f197b028d771a35fb6cb954a13f8d4c8; manifest3582bytes SHA256aa21a3f5b6146e830feca2093726c354e068ff9f9ad94ff150986ea758858770. Source/seams:reference/component-focus/README.md. Previous:component-overlay;target checkpoint:component-focus.

下一切片优先selection-release click-only回退及真实selection host，复读tui-alt-screen.ts:1303–1385和test:1693起nested MouseRegion/drag-selection；复用ComponentGesture::apply_dispatch_result和已验证Overlay/Focus，不重写焦点状态机。URL先于组件click，overlay.hit+decline阻止layout穿透；结果存在时apply→clear selection→条件render，否则copyOnSelect→render。保留clickCount与point的scrollView身份。先定义owning selection state和必需host接口，再实际源码oracle；不能用空callback冒充接通。granularity/autoscroll/clipboard/OS若未覆盖需明示。详见NEXT_SLICE_PLAN.md。


Final document/source protection audit PASS 2026-09-24T19:53:20+09:00; all5 source-scope raw-byte hashes remain identical to the first protection audit. UTF-8/history/root-path checks passed; AGENTS archive unchanged and clean tracked ROADMAP matches HEAD (not a dirty-snapshot file). Log: docs/migration/validation/2026-09-24-195319-component-focus-final-audit-retry.log. Earlier failed wrapper log retained. Only this receipt is appended after those checks; no production/test/fixture changes. All logs are closed before checkpoint creation without tee. Component-focus manifest/verification and external independent receipt remain the sealing authority; full migration incomplete, goal active.


## Owning selection state / release / autoscroll — 2026-09-24T20:36:36+09:00

- 新 `ComponentSelection` owning控制器：anchor/focus/range/scroll身份、character/word/line粒度、500ms click cycle、pressActive/dragged/URL、drag pointer/direction/50ms interval。controller不可Clone，避免复制timer token。
- 已移植scroll/content/clip坐标、word与`/`/`-`连接、line range、granularity focus更新、反向选择、grapheme-cell边界、ANSI剥离与JS trimEnd、active text、自动滚动start/stop/tick（真实ScrollHandle::scroll_by）。clear保留selection click history；完整start/stop/focus-out重置仍需host接线。
- 完整press/move/release分支，URL激活优先，URL Result::Err忽略。click回退先Overlay，hit+decline不穿透layout；有result时真实apply_dispatch_result→clear→条件render，无result时copyOnSelect启动投递→render。普通release已被组件处理时不会到selection回退，这不是异常。
- Gesture的必需selection回调新增`&mut ComponentGesture`，使release-click capture在同一个live controller中同步保留。只改此signature/call/2行doc及三个旧测试host的unused参数；原算法/旧expected不变。宿主测试用Option::take短暂拥有Selection，避免跨callback借用；不支持自身重入。
- `ComponentSelectionHost`无默认空实现；外部服务包括frame/screen/live hasOverlay、Intl-equivalent分词、unreferenced interval调度/取消、URL opener、开始clipboard投递。`request_copy_active_selection`的bool仅表示已发起投递，不是系统剪贴板成功。宿主必须在drop前停止timer，取消过期队列tick；不能在ScrollView worker上操作ComponentHandle。
- 实际完整TuiAltScreen/TuiBase/ScrollView/Layout/MouseRegion/Container源码oracle，22模块与4参考测试文件哈希。**194场景/1707步**：basic29/123、ranges89/326、scroll26/219、urls13/55、composed21/152、sequences16/832。逐步比较return、全部Selection状态、bounds/text、scroll top/follow、Focus flags、Gesture capture/history与有序trace。
- Rust真实复用Focus/Overlay/Gesture/layout/scroll，不以id路由或flags模拟替代。6差分函数+3ownership契约=9项；含scroll anchor脱离registry/frame仍owning、同一live gesture回退capture及真实frame替换、独立controller timer/history。20个Intl segment输入是外部服务输入，不是从expected selection ranges反喂答案，更不是Rust ICU引擎已移植。
- 初始175/1619及随后193/1698已通过的全部6组都是最终fixture相等前缀，19→20个外部分词输入也保留。初始错误frame fixture/generator及已通过175/193两版fixture+manifest都已留portable forensic备份。

2026-09-24 20:27:16–20:28:44 +09:00四门禁全部exit0：`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`、`cargo test --offline --all-targets`、`cargo test --offline --doc`。all-targets **2447 passed =2411 lib+27 generate-models+9 pirs，0 failed，2历史CJK ignored**；doctests **5 passed，0 failed，1历史ignored**。本切片新增9个函数，不是2447个新测试。日志：`docs/migration/validation/2026-09-24-202716-component-selection-full-gates.log`。

20:28:54–20:30:06，22串行oracle命令全部exit0；**30产物**（2 Selection+2 Focus+2 Overlay+2 Gesture+2 ComponentRouting+2 Dispatch+2 Mouse+2 Layout+2 Stack+7 Markdown+5 LaTeX）逐字节复现，旧28与component-focus快照字节相等；30 ANSI-width probes一致，真实layout.test.ts的15测试通过。完整native overlay/alt-screen suite仍未执行，离线缺@xterm/headless；4个selection参考测试文件只读/哈希不算执行。完整命令与输出：`docs/migration/validation/2026-09-24-202854-component-selection-oracle-repro.log`。

20:31:42–20:31:43新selection-specific保护审计PASS：前514 archive/evidence/supplemental不变，179个非allow-list继承source/build不变，两个HEAD不变、两个index空、历史删除保留、新/变更源码无unsafe。6项继承源码逻辑diff严格受限；旧28产物、两版passed prefixes、失败修复前已通过3组及失败3组输入不变均核验。命令`python docs/migration/tools/audit_component_selection.py`；日志`docs/migration/validation/2026-09-24-203142-component-selection-protection-audit.log`。文档收尾后再审计，以最终收据和快照verification为准。

Selection fixture：3219396 bytes，SHA256 `78d9eb63d98493b1b84cafc800f9697a44f87367f5dd42e48a975c691f9bd2ae`。source-manifest：3639 bytes，SHA256 `30315b8042c9e13586ac52a5920f4f51f359eb295f5e996189b68321b62ba836`。

1. `2026-09-24-201410-component-selection-initial-tests.log`：新Rust harness E0282 registry类型推断、E0596 indexed mutable render。只修显式类型和短with_mut借用，production/generator/expected不变。
2. `2026-09-24-201507-component-selection-tests-compile-retry.log`：3组通过、3组失败。新JS手工frame发布漏了actual LayoutBox独立scrollView字段；对照layout.ts:23–34/152–161/427–450后仅修新frame seam，重新运行真实源码。未改Rust production或手写expected。初始通过basic/ranges/composed保持相等，scroll/urls/sequences输入保持相等。`2026-09-24-201735-component-selection-frame-schema-retry.log`：175/1619、6组通过。
3. `2026-09-24-202005-component-selection-append-writer-diagnostic.log`：追加writer标记在node builder和step中各命中一次导致AssertionError；之前已保存初始通过备份/追加generator/两行doc，未安装fixture/写Rust test。缩小至fn step后完成。该文件是诊断记录，不伪称原始工具transcript。
4. `2026-09-24-202116-component-selection-appended-tests.log`：193/1698全部差分+2契约通过，第三契约错误假设普通handled release仍会进入selection click回退，unwrap失败。原名actual-renderer-owning-capture-after-fallback场景保留不改，作为“release拦截”反例；追加click-only真正回退+frame替换场景，再验证正反对照。`2026-09-24-202633-component-selection-capture-contract-retry.log`：194/1707与全部9函数通过，所有旧passed前缀/segments不变。production未因这次错误契约改动。
5. 初次只读定位误猜工作区根AGENTS（不存在），随后使用真实pi-rust/AGENTS；未写文件。历史focus及更早失败记录仍在WORK_LOG/validation/不可覆盖快照，不抹除。

- **不是完整TuiAltScreen/OS host。** Focus/Overlay/Gesture/Selection及owning Container/MouseRegion/layout路由已存在，不要重写成stub。旧index-based screen、legacy overlay策略、真实input queue/scheduler/compositor仍未全面接线；frame发布需owning handle root，bare borrowed box无handle仍跳过路由。
- 本轮selection状态/geometry/text/URL决策/autoscroll tick/click回退已做；**Intl分词引擎、系统clipboard delivery/异步成功与flash/OSC52、selection painting、完整event loop/lifecycle reset尚未做**。copy initiation不等于成功，URL opener Result接口不吞Rust panic。
- full input prefilters、key release/handler presence、search、viewport、paste、render scheduling仍有host seams；Focus restore_before_input只迁移tui.ts:1042–1068焦点块，测试额外复现constructor viewport查询，不代表完整键盘分发。
- 当前visible insertion stack逆序决定mouse focus owner，上次rendered rectangles逆序决定hit；hit+decline不穿透、不重查hidden/removal。only focus=true改focusTarget；concrete capture target/geometry不变，compositor需发布真实visual-order矩形。
- active gesture先于search/overlay/indicator/scrollbar；capture优先pressTarget，移动sticky清component click history；release+click render OR不短路，最后clear再render。Gesture focus-out/start清history，stop仅清gesture；wheel独立viewport。Selection clear保留自身lastClick，勿混同两种history。
- Rc/RefCell handles非Send/Sync；timer callbacks须host queue到同线程。无任意self-reentrant callback/render/visibility、强引用环、cyclic child trees或JS options alias/getter mutation支持；preFocus循环有防护。finite integer cell/UTF-8边界明确，i64 saturation/大SGR拒绝不代表任意JS number/UTF-16等价。
- ScrollView worker timer不等于Node event loop；Kitty仅有限ASCII-base64/registry/crop，完整像素/placement/retransmission/deletion/iTerm2/capability probing未做。marked18.0.5替代不可用18.0.11，source/transform/highlight/raw Component/full grammar仍有缺口。
- M4全包、M5/M6、完整AgentHarness/dispatcher/MemorySessionRepo/Facade未完成；Lane12已有实现。所有更早“缺owning focus/gesture/overlay/selection”等说明仅是历史状态，详见最新日期切片。

下一切片优先**selection paint/highlight**，先读真实`tui-alt-screen.ts:1383–1422、1553–1617、1658–1673`及对应测试，复用已验证Selection bounds/columns、ScrollHandle身份与layout。实现实际applySelectionHighlight/applySelection，保留ANSI SGR后重新inverse、OSC/DCS/图片行、grapheme/clip/scroll投影语义；scroll投影可能是负screen row/col，不能直接塞回usize selection point而提前clamp。用真实源码新oracle与renderLayoutFrame组合验证，不能以style flag或identity返回冒充paint完成。完整compositor仍另算；clipboard异步成功/flash/OSC52在后续独立切片。详见NEXT_SLICE_PLAN.md。


## 2026-09-24T21:14:57+09:00 — Selection Paint validated slice

- 新独立模块 `src/tui/component_selection_paint.rs`，对应真实 `tui-alt-screen.ts:1553–1617`：`apply_selection_highlight`、纯函数`apply_selection`、`ComponentSelection::apply_selection`便捷入口。便捷入口用既有`bounds()`；纯函数输入必须是已规范化bounds。
- highlight开头inverse，保留真实extract_ansi_code识别的token，并在每个以m结尾的ANSI token后重新inverse，尾部inverse-off；不能仅首尾加样式。图片标记行（包括嵌入Kitty/iTerm2）不改。
- rect/clip/screen长度/terminal columns裁切；scroll内容坐标以signed i128投影，负screen row/col不能提前clamp；沿用真实grapheme-cell边界和三段strict slice_by_column。缺bounds/frame/scroll box保持内容不变。传入saved frame与live scrollTop正确配合，无Selection/Focus/Gesture/scroll/layout/timer副作用。
- 新实际完整源码oracle复制22模块、哈希4参考测试文件；调用真实paint/columns/highlight而非手抄JS算法。`paintBounds`是明确normalized-bounds seam；`paint`由真实事件形成Selection；`renderFrame`使用实际Container/ScrollView/renderLayoutFrame。每步比较结果、完整Selection/Focus/Gesture/scroll状态和有序trace。
- **295场景/1266步**：highlights30/30、screen131/132、scroll106/322、composed20/118、sequences8/664。**8个新增Rust测试函数=5差分+3独立契约**（ANSI/OSC原样与reset重施inverse；脱离registry/current frame后的owning scroll+saved frame；负起始行不能限制首个可见行起始列）。2个Intl segment输入是外部服务输入，不是Rust ICU引擎。
- 旧Selection194场景/1707步、Focus/Overlay/Gesture及全部旧30产物、前轮forensics保持字节一致。仅两个继承源码增加module声明：`src/tui/mod.rs`、`src/tui/tests.rs`。新源码仅paint module、fixture与test三个文件；未改Cargo/依赖、旧算法/tests/fixtures或legacy host。

### Verification
2026-09-24 **21:01:31–21:01:52 +09:00** 原样四标准门禁全部exit0：
`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`、`cargo test --offline --all-targets`、`cargo test --offline --doc`。
all-targets **2455 passed =2419 lib+27 generator+9 CLI，0 failed，2历史CJK ignored**；doctests **5 passed，0 failed，1历史ignored**。本轮只新增8个测试函数，不是2455个新测试。未改测试线程数、跳过或放宽测试；日志`docs/migration/validation/2026-09-24-210131-component-selection-paint-full-gates-retry.log`。

21:02:13–21:03:24，24串行oracle命令全部exit0；**32产物**逐字节复现（新paint2+旧30），旧30与component-selection快照相等；30 ANSI probes一致，真实layout.test.ts的15测试通过。完整native alt-screen/overlay suite仍离线缺`@xterm/headless`而未执行；4个参考测试文件只读/哈希不算执行。完整顺序/命令/输出在`2026-09-24-210213-component-selection-paint-oracle-repro.log`。

21:05:32–21:05:34首次保护审计及previous archive-only独立验证通过；21:10:44–21:10:46接续保护审计再次通过：545旧archive、evidence/supplemental保持；**186个非allow-list继承source/build、536个所有非allow-list继承文件**保持字节不变；两个HEAD不变、两个index空。全部5个源码scope hash等于通过门禁时witness；历史WORK_LOG前缀保留。日志`2026-09-24-210532-component-selection-paint-protection-audit.log`、`2026-09-24-211044-component-selection-paint-handoff-resume-protection.log`。文档收尾后还须`audit_component_selection_paint.py --handoff`，以实际关闭日志为准。

### Retained failures
1. `2026-09-24-205312-component-selection-paint-initial-oracle.log`：初次真实oracle成功；fixture此后从未改写，没有expected迎合修复。
2. `2026-09-24-205335-component-selection-paint-initial-tests.log`：fmt成功；新production调用不存在的`ScrollHandle::scroll_top()`而E0599。仅改用既有`scroll.snapshot().scroll_top`，未改旧源码或fixture。`2026-09-24-205541-component-selection-paint-accessor-retry.log`：fmt和8个新增测试全过。
3. `2026-09-24-205750-component-selection-paint-full-gates.log`：fmt/clippy过，all-targets exit101；lib2418 passed/1 failed/2 ignored。未修改的`ai::api::google_vertex::tests::default_budgets_follow_the_vertex_model_families`在`google_vertex/mod.rs:2661`失败：flash-lite Medium actual24576/expected8192。runner fail-fast，所以当次generator/CLI/doc未跑。
4. `2026-09-24-210119-component-selection-paint-vertex-diagnostic-repeats.log`：该既有Vertex测试5次isolated全过；之后原样四门禁重试全过，期间未改production/test/expected/env/线程策略。`capture_simple`读取received_requests().last()且不验证新请求或Done，24576又是前一case值，这**仅是诊断线索，根因未证明**。不声称已修复，不认定环境/并发race；完整失败、诊断、重试均保留。

### Boundaries / next
下一切片：**clipboard async delivery/result、flash及OSC52**。先读`tui-alt-screen.ts:301–305、643–644、1445–1468`与完整`components/alt-screen-flash.ts`及对应测试。注入copySelection必须await，仅`=== true`成功；string失败消息、其它值Copy failed、error duration5000ms；rejection按真实源码传播、不吞异常。无注入路径写UTF-8 base64 OSC52+BEL并flash Copied!，上游return true不等于操作系统核验送达。现有`request_copy_active_selection` bool只代表initiated，不能偷偷改成虚构的送达证明。复用既有Selection真实text；用可控deferred promise/future对照真实源码的pending/resolve/reject及有序trace，不触发真实剪贴板。详见NEXT_SLICE_PLAN.md。

The pure paint stage uses UTF-8/finite integer cells and Vec contents, not arbitrary JS-number/lone-surrogate/array-identity compatibility. Upstream search/indicator/overlay/selection/flash order is not yet a complete Rust compositor. Current checkpoint entry: `.migration-handoff/checkpoint-2026-09-24-component-selection-paint`; sealing requires manifest/verification plus independent external receipt.


## 2026-09-24T21:51:29+09:00 — Component clipboard + flash
- 新 `src/tui/component_clipboard.rs`：注入service在调用时立即开始，返回owned non-Send Future；pending期间不持有可变host/Selection借用。仅Boolean(true)成功；string（含空串）原样失败消息，其他值Copy failed；失败提示5000ms，不走fallback；同步throw/异步reject/terminal或flash错误用Result传播。无注入时立即写UTF-8标准base64 OSC52+BEL、flash Copied!并返回ready true；这不是OS送达核验。
- `ComponentSelection::copy_active_selection_to_clipboard`在调用时抓取真实active_text，空/缺选择返回false；既有request_copy_active_selection的bool仍仅代表initiated。Host必须保留/poll待完成Future，丢弃Future取消continuation，与丢弃JS Promise不同；release任务队列尚需完整host接线。
- 新 `src/tui/components/alt_screen_flash.rs`：真实stack/render/invalidate、递增id、setTimeout→unref→entry插入→requestRender、到期按id删除、dispose清timer/entries但不render/重置id。FlashId有owning container identity，避免跨container同numeric id误删。Math.max(0,duration)保留NaN，Node timer coercion仍是host服务；timer须同线程queue，drop前dispose。render严格复用truncate_to_width及inverse样式。
- 新真实完整源码oracle复制22modules、哈希4参考test文件（不算native执行）；**355场景/1881步**：delivery35/151、osc52 97/291、selection85/501、flashes128/748、sequences10/190。每步严格比较result/beforeDrain/settled状态、Selection字段与有序trace。5差分+3独立契约=8个新Rust测试函数。
- 原297场景/1533步expected冻结，58个新空白回归仅追加：25JS trim whitespace+4non-trim codepoints、注入/OSC52双路径和leading whitespace保留；所有原case及5个原Intl输入前缀不变。现在34个Intl服务输入，不是Rust ICU。实际Selection事件用于empty-tree/no-overlay/non-scroll；不能说本切片已验证ScrollView/layout clipboard组合或完整eventloop。
- 新差分发现继承Selection真实trimEnd缺陷：is_js_space_unicode仅Zs/Zl/Zp，漏TAB等。只把utils.rs已有js_trim_end暴露pub(crate)，Selection import/call复用它；其算法未变。旧Selection194/1707、Paint295/1266及全部32旧产物仍字节不变。本轮不是“所有旧production不变”：这个精确修正是明确例外。
- 继承source allow-list共5文件：`src/tui/mod.rs`、`src/tui/tests.rs`、`src/tui/components/mod.rs`仅各增module声明；`src/tui/utils.rs`仅helper可见性；`src/tui/component_selection.rs`仅import与trim调用。新production/test/fixture共4文件；全部9source-scope hash有gate witness。未改Cargo/依赖/旧tests/fixtures或legacy host。

### Validation
2026-09-24 **21:42:25–21:43:44 +09:00** 原样四标准门禁全部exit0：
`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`、`cargo test --offline --all-targets`、`cargo test --offline --doc`。
all-targets **2463 passed =2427 lib+27 generator+9 CLI，0 failed，2历史CJK ignored**；doctests **5 passed，0 failed，1历史ignored**。只新增8个Rust测试函数，不是2463个新测试；未改线程数、skip或测试标准。日志`2026-09-24-214225-component-clipboard-full-gates.log`另含1次先行只读oracle verifier，因此合计5条exit0。

21:44:25–21:45:37，26串行oracle命令全exit0；**34产物**逐字节复现（新2+旧32），旧32与previous paint快照一致；30 ANSI probes一致，真实layout.test.ts的15测试通过。完整native alt-screen/overlay suite仍缺离线`@xterm/headless`而未执行；4参考文件只读/哈希不等于执行。日志`2026-09-24-214425-component-clipboard-oracle-repro.log`。

21:46:28–21:46:30初次保护audit PASS；21:47:01–21:47:03重跑audit及独立previous archive-only verifier都通过：569旧archive/evidence/supplemental保持，**186非allow-list继承source/build、557所有非allow-list继承文件**字节不变；两个HEAD不变、index均空、历史删除仍缺失、全部9source hash等于gate witness、WORK_LOG旧前缀保留。日志`2026-09-24-214701-component-clipboard-protection-and-archive-retry.log`。archive-only不代表修改后live还等于previous。文档收尾后须最终`audit_component_clipboard.py --handoff`，以实际关闭日志为准。

### Failures
1. 初次oracle observer用了不存在lastSelectionClick/selectionPressedUrl；21:27对照实际字段修正为lastClick/pressedUrl并增加bounds/copyOnSelect，当时尚未安装expected或跑Rust。旧generator/manifest/fixture在`validation/component-clipboard-initial-oracle-forensics`，未改上游或生产。
2. `2026-09-24-213103-component-clipboard-initial-tests.log`：fmt过、clipboard测试7pass/1fail，跨行空白文本差异。`2026-09-24-213721-component-clipboard-trimend-retry.log`仍7pass/1fail：修复前guard误把历史已删除markdown_debug.rs算修改而退出，PowerShell又继续了测试；尽管名叫retry，当时尚未修复。所有pre-fix源/297-case oracle/manifest/generator留在`validation/component-clipboard-first-test-evidence`。Expected从未迎合Rust改写。
3. `2026-09-24-213827-component-clipboard-trimend-applied-retry.log`：正确处理historical deletion、精确2-file production修复、fmt和8tests全过；`2026-09-24-214001-component-clipboard-trimend-regression-oracle.log`生成58新增case；`2026-09-24-214031-component-clipboard-trimend-regression-tests.log`证明297前缀/旧Intl不变、安装新fixture、fmt和8tests全过。
4. `2026-09-24-214628-component-clipboard-protection-audit.log`：audit PASS，但后续独立verifier命令误用不存在的--checkpoint退出2（尚未验证archive）。21:47改为位置参数重试通过；没有修改verifier或archive，也不能把exit2称archive损坏。
5. **继承Vertex诊断不删除**：上一paint轮标准门禁曾失败1次（gemini-2.5-flash-lite Medium得到24576，预期8192）；之后5次isolated和原样四门禁retry通过，相关生产/测试未改。capture_simple取received_requests().last()等仅线索，**根因未证明**，不认定race/环境，也不声称已修复。本轮原样全门禁通过不改变该结论。完整旧失败/诊断/retry仍受保护。

### Remaining
- **不是完整TuiAltScreen/OS host。** Focus/Overlay/Gesture/Selection、Paint、clipboard Future/OSC52、flash controller及owning Container/MouseRegion/layout路由已存在，不重写成stub。full lifecycle/input filters/queue/key release/search/viewport/paste/render scheduling/compositor/legacy screen仍未全面接线。
- 本切片不是native clipboard adapter、实际OS送达验证、Rust Intl segmentation engine，也不是release task queue/eventloop完成。Selection clipboard组合目前non-scroll；完整ScrollView/layout/overlay集成仍需覆盖。Drop Future的取消差异明确；Rc/RefCell句柄非Send/Sync，timer必须同线程host queue，不能用ScrollView worker冒充Node eventloop。
- 真实doRender顺序search → indicator → overlays → selection → flashes → cursor/line resets/diff renderer尚未完整集成；flash controller的render不等于compositeFlashes已做。Focus restore_before_input仅焦点恢复块；frame发布需owning root，borrowed box仍有范围限制。
- visible insertion stack逆序决定focus owner，last rendered rectangle逆序决定hit；hit+decline不穿透，不重查hidden/removal；only focus=true改变focusTarget。Gesture capture优先pressTarget、移动sticky、release+click render OR不短路；Selection clear保留自身lastClick，勿混同Gesture history。
- 有限integer cells/UTF-8/native计数边界，不声明任意JS numbers/UTF16孤立surrogate/JS array identity等价；不支持任意self-reentrant callbacks、强引用环/cyclic child树/JS getter/options alias mutation。Kitty完整像素/placement/retransmission/deletion/iTerm2/probing未齐；marked18.0.5替代不可用18.0.11，完整source/transform/highlight/raw Component/grammar仍有缺口。
- M4全包、M5/M6、完整AgentHarness/dispatcher/MemorySessionRepo/Facade仍未完成；Lane12已有实现，不重写成stub。各更早“clipboard/selection/paint/focus尚缺”的说法属于历史状态，以本条范围为准。

### Handoff
- 新切片快照入口：workspace `.migration-handoff/checkpoint-2026-09-24-component-clipboard`。**封存是否完成以实际manifest.json/manifest.sha256/verification.json及外部component-clipboard-independent-verification-*.json成功收据为准**，文档不预写自身manifest hash。若快照尚未生成/核验未过，先完成封存，不能冒充已封存或直接开始新切片。
- previous：`.migration-handoff/checkpoint-2026-09-24-component-selection-paint`，2026-09-24T21:16:08+09:00封存，569present/1historical deletion，manifest SHA256 `af1a56f495847a3c0e32d2ffc92ac28374b12b8f8725ffb32c9ad4f56fbf1fde`。本轮entry外部`component-clipboard-entry-20260924-211719.json`21:17:20已验证全部archive/live/root/status/diff/HEAD/index；21:47 archive-only是追加复核，不是修改后live一致证明。
- `validation/component-clipboard-accepted-source.json`存9scope文件通过门禁后的原始hash。当前fixture5202543bytes SHA256 `c7c3effa66f27d5d3c9353b98811ca7f422a28fdd37ec2f33a5e5bbbe08f9918`；source-manifest3581bytes SHA256 `2d7340c8c3c3974e38a5aab009fc26f169a2fbfa4bd2aa2b741f39fcc1137f49`。
- WORK_LOG只能binary UTF-8 append；本轮217724byte保护前缀SHA256 `5be28a816ab8225414b34bcf5bd8d91467affda87bb3b9b2ef4d50fd5e27c192`；207211/188843/171829/155716/143371/128257历史前缀继续保护。WORK_LOG、TUI账本各4个历史U+FFFD保留，不新增、不批量修复。TUI仅替换顶部Current API status+追加，ORACLE只追加。
- 快照只是dirty-worktree备份，不是完整仓库；干净tracked `docs/ROADMAP.md`不在archive，别盲目当patch恢复。根交接只有workspace/MIGRATION_HANDOFF.md，不创建Rust根同名文件。封存前关闭所有日志；不能tee checkpoint或最终live verifier进repo日志；独立收据只写workspace `.migration-handoff`直属新文件。旧快照不可覆盖。

下一切片建议：**flash屏幕合成 + jump-to-end indicator绘制/点击**，复用本轮真实flash controller、既有composite_tui_line、owning ScrollHandle/真实LayoutFrame，逐步逼近完整compositor；不要继续把已完成clipboard/flash重写一遍。已只读检查上游tui-alt-screen.ts:479–482、1018–1024、1622–1656、1659–1680及测试位置；具体实施与源码oracle要求见NEXT_SLICE_PLAN.md。完整paste/搜索/事件循环后续另算。


### 2026-09-24T21:52:21+09:00 — final handoff/source audit receipt
2026-09-24 21:51:29–21:51:31+09:00 `audit_component_clipboard.py --handoff` PASS in `docs/migration/validation/2026-09-24-215129-component-clipboard-handoff-docs-and-audit.log`. Source witness9raw-byte hashes unchanged;186nonallow source/build and557all nonallow inherited files preserved;355cases/1881steps,34artifact hashes,frozen297prefixes,history/UTF8/ledger/root/HEAD/index/clean tracked ROADMAP checks passed. Exact trimEnd correction and all failed attempts remain disclosed;inherited Vertex cause NOT proven. Only this receipt is appended after those checks,no production/test/fixture changes. A final-state read-only audit will validate these receipts before creating the non-overwriting clipboard checkpoint. All command logs must close first;checkpoint/live verifier are not teed into repo logs. Sealing authority is the actual checkpoint manifest/verification plus external component-clipboard-independent-verification receipt. Full migration incomplete;goal active.


## 2026-09-24 component-screen-widgets acceptance

- 新 `src/tui/component_screen_widgets.rs`：`composite_flashes`复用真实AltScreenFlashContainer/render与composite_tui_line；只取最后height条，**height=0是JS slice(-0)=slice(0)，保留所有flash行**。无entries不补行，有entries才补齐；空width及image base等按实际源码处理。
- `ScrollToEndIndicator::composite`每次draw先清rect，依次检查label、follow_end配置/当前following、真实clip、row/image、scrollbar保留列；然后调用label、truncate/visibleWidth、floor居中。错误用Result传播，rect保持已清，不走fallback。
- 点击使用**上次发布rect**命中，但滚动**当前primary或implicit ScrollHandle**。真实scroll_to_end先发生，其自身render通知之后才explicit request_render；因此可能两次通知。点击不清rect，只在下一draw清除。
- signed geometry用i128中间运算，不提前clamp负origin。正列复用旧compositor；负列最小helper保留signed afterStart再提取可见graphemes。负row在JS是命名array property，Rust `IndicatorOutput.negative_row`单独暴露，不伪画到第0行。
- 真实完整源码oracle复制22modules、哈希4参考test文件（哈希不是执行）。**297场景/1094步**：flashes141/336、indicator57/237、clicks51/234、composed13/147、routing5/20、signed30/120。逐步比较return/error、screen/negative-row、rect、三个真实scroll状态、flash entries/nextId、layout几何及有序callback/render/flash-timer trace。6差分+3独立契约=9个新增Rust测试函数，不是297个函数。
- composed组执行真正renderLayoutFrame/VStack/ScrollView/dock；indicator/clicks/signed明确使用manual geometry seam。routing执行真实handleMouseEvent/ComponentGesture，但无关search/overlay/layout/scrollbar/paste/selection是trace/mock服务，不是完整native controller。Selection paint输入normalized bounds，不是完整鼠标selection组合；Scroll自动隐藏timer为non-delivered service，Flash timer单独记录/手动delivery。
- 继承source allow-list仅3文件：`src/tui/mod.rs`和`src/tui/tests.rs`各追加一个module；`src/tui/components/scroll_view.rs`仅追加只读follow_end getter，**不改ScrollView算法**。新production/test/fixture共3文件，总6source hash有gate witness。AI、Cargo/依赖、旧tests/fixtures/legacy host均未改。

2026-09-24 **22:28:18–22:28:40 +09:00** 四条原样标准命令全部exit0：
`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`、`cargo test --offline --all-targets`、`cargo test --offline --doc`。
all-targets **2472 passed =2436 lib+27 generator+9 CLI，0 failed，2历史CJK ignored**；doctests **5 passed，0 failed，1历史ignored**。本轮只新增9个测试函数。未改并发数、skip、断言或expected。

**验证环境条件不可省略：**此次通过显式给测试子进程设置 `NO_PROXY=localhost,127.0.0.1,::1`；不修改系统代理/父进程环境。使用 `python docs/migration/tools/run_component_screen_widgets_validation.py gates --loopback-no-proxy`；四条Cargo命令及overlay同时记录于`2026-09-24-222818-component-screen-widgets-gates.log`和`component-screen-widgets-gate-source-20260924-222818.json`。继承环境的首次门禁失败仍然是失败，不能称为原环境已修复。

22:29:01–22:30:15，28串行oracle命令全exit0；**36产物**逐字节复现（新2+旧34），旧34与clipboard快照一致；30 ANSI probes一致，真正layout.test.ts的15测试通过。日志`2026-09-24-222901-component-screen-widgets-repro.log`。完整native alt-screen/overlay suite仍缺离线`@xterm/headless`而**未执行**，4参考文件只读/哈希不等于执行。

22:32:04–22:32:05只读保护audit PASS：603旧archive文件及1历史删除保持，**192非allow-list继承source/build、593所有非allow-list继承文件**字节不变；两个HEAD/index、6source witness、冻结的fixture/generator/manifest、WORK_LOG前缀、成功/失败/AB证据均校验通过。日志`2026-09-24-223204-component-screen-widgets-audit.log`。本段是文档收尾前审计；还需最终`audit_component_screen_widgets.py --handoff`，以实际关闭日志为准。

First full gate416fail/4hung was stopped at22:24:26 with explicit process ownership evidence;serial AB sampledHTTP fail-pass-fail establishes current proxy-sensitive loopback transport. Only subprocess NO_PROXY isolated later gates;not an AI code fix. Initial oracle/compile/test-observer failures and frozen-before-tests corpus remain retained in validation. Full migration incomplete.

- **不是完整TuiAltScreen/OS host。**完整lifecycle/input filters/queue/key release/search/viewport/paste/render scheduling/compositor及legacy screen尚未全面接线。
- 真实doRender順序是search → indicator → overlays → selection → flashes → cursor/resets/diff；本轮只补flash/indicator阶段及有限组合，不声明完整搜索/overlay/native eventloop已完成。完整ScrollView/layout/overlay clipboard组合、release任务队列、native clipboard/OS送达、Rust Intl segmentation engine仍需实现。
- 有限可表示integer cells/UTF-8/native计数边界；不声明任意JS numbers、输入array identity/properties、lone UTF16 surrogates等价。不支持任意self-reentrant callbacks、强引用环/cyclic child树/JS getter/options alias mutation。Rc/RefCell控制器非Send/Sync；timer必须同线程host queue，不用ScrollView worker冒充Node eventloop。
- Kitty完整像素/placement/retransmission/deletion/iTerm2/probing未齐；marked18.0.5替代不可用18.0.11，完整source/transform/highlight/raw Component/grammar仍有缺口。
- M4全包、M5/M6、完整AgentHarness/dispatcher/MemorySessionRepo/Facade仍未完成；Lane12已有实现，不重写stub。历史文档中缺flash screen/indicator/clipboard/paint等说法仅代表当时状态。


## 2026-09-24T23:19:07+09:00 — AltScreenSearchIndex pure index slice

- 新 `src/tui/alt_screen_search_index.rs`：实际corpus/query/index/find/key实现。先按原UTF16 units剥离terminal sequences；ASCII按non-space run，非ASCII按Rust Unicode17 grapheme构建span；空白/行间压缩separator，列按真实width计算。ASCII命中可裁切列，非ASCII命中grapheme一部分仍映射整个grapheme；相邻同row段合并。
- 匹配是literal Unicode simple-case-insensitive的非重叠KMP，token是Unicode code point，offset保留原UTF16位置；不是lowercase substring、full/locale folding、Unicode normalization或可执行regex。新 `simple_case_fold.rs`来自Unicode17 CaseFolding.txt的1512个C/S映射，不是从expected搜索输出提取表。既有regex-syntax0.8.11是Unicode16，故不直接拿它冒充当前Node17匹配。
- `Utf16Text`入口保留lone surrogates，剥ANSI可以重新拼成合法surrogate pair；lone surrogate不匹配有效pair的半边、不当作U+FFFD输出。mapped replacement view只用于分词边界；真实单位用于存储、宽度和匹配。UTF8便捷入口对良构字符串无损。
- cache比较source原始字符串内容/长度，复制source输入；normalized query字面变化才重算（大小写变化仍changed）。`SearchMatches`、match、segments array、segment对象是四层独立Rc/RefCell identity；cache hit返回相同array，重算产生新array但保留旧alias。支持外部改array和嵌套segment、replace segments/detach后的别名，不用克隆Vec假装JS identity。
- 22完整上游模块离线复制/哈希，实际调用未改动`alt-screen-search.ts:1–196`；读取private corpus是观察，不是替代算法。**3069场景**：3058 standalone search+7cache sequences（76操作）+4keys；10差分+7独立契约=**17个新Rust测试函数**，不是3069测试函数。包含1512simple folds、766 Unicode17 GraphemeBreakTest/真实Intl边界、185raw UTF16、384固定seed混合输入等。
- oracle冻结前审查并验证实际Node Intl与766标准分词输入一致；Rust在运行时自行分词/宽度/匹配，不注入oracle graphemes或matches。本轮证明这些覆盖输入一致，**不是完整Intl API/locale/word-segmentation全域证明**。
- 继承source allow-list仅4文件：`src/tui/mod.rs`、`src/tui/tests.rs`各加module；`src/tui/utils.rs`加一个CRLF re-export；`src/tui/utils/utf16.rs`只追加共享现有ansi_length的raw strip helper。旧width/wrap/ScrollView/AI/Cargo/旧fixture/test算法不改。

最终当前源码于2026-09-24 **23:10:51–23:11:52 +09:00**通过四条原样标准命令：
`cargo fmt --all -- --check`、`cargo clippy --offline --all-targets -- -D warnings`、`cargo test --offline --all-targets`、`cargo test --offline --doc`，全exit0。
all-targets **2489 passed =2453 lib+27 generator+9 CLI，0 failed，2历史CJK ignored**；doc **5 passed，0 failed，1历史ignored**。新增17测试函数；不修改线程数/skip/断言/expected。

**环境条件不可省略：**runner仅给门禁子进程显式设置 `NO_PROXY=localhost,127.0.0.1,::1`，不更改系统代理或父环境。日志`2026-09-24-231051-alt-screen-search-gates.log`，witness`alt-screen-search-gate-source-20260924-231051.json`。普通复现命令：`python docs/migration/tools/run_alt_screen_search_validation.py gates --loopback-no-proxy`。

23:12:41–23:13:55，31个串行oracle/verify命令全exit0；**39产物byte-identical（新3+旧36）**，30 ANSI probes与previous一致，实际`layout.test.ts`15测试通过。日志`2026-09-24-231241-alt-screen-search-repro.log`。新3是fixture/source-manifest/general runtime fold table。完整native alt-screen suite因缺离线`@xterm/headless`仍**未执行**；reference test哈希和3个纯索引具名Rust契约不是native suite执行。

23:15:16–23:15:17只读保护audit PASS：647旧archive文件/1历史删除、**194非allow-list source/build和636所有非allow-list继承文件**字节不变；两个HEAD/index、8source witness、冻结expected/generator/table、历史WORK_LOG前缀及失败证据通过。日志`2026-09-24-231516-alt-screen-search-audit.log`。这是文档收尾前audit；最终还要`audit_alt_screen_search.py --handoff`，以实际关闭日志及独立封存收据为准。

- **本轮真实失败必须保留：**首17测试及23:03:20第一轮门禁通过，但23:09:11保护audit在`utils.rs`精确字节比较失败：新增import混入LF，首次cargo fmt把旧CRLF工具文件整体规范成LF。去掉新import后，其余内容严格等于旧CRLF→LF转换，没有功能变化。`alt-screen-search-crlf-audit-evidence`保留pre-fix源码/auditor/原acceptance/repair收据；失败日志`2026-09-24-230911-alt-screen-search-audit.log`未删。恢复原CRLF+一个CRLF import，**不放宽audit**；再跑四门禁和31命令repro，当前receipt指向修复后source witness。两轮source witness只有utils.rs字节不同；fixtures/generator/table和其他7source一致。
- 标准源/Unicode license的只读HTTPS获取：`2026-09-24-225033-alt-screen-search-unicode-acquisition.log`与`reference/alt-screen-search-index/unicode/acquisition.json`记录URL/bytes/hash；没有下载或升级Cargo/npm依赖，测试/oracle重放均离线。
- **继承screen-widgets环境失败仍是失败：**`2026-09-24-221422-component-screen-widgets-gates.log`有416FAILED/4个Radius持续未结束；仅在核对PID归属后结束owned test进程，logger4294967295，doc未跑。AB日志222713显示同HTTP样本inherited fail101→child NO_PROXY pass0→inherited fail101；另外3样本bypass通过。未逐项抓包归因416失败，不知道系统代理变化时间，没修AI/系统代理/并发/skip。不要说已修复原环境。Radius无timeout位置只是风险，没有所有挂起栈证明。
- 历史222359/222424进程终止`.ps1`是不可重放取证记录，**不要执行**。更早paint的Vertex单次失败root cause仍未证明；5isolated和原样retry通过不算修复证明。

- **不是完整TuiAltScreen/OS host。**Search UI（本轮仅index/find/key）、刷新/匹配导航定位、highlight paint、lifecycle/input filters/queue/key release/viewport/paste/render scheduling、完整compositor/legacy screen仍未全面接线。真实doRender顺序search→indicator→overlays→selection→flashes→cursor/resets/diff，不能把已有独立API说成全host集成。
- 新search的rawUTF16支持不代表全TUI/API/OS边界均支持raw units；新search分词有真实Unicode17覆盖，但完整Intl/locale/word API、旧clipboard Selection Intl服务seam仍需分别完成。typed dense arrays/非负可表示cells不等价任意JS数值/sparse array/named properties/getters/cyclic对象。
- Rc/RefCell控制器及search handles是同线程API；外部冲突借用须释放，不保证Send/Sync、自重入回调或Node eventloop。Clipboard已实现真实eager service/owned Future/OSC52，但host需持有/poll Future，drop会取消continuation；native clipboard/OS送达仍未完成。
- 已有owning Container/layout/ScrollView/Gesture/Overlay/Focus/Selection/paint/flash/indicator/clipboard不可回退或stub化。Flash height=0保留所有flash行；indicator click命中旧rect但滚动当前primary/implicit，可能两次render通知。旧材料“尚缺这些组件”只是历史状态。
- Kitty完整像素/placement/retransmission/deletion/iTerm2/probing未齐；marked18.0.5替代不可用18.0.11，完整source/transform/highlight/raw Component/grammar仍有缺口。
- M4全包、M5/M6、完整AgentHarness/dispatcher/MemorySessionRepo/Facade仍未完成；Lane12已有实现，不重写成stub。


## 2026-09-25T00:04:16+09:00 — alt-screen-search-component 已验证，收尾后暂停

- Actual owning SearchComponent drives existing Input, focus/query callback, three-row border/result, dynamic keybindings/key labels, style order and last-render half-open navigation rect;1513 scenarios/11770 ops. Rust16 new test functions, not1513 tests. No pre-rendered Input substitution.
- Shared scalar+VS16 runtime RGI supplement: exhaustive1112064 scalar probes/207 bases;1606 actual-source width/truncate/slice cases. Fixes inherited ©️ width1→2;old3331 table/128360 fixtures/Input/index retained unchanged. Exact2 CRLF-safe utils edits plus mod registration;5 new source/data/test files.
- Final2505 all-target passed=2469lib+27generator+9CLI;2 historical ignored;docs5pass/1 historical ignored. Child-only NO_PROXY=localhost,127.0.0.1,::1.34repro commands/44 byte-identical artifacts/30ANSI probes/15native layout tests. Initial14 tests10pass/4fail are retained;5unicode mismatches fixed in generic width,3new independent assumptions corrected using actual-source probes;UI expected frozen unchanged.
- First full gate2468pass/1Vertex missing-project fail/2ignored;isolated and unchanged full retry passed,root cause not established. Historical416fail/4hung/proxy AB,index CRLF failure and network provenance remain. Evidence:validation/search-component-acceptance.json and reference/alt-screen-search-component/README.md.
- Valid UTF8 UI/safe result integers only, no full host search lifecycle/native alt-screen suite/OS clipboard/fullIntl. FullM4/M5/M6/Harness integration still incomplete. User requires暂停 after seal;do not start next slice.
