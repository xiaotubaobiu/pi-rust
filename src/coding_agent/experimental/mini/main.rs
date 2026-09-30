//! Port of upstream `mini/main.ts` (the `mini` command parser).

use super::tui_view::TuiOptions;

/// Upstream `parseArgs`: `--continue`/`-c`; anything else fails.
pub fn parse_args(argv: &[String]) -> Result<TuiOptions, String> {
    let mut options = TuiOptions::default();
    for arg in argv {
        match arg.as_str() {
            "--continue" | "-c" => options.continue_session = true,
            other => return Err(format!("Unknown argument: {other}")),
        }
    }
    Ok(options)
}
