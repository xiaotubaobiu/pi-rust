"""Read-only verifier for actual-source screen widgets; never installs fixtures."""
import hashlib
import json
from pathlib import Path
REPO = Path(__file__).resolve().parents[3]
PATHS = {'fixtures.json':'src/tui/component_screen_widgets/fixtures.json',
         'source-manifest.json':'docs/migration/reference/component-screen-widgets/source-manifest.json'}
COUNTS = {'flashes':(141,336),'indicator':(57,237),'clicks':(51,234),
          'composed':(13,147),'routing':(5,20),'signed':(30,120)}
def sha(data): return hashlib.sha256(data).hexdigest()
def main():
    for name, rel in PATHS.items():
        actual=(REPO/'target/component-screen-widgets-oracle'/name).read_bytes()
        expected=(REPO/rel).read_bytes()
        assert actual==expected, rel
        print('BYTE-IDENTICAL',rel,len(actual),sha(actual))
    m=json.loads((REPO/PATHS['source-manifest.json']).read_bytes())
    data=(REPO/PATHS['fixtures.json']).read_bytes();f=json.loads(data)
    assert m['upstreamHead']=='5901446094988aa5cd8e11efdaa131c3949106f1'
    assert m['nativeTestsExecuted'] is False
    assert m['node']=='v25.8.2', 'Recorded artifact runtime is pinned; do not silently refresh'
    assert (len(m['sources']),len(m['referenceTests']))==(22,4)
    for kind, directory in [('sources','src'),('referenceTests','test')]:
        for name,digest in m[kind].items():
            assert sha((REPO.parent/'pi/packages/tui'/directory/name).read_bytes())==digest,name
    assert m['generatorSha256']==sha((REPO/'docs/migration/reference/component-screen-widgets/generate-fixtures.mjs').read_bytes())
    assert m['artifacts']['fixtures.json']=={'bytes':len(data),'sha256':sha(data),'counts':{k:len(v)for k,v in f.items()}}
    assert {g:(len(cs),sum(len(c['ops'])for c in cs))for g,cs in f.items()}==COUNTS
    errors=[]
    for g,cs in f.items():
        assert len({c['name']for c in cs})==len(cs), g
        for c in cs:
            assert len(c['ops'])==len(c['expected'])
            for i,e in enumerate(c['expected']):
                assert set(e)=={'value','state','trace'}
                if isinstance(e['value'],dict)and 'error'in e['value']:
                    errors.append((g,c['name'],i,e['value']))
    assert errors==[('indicator','callback-error-clears',4,{'error':'label rejected'})]
    frozen=REPO/'docs/migration/validation/component-screen-widgets-first-test-evidence'
    for rel in PATHS.values():
        assert (frozen/rel).read_bytes()==(REPO/rel).read_bytes(),rel
    assert (frozen/'docs/migration/reference/component-screen-widgets/generate-fixtures.mjs').read_bytes()==(REPO/'docs/migration/reference/component-screen-widgets/generate-fixtures.mjs').read_bytes()
    print('FROZEN-BEFORE-RUST-TESTS corpus/manifest/generator unchanged')
    print('COUNTS',COUNTS,'TOTAL-CASES',sum(v[0]for v in COUNTS.values()),'TOTAL-STEPS',sum(v[1]for v in COUNTS.values()))
    print('PASS: 22 complete modules;4 consulted test hashes (NOT native execution);manual geometry / real layout / routing seams separate;negative array property recorded')
if __name__=='__main__':main()
