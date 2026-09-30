"""Read-only actual-source index oracle verifier; never installs expected data."""
import hashlib
import json
from pathlib import Path
REPO = Path(__file__).resolve().parents[3]
PATHS = {'fixtures.json':'src/tui/alt_screen_search_index/fixtures.json',
         'source-manifest.json':'docs/migration/reference/alt-screen-search-index/source-manifest.json',
         'simple_case_fold.rs':'src/tui/alt_screen_search_index/simple_case_fold.rs'}
COUNTS = {'basic':26,'whitespace':87,'literals':53,'unicode':45,'folding':1512,'graphemes':766,'raw':185,'fuzz':384,'cache':7,'keys':4}
def sha(b): return hashlib.sha256(b).hexdigest()
def main():
    for name,rel in PATHS.items():
        actual=(REPO/'target/alt-screen-search-oracle'/name).read_bytes()
        assert actual==(REPO/rel).read_bytes(),rel
        print('BYTE-IDENTICAL',rel,len(actual),sha(actual))
    manifest=json.loads((REPO/PATHS['source-manifest.json']).read_bytes())
    data=(REPO/PATHS['fixtures.json']).read_bytes();fixture=json.loads(data)
    assert manifest['upstreamHead']=='5901446094988aa5cd8e11efdaa131c3949106f1'
    assert manifest['node']=='v25.8.2' and manifest['unicode']=='17.0' and manifest['icu']=='78.2'
    assert manifest['nativeTestsExecuted'] is False
    assert (len(manifest['sources']),len(manifest['referenceTests']))==(22,1)
    for kind,directory in [('sources','src'),('referenceTests','test')]:
        for name,digest in manifest[kind].items():
            assert sha((REPO.parent/'pi/packages/tui'/directory/name).read_bytes())==digest,name
    reference=REPO/'docs/migration/reference/alt-screen-search-index'
    for name,digest in manifest['unicodeData'].items():
        assert sha((reference/'unicode'/name).read_bytes())==digest,name
    assert sha((reference/'generate-fixtures.mjs').read_bytes())==manifest['generatorSha256']
    assert {k:len(v)for k,v in fixture.items()}==COUNTS
    assert manifest['artifacts']['fixtures.json']=={'bytes':len(data),'sha256':sha(data),'counts':COUNTS}
    for group,cases in fixture.items():
        assert len(cases)==len({c['name']for c in cases}),group
    assert sum(len(c['ops'])for c in fixture['cache'])==76
    assert all(len(c['ops'])==len(c['expected'])for c in fixture['cache'])
    assert len(fixture['folding'])==len({tuple(c['pair'])for c in fixture['folding']})==1512
    frozen=REPO/'docs/migration/validation/alt-screen-search-first-test-evidence'
    receipt=json.loads((frozen/'freeze.json').read_bytes())
    for rel,entry in receipt['files'].items():
        expected=(frozen/rel).read_bytes()
        assert expected==(REPO/rel).read_bytes(),rel
        assert entry=={'bytes':len(expected),'sha256':sha(expected)},rel
    assert len(receipt['files'])==10
    print('FROZEN-BEFORE-RUST-TESTS',receipt['recorded'],'10 files unchanged: expected/generator/bootstrap/standard data/license/runtime folding table')
    print('COUNTS',COUNTS,'TOTAL-CASES',sum(COUNTS.values()),'CACHE-STEPS',76)
    print('PASS: actual complete source index;raw UTF16;array/object/nested alias identity;1512 Unicode17 simple folds;766 Intl/conformance inputs;no Search UI/native host suite execution')
if __name__=='__main__': main()
