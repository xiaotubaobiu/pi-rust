use super::{render_latex, render_latex_utf16, RenderLatexOptions};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureFile {
    upstream_test_cases: usize,
    upstream_test_count: usize,
    upstream_assertions: usize,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    id: String,
    source: String,
    display: bool,
    expected: Option<String>,
}

fn check_case(case: &Case) {
    assert_eq!(
        render_latex_utf16(
            &case.source.encode_utf16().collect::<Vec<_>>(),
            RenderLatexOptions {
                display: case.display
            }
        ),
        case.expected
            .as_ref()
            .map(|s| s.encode_utf16().collect::<Vec<_>>()),
        "raw UTF-16: {}",
        case.id,
    );
    assert_eq!(
        render_latex(
            &case.source,
            RenderLatexOptions {
                display: case.display
            }
        ),
        case.expected,
        "{} (display={}): {:?}",
        case.id,
        case.display,
        case.source,
    );
}

#[test]
fn original_upstream_assertions_match_byte_for_byte() {
    let file: FixtureFile = serde_json::from_str(include_str!("fixtures.json")).unwrap();
    assert_eq!(file.upstream_test_count, 111);
    assert_eq!(file.upstream_assertions, 149);
    assert_eq!(file.upstream_test_cases, 149);
    for case in &file.cases[..file.upstream_test_cases] {
        assert!(case.id.starts_with("upstream: "));
        check_case(case);
    }
}

#[test]
fn all_generated_differential_cases_match_byte_for_byte() {
    let file: FixtureFile = serde_json::from_str(include_str!("fixtures.json")).unwrap();
    assert!(file.cases.len() >= 2200);
    let mut none_count = 0;
    for case in &file.cases[file.upstream_test_cases..] {
        none_count += usize::from(case.expected.is_none());
        check_case(case);
    }
    assert!(
        none_count >= 30,
        "malformed/unsupported cases must be covered"
    );
}

