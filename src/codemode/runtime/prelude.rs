//! Port of upstream `codemode/src/runtime/prelude-source.ts` — the JavaScript
//! evaluated inside the VM before the script runs.
//!
//! [`PRELUDE_SOURCE`] is **byte-exact**: it is embedded from
//! `tests/fixtures/codemode_oracle/src/runtime/prelude.js`, a file generated
//! from the verbatim upstream `prelude-source.ts` (its interpolation of
//! `MAX_STORE_VALUE_CHARS` / `MAX_STORE_TOTAL_CHARS` /
//! `JSON.stringify(IMAGE_HELPER_EXPECTS)` already applied) by
//! `tests/fixtures/codemode_oracle/gen_prelude.tmp.mjs`. The upstream
//! doc-comment of the prelude applies unchanged: it keeps the host bridge in
//! a closure, builds `tools`, `ALL_TOOLS`, the output helpers (`text`,
//! `image`, `exit`, `console`), and `store`/`load`, evaluates to
//! `(bridge, toolsJson, globalsJson, storeJson) => { settle, run, stalled }`,
//! and `stalled()` reports scripts waiting on promises nothing can resume.

/// Upstream `MAX_STORE_VALUE_CHARS` (256 KiB characters of JSON per value).
pub const MAX_STORE_VALUE_CHARS: usize = 256 * 1024;
/// Upstream `MAX_STORE_TOTAL_CHARS` (1 MiB characters of JSON in total).
pub const MAX_STORE_TOTAL_CHARS: usize = 1024 * 1024;

pub const PRELUDE_SOURCE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/codemode_oracle/src/runtime/prelude.js"
));

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prelude_mentions_the_expected_helpers() {
        assert!(PRELUDE_SOURCE.contains("function store(key, value)"));
        assert!(PRELUDE_SOURCE.contains("settle(id, ok, payload)"));
        assert!(PRELUDE_SOURCE.contains(&MAX_STORE_VALUE_CHARS.to_string()));
        assert!(PRELUDE_SOURCE.contains(&MAX_STORE_TOTAL_CHARS.to_string()));
        assert!(PRELUDE_SOURCE.contains("image expects a non-empty image URL string"));
    }
}
