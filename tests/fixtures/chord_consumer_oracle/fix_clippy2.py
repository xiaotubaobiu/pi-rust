import re

# ── consumer.rs ──────────────────────────────────────────────────────────────
p = "src/chord/consumer.rs"
s = open(p, encoding="utf8").read()

# stray blank line after doc comment
s = s.replace("""/// Port of upstream `RemoteServiceBindingImpl` (`consumer.ts:425-634`).

pub struct RemoteServiceBinding {""", """/// Port of upstream `RemoteServiceBindingImpl` (`consumer.ts:425-634`).
pub struct RemoteServiceBinding {""")

# unused Result in remote_facade Remote arm
s = s.replace("""            ServiceTarget::Remote(facade) => {
                (self.assert)();
                Ok(facade.clone())
            }""", """            ServiceTarget::Remote(facade) => {
                (self.assert)()?;
                Ok(facade.clone())
            }""")
open(p, "w", encoding="utf8", newline="\n").write(s)

# ── bundler.rs ───────────────────────────────────────────────────────────────
p = "src/chord/bundler.rs"
s = open(p, encoding="utf8").read()
s = s.replace("""use crate::chord::node::{
    validate_manifest, FacetBundleEntry, FACET_BUNDLE_FORMAT, FACET_BUNDLE_FORMAT_VERSION,
    FACET_BUNDLE_MANIFEST_FILE,
};""", """use crate::chord::node::{
    validate_manifest, FacetBundleEntry, FACET_BUNDLE_FORMAT, FACET_BUNDLE_FORMAT_VERSION,
};""")
# type_complexity at parse_chord_configuration return: introduce a named struct
old = """fn parse_chord_configuration(
    value: Option<&Value>,
    path: &str,
) -> Result<(BTreeMap<String, Option<String>>, Vec<String>, bool), ChordError> {"""
new = """fn parse_chord_configuration(
    value: Option<&Value>,
    path: &str,
) -> Result<ChordConfiguration, ChordError> {"""
assert old in s
s = s.replace(old, new)
s = s.replace("""    let Some(value) = value else {
        return Ok((BTreeMap::new(), Vec::new(), true));
    };""", """    let Some(value) = value else {
        return Ok(ChordConfiguration::default());
    };""")
s = s.replace("""    Ok((facets, external, source_map))
}""", """    Ok(ChordConfiguration {
        facets,
        external,
        source_map,
    })
}""")
old = """    let (configured_facets, external, source_map) =
        parse_chord_configuration(parsed.get("chord"), path)?;"""
new = """    let chord = parse_chord_configuration(parsed.get("chord"), path)?;
    let (configured_facets, external, source_map) =
        (chord.facets, chord.external, chord.source_map);"""
assert old in s
s = s.replace(old, new)
# add the struct before FacetPackageMetadata
old = """/// The parsed shape produced by `readFacetPackageMetadata`"""
new = """/// The parsed `chord` field of a facet `package.json` (upstream
/// `parseChordConfiguration`'s return shape).
#[derive(Clone, Debug, Default)]
pub struct ChordConfiguration {
    pub facets: BTreeMap<String, Option<String>>,
    pub external: Vec<String>,
    pub source_map: bool,
}

/// The parsed shape produced by `readFacetPackageMetadata`"""
assert old in s
s = s.replace(old, new)
open(p, "w", encoding="utf8", newline="\n").write(s)

# ── facets.rs ────────────────────────────────────────────────────────────────
p = "src/chord/facets.rs"
s = open(p, encoding="utf8").read()
# aliases for the complex closure types
old = """pub type Disposal = Box<dyn FnOnce() -> Result<(), ChordError> + Send>;"""
new = """pub type Disposal = Box<dyn FnOnce() -> Result<(), ChordError> + Send>;
/// Arc'd provider operation (install / validateReplacement / replace).
pub type ProviderOp = Arc<dyn Fn(&Arc<RemoteServiceProvider>) -> Result<(), ChordError> + Send + Sync>;
/// Arc'd keyed connector over the local registry (upstream `connectLocal`).
pub type ConnectLocal = Arc<dyn Fn(&Arc<LocalKeyedServiceRegistry>) -> Result<(), ChordError> + Send + Sync>;
/// Arc'd keyed connector over the provider (upstream `connectRemote`).
pub type ConnectRemote = Arc<dyn Fn(&Arc<RemoteServiceProvider>) -> Result<(), ChordError> + Send + Sync>;
/// Facet setup entry point (upstream `facet.setup(env)`).
pub type FacetSetup = Arc<dyn Fn(&mut FacetEnvironment) -> Result<(), ChordError> + Send + Sync>;"""
assert old in s
s = s.replace(old, new)
s = s.replace(
    "    setup: Arc<dyn Fn(&mut FacetEnvironment) -> Result<(), ChordError> + Send + Sync>,",
    "    setup: FacetSetup,")
s = s.replace(
    """        connect_local: Arc<dyn Fn(&Arc<LocalKeyedServiceRegistry>) -> Result<(), ChordError> + Send + Sync>,
        connect_remote: Arc<dyn Fn(&Arc<RemoteServiceProvider>) -> Result<(), ChordError> + Send + Sync>,""",
    """        connect_local: ConnectLocal,
        connect_remote: ConnectRemote,""")
# ServiceSource catalogue/open fields
s = s.replace("""    pub catalogue:
        Arc<dyn Fn(&Context) -> Result<Vec<ServiceCatalogueEntry>, ChordError> + Send + Sync>,
    pub open: Arc<
        dyn Fn(ServiceSourceOpenOptions) -> Result<Arc<dyn ServiceSourceBinding>, ChordError>
            + Send
            + Sync,
    >,""", """    pub catalogue: CatalogueFn,
    pub open: OpenFn,""")
old = """/// One external service source (upstream `RemoteServiceSource`).
pub struct ServiceSource {"""
new = """/// The source's catalogue resolver (upstream `catalogue(context)`).
pub type CatalogueFn =
    Arc<dyn Fn(&Context) -> Result<Vec<ServiceCatalogueEntry>, ChordError> + Send + Sync>;
/// The source's binding opener (upstream `open(options)`).
pub type OpenFn = Arc<
    dyn Fn(ServiceSourceOpenOptions) -> Result<Arc<dyn ServiceSourceBinding>, ChordError>
        + Send
        + Sync,
>;

/// One external service source (upstream `RemoteServiceSource`).
pub struct ServiceSource {"""
assert old in s
s = s.replace(old, new)
# unused `value` field of HostValuesImpl in the oracle test: keep for the
# downcast assertions; silence via underscore-free use in Debug? Add getter use.
open(p, "w", encoding="utf8", newline="\n").write(s)

# ── consumer_oracle.rs: field `value` never read ────────────────────────────
p = "src/chord/consumer_oracle.rs"
s = open(p, encoding="utf8").read()
s = s.replace("""struct HostValuesImpl {
    name: String,
    value: String,
}""", """struct HostValuesImpl {
    name: String,
    #[allow(dead_code)]
    value: String,
}""")
open(p, "w", encoding="utf8", newline="\n").write(s)
print("ok")
