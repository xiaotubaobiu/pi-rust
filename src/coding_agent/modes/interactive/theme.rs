//! Component glue mirrors upstream callback signatures whose types are
//! inherently wide; factoring each into an alias adds no information.
#![allow(clippy::type_complexity)]
//! Port of upstream `coding-agent/src/modes/interactive/theme/theme.ts`
//! (1234 lines, sha256 `c3bf2e3b72f6bb782f34de0535fcc1758b9b6ea7a0d2e7d6f17244fa55c3f31a`)
//! — the deterministic theme core.
//!
//! Oracle: `tests/fixtures/interactive_r17_oracle/theme_oracle.mjs` runs verbatim
//! upstream bodies under node and captures `theme_oracle.json`; the tests in
//! `interactive_tests.rs` compare this module's output against it byte for
//! byte.
//!
//! Presentation seams (see `interactive/mod.rs`): the fs watcher, the
//! `globalThis` singleton, chalk's env-dependent color level, and the
//! typebox-backed validator live elsewhere or are parameterized.

use std::collections::BTreeMap;
use std::future::Future;

use serde_json::Value;

use super::theme_json::ThemeJson;
use crate::coding_agent::utils::text::strip_bom;

/// Upstream `ColorMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorMode {
    Truecolor,
    Color256,
}

/// Upstream `ThemeColorValue`: a hex string (or var ref / empty), or a
/// 256-color index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ColorValue {
    Str(String),
    Index(u8),
}

impl ColorValue {
    /// The resolved form of a color value after var expansion.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            ColorValue::Str(s) => Some(s),
            ColorValue::Index(_) => None,
        }
    }
}

/// A resolved color: hex string, empty string, or 256 index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedColor {
    Str(String),
    Index(u8),
}

/// Upstream `TerminalTheme`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalTheme {
    Light,
    Dark,
}

/// Upstream `SourceInfo`-style provenance is carried as plain strings.
#[derive(Debug, Clone)]
pub struct Theme {
    pub name: Option<String>,
    pub source_path: Option<String>,
    fg_colors: BTreeMap<String, String>,
    bg_colors: BTreeMap<String, String>,
    mode: ColorMode,
}

// ============================================================================
// Color Utilities (verbatim upstream semantics)
// ============================================================================

/// Upstream `hexToRgb`.
pub fn hex_to_rgb(hex: &str) -> Result<(u8, u8, u8), String> {
    let cleaned = hex.replace('#', "");
    if cleaned.len() != 6 || !cleaned.is_ascii() {
        return Err(format!("Invalid hex color: {hex}"));
    }
    // parseInt(...,16) tolerates trailing garbage within a slice (e.g. "fg"
    // parses to 15); this port is strict for such malformed inputs (D5).
    let parse = |slice: &str| -> Result<u8, String> {
        u8::from_str_radix(slice, 16).map_err(|_| format!("Invalid hex color: {hex}"))
    };
    let r = parse(&cleaned[0..2])?;
    let g = parse(&cleaned[2..4])?;
    let b = parse(&cleaned[4..6])?;
    Ok((r, g, b))
}

/// The 6x6x6 color cube channel values (indices 0-5).
const CUBE_VALUES: [u8; 6] = [0, 95, 135, 175, 215, 255];

/// Grayscale ramp values (indices 232-255, 24 grays from 8 to 238).
fn gray_values() -> impl Iterator<Item = u8> {
    (0..24).map(|i| 8 + i * 10)
}

fn find_closest_cube_index(value: u8) -> usize {
    let mut min_dist = f64::INFINITY;
    let mut min_idx = 0usize;
    for (i, candidate) in CUBE_VALUES.iter().enumerate() {
        let dist = (i32::from(value) - i32::from(*candidate)).abs();
        if f64::from(dist) < min_dist {
            min_dist = f64::from(dist);
            min_idx = i;
        }
    }
    min_idx
}

fn find_closest_gray_index(gray: u8) -> usize {
    let mut min_dist = f64::INFINITY;
    let mut min_idx = 0usize;
    for (i, candidate) in gray_values().enumerate() {
        let dist = (i32::from(gray) - i32::from(candidate)).abs();
        if f64::from(dist) < min_dist {
            min_dist = f64::from(dist);
            min_idx = i;
        }
    }
    min_idx
}

