//! Component glue mirrors upstream callback signatures whose types are
//! inherently wide; factoring each into an alias adds no information.
#![allow(clippy::type_complexity)]
//! Port of `modes/interactive/components/user-message.ts` (70 lines, sha256
//! `234d4f2544a0cb60082a6012a63576cdda4e9f99cdd0560129dd1efe5c6c7b1d`):
//! renders a user message (Markdown in a padded, background-colored Box) with
//! OSC-133 shell-integration zone markers.

use std::sync::Arc;

use crate::coding_agent::modes::interactive::components::markdown_transform::{
    create_markdown_transform, MarkdownTransformer,
};
use crate::coding_agent::modes::interactive::components::support::{
    plain_markdown_theme, MessageBgBox, OSC133_ZONE_END, OSC133_ZONE_FINAL, OSC133_ZONE_START,
};
use crate::coding_agent::modes::interactive::theme::Theme;
use crate::tui::component::Component;
use crate::tui::components::markdown::{DefaultTextStyle, Markdown, MarkdownTheme};
use crate::tui::utf16::Utf16Text;

/// Upstream `UserMessageComponent`.
pub struct UserMessageComponent {
    box_: MessageBgBox,
    text: String,
    /// Upstream defaults to the process-global `getMarkdownTheme()` (theme
    /// seam D1); the port threads a theme factory through.
    markdown_theme_factory: Arc<dyn Fn() -> MarkdownTheme + Send + Sync>,
    output_pad: usize,
    markdown_transformers: Arc<Vec<MarkdownTransformer>>,
    theme: Arc<Theme>,
}

fn theme_color_style(
    theme: &Arc<Theme>,
    color: &'static str,
) -> Arc<dyn Fn(&Utf16Text) -> Utf16Text + Send + Sync> {
    let theme = Arc::clone(theme);
    Arc::new(move |text: &Utf16Text| {
        let plain = text.to_string_lossy();
        Utf16Text::from(theme.fg(color, &plain).expect("theme fg color"))
    })
}

impl UserMessageComponent {
    /// Upstream constructor.
    pub fn new(
        theme: Arc<Theme>,
        text: &str,
        markdown_theme: Option<MarkdownTheme>,
        output_pad: usize,
        markdown_transformers: Vec<MarkdownTransformer>,
    ) -> Self {
        let default_markdown_theme = markdown_theme;
        let markdown_theme_factory: Arc<dyn Fn() -> MarkdownTheme + Send + Sync> =
            Arc::new(move || {
                default_markdown_theme
                    .clone()
                    .unwrap_or_else(plain_markdown_theme)
            });
        let mut component = Self {
            box_: MessageBgBox::default(),
            text: text.to_string(),
            markdown_theme_factory,
            output_pad,
            markdown_transformers: Arc::new(markdown_transformers),
            theme,
        };
        component.rebuild();
        component
    }

    /// Upstream `setOutputPad`.
    pub fn set_output_pad(&mut self, padding: usize) {
        self.output_pad = padding;
        self.rebuild();
    }

    fn rebuild(&mut self) {
        self.box_ = MessageBgBox::new(
            self.output_pad,
            1,
            Some({
                let theme = Arc::clone(&self.theme);
                Arc::new(move |content: &str| {
                    theme.bg("userMessageBg", content).expect("userMessageBg")
                })
            }),
        );
        let transform =
            create_markdown_transform("user", false, Arc::clone(&self.markdown_transformers));
        self.box_.add_child(Box::new(Markdown::new(
            self.text.clone(),
            0,
            0,
            (self.markdown_theme_factory)(),
            Some(DefaultTextStyle {
                color: Some(theme_color_style(&self.theme, "userMessageText")),
                ..DefaultTextStyle::default()
            }),
            Some(crate::tui::components::markdown::MarkdownOptions {
                preserve_ordered_list_markers: true,
                preserve_backslash_escapes: true,
                transform: Some(transform),
                render_latex: true,
            }),
        )));
    }
}

impl Component for UserMessageComponent {
    fn render(&mut self, width: usize) -> Vec<String> {
        let mut lines = self.box_.render(width);
        if lines.is_empty() {
            return lines;
        }
        lines[0] = format!("{OSC133_ZONE_START}{}", lines[0]);
        let last = lines.len() - 1;
        lines[last] = format!("{OSC133_ZONE_END}{OSC133_ZONE_FINAL}{}", lines[last]);
        lines
    }

    fn invalidate(&mut self) {
        self.box_.invalidate();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dark() -> Arc<Theme> {
        Arc::new(
            crate::coding_agent::modes::interactive::theme::load_builtin_theme(
                "dark",
                Some(crate::coding_agent::modes::interactive::theme::ColorMode::Truecolor),
            )
            .expect("dark"),
        )
    }

    /// Oracle zone-wrapper probe (tests/fixtures/interactive_r19_oracle scenario
    /// `message_components` `userZoneProbe`): the OSC-133 markers wrap the
    /// first/last line of the Box output.
    #[test]
    fn osc133_zone_markers_wrap_render() {
        // Fixed inner lines: the probe replaces the Box body so the wrapper is
        // the compared surface.
        let theme = dark();
        let mut component = UserMessageComponent::new(theme, "probe text", None, 1, Vec::new());
        // Render through the box with a stubbed markdown child is not possible
        // without the markdown engine; assert the wrapper contract on fixed
        // lines instead by rendering and checking prefixes.
        let lines = component.render(40);
        assert!(lines[0].starts_with("\x1b]133;A\x07"), "zone start marker");
        let last = lines.last().expect("non-empty");
        assert!(
            last.starts_with("\x1b]133;B\x07\x1b]133;C\x07"),
            "zone end + final markers"
        );
        // inner content carries the userMessageBg background
        // (userMsgBg #343541 → 52;53;65)
        assert!(lines
            .iter()
            .any(|line| line.contains("\x1b[48;2;52;53;65m")));
    }

    #[test]
    fn empty_render_keeps_no_markers() {
        let theme = dark();
        // Markdown("") renders zero rows and the upstream Box early-returns on
        // empty child output, so the zone-wrapped render is empty too.
        let mut component = UserMessageComponent::new(theme, "", None, 1, Vec::new());
        let lines = component.render(40);
        assert!(lines.is_empty());
    }

    /// Markdown transform wiring: `preserveOrderedListMarkers` +
    /// `preserveBackslashEscapes` + the "user" transformer context.
    #[test]
    fn transformer_context_is_user() {
        let theme = dark();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let handle = std::sync::Arc::clone(&seen);
        let transformers = vec![Box::new(move |md: &str, ctx: &crate::coding_agent::modes::interactive::components::markdown_transform::MarkdownTransformContext| {
            *handle.lock().unwrap() = format!("{}:{}", ctx.message_type, ctx.is_streaming);
            Some(md.to_uppercase())
        }) as MarkdownTransformer];
        let mut component = UserMessageComponent::new(theme, "hello", None, 1, transformers);
        let lines = component.render(40);
        assert_eq!(*seen.lock().unwrap(), "user:false");
        assert!(lines.iter().any(|line| line.contains("HELLO")));
    }
}
