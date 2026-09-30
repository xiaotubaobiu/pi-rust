"""Read-only source/fixture/gate/reproduction/handoff protection audit."""
import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
REPO=Path(__file__).resolve().parents[3]
PREVIOUS=REPO.parent/'.migration-handoff/checkpoint-2026-09-24-component-screen-widgets'
LOGS=REPO/'docs/migration/validation'
ALLOWED={'src/tui/mod.rs','src/tui/tests.rs','src/tui/utils.rs','src/tui/utils/utf16.rs'}
NEW={'src/tui/alt_screen_search_index.rs','src/tui/tests/alt_screen_search_index.rs','src/tui/alt_screen_search_index/fixtures.json','src/tui/alt_screen_search_index/simple_case_fold.rs'}
DOCS={'HANDOFF.md','docs/migration/MIGRATION_STATUS.md','docs/migration/WORK_LOG.md','docs/migration/NEXT_SESSION_PROMPT.md','docs/migration/NEXT_SLICE_PLAN.md','docs/migration/TUI_COMPATIBILITY.md','docs/migration/ORACLE_COVERAGE.md'}
def sha(b):return hashlib.sha256(b).hexdigest()
def git(root,*args):return subprocess.check_output(['git','-C',str(root),*args])
def safe(root,rel):
    p=root/rel
    assert not Path(rel).is_absolute() and '..'not in Path(rel).parts and not p.is_symlink(),rel
    assert p.resolve().is_relative_to(root.resolve()),rel
    return p