fn color_distance(r1: u8, g1: u8, b1: u8, r2: u8, g2: u8, b2: u8) -> f64 {
    // Weighted Euclidean distance (human eye is more sensitive to green)
    let dr = f64::from(r1) - f64::from(r2);
    let dg = f64::from(g1) - f64::from(g2);
    let db = f64::from(b1) - f64::from(b2);
    dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114
}

/// Upstream `rgbTo256`.
pub fn rgb_to_256(r: u8, g: u8, b: u8) -> u8 {
    // Find closest color in the 6x6x6 cube
    let r_idx = find_closest_cube_index(r);
    let g_idx = find_closest_cube_index(g);
    let b_idx = find_closest_cube_index(b);
    let cube_r = CUBE_VALUES[r_idx];
    let cube_g = CUBE_VALUES[g_idx];
    let cube_b = CUBE_VALUES[b_idx];
    let cube_index = 16 + 36 * r_idx + 6 * g_idx + b_idx;
    let cube_dist = color_distance(r, g, b, cube_r, cube_g, cube_b);

    // Find closest grayscale
    let gray = (0.299 * f64::from(r) + 0.587 * f64::from(g) + 0.114 * f64::from(b) + 0.5).floor();
    let gray_idx = find_closest_gray_index(gray as u8);
    let gray_value = 8 + gray_idx as u8 * 10;
    let gray_index = 232 + gray_idx;
    let gray_dist = color_distance(r, g, b, gray_value, gray_value, gray_value);

    // Only consider grayscale if color is nearly neutral (spread < 10)
    // AND grayscale is actually closer
    let max_c = r.max(g).max(b);
    let min_c = r.min(g).min(b);
    let spread = max_c - min_c;

    if spread < 10 && gray_dist < cube_dist {
        return gray_index as u8;
    }

    cube_index as u8
}

/// Upstream `hexTo256`.
pub fn hex_to_256(hex: &str) -> Result<u8, String> {
    let (r, g, b) = hex_to_rgb(hex)?;
    Ok(rgb_to_256(r, g, b))
}

pub fn fg_ansi(color: &ResolvedColor, mode: ColorMode) -> Result<String, String> {
    match (color, mode) {
        (ResolvedColor::Str(s), _) if s.is_empty() => Ok("\x1b[39m".to_string()),
        (ResolvedColor::Index(i), _) => Ok(format!("\x1b[38;5;{i}m")),
        (ResolvedColor::Str(s), ColorMode::Truecolor) => hex_to_rgb(s)
            .map(|(r, g, b)| format!("\x1b[38;2;{r};{g};{b}m"))
            .map_err(|_| format!("Invalid color value: {s}")),
        (ResolvedColor::Str(s), ColorMode::Color256) => hex_to_256(s)
            .map(|index| format!("\x1b[38;5;{index}m"))
            .map_err(|_| format!("Invalid color value: {s}")),
    }
}

pub fn bg_ansi(color: &ResolvedColor, mode: ColorMode) -> Result<String, String> {
    match (color, mode) {
        (ResolvedColor::Str(s), _) if s.is_empty() => Ok("\x1b[49m".to_string()),
        (ResolvedColor::Index(i), _) => Ok(format!("\x1b[48;5;{i}m")),
        (ResolvedColor::Str(s), ColorMode::Truecolor) => hex_to_rgb(s)
            .map(|(r, g, b)| format!("\x1b[48;2;{r};{g};{b}m"))
            .map_err(|_| format!("Invalid color value: {s}")),
        (ResolvedColor::Str(s), ColorMode::Color256) => hex_to_256(s)
            .map(|index| format!("\x1b[48;5;{index}m"))
            .map_err(|_| format!("Invalid color value: {s}")),
    }
}

/// Upstream `resolveVarRefs`.
pub fn resolve_var_refs(
    value: &ColorValue,
    vars: &BTreeMap<String, ColorValue>,
) -> Result<ResolvedColor, String> {
    resolve_var_refs_inner(value, vars, &mut Vec::new())
}

