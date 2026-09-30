//! Port of upstream `micro/main.ts`: the argument parser.

use super::runtime::OpenMicroOptions;

/// Upstream `parseArgs`: `--continue`/`-c` flags; anything else fails with
/// the exact upstream error.
pub fn parse_micro_args(argv: &[String]) -> Result<OpenMicroOptions, String> {
    let mut options = OpenMicroOptions::default();
    for arg in argv {
        match arg.as_str() {
            "--continue" | "-c" => options.continue_session = true,
            other => return Err(format!("Unknown argument: {other}")),
        }
    }
    Ok(options)
}
