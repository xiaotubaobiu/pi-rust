# Markdown differential oracle

Runs the actual read-only `pi/packages/tui/src/components/markdown.ts` at full
HEAD `5901446094988aa5cd8e11efdaa131c3949106f1` in scratch. Expected output is
never generated from the Rust renderer. No network or real providers.

## Reproduce offline

From the pi-rust root:

```powershell
& C:/Users/13063/anaconda3/node.exe docs/migration/reference/markdown/run.mjs
```

Requires Node type stripping (validated with v25.8.2). Optional positional
arguments: pi root, dependency root, scratch directory. Defaults: sibling pi,
sibling `.migration-handoff/reference-deps`, and `target/markdown-oracle`.
The bootstrap checks the exact upstream HEAD and rejects scratch directories
whose resolved existing ancestor is inside pi. It writes only to scratch.

Offline dependencies (package directories or npm tarball `package/` layout):
marked18.0.5, chalk5.6.2, get-east-asian-width1.6.0. **Upstream pins marked18.0.11;
18.0.5 is an explicitly disclosed substitute, not exact-version parity.**
Dependency licenses remain in the cache; lexer/theme attribution and licenses
are retained in MARKED-LICENSE.txt and CHALK-LICENSE.txt. Upstream MIT license
is also retained in `../latex/PI-LICENSE.txt`.

## Six output artifacts

| Scratch output | Stored copy | Scope |
|---|---|---|
| fixtures.json | src/tui/markdown_fixtures.json | Original94 cases (82 inherited +12 resumed regressions); unchanged bytes; four upstream literal checks |
| utf16-fixtures.json | src/tui/markdown_utf16_fixtures.json | 2880 Markdown cases with actual raw units, final UTF-8 encoding and raw visible widths |
| utf16-wrap-fixtures.json | src/tui/utils/utf16/wrap-fixtures.json | 2152 direct upstream raw ANSI-wrap cases |
| source-fixtures.json | src/tui/markdown_source_fixtures.json |3702 final-output cases from1234 source/lexer seeds;three widths/styles/hyperlink configurations |
| source-utf16-fixtures.json | src/tui/markdown_source_utf16_fixtures.json | 2688 raw-source cases: exact units, widths, final encoding, callback transforms, six layout contexts and cache |
| inline-tail-fixtures.json | src/tui/markdown_inline_tail_fixtures.json | 48 actual marked lexInline cases:24 prefixes × high units d800/dbff; raw/text/href/recursive children; internal prefix+tail representation only |
| source-manifest.json | docs/migration/reference/markdown/source-manifest.json | Four upstream TS hashes, exact HEAD, generator hash, Node/dependency versions, artifact SHA-256/bytes/counts |

Compare all seven files byte-for-byte after generation. Copying scratch output
to stored fixtures is a deliberate, separate action, not performed by run.mjs.
Never replace expected values with Rust output or normalize malformed units.
Original fixture SHA-256:
`92c51fd3c0e41d61e4db25f31da779d70624877486339790021ae54858d18d38`.
Raw Markdown SHA-256:
`e27e659cc0ed24d6a8115ce0304c5dd1e7b0bbf12bf13bced2379091e467a131`.
Raw wrap SHA-256:
`23dde87043952907c8ee6ec860b8588fd4ad27ed5cb13960d3d4e1d4012781d9`.

2880 cases = six formulas ×10 contexts ×eight widths ×six styles. Contexts
include inline/paragraph/strong/italic/heading/quote/list/table/display/link;
widths1,2,3,4,5,8,14,30; styles include none,bold,grayItalic,bgBlue plus raw
unit-counting and code-unit-reversing callbacks. Padding and OSC8 are included.
Rust also checks render cache hits and invalidate. The raw wrapper sweep
includes lone/pair/reversed surrogates, genuine U+FFFD, combining/prepend marks,
CJK, private-use literals, tabs/CRLF/U+FEFF, malformed CSI, raw OSC8 URL/params
with BEL/ST, width0 and seeded compositions. These are fixture rows, not Rust
test functions or a complete marked compliance suite; corpora overlap.