fn resolve_var_refs_inner(
    value: &ColorValue,
    vars: &BTreeMap<String, ColorValue>,
    visited: &mut Vec<String>,
) -> Result<ResolvedColor, String> {
    match value {
        ColorValue::Index(i) => Ok(ResolvedColor::Index(*i)),
        ColorValue::Str(s) if s.is_empty() || s.starts_with('#') => {
            Ok(ResolvedColor::Str(s.clone()))
        }
        ColorValue::Str(s) => {
            if visited.contains(s) {
                return Err(format!("Circular variable reference detected: {s}"));
            }
            let Some(next) = vars.get(s) else {
                return Err(format!("Variable reference not found: {s}"));
            };
            visited.push(s.clone());
            resolve_var_refs_inner(next, vars, visited)
        }
    }
}

/// Upstream `resolveThemeColors`.
pub fn resolve_theme_colors(
    colors: &BTreeMap<String, ColorValue>,
    vars: &BTreeMap<String, ColorValue>,
) -> Result<BTreeMap<String, ResolvedColor>, String> {
    let mut resolved = BTreeMap::new();
    for (key, value) in colors {
        resolved.insert(key.clone(), resolve_var_refs(value, vars)?);
    }
    Ok(resolved)
}

fn fallback(colors: &mut BTreeMap<String, ColorValue>, key: &str, fallback_key: &str) {
    if !colors.contains_key(key) {
        let value = colors
            .get(fallback_key)
            .cloned()
            .expect("fallback key present");
        colors.insert(key.to_string(), value);
    }
}

/// Upstream `withThemeColorFallbacks`.
pub fn with_theme_color_fallbacks(
    colors: &BTreeMap<String, ColorValue>,
) -> BTreeMap<String, ColorValue> {
    let mut computed = colors.clone();
    fallback(&mut computed, "scrollbarTrack", "muted");
    fallback(&mut computed, "scrollbarThumb", "text");
    fallback(&mut computed, "thinkingMax", "thinkingXhigh");
    fallback(&mut computed, "searchMatchBg", "selectedBg");
    fallback(&mut computed, "searchMatchText", "text");
    computed
}

/// Upstream `ansi256ToHex`.
pub fn ansi256_to_hex(index: u8) -> String {
    // Basic colors (0-15) - approximate common terminal values
    const BASIC_COLORS: [&str; 16] = [
        "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
        "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
    ];
    if index < 16 {
        return BASIC_COLORS[usize::from(index)].to_string();
    }

    // Color cube (16-231): 6x6x6 = 216 colors
    if index < 232 {
        let cube_index = index - 16;
        let r = cube_index / 36;
        let g = (cube_index % 36) / 6;
        let b = cube_index % 6;
        let to_hex = |n: u8| -> String {
            let value = if n == 0 { 0 } else { 55 + n as u32 * 40 };
            format!("{value:02x}")
        };
        return format!("#{}{}{}", to_hex(r), to_hex(g), to_hex(b));
    }

    // Grayscale (232-255): 24 shades
    let gray = 8 + (index - 232) * 10;
    format!("#{gray:02x}{gray:02x}{gray:02x}")
}

// ============================================================================
// Theme (upstream Theme class)
// ============================================================================

/// Keys routed to the background table by upstream `createTheme`.
const BG_COLOR_KEYS: [&str; 7] = [
    "selectedBg",
    "searchMatchBg",
    "userMessageBg",
    "customMessageBg",
    "toolPendingBg",
    "toolSuccessBg",
    "toolErrorBg",
];

