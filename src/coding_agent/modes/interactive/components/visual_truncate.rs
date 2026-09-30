//! Component glue mirrors upstream callback signatures whose types are
//! inherently wide; factoring each into an alias adds no information.
#![allow(clippy::type_complexity)]
//! Port of `modes/interactive/components/visual-truncate.ts` (50 lines, sha256
//! `05eb9a43fb379e54d677622a287a865e3be6cce185e60332e367f2432e4e37b5`):
//! width-aware tail truncation shared by tool-execution and bash-execution.

use crate::tui::component::Component;
use crate::tui::components::text::Text;

/// Upstream `VisualTruncateResult`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VisualTruncateResult {
    /// The visual lines to display.
    pub visual_lines: Vec<String>,
    /// Number of visual lines that were skipped (hidden).
    pub skipped_count: usize,
}

/// Truncate text to a maximum number of visual lines (from the end), accounting
/// for line wrapping at the terminal width (upstream `truncateToVisualLines`).
///
/// `padding_x` mirrors the upstream `paddingX` Text parameter: `0` when the
/// result will be placed in a Box (the Box adds its own padding), `1` for a
/// plain Container.
pub fn truncate_to_visual_lines(
    text: &str,
    max_visual_lines: usize,
    width: usize,
    padding_x: usize,
) -> VisualTruncateResult {
    if text.is_empty() {
        return VisualTruncateResult {
            visual_lines: Vec::new(),
            skipped_count: 0,
        };
    }

    // Temporary Text component to render and get visual lines.
    let mut temp_text = Text::with_options(text, padding_x, 0, None);
    let mut all_visual_lines = temp_text.render(width);

    if all_visual_lines.len() <= max_visual_lines {
        return VisualTruncateResult {
            skipped_count: 0,
            visual_lines: all_visual_lines,
        };
    }

    let skipped_count = all_visual_lines.len() - max_visual_lines;
    let visual_lines = all_visual_lines.split_off(skipped_count);
    VisualTruncateResult {
        visual_lines,
        skipped_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Oracle: scratch/interactive_r19_oracle scenario `visual_truncate` —
    /// byte-identical against the real upstream `Text` wrapping.
    #[test]
    fn matches_oracle() {
        let long = (0..30)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        // 12 words, exactly as in the oracle scenario
        let wrap = "word ".repeat(12).trim_end().to_string();
        let pad40 = |s: &str| format!("{s:<40}");

        let empty = truncate_to_visual_lines("", 5, 40, 0);
        assert_eq!(empty.visual_lines, Vec::<String>::new());
        assert_eq!(empty.skipped_count, 0);

        let abc = truncate_to_visual_lines("a\nb\nc", 5, 40, 0);
        assert_eq!(abc.visual_lines, vec![pad40("a"), pad40("b"), pad40("c")]);
        assert_eq!(abc.skipped_count, 0);

        let five = truncate_to_visual_lines("a\nb\nc\nd\ne", 2, 40, 0);
        assert_eq!(five.visual_lines, vec![pad40("d"), pad40("e")]);
        assert_eq!(five.skipped_count, 3);

        let tail = truncate_to_visual_lines(&long, 3, 40, 1);
        assert_eq!(
            tail.visual_lines,
            vec![pad40(" line 27"), pad40(" line 28"), pad40(" line 29")]
        );
        assert_eq!(tail.skipped_count, 27);

        let wrapped_pad1 = truncate_to_visual_lines(&wrap, 2, 20, 1);
        assert_eq!(
            wrapped_pad1.visual_lines,
            vec![
                format!("{:<20}", " word word word"),
                format!("{:<20}", " word word word"),
            ]
        );
        assert_eq!(wrapped_pad1.skipped_count, 2);

        // paddingX = 0 keeps lines unindented (Box provides its own padding);
        // rows are padded to the render width (20), not the 40 used above.
        let wrapped_pad0 = truncate_to_visual_lines(&wrap, 2, 20, 0);
        assert_eq!(
            wrapped_pad0.visual_lines,
            vec![
                "word word word word ".to_string(),
                "word word word word ".to_string()
            ]
        );
        assert_eq!(wrapped_pad0.skipped_count, 1);
    }
}
