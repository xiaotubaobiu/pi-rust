"""Read-only actual-source UI/width oracle verifier; never rewrites expected data."""
import hashlib
import json
from pathlib import Path
REPO = Path(__file__).resolve().parents[3]
REFERENCE = REPO / 'docs/migration/reference/alt-screen-search-component'
LOGS = REPO / 'docs/migration/validation'
PATHS = {
    'fixtures.json': 'src/tui/alt_screen_search_component/fixtures.json',
    'source-manifest.json': 'docs/migration/reference/alt-screen-search-component/source-manifest.json',
    'rgi_emoji_vs16.rs': 'src/tui/utils/rgi_emoji_vs16.rs',
    'width-vs16-fixtures.json': 'src/tui/alt_screen_search_component/width_vs16_fixtures.json',
    'width-vs16-manifest.json': 'docs/migration/reference/alt-screen-search-component/width-vs16-manifest.json',
}
COUNTS = {'render': 953, 'styles': 84, 'keys': 169, 'editing': 35, 'unicode': 198, 'paste': 24, 'sequences': 50}
def sha(b): return hashlib.sha256(b).hexdigest()
def entry(b): return {'bytes': len(b), 'sha256': sha(b)}
def main():
    for name, rel in PATHS.items():
        actual = (REPO / 'target/alt-screen-search-component-oracle' / name).read_bytes()
        assert actual == (REPO / rel).read_bytes(), rel
        print('BYTE-IDENTICAL', rel, len(actual), sha(actual))
    manifest = json.loads((REFERENCE / 'source-manifest.json').read_bytes())
    assert manifest['upstreamHead'] == '5901446094988aa5cd8e11efdaa131c3949106f1'
    assert (manifest['node'], manifest['unicode'], manifest['icu']) == ('v25.8.2', '17.0', '78.2')
    assert manifest['nativeTestsExecuted'] is False
    assert manifest['dependencies'] == {'get-east-asian-width': '1.6.0'}
    assert (len(manifest['sources']), len(manifest['referenceTests'])) == (22, 1)
    for kind, directory in [('sources', 'src'), ('referenceTests', 'test')]:
        for name, digest in manifest[kind].items():
            assert sha((REPO.parent / 'pi/packages/tui' / directory / name).read_bytes()) == digest, name
    assert sha((REFERENCE / 'generate-fixtures.mjs').read_bytes()) == manifest['generatorSha256']
    raw = (REPO / PATHS['fixtures.json']).read_bytes()
    fixture = json.loads(raw)
    assert {k: len(v) for k, v in fixture.items()} == COUNTS
    assert manifest['artifacts']['fixtures.json'] == dict(entry(raw), counts=COUNTS)
    assert sum(len(c['ops']) for cases in fixture.values() for c in cases) == 11770
    for group, cases in fixture.items():
        assert len(cases) == len({c['name'] for c in cases}), group
        assert all(len(c['ops']) == len(c['expected']) for c in cases), group
    width = json.loads((REFERENCE / 'width-vs16-manifest.json').read_bytes())
    wf = json.loads((REPO / PATHS['width-vs16-fixtures.json']).read_bytes())
    assert (width['node'], width['unicode']) == ('v25.8.2', '17.0')
    assert width['generatorSha256'] == sha((REFERENCE / 'width-vs16.mjs').read_bytes())
    assert width['upstreamUtilsSha256'] == manifest['sources']['utils.ts']
    assert width['upstreamComponentSha256'] == manifest['sources']['alt-screen-search.ts']
    assert width['scannedScalars'] == wf['scannedScalars'] == 1112064
    assert width['acceptedBases'] == len(wf['acceptedBases']) == 207
    assert wf['acceptedBases'] == sorted(set(wf['acceptedBases']))
    assert width['cases'] == len(wf['cases']) == 1606
    for name, expected in width['artifacts'].items():
        assert entry((REPO / PATHS[name]).read_bytes()) == expected, name
    assert wf['independent']['rect'] == [2, 3, 4, 5]
    assert wf['independent']['firstQuery'] == ['abc']
    assert wf['independent']['afterBackspace'] == ['abc', 'ab']
    for directory in ['search-component-first-test-evidence', 'search-component-vs16-evidence']:
        frozen = LOGS / directory
        receipt = json.loads((frozen / 'freeze.json').read_bytes())
        assert len(receipt['files']) == 4
        for rel, expected in receipt['files'].items():
            data = (frozen / rel).read_bytes()
            assert data == (REPO / rel).read_bytes(), rel
            assert entry(data) == expected, rel
        print('FROZEN', directory, receipt['recorded'], '4 files unchanged')
    for directory, receipt_name, subdir in [
        ('search-component-first-test-evidence', 'initial-source.json', 'initial-source'),
        ('search-component-initial-failure-evidence', 'receipt.json', ''),
    ]:
        base = LOGS / directory
        receipt = json.loads((base / receipt_name).read_bytes())
        for rel, expected in receipt['files'].items():
            assert entry((base / subdir / rel).read_bytes()) == expected, rel
        print('INITIAL-SOURCE-AND-FAILURE-EVIDENCE', directory, 'unchanged')
    print('COUNTS', COUNTS, 'TOTAL-CASES', sum(COUNTS.values()), 'OPERATIONS', 11770)
    print('WIDTH exhaustive1112064 scalar+VS16 probes;207 bases;1606 cases;actual-source rect/paste probes')
    print('PASS: real SearchComponent/Input/style/keybindings;valid UTF8 UI;not raw UTF16 UI/full host/native alt-screen suite')
if __name__ == '__main__': main()