impl Theme {
    /// Upstream `new Theme(fgColors, bgColors, mode, options)` with the same
    /// optional-key fallbacks applied in the constructor.
    pub fn new(
        fg_colors: &BTreeMap<String, ResolvedColor>,
        bg_colors: &BTreeMap<String, ResolvedColor>,
        mode: ColorMode,
        name: Option<String>,
        source_path: Option<String>,
    ) -> Self {
        let mut fg_map = BTreeMap::new();
        let mut fg_input = fg_colors.clone();
        // Constructor fallbacks (verbatim upstream expressions).
        fg_input
            .entry("scrollbarTrack".to_string())
            .or_insert_with(|| fg_colors.get("muted").cloned().expect("muted"));
        fg_input
            .entry("scrollbarThumb".to_string())
            .or_insert_with(|| fg_colors.get("text").cloned().expect("text"));
        fg_input
            .entry("thinkingMax".to_string())
            .or_insert_with(|| {
                fg_colors
                    .get("thinkingXhigh")
                    .cloned()
                    .expect("thinkingXhigh")
            });
        fg_input
            .entry("searchMatchText".to_string())
            .or_insert_with(|| fg_colors.get("text").cloned().expect("text"));
        for (key, value) in &fg_input {
            fg_map.insert(key.clone(), fg_ansi(value, mode).expect("theme fg color"));
        }

        let mut bg_map = BTreeMap::new();
        let mut bg_input = bg_colors.clone();
        bg_input
            .entry("searchMatchBg".to_string())
            .or_insert_with(|| bg_colors.get("selectedBg").cloned().expect("selectedBg"));
        for (key, value) in &bg_input {
            bg_map.insert(key.clone(), bg_ansi(value, mode).expect("theme bg color"));
        }

        Self {
            name,
            source_path,
            fg_colors: fg_map,
            bg_colors: bg_map,
            mode,
        }
    }

    /// Upstream `Theme.fg`: colorize with a foreground reset only.
    pub fn fg(&self, color: &str, text: &str) -> Result<String, String> {
        let ansi = self.get_fg_ansi(color)?;
        Ok(format!("{ansi}{text}\x1b[39m"))
    }

    /// Upstream `Theme.bg`: colorize with a background reset only.
    pub fn bg(&self, color: &str, text: &str) -> Result<String, String> {
        let ansi = self.get_bg_ansi(color)?;
        Ok(format!("{ansi}{text}\x1b[49m"))
    }

    /// Upstream `Theme.bold`. Chalk seam: the enabled-level ANSI codes are
    /// fixed here instead of depending on process env (D2 in mod.rs).
    pub fn bold(&self, text: &str) -> String {
        format!("\x1b[1m{text}\x1b[22m")
    }

    /// Upstream `Theme.italic`.
    pub fn italic(&self, text: &str) -> String {
        format!("\x1b[3m{text}\x1b[23m")
    }

    /// Upstream `Theme.underline`.
    pub fn underline(&self, text: &str) -> String {
        format!("\x1b[4m{text}\x1b[24m")
    }

    /// Upstream `Theme.inverse`.
    pub fn inverse(&self, text: &str) -> String {
        format!("\x1b[7m{text}\x1b[27m")
    }

    /// Upstream `Theme.strikethrough`.
    pub fn strikethrough(&self, text: &str) -> String {
        format!("\x1b[9m{text}\x1b[29m")
    }

    /// Upstream `getFgAnsi`.
    pub fn get_fg_ansi(&self, color: &str) -> Result<String, String> {
        self.fg_colors
            .get(color)
            .cloned()
            .ok_or_else(|| format!("Unknown theme color: {color}"))
    }

    /// Upstream `getBgAnsi`.
    pub fn get_bg_ansi(&self, color: &str) -> Result<String, String> {
        self.bg_colors
            .get(color)
            .cloned()
            .ok_or_else(|| format!("Unknown theme background color: {color}"))
    }

    /// Upstream `getColorMode`.
    pub fn get_color_mode(&self) -> ColorMode {
        self.mode
    }

    /// Upstream `getThinkingBorderColor`, applied to a string immediately.
    pub fn get_thinking_border_color(
        &self,
        level: ThinkingLevel,
        text: &str,
    ) -> Result<String, String> {
        let key = match level {
            ThinkingLevel::Off => "thinkingOff",
            ThinkingLevel::Minimal => "thinkingMinimal",
            ThinkingLevel::Low => "thinkingLow",
            ThinkingLevel::Medium => "thinkingMedium",
            ThinkingLevel::High => "thinkingHigh",
            ThinkingLevel::Xhigh => "thinkingXhigh",
            ThinkingLevel::Max => "thinkingMax",
        };
        self.fg(key, text)
    }