def probe(text):
    tail=text.split('docs/migration/reference/markdown/probe-ansi-rejoin.mjs START ',1)[1]
    return json.JSONDecoder().raw_decode(tail[tail.index('{'):])[0]

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--handoff',action='store_true');args=parser.parse_args()
    print('START',datetime.now().astimezone().isoformat())
    raw=(PREVIOUS/'manifest.json').read_bytes()
    assert sha(raw)=='70c849ecc5874e03dc4983f660d133806395e8a8867d08416ef1dbb77fc094d0'
    assert sha(raw)==(PREVIOUS/'manifest.sha256').read_text().split()[0]
    manifest=json.loads(raw);old={e['path']:e for e in manifest['files']}
    archived=deleted=protected=unchanged=0
    for rel,entry in old.items():
        backup=safe(PREVIOUS/'files',rel);live=safe(REPO,rel)
        if entry['sha256']is None:
            assert not backup.exists()and not live.exists(),rel;deleted+=1;continue
        assert sha(backup.read_bytes())==entry['sha256'],rel;archived+=1
        if (rel.startswith('src/')or rel in ('Cargo.toml','Cargo.lock','build.rs'))and rel not in ALLOWED:
            assert sha(live.read_bytes())==entry['sha256'],rel;protected+=1
        if rel not in ALLOWED|DOCS:
            assert sha(live.read_bytes())==entry['sha256'],rel;unchanged+=1
    assert (archived,deleted,protected,unchanged)==(647,1,194,636)
    for entry in manifest['evidence']+manifest['supplemental']:
        assert sha(safe(PREVIOUS,entry['path']).read_bytes())==entry['sha256'],entry['path']
    for root,key in [(REPO,'head'),(REPO.parent/'pi','upstream_head')]:
        assert git(root,'rev-parse','HEAD').decode().strip()==manifest[key]
        assert not git(root,'diff','--cached','--name-only','-z')
    print('PRESERVED 647 archive files/1 historical deletion;194 nonallow source/build;636 all nonallow inherited files;both HEADs and indices unchanged')
    before=(PREVIOUS/'files/docs/migration/WORK_LOG.md').read_bytes();work=(REPO/'docs/migration/WORK_LOG.md').read_bytes()
    assert len(before)==243321 and sha(before)=='e65b8efde92b95e2741c1d52fd57f4a75979f6c58837ed5e29ded89eb81b0cc0'
    assert work.startswith(before)
    for length,digest in [(233715,'d41ab4e0eab716c331518543acca9767e2e800974e601b0a342e201d437674d8'),(217724,'5be28a816ab8225414b34bcf5bd8d91467affda87bb3b9b2ef4d50fd5e27c192'),(207211,'61ca26dc0ae40c1dfdc53c58ed1b159ba3bb2780e3c763878779d7f8d5aa31b5'),(188843,'aab4eb10280fb41045bc29c024ea288501fd9eea796c59ad1e6eabf129743ce9'),(171829,'542a2fb9cc733d5b2b6e444330a6cfbc2210716d66fd91cab841da820a6e8102'),(155716,'edc687f392f90972602231e855dae8aca82aae6afa7dac2c0bd9dce51058a516'),(143371,'a0b27e696293ff779dd9003328c89d7ec045ada505a178e6fa8d28194c958953'),(128257,'bc967c8cc03d94504b8b3a6cb349e385928e092a77488dc7abb806c33d4eebe5')]:
        assert sha(work[:length])==digest,length
    print('WORK-LOG-PREFIX',len(before),sha(before),'CURRENT',len(work),sha(work))
    for rel,decl in [('src/tui/mod.rs','\npub mod alt_screen_search_index;\n'),('src/tui/tests.rs','\nmod alt_screen_search_index;\n')]:
        assert (REPO/rel).read_bytes()==(PREVIOUS/'files'/rel).read_bytes()+decl.encode(),rel
    rel='src/tui/utils.rs';addition=b'pub(crate) use utf16::strip_terminal_sequences_utf16;\r\n'
    current=(REPO/rel).read_bytes();assert current.count(addition)==1
    assert current.replace(addition,b'')==(PREVIOUS/'files'/rel).read_bytes()
    rel='src/tui/utils/utf16.rs';prior=(PREVIOUS/'files'/rel).read_bytes();current=(REPO/rel).read_bytes()
    addition=b'''
/// Strip once in original units, allowing ANSI removal to rejoin surrogate pairs.
/// Shares exactly the existing raw ANSI recognizer with width/wrapping.
pub(crate) fn strip_terminal_sequences_utf16(units: &[u16]) -> Vec<u16> {
    let mut result = Vec::with_capacity(units.len());
    let mut offset = 0;
    while offset < units.len() {
        if let Some(length) = ansi_length(units, offset) {
            offset += length;
        } else {
            result.push(units[offset]);
            offset += 1;
        }
    }
    result
}
'''
    assert current==prior+addition
    dirty={p.decode('utf8')for p in git(REPO,'ls-files','--modified','--deleted','--others','--exclude-standard','-z').split(b'\0')if p}
    assert {p for p in dirty-old.keys()if p.startswith('src/')or p in ('Cargo.toml','Cargo.lock','build.rs')}==NEW
    accept=json.loads((LOGS/'alt-screen-search-acceptance.json').read_bytes())
    witness=json.loads(safe(LOGS,accept['witness']).read_bytes());assert set(witness['source'])==ALLOWED|NEW
    for rel in sorted(ALLOWED|NEW):
        b=(REPO/rel).read_bytes();assert witness['source'][rel]=={'bytes':len(b),'sha256':sha(b)},rel
        assert not re.search(r'\bunsafe\s*(?:\{|fn\b|impl\b|trait\b|extern\b)',b.decode('utf8'))
        print('SOURCE-WITNESS',rel,len(b),sha(b))
    for rel,digest in accept['evidence_sha256'].items():
        assert sha(safe(LOGS,rel).read_bytes())==digest,rel
    repair=json.loads(safe(LOGS,accept['crlf_repair']).read_bytes())
    old_witness=json.loads(safe(LOGS,accept['pre_crlf_witness']).read_bytes())
    assert old_witness['source']['src/tui/utils.rs']==repair['before']
    assert witness['source']['src/tui/utils.rs']==repair['after']
    assert {k:v for k,v in old_witness['source'].items()if k!='src/tui/utils.rs'}=={k:v for k,v in witness['source'].items()if k!='src/tui/utils.rs'}
    failure=safe(LOGS,accept['failed_audit']).read_text('utf8')
    assert 'AssertionError'in failure and 'EXIT=1 END'in failure
    pre=safe(LOGS,'alt-screen-search-crlf-audit-evidence/src/tui/utils.rs').read_bytes()
    original=(PREVIOUS/'files/src/tui/utils.rs').read_bytes()
    assert pre.replace(b'pub(crate) use utf16::strip_terminal_sequences_utf16;\n',b'')==original.replace(b'\r\n',b'\n')
    print('CRLF FAILURE retained:exact-byte audit rejected normalization;restored original CRLF plus one import;only utils.rs bytes differ between gate witnesses;all four gates/repro rerun')
    overlay={'NO_PROXY':'localhost,127.0.0.1,::1'}
    assert witness['environment_overlay']==accept['environment_overlay']==overlay
    gates=safe(LOGS,accept['gates']).read_text('utf8')
    assert json.loads(re.search(r'^ENVIRONMENT_OVERLAY (.+)$',gates,re.M).group(1))==overlay
    commands=['cargo fmt --all -- --check','cargo clippy --offline --all-targets -- -D warnings','cargo test --offline --all-targets','cargo test --offline --doc']
    assert re.findall(r'^COMMAND (.*?) START ',gates,re.M)==commands
    assert gates.count('EXIT=0 END')==4 and 'EXIT=101'not in gates
    for passed,ignored in [(2453,2),(27,0),(9,0),(5,1)]:
        assert f'test result: ok. {passed} passed; 0 failed; {ignored} ignored;'in gates
    print('GATES original4 commands exit0;2489all-target passes=2453lib+27generator+9CLI;2historical ignored;docs5pass/1historical ignored;child-only loopback NO_PROXY')
    initial=safe(LOGS,accept['initial_test']).read_text('utf8')
    assert 'test result: ok. 17 passed; 0 failed; 0 ignored;'in initial and initial.count('EXIT=0 END')==2
    frozen=LOGS/'alt-screen-search-first-test-evidence'
    freeze=json.loads((frozen/'freeze.json').read_bytes())
    test_time=re.search(r'COMMAND cargo test --offline --lib search_index -- --nocapture START (.+)',initial).group(1)
    assert datetime.fromisoformat(freeze['recorded']) < datetime.fromisoformat(test_time)
    for rel in ALLOWED|{'src/tui/alt_screen_search_index.rs','src/tui/tests/alt_screen_search_index.rs'}:
        assert (frozen/rel).is_file(),rel
    repro=safe(LOGS,accept['repro']).read_text('utf8')
    assert repro.count('EXIT=0 END')==31
    artifacts=re.findall(r'^BYTE-IDENTICAL (\S+) (\d+) ([a-f0-9]{64})$',repro,re.M)
    assert len(artifacts)==len({a[0]for a in artifacts})==39
    preserved=0
    for rel,size,digest in artifacts:
        b=safe(REPO,rel).read_bytes();assert len(b)==int(size)and sha(b)==digest,rel
        if rel in old:
            assert digest==old[rel]['sha256'];preserved+=1
    assert preserved==36
    previous=(PREVIOUS/'files/docs/migration/validation/2026-09-24-222901-component-screen-widgets-repro.log').read_text('utf8')
    assert probe(repro)==probe(previous)and len(probe(repro)['cases'])==30
    assert 'ℹ tests 15'in repro and 'ℹ pass 15'in repro and 'ℹ fail 0'in repro
    print('REPRO 39artifacts byte-identical,36inherited unchanged;30ANSI probes unchanged;15real native layout tests passed')
    subprocess.run([sys.executable,'docs/migration/tools/verify_alt_screen_search_oracle.py'],cwd=REPO,check=True)
    acquisition=json.loads((REPO/'docs/migration/reference/alt-screen-search-index/unicode/acquisition.json').read_bytes())
    for name,e in acquisition['files'].items():
        b=(REPO/'docs/migration/reference/alt-screen-search-index/unicode'/name).read_bytes()
        assert len(b)==e['bytes']and sha(b)==e['sha256']
    prior_accept=json.loads((LOGS/'component-screen-widgets-acceptance.json').read_bytes())
    for rel,digest in prior_accept['evidence_sha256'].items():
        assert sha(safe(LOGS,rel).read_bytes())==digest,rel
    failed=safe(LOGS,prior_accept['first_failed_gates']).read_text('utf8')
    assert len(re.findall(r'^test (.+?) \.\.\. FAILED$',failed,re.M))==416
    assert failed.count('has been running for over 60 seconds')==4
    assert 'EXIT=4294967295 END'in failed
    ab=safe(LOGS,prior_accept['diagnostic']).read_text('utf8')
    assert [r['exit']for r in json.loads(re.search(r'^RESULTS (.+)$',ab,re.M).group(1))]==[101,0,101,0,0,0]
    print('NETWORK provenance explicitly retained;runtime table general C/S data not expected outputs. Previous416fail/4hung and proxy AB retained;not relabeled as a code fix.')
    for rel in DOCS:
        old_text=(PREVIOUS/'files'/rel).read_text('utf8');current=(REPO/rel).read_text('utf8')
        assert current.count('\ufffd')==old_text.count('\ufffd'),rel
    if args.handoff:
        for rel in DOCS-{'docs/migration/WORK_LOG.md','docs/migration/TUI_COMPATIBILITY.md','docs/migration/ORACLE_COVERAGE.md'}:
            text=(REPO/rel).read_text('utf8')
            for marker in ['alt-screen-search-index','checkpoint-2026-09-24-alt-screen-search-index','全量迁移未完成','2489','NO_PROXY','416']:
                assert marker in text,(rel,marker)
        old_tui=(PREVIOUS/'files/docs/migration/TUI_COMPATIBILITY.md').read_text('utf8');tui=(REPO/'docs/migration/TUI_COMPATIBILITY.md').read_text('utf8')
        old_line=next(l for l in old_tui.splitlines()if l.startswith('Current mouse/focus/selection API status:'))
        new_line=next(l for l in tui.splitlines()if l.startswith('Current mouse/focus/selection API status:'))
        assert tui.startswith(old_tui.replace(old_line,new_line,1))
        assert (REPO/'docs/migration/ORACLE_COVERAGE.md').read_bytes().startswith((PREVIOUS/'files/docs/migration/ORACLE_COVERAGE.md').read_bytes())
        root=(REPO.parent/'MIGRATION_HANDOFF.md').read_text('utf8')
        for marker in ['checkpoint-2026-09-24-alt-screen-search-index','2489','NO_PROXY','416']:
            assert marker in root,marker
        assert '\ufffd'not in root and not (REPO/'MIGRATION_HANDOFF.md').exists()
        assert git(REPO,'ls-files','--','docs/ROADMAP.md').strip()==b'docs/ROADMAP.md'
        assert not git(REPO,'diff','--','docs/ROADMAP.md')
        print('HANDOFF current pointers/counts/limits/UTF8 and append-only ledgers verified;ROADMAP still clean tracked,not assumed in archive;AGENTS preserved')
    print('PASS',datetime.now().astimezone().isoformat())
if __name__=='__main__':main()