## Source/lexer corpus and reproducible checks

1234 inputs are rendered at width12/plain/no hyperlinks, width40/grayItalic/no hyperlinks, and width24/plain/hyperlinks. Coverage includes full/collapsed/shortcut reference links and images, labels/whitespace/case, destinations/titles/parenthesis tails, HTML declarations/attributes/raw tags/blank lines/unclosed blocks, heading/setext/table JS line terminators, code-fence info, math guards/pending commands and selected astral source text. This is a bounded differential corpus, not the entire marked compliance suite.

Expected lines are actual upstream Markdown output encoded through Node Buffer UTF-8, matching the public String-returning boundary. No Rust-derived expectation or skip whitelist. The source test aggregates every mismatch/panic and fails if any occur. Source fixture SHA-256:
`70ab4e9baa662095c5de2da61a80d5338cc061a62ad8fe41680436e19a4fdf61`.

To regenerate both oracles and verify all twelve artifacts without installing anything:
```powershell
& C:/Users/13063/anaconda3/node.exe docs/migration/reference/markdown/run.mjs
& C:/Users/13063/anaconda3/node.exe docs/migration/reference/latex/run.mjs
& C:/Users/13063/anaconda3/python.exe docs/migration/tools/verify_tui_oracles.py --previous ../.migration-handoff/checkpoint-2026-09-24-markdown-link-units
```
The optional `--previous` argument also checks the three older Markdown and five LaTeX artifacts against that immutable snapshot, plus the complete2538-case source and1152-case raw-source prefixes. Prior internal-tail token prefixes are also checked when available. Paths are centralized in this read-only verifier; notably the LaTeX domain ledger is in reference/latex, not src/tui/latex.

## Verified representation and deliberate callback API change

The red case `$\sqrt😀$` at width1 was an early-encoding layout error:
old lines `["√", "(", "�", ")", "�"]` versus upstream's
`["√", "(�", ")�"]`. The retained red log gives the exact original case.

Markdown now consumes the raw LaTeX API. `Utf16Text` and
`Markdown::render_utf16(width) -> Vec<Utf16Text>` preserve real units through
inline/block rendering, styles, lists/quotes/tables, ANSI wrapping, padding,
background and cache. No colliding surrogate sentinel is used. The convenience
`Markdown::render(width) -> Vec<String>` encodes lossily only after this layout.

**Markdown StyleFn intentionally changes to**
`Arc<dyn Fn(&Utf16Text) -> Utf16Text + Send + Sync>`. Other components' own style
aliases are unaffected. Callers should concatenate units, not stringify them:

```rust
use std::sync::Arc;
use pi_rust::tui::components::markdown::StyleFn;
use pi_rust::tui::utf16::Utf16Text;

let cyan: StyleFn = Arc::new(|text| {
    let mut result = Utf16Text::from("\x1b[36m");
    result.push(text);
    result.push("\x1b[39m");
    result
});
```

There is intentionally no Display implementation. Use `as_units`/`into_units`
for raw access, `to_string_checked` for a fallible UTF-8 conversion, or explicitly
choose `to_string_lossy` at an intended encoding boundary. UnitCount and
reverseUnits oracles prove callbacks inspect/transform actual units, rather
than a lossy adapter guessing ANSI prefixes. Helper split/replace require a
nonempty search sequence and document that precondition.

The new cases also caught a pre-existing table-prefix bug: only an explicit
outer styleContext is restored after wrapping a cell, not implicit default
styling. The raw wrapper reuses the exact JS trim set, not Unicode separator
categories alone. Both failures and the fixes are recorded.

## Inline-link source-unit boundary

The public source API still takes UTF-8, but marked's inline-link raw substring
can split a valid astral input. For example, `[a](  😀)tail)` leaves a lone low
surrogate in the remaining source because the cut ignores leading href whitespace.
The Rust lexer now computes this cut in UTF-16 units, retains both raw token
spans losslessly, and continues the remaining low surrogate as part of an exact
text token. It does not floor the boundary or render a replacement character early.