    /// Upstream `getBashModeBorderColor`, applied to a string immediately.
    pub fn get_bash_mode_border_color(&self, text: &str) -> Result<String, String> {
        self.fg("bashMode", text)
    }
}

/// Upstream `ThinkingLevel` (from `@earendil-works/pi-agent-core`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

// ============================================================================
// Theme Loading (deterministic core over explicit JSON documents)
// ============================================================================

/// The byte-identical built-in theme documents (`theme/dark.json`,
/// `theme/light.json`, sha256-matched to upstream dark.json / light.json).
pub const BUILTIN_THEME_DARK_JSON: &str = include_str!("theme/dark.json");
pub const BUILTIN_THEME_LIGHT_JSON: &str = include_str!("theme/light.json");

/// Upstream `getBuiltinThemes` (the `{ dark, light }` literal, dedeterminized
/// from fs+config indirection to byte-identical embedded documents).
pub fn builtin_theme_names() -> [&'static str; 2] {
    ["dark", "light"]
}

pub fn get_builtin_theme_json(name: &str) -> Option<ThemeJson> {
    let content = match name {
        "dark" => BUILTIN_THEME_DARK_JSON,
        "light" => BUILTIN_THEME_LIGHT_JSON,
        _ => return None,
    };
    Some(ThemeJson::parse(strip_bom(content)).expect("built-in theme JSON parses"))
}

/// Upstream `createTheme` (`mode` defaults to the terminal capability probe;
/// the probe is presentation, so callers pass an explicit mode or [`None`] to
/// get the upstream 256-color conservative default via [`default_color_mode`]).
pub fn create_theme(
    theme_json: &ThemeJson,
    mode: Option<ColorMode>,
    source_path: Option<String>,
) -> Result<Theme, String> {
    let color_mode = mode.unwrap_or(ColorMode::Color256);
    let resolved = resolve_theme_colors(
        &with_theme_color_fallbacks(&theme_json.colors),
        theme_json.vars.as_ref().unwrap_or(&BTreeMap::new()),
    )?;
    let mut fg_colors = BTreeMap::new();
    let mut bg_colors = BTreeMap::new();
    for (key, value) in &resolved {
        if BG_COLOR_KEYS.contains(&key.as_str()) {
            bg_colors.insert(key.clone(), value.clone());
        } else {
            fg_colors.insert(key.clone(), value.clone());
        }
    }
    Ok(Theme::new(
        &fg_colors,
        &bg_colors,
        color_mode,
        Some(theme_json.name.clone()),
        source_path,
    ))
}

/// Upstream `loadThemeFromPath` core: parse + build from file content.
pub fn load_theme_from_content(
    content: &str,
    mode: Option<ColorMode>,
    source_path: String,
) -> Result<Theme, String> {
    let theme_json = parse_theme_json_content(&source_path, content)?;
    create_theme(&theme_json, mode, Some(source_path))
}

/// Upstream `parseThemeJsonContent`.
pub fn parse_theme_json_content(label: &str, content: &str) -> Result<ThemeJson, String> {
    let json: Value = serde_json::from_str(strip_bom(content))
        .map_err(|error| format!("Failed to parse theme {label}: {error}"))?;
    super::theme_json::validate_theme_json(label, &json)
}

/// Upstream `loadThemeJson` restricted to the built-in registry; custom-dir
/// and registered-theme lookups are the caller's registry concern.
pub fn load_builtin_theme(name: &str, mode: Option<ColorMode>) -> Result<Theme, String> {
    let theme_json =
        get_builtin_theme_json(name).ok_or_else(|| format!("Theme not found: {name}"))?;
    create_theme(&theme_json, mode, None)
}

/// Upstream `getThemeByName` over the built-in registry.
pub fn get_builtin_theme_by_name(name: &str) -> Option<Theme> {
    load_builtin_theme(name, None).ok()
}

