# Actual-source clipboard + flash oracle

## Authority and scope
The pinned read-only `pi` HEAD is `5901446094988aa5cd8e11efdaa131c3949106f1`. `run.mjs` copies22 complete upstream modules and the already-offline `get-east-asian-width@1.6.0`, then executes the real `TuiAltScreen` clipboard/public-selection methods and real `AltScreenFlashContainer`. No reference clipboard/base64/selection/flash algorithm is hand-transcribed. Four upstream test files are consulted and hashed, **not executed** here; full native alt-screen tests remain unavailable offline because `@xterm/headless` is missing. Scratch defaults to `target/component-clipboard-oracle` and refuses any path inside pi.

## Corpus and observations
**355 cases /1881 steps**: delivery35/151, osc52 97/291, selection85/501, flashes128/748, sequences10/190. Five differential Rust functions and three independent contracts are eight new tests, not355 independent test functions. Every operation compares its return, before-drain state/ordered trace, and quiescent state/ordered trace: tasks (pending/ready/error), flash entries and nextId, timer status, real Selection points/bounds/text/copyOnSelect/click state. Initial297cases/1533steps remain an exact prefix in every group;58 additional cases cover25 trim whitespace codepoints and4 non-trim counterexamples across injected and OSC52 paths while preserving leading whitespace.

Coverage includes ready/deferred true/false/empty and nonempty message/other JS values; synchronous throw, rejected and deferred-rejected promises, first-settlement wins, no fallback on injection failure; terminal/flash failures; UTF-8 standard base64 padding and long Unicode input; actual select/drag/release/public copy, copyOnSelect, clear/screen changes while pending, double/triple clicks; stacked flash render with ANSI/OSC8/Unicode/zero-width text, duration default/negative/fractional/NaN/infinities, dispose and duplicate/out-of-order expiry; three concurrent deliveries and manual flashes. The Rust clipboard host delegates flash handling to the actual new controller, not a message-only stub. Independent tests verify eager initiation versus awaited flash, owned Rc host without mutable borrows across await, rejection propagation, and container-owned timer identity (including numeric-id collisions).

Installed fixture5202543 bytes SHA256 `c7c3effa66f27d5d3c9353b98811ca7f422a28fdd37ec2f33a5e5bbbe08f9918`; source-manifest3581 bytes SHA256 `2d7340c8c3c3974e38a5aab009fc26f169a2fbfa4bd2aa2b741f39fcc1137f49`. Metadata captures generator and all upstream source/reference-test hashes.

## Explicit seams and limitations
- Source uses the complete actual TuiAltScreen instance; constructor trace is cleared before operations, so this is **not** lifecycle coverage. Actual Selection is exercised with an empty component tree, no overlays and no scroll frame; this slice does not claim real ScrollView/layout clipboard composition.
- Clock, terminal, copy service, timer queue and34 recorded Intl word-segmentation inputs are host services. Those inputs are not a Rust ICU implementation. No actual clipboard, credentials, network, terminal startup or URL opening occurs.
- JS snapshots precede a16-microtask quiescence drain; Rust retains real oneshot futures and polls its pending tasks at the analogous explicit boundary. Arbitrary microtask interleavings/event-loop equivalence are **not** claimed. The release-only queue tracks nonempty initiated operations; public empty selection returns false and is tested separately.
- Rust calls injection synchronously before returning its completion Future, captures active text at invocation, and requires the single-threaded host to retain/poll pending operations. Dropping an uncompleted Rust Future cancels its continuation unlike discarding a JS Promise. No mutable selection or host borrow is held across await.
- Flash timing models schedule → unref → insertion → render request and id-based expiry; NaN behavior is retained. Node timer coercion, native clipboard tools, full render scheduling/compositor, OS integration and legacy screen remain future work. Timer callbacks must queue to the owning non-Send host; no synchronous reentry during scheduling. Call dispose before discarding the controller.
- Valid UTF-8, finite integer selection cells and native usize/u64 counters are supported; no arbitrary JS-number or lone-surrogate equivalence claim. OSC52 success only means write/flash completed, not verified native clipboard acceptance.

## Failures retained and narrow fix
The first observer scaffold read nonexistent lastSelectionClick/selectionPressedUrl; inspection corrected these to actual lastClick/pressedUrl and added bounds/copyOnSelect before Rust tests ran. Original output/generator/manifest remain in `validation/component-clipboard-initial-oracle-forensics`.

The first Rust comparison then exposed a real inherited Selection defect: category-only trimming left TAB and other JS trim whitespace. The frozen actual-source expected was NOT edited. `utils.rs` only exposes its existing exact js_trim_end helper as pub(crate); `component_selection.rs` imports/calls it. No other old algorithms/tests/fixtures change. The first pre-edit guard incorrectly counted the historical markdown_debug.rs deletion as a modification and aborted before writes; a mislabelled retry consequently repeated the same failure. The corrected guard and subsequent applied repair passed all8 tests. Original sources, full297-case corpus and generator/manifest are retained in `validation/component-clipboard-first-test-evidence`; the verifier always checks their expected prefix. After that acceptance,58 new cases were appended and passed. Full logs/receipts are in WORK_LOG and the slice record.

## Offline reproduction (from pi-rust)
```powershell
C:/Users/13063/anaconda3/node.exe docs/migration/reference/component-clipboard/run.mjs
C:/Users/13063/anaconda3/python.exe docs/migration/tools/verify_component_clipboard_oracle.py --previous ../.migration-handoff/checkpoint-2026-09-24-component-selection-paint
cargo test --offline --lib tui::tests::component_clipboard -- --nocapture
```
The verifier is read-only, never installs fixtures and never changes expected data. Full four-gate/oracle/protection outcomes are recorded separately. Full M4/full migration are **not complete**.