Additive `Token.raw_utf16` and `Token.text_utf16` fields override the legacy
String display views when present. Source reconstruction must use the raw override,
not `raw.len()`; Markdown styles/layout consume the text override. This does
not make all lexer hooks or arbitrary raw-source inputs UTF-16-native.

The2688 raw-source cases comprise28 seeds × six contexts (plain/strong/quote/list/
heading/table) × widths1,2,12,40 × four styles (none,bgBlue,unitCount,reverseUnits).
They include a retained low surrogate immediately before emphasis, math, code and
reference starts. Each case checks actual units, raw widths, final UTF-8, cache and
invalidation. New fixture SHA-256:
`a85dddadcb30c563ebfa94d65f8c6effe4a51ce6ede5b4a0877075cef9138d9c`.

## Emphasis tails and one-pass raw-width normalization

Non-punctuation masks and emphasis delimiters now count/clip/index UTF-16 units,
not UTF-8 bytes/scalars. The909-case initial red included `*a* [😀](/x)`.
Some upstream emphasis cuts leave a real high surrogate in recursive content.
The private recursive representation is a valid UTF-8 prefix with at most one
trailing high unit, not a public arbitrary raw-source API. Its48-case token
corpus also checks URL/backpedal, href, email, tags, links, escapes and emphasis.
Token.href_utf16 overrides the legacy href display view when needed. The new
LexerExtensions::inline_tokenizer_with_tail defaults to the legacy UTF-8 hook;
unknown extensions are not claimed to handle this raw boundary losslessly.
Markdown's own hook retains pending LaTeX raw/text units and link URL styles.
Internal-tail fixture SHA-256:
`38b4d0a6b9ae9bf92640493c5bbfb196f817d26e713407aaa4b7b2f3e83ef8b6`.

Removing ANSI may bring two originally isolated surrogate units together.
Raw visible width now expands tabs and strips ANSI once on actual units before
UTF-16 decoding/segmentation. The recognizer is shared with raw wrapping.
A second strip would be wrong if the first pass forms a fresh ESC sequence.
Run the independently retained30-case upstream probe after run.mjs:
```powershell
& C:/Users/13063/anaconda3/node.exe --experimental-strip-types docs/migration/reference/markdown/probe-ansi-rejoin.mjs
```
Its exact output is retained in `../../validation/2026-09-24-1454-ansi-rejoin-once-upstream.json`.

## Evidence and limitations

- Markdown17 tests (16 component +1 lexer), raw-width4 tests, raw-wrap1 test pass; `cargo test --lib markdown` matches21 due to4 other historical test names. Source3702/raw-source2688/tail48 are case rows, not test functions.
- Full gates14:57:23–14:58:24:fmt, strict Clippy, all-targets2373 passed (2337 lib +27 generate-models +9 pirs),0 failed,2 historical CJK ignored; doctests5 passed,1 historical ignored. Log:`../../validation/2026-09-24-145723-markdown-mask-coordinates-full-gates.log`.
- Seven Markdown +five LaTeX artifacts reproduced byte-identically14:59:02–14:59:05;8 historical artifacts and2538/1152 complete prefixes unchanged. Log:`../../validation/2026-09-24-145902-markdown-mask-coordinates-oracle-repro.log`.
- Retained initial red:`2026-09-24-142704-markdown-mask-coordinates-red.log` (909 differences/303 seeds,0 panics). Raw-source all-failures red:`2026-09-24-144814-markdown-emphasis-raw-all-red.log` (30 width/layout failures); width-unit red:`2026-09-24-145421-ansi-rejoin-unit-red.log` (expected2, actual0). All repaired without changing upstream expectations. Earlier red/green and corrected generator syntax failure remain in WORK_LOG/validation.

Source input, transform/highlight and Component APIs still use UTF-8; unknown
stateful callback invocation order, complete raw-tag/reference/backtick grammar
and arbitrary malformed raw-source inputs remain unproven. This is not full
marked/pinned18.0.11, whole-TUI/OS-boundary or full pi migration completion.
The next independent M4 slice is missing stack/h-stack allocation/layout.