/// Upstream `getAvailableThemesWithPaths` ordering: built-ins first in
/// registry order, then custom-dir infos, then registered; deduped by name and
/// sorted by name at the end. `localeCompare` is ported as byte-wise ordering
/// (identical for the ASCII names the oracle covers; D4 in mod.rs).
pub fn sort_theme_infos(mut infos: Vec<(String, Option<String>)>) -> Vec<(String, Option<String>)> {
    let mut seen = std::collections::BTreeSet::new();
    infos.retain(|(name, _)| seen.insert(name.clone()));
    infos.sort_by(|a, b| a.0.cmp(&b.0));
    infos
}

// ============================================================================
// Theme Setting Helpers (verbatim upstream semantics)
// ============================================================================

/// Upstream `parseAutoThemeSetting` -> `(lightTheme, darkTheme)`.
pub fn parse_auto_theme_setting(theme_setting: Option<&str>) -> Option<(String, String)> {
    let theme_setting = theme_setting?;
    let slash_index = theme_setting.find('/')?;
    if theme_setting[slash_index + 1..].contains('/') {
        return None;
    }

    let light_theme = theme_setting[..slash_index].trim();
    let dark_theme = theme_setting[slash_index + 1..].trim();
    if light_theme.is_empty() || dark_theme.is_empty() {
        return None;
    }
    Some((light_theme.to_string(), dark_theme.to_string()))
}

/// Upstream `resolveThemeSetting`.
pub fn resolve_theme_setting(
    theme_setting: Option<&str>,
    terminal_theme: TerminalTheme,
) -> Option<String> {
    if let Some((light, dark)) = parse_auto_theme_setting(theme_setting) {
        return Some(if terminal_theme == TerminalTheme::Light {
            light
        } else {
            dark
        });
    }
    let theme_setting = theme_setting?;
    if theme_setting.contains('/') {
        return None;
    }
    Some(theme_setting.to_string())
}

// ============================================================================
// Terminal Theme Detection (verbatim upstream semantics)
// ============================================================================

/// Upstream `getColorFgBgBackgroundIndex`.
pub fn get_color_fg_bg_background_index(colorfgbg: &str) -> Option<u8> {
    for part in colorfgbg.split(';').rev() {
        if let Ok(bg) = part.trim().parse::<i64>() {
            if (0..=255).contains(&bg) {
                return Some(bg as u8);
            }
        }
    }
    None
}

fn to_linear(channel: f64) -> f64 {
    let value = channel / 255.0;
    if value <= 0.03928 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

/// Upstream `getRgbColorLuminance`.
pub fn get_rgb_color_luminance(rgb: (u8, u8, u8)) -> f64 {
    let (r, g, b) = rgb;
    0.2126 * to_linear(f64::from(r))
        + 0.7152 * to_linear(f64::from(g))
        + 0.0722 * to_linear(f64::from(b))
}

/// Upstream `getAnsiColorLuminance`.
pub fn get_ansi_color_luminance(index: u8) -> f64 {
    let rgb = hex_to_rgb(&ansi256_to_hex(index)).expect("ansi256ToHex emits valid hex");
    get_rgb_color_luminance(rgb)
}

/// Upstream `getThemeForRgbColor`.
pub fn get_theme_for_rgb_color(rgb: (u8, u8, u8)) -> TerminalTheme {
    if get_rgb_color_luminance(rgb) >= 0.5 {
        TerminalTheme::Light
    } else {
        TerminalTheme::Dark
    }
}

/// Upstream `TerminalThemeDetection`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalThemeDetection {
    pub theme: TerminalTheme,
    pub source: DetectionSource,
    pub detail: String,
    pub confidence: Confidence,
}

/// Upstream `source` field values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetectionSource {
    TerminalBackground,
    Colorfgbg,
    Fallback,
}

/// Upstream `confidence` field values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confidence {
    High,
    Low,
}