#[test]
fn reference_manifest_matches_checked_in_tables_and_fixtures() {
    let manifest: serde_json::Value = serde_json::from_str(include_str!(
        "../../../docs/migration/reference/latex/source-manifest.json"
    ))
    .unwrap();
    for (key, bytes) in [
        ("fixturesSha256", include_bytes!("fixtures.json").as_slice()),
        ("tablesSha256", include_bytes!("tables.rs").as_slice()),
        (
            "rawFixturesSha256",
            include_bytes!("utf16-fixtures.json").as_slice(),
        ),
        (
            "utf16DomainSha256",
            include_bytes!("../../../docs/migration/reference/latex/utf16-domain.json").as_slice(),
        ),
    ] {
        assert_eq!(
            Sha256::digest(bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>(),
            manifest[key].as_str().unwrap()
        );
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Utf16Case {
    source: String,
    display: bool,
    expected_utf16: Vec<u16>,
    expected_terminal_utf8: String,
}

#[derive(Deserialize)]
struct Utf16Cases {
    cases: Vec<Utf16Case>,
}

#[test]
fn unbraced_astral_arguments_match_upstream_terminal_encoding() {
    let file: Utf16Cases = serde_json::from_str(include_str!(
        "../../../docs/migration/reference/latex/utf16-domain.json"
    ))
    .unwrap();
    assert_eq!(file.cases.len(), 22);
    for case in file.cases {
        assert_eq!(
            String::from_utf16_lossy(&case.expected_utf16),
            case.expected_terminal_utf8,
        );
        assert_eq!(
            render_latex(
                &case.source,
                RenderLatexOptions {
                    display: case.display
                }
            ),
            Some(case.expected_terminal_utf8),
            "display={}: {:?}",
            case.display,
            case.source,
        );
    }
}

#[test]
fn unbraced_astral_arguments_preserve_exact_upstream_utf16_units() {
    let file: Utf16Cases = serde_json::from_str(include_str!(
        "../../../docs/migration/reference/latex/utf16-domain.json"
    ))
    .unwrap();
    for case in file.cases {
        assert_eq!(
            render_latex_utf16(
                &case.source.encode_utf16().collect::<Vec<_>>(),
                RenderLatexOptions {
                    display: case.display
                }
            ),
            Some(case.expected_utf16),
            "display={}: {:?}",
            case.display,
            case.source,
        );
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFixtureFile {
    raw_cases: Vec<RawCase>,
    width_cases: Vec<WidthCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCase {
    id: String,
    source_utf16: Vec<u16>,
    display: bool,
    expected_utf16: Option<Vec<u16>>,
    expected_terminal_utf8: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WidthCase {
    source_utf16: Vec<u16>,
    expected: usize,
}

#[test]
fn raw_utf16_differential_corpus_matches_units_and_terminal_encoding() {
    let file: RawFixtureFile = serde_json::from_str(include_str!("utf16-fixtures.json")).unwrap();
    assert_eq!(file.raw_cases.len(), 3278);
    let mut lone_input = 0;
    let mut lone_output = 0;
    let mut unsupported = 0;
    for case in file.raw_cases {
        lone_input += usize::from(String::from_utf16(&case.source_utf16).is_err());
        lone_output += usize::from(
            case.expected_utf16
                .as_ref()
                .is_some_and(|u| String::from_utf16(u).is_err()),
        );
        unsupported += usize::from(case.expected_utf16.is_none());
        let actual = render_latex_utf16(
            &case.source_utf16,
            RenderLatexOptions {
                display: case.display,
            },
        );
        assert_eq!(
            actual, case.expected_utf16,
            "{} display={} input={:?}",
            case.id, case.display, case.source_utf16
        );
        assert_eq!(
            actual.as_ref().map(|u| String::from_utf16_lossy(u)),
            case.expected_terminal_utf8,
            "terminal: {}",
            case.id
        );
        if let Ok(source) = String::from_utf16(&case.source_utf16) {
            assert_eq!(
                render_latex(
                    &source,
                    RenderLatexOptions {
                        display: case.display
                    }
                ),
                case.expected_terminal_utf8,
                "public UTF-8: {}",
                case.id
            );
        }
    }
    assert!(
        lone_input > 1000 && lone_output > 1000 && unsupported > 100,
        "coverage must not silently disappear"
    );
}

#[test]
fn raw_utf16_terminal_width_matches_actual_upstream() {
    let file: RawFixtureFile = serde_json::from_str(include_str!("utf16-fixtures.json")).unwrap();
    assert_eq!(file.width_cases.len(), 12415);
    for case in file.width_cases {
        assert_eq!(
            super::visible_width_utf16(&case.source_utf16),
            case.expected,
            "raw width: {:?}",
            case.source_utf16
        );
    }
}

/// Upstream looks commands up in plain `Record<string, string>` literals, so
/// `Object.prototype` members resolve as inherited values. The generated
/// fixtures cannot cover this (`Object.keys` sees only own properties), so
/// these expectations were captured by running the upstream source directly
/// with node v25.8.2 (`--experimental-strip-types`), covering every reachable
/// lookup site: symbol commands, `\not{...}` values (including the
/// underscore members no command can spell), and composition into display
/// fractions, operator limits, matrices, and wrappers.
#[test]
fn object_prototype_member_lookups_match_node_oracle() {
    const FN_OBJECT: &str = "function Object() { [native code] }";
    const FN_TO_STRING: &str = "function toString() { [native code] }";
    const FN_TO_LOCALE_STRING: &str = "function toLocaleString() { [native code] }";
    const FN_VALUE_OF: &str = "function valueOf() { [native code] }";
    const FN_HAS_OWN: &str = "function hasOwnProperty() { [native code] }";
    const FN_IS_PROTO: &str = "function isPrototypeOf() { [native code] }";
    const FN_PROP_ENUM: &str = "function propertyIsEnumerable() { [native code] }";
    let cases: &[(&str, bool, Option<&str>)] = &[
        (r"a\toString b", false, Some(&format!("a{FN_TO_STRING} b"))),
        (r"a\constructor b", false, Some(&format!("a{FN_OBJECT} b"))),
        (r"a\valueOf b", false, Some(&format!("a{FN_VALUE_OF} b"))),
        (
            r"a\toLocaleString b",
            false,
            Some(&format!("a{FN_TO_LOCALE_STRING} b")),
        ),
        (
            r"a\hasOwnProperty b",
            false,
            Some(&format!("a{FN_HAS_OWN} b")),
        ),
        (
            r"a\isPrototypeOf b",
            false,
            Some(&format!("a{FN_IS_PROTO} b")),
        ),
        (
            r"a\propertyIsEnumerable b",
            false,
            Some(&format!("a{FN_PROP_ENUM} b")),
        ),
        (r"\toString{x}", false, Some(&format!("{FN_TO_STRING}x"))),
        (r"\toString{AB}", false, Some(&format!("{FN_TO_STRING}AB"))),
        (r"\valueOf{x}", false, Some(&format!("{FN_VALUE_OF}x"))),
        (r"\constructor{AB}", false, Some(&format!("{FN_OBJECT}AB"))),
        (
            r"\toLocaleString{AB}",
            false,
            Some(&format!("{FN_TO_LOCALE_STRING}AB")),
        ),
        (
            r"\hasOwnProperty{AB}",
            false,
            Some(&format!("{FN_HAS_OWN}AB")),
        ),
        (
            r"\isPrototypeOf{x}",
            false,
            Some(&format!("{FN_IS_PROTO}x")),
        ),
        (
            r"\propertyIsEnumerable{x}",
            false,
            Some(&format!("{FN_PROP_ENUM}x")),
        ),
        (r"\not{toString}", false, Some(FN_TO_STRING)),
        (r"\not{valueOf}", false, Some(FN_VALUE_OF)),
        (r"\not{constructor}", false, Some(FN_OBJECT)),
        (r"\not{hasOwnProperty}", false, Some(FN_HAS_OWN)),
        (r"\not{isPrototypeOf}", false, Some(FN_IS_PROTO)),
        (r"\not{propertyIsEnumerable}", false, Some(FN_PROP_ENUM)),
        (r"\not{toLocaleString}", false, Some(FN_TO_LOCALE_STRING)),
        (r"\not{__proto__}", false, Some("[object Object]")),
        (
            r"\not{__defineGetter__}",
            false,
            Some("function __defineGetter__() { [native code] }"),
        ),
        (
            r"\not{__defineSetter__}",
            false,
            Some("function __defineSetter__() { [native code] }"),
        ),
        (
            r"\not{__lookupGetter__}",
            false,
            Some("function __lookupGetter__() { [native code] }"),
        ),
        (
            r"\not{__lookupSetter__}",
            false,
            Some("function __lookupSetter__() { [native code] }"),
        ),
        (
            r#"\frac{\not{toString}}{x}"#,
            true,
            Some(concat!(
                "function toString() { [native code] }\n",
                "─────────────────────────────────────\n",
                "                  x"
            )),
        ),
        (
            r"x^\not{valueOf}",
            false,
            Some("x^(function valueOf() { [native code] })"),
        ),
        (
            r#"\begin{pmatrix}\not{toString}&1\\1&2\end{pmatrix}"#,
            false,
            Some(concat!(
                "⎛ function toString() { [native code] } │ 1 ⎞\n",
                "⎝ 1                                     │ 2 ⎠"
            )),
        ),
        (r"a\toString b", true, Some(&format!("a{FN_TO_STRING} b"))),
        (
            r#"\operatorname*{\not{valueOf}}_a^b"#,
            false,
            Some("function valueOf() { [native code] }[a]ᵇ"),
        ),
        (r"\not{   toString   }", false, Some(FN_TO_STRING)),
        (r"\text{\not{toString}}", false, Some(FN_TO_STRING)),
    ];
    for (index, (source, display, expected)) in cases.iter().enumerate() {
        check_case(&Case {
            id: format!("object-prototype: {index}"),
            source: (*source).to_string(),
            display: *display,
            expected: expected.map(|s| s.to_string()),
        });
    }
}