/// Upstream `detectTerminalBackgroundFromEnv` over an explicit COLORFGBG value
/// (`None` models an env map without the key; `Some("")` models an empty one).
pub fn detect_terminal_background_from_env(colorfgbg: Option<&str>) -> TerminalThemeDetection {
    let colorfgbg = colorfgbg.unwrap_or("");
    if let Some(bg) = get_color_fg_bg_background_index(colorfgbg) {
        return TerminalThemeDetection {
            theme: if get_ansi_color_luminance(bg) >= 0.5 {
                TerminalTheme::Light
            } else {
                TerminalTheme::Dark
            },
            source: DetectionSource::Colorfgbg,
            detail: format!("background color index {bg}"),
            confidence: Confidence::High,
        };
    }

    TerminalThemeDetection {
        theme: TerminalTheme::Dark,
        source: DetectionSource::Fallback,
        detail: "no terminal background hint found".to_string(),
        confidence: Confidence::Low,
    }
}

/// Upstream `TerminalBackgroundThemeDetector`. The receiver is shared
/// (`&self` with interior mutability) because upstream starts both terminal
/// queries concurrently.
pub trait TerminalBackgroundDetector {
    fn query_terminal_background_color(
        &self,
        timeout_ms: u64,
    ) -> impl Future<Output = Result<Option<(u8, u8, u8)>, String>> + Send;
}

/// Upstream `TerminalAutoThemeDetector`.
pub trait TerminalAutoDetector: TerminalBackgroundDetector {
    fn query_terminal_color_scheme(
        &self,
        _timeout_ms: u64,
    ) -> impl Future<Output = Result<Option<TerminalTheme>, String>> + Send {
        async { Err("not supported".to_string()) }
    }
}

/// Upstream `detectTerminalBackgroundTheme`.
pub async fn detect_terminal_background_theme<D: TerminalBackgroundDetector>(
    ui: &D,
    timeout_ms: u64,
    colorfgbg: Option<&str>,
) -> TerminalThemeDetection {
    match ui.query_terminal_background_color(timeout_ms).await {
        Ok(Some(rgb)) => TerminalThemeDetection {
            theme: get_theme_for_rgb_color(rgb),
            source: DetectionSource::TerminalBackground,
            detail: format!("OSC 11 background rgb({}, {}, {})", rgb.0, rgb.1, rgb.2),
            confidence: Confidence::High,
        },
        _ => detect_terminal_background_from_env(colorfgbg),
    }
}

/// Upstream `detectTerminalThemeForAuto`. Both queries are started together
/// (upstream launches the color-scheme query first, then the background
/// query); the color-scheme result wins when it produces a theme. Divergence
/// D7 (mod.rs): upstream returns without waiting for the background query,
/// this port awaits both, so callers' background queries must resolve.
pub async fn detect_terminal_theme_for_auto<D: TerminalAutoDetector>(
    ui: &D,
    timeout_ms: u64,
    colorfgbg: Option<&str>,
) -> TerminalTheme {
    // Both queries start; the background future is polled only after the
    // color-scheme future pends, preserving the upstream start order.
    let (color_scheme, background) = tokio::join!(
        ui.query_terminal_color_scheme(timeout_ms),
        detect_terminal_background_theme(ui, timeout_ms, colorfgbg),
    );
    if let Ok(Some(scheme)) = color_scheme {
        return scheme;
    }
    background.theme
}

// ============================================================================
// HTML Export Helpers (verbatim upstream semantics over explicit documents)
// ============================================================================

/// Upstream `getResolvedThemeColors` core over an explicit theme document (the
/// by-name fs lookup is the caller's registry concern; the `isLight` default
/// text rule reads `themeJson.name` as upstream reads the resolved name).
pub fn get_resolved_theme_colors(theme_json: &ThemeJson) -> BTreeMap<String, String> {
    let is_light = theme_json.name == "light";
    let resolved = resolve_theme_colors(
        &with_theme_color_fallbacks(&theme_json.colors),
        theme_json.vars.as_ref().unwrap_or(&BTreeMap::new()),
    )
    .expect("export resolution invariant: theme docs resolve");

    // Default text color for empty values (terminal uses default fg color)
    let default_text = if is_light { "#000000" } else { "#e5e5e7" };

    let mut css_colors = BTreeMap::new();
    for (key, value) in resolved {
        match value {
            ResolvedColor::Index(index) => {
                css_colors.insert(key, ansi256_to_hex(index));
            }
            ResolvedColor::Str(s) if s.is_empty() => {
                css_colors.insert(key, default_text.to_string());
            }
            ResolvedColor::Str(s) => {
                css_colors.insert(key, s);
            }
        }
    }
    css_colors
}

/// Upstream `getThemeExportColors` return shape (`None` = not specified).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ThemeExportColors {
    pub page_bg: Option<String>,
    pub card_bg: Option<String>,
    pub info_bg: Option<String>,
}

/// Upstream `getThemeExportColors` core over an explicit theme document.
pub fn get_theme_export_colors(theme_json: &ThemeJson) -> ThemeExportColors {
    let Some(export) = &theme_json.export else {
        return ThemeExportColors::default();
    };

    let empty = BTreeMap::new();
    let vars = theme_json.vars.as_ref().unwrap_or(&empty);
    let resolve = |value: Option<&ColorValue>| -> Option<String> {
        let value = value?;
        match resolve_var_refs(value, vars).ok()? {
            ResolvedColor::Index(index) => Some(ansi256_to_hex(index)),
            ResolvedColor::Str(s) if s.is_empty() => None,
            ResolvedColor::Str(s) => Some(s),
        }
    };

    ThemeExportColors {
        page_bg: resolve(export.page_bg.as_ref()),
        card_bg: resolve(export.card_bg.as_ref()),
        info_bg: resolve(export.info_bg.as_ref()),
    }
}

/// Upstream `isLightTheme`.
pub fn is_light_theme(theme_name: Option<&str>) -> bool {
    theme_name == Some("light")
}

// ============================================================================
// Language Table (verbatim upstream semantics)
// ============================================================================

/// Upstream `getLanguageFromPath`. `filePath.split(".").pop()` takes the
/// substring after the last "." of the WHOLE path (so "dir.d/file" looks up
/// "d/file" and misses), lowercased; the empty extension also misses.
pub fn get_language_from_path(file_path: &str) -> Option<&'static str> {
    let ext = match file_path.rfind('.') {
        Some(index) => file_path[index + 1..].to_ascii_lowercase(),
        None => file_path.to_ascii_lowercase(),
    };
    EXT_TO_LANG
        .iter()
        .find(|(candidate, _)| *candidate == ext)
        .map(|(_, language)| *language)
}

/// Upstream `extToLang`.
const EXT_TO_LANG: &[(&str, &str)] = &[
    ("ts", "typescript"),
    ("tsx", "typescript"),
    ("js", "javascript"),
    ("jsx", "javascript"),
    ("mjs", "javascript"),
    ("cjs", "javascript"),
    ("py", "python"),
    ("rb", "ruby"),
    ("rs", "rust"),
    ("go", "go"),
    ("java", "java"),
    ("kt", "kotlin"),
    ("swift", "swift"),
    ("c", "c"),
    ("h", "c"),
    ("cpp", "cpp"),
    ("cc", "cpp"),
    ("cxx", "cpp"),
    ("hpp", "cpp"),
    ("cs", "csharp"),
    ("php", "php"),
    ("sh", "bash"),
    ("bash", "bash"),
    ("zsh", "bash"),
    ("fish", "fish"),
    ("ps1", "powershell"),
    ("sql", "sql"),
    ("html", "html"),
    ("htm", "html"),
    ("css", "css"),
    ("scss", "scss"),
    ("sass", "sass"),
    ("less", "less"),
    ("json", "json"),
    ("yaml", "yaml"),
    ("yml", "yaml"),
    ("toml", "toml"),
    ("xml", "xml"),
    ("md", "markdown"),
    ("markdown", "markdown"),
    ("dockerfile", "dockerfile"),
    ("makefile", "makefile"),
    ("cmake", "cmake"),
    ("lua", "lua"),
    ("perl", "perl"),
    ("r", "r"),
    ("scala", "scala"),
    ("clj", "clojure"),
    ("ex", "elixir"),
    ("exs", "elixir"),
    ("erl", "erlang"),
    ("hs", "haskell"),
    ("ml", "ocaml"),
    ("vim", "vim"),
    ("graphql", "graphql"),
    ("proto", "protobuf"),
    ("tf", "hcl"),
    ("hcl", "hcl"),
];
