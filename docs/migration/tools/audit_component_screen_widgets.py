"""Read-only screen-widget protection/gates/repro/handoff audit.
Does not import the checkpoint writer or rewrite any expected output.
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
REPO = Path(__file__).resolve().parents[3]
PREVIOUS = REPO.parent / '.migration-handoff/checkpoint-2026-09-24-component-clipboard'
LOGS = REPO / 'docs/migration/validation'
ALLOWED = {'src/tui/mod.rs', 'src/tui/tests.rs', 'src/tui/components/scroll_view.rs'}
NEW = {'src/tui/component_screen_widgets.rs', 'src/tui/tests/component_screen_widgets.rs', 'src/tui/component_screen_widgets/fixtures.json'}
DOCS = {'HANDOFF.md', 'docs/migration/MIGRATION_STATUS.md', 'docs/migration/WORK_LOG.md', 'docs/migration/NEXT_SESSION_PROMPT.md', 'docs/migration/NEXT_SLICE_PLAN.md', 'docs/migration/TUI_COMPATIBILITY.md', 'docs/migration/ORACLE_COVERAGE.md'}
def sha(b):return hashlib.sha256(b).hexdigest()
def git(root,*args):return subprocess.check_output(['git','-C',str(root),*args])
def safe(root,rel):
    p=root/rel
    assert not Path(rel).is_absolute() and '..'not in Path(rel).parts
    assert p.resolve().is_relative_to(root.resolve()) and not p.is_symlink(),rel
    return p

def probe(text):
    tail=text.split('docs/migration/reference/markdown/probe-ansi-rejoin.mjs START ',1)[1]
    return json.JSONDecoder().raw_decode(tail[tail.index('{'):])[0]

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--handoff',action='store_true');args=parser.parse_args()
    print('START',datetime.now().astimezone().isoformat())
    raw=(PREVIOUS/'manifest.json').read_bytes()
    assert sha(raw)=='751535c1c6dda88d03f49dd2424638675dfb590101cf172ea2f19d5fd45d3cb6'
    assert sha(raw)==(PREVIOUS/'manifest.sha256').read_text().split()[0]
    m=json.loads(raw);old={e['path']:e for e in m['files']};archived=protected=unchanged=deleted=0
    for rel,e in old.items():
        backup=safe(PREVIOUS/'files',rel);live=safe(REPO,rel)
        if e['sha256'] is None:
            assert not backup.exists() and not live.exists(),rel;deleted+=1;continue
        assert sha(backup.read_bytes())==e['sha256'],rel;archived+=1
        if (rel.startswith('src/')or rel in ('Cargo.toml','Cargo.lock','build.rs'))and rel not in ALLOWED:
            assert sha(live.read_bytes())==e['sha256'],rel;protected+=1
        if rel not in ALLOWED|DOCS:
            assert sha(live.read_bytes())==e['sha256'],rel;unchanged+=1
    assert (archived,deleted,protected,unchanged)==(603,1,192,593)
    for e in m['evidence']+m['supplemental']:
        assert sha(safe(PREVIOUS,e['path']).read_bytes())==e['sha256'],e['path']
    for root,key in [(REPO,'head'),(REPO.parent/'pi','upstream_head')]:
        assert git(root,'rev-parse','HEAD').decode().strip()==m[key]
        assert not git(root,'diff','--cached','--name-only','-z')
    print('PRESERVED',archived,'archive files/',deleted,'historical deletion;192 nonallow source/build;593 all nonallow inherited files;both HEADs/index unchanged')
    before=(PREVIOUS/'files/docs/migration/WORK_LOG.md').read_bytes();work=(REPO/'docs/migration/WORK_LOG.md').read_bytes()
    assert len(before)==233715 and sha(before)=='d41ab4e0eab716c331518543acca9767e2e800974e601b0a342e201d437674d8'
    assert work.startswith(before)
    for length,digest in [(217724,'5be28a816ab8225414b34bcf5bd8d91467affda87bb3b9b2ef4d50fd5e27c192'),(207211,'61ca26dc0ae40c1dfdc53c58ed1b159ba3bb2780e3c763878779d7f8d5aa31b5'),(188843,'aab4eb10280fb41045bc29c024ea288501fd9eea796c59ad1e6eabf129743ce9'),(171829,'542a2fb9cc733d5b2b6e444330a6cfbc2210716d66fd91cab841da820a6e8102'),(155716,'edc687f392f90972602231e855dae8aca82aae6afa7dac2c0bd9dce51058a516'),(143371,'a0b27e696293ff779dd9003328c89d7ec045ada505a178e6fa8d28194c958953'),(128257,'bc967c8cc03d94504b8b3a6cb349e385928e092a77488dc7abb806c33d4eebe5')]:
        assert sha(work[:length])==digest,length
    print('WORK-LOG-PREFIX',len(before),sha(before),'CURRENT',len(work),sha(work))
    for rel,decl in [('src/tui/mod.rs','pub mod component_screen_widgets;\n'),('src/tui/tests.rs','mod component_screen_widgets;\n')]:
        assert (REPO/rel).read_bytes()==(PREVIOUS/'files'/rel).read_bytes()+decl.encode()
    rel='src/tui/components/scroll_view.rs'
    addition=b'    /// Configured follow policy, distinct from the current following state.\n    pub fn follow_end(&self) -> bool {\n        self.state.lock().unwrap().follow_end\n    }\n'
    current=(REPO/rel).read_bytes();assert current.count(addition)==1
    assert current.replace(addition,b'')==(PREVIOUS/'files'/rel).read_bytes()
    dirty={p.decode('utf8')for p in git(REPO,'ls-files','--modified','--deleted','--others','--exclude-standard','-z').split(b'\0')if p}
    assert {p for p in dirty-old.keys()if p.startswith('src/')or p in ('Cargo.toml','Cargo.lock','build.rs')}==NEW
    accept=json.loads((LOGS/'component-screen-widgets-acceptance.json').read_bytes())
    witness=json.loads(safe(LOGS,accept['witness']).read_bytes());assert set(witness['source'])==ALLOWED|NEW
    for rel in sorted(ALLOWED|NEW):
        b=(REPO/rel).read_bytes();assert witness['source'][rel]=={'bytes':len(b),'sha256':sha(b)},rel
        assert not re.search(r'\bunsafe\s*(?:\{|fn\b|impl\b|trait\b|extern\b)',b.decode('utf8'))
        print('SOURCE-WITNESS',rel,len(b),sha(b))
    for rel,digest in accept['evidence_sha256'].items():
        assert sha(safe(LOGS,rel).read_bytes())==digest,rel
    overlay={'NO_PROXY':'localhost,127.0.0.1,::1'}
    assert accept['environment_overlay']==witness['environment_overlay']==overlay
    failed_witness=json.loads(safe(LOGS,accept['first_failed_witness']).read_bytes())
    assert failed_witness['source']==witness['source'],'production/test/fixture changed between failed and passed gates'
    failed=safe(LOGS,accept['first_failed_gates']).read_text('utf8')
    assert len(re.findall(r'^test (.+?) \.\.\. FAILED$',failed,re.M))==416
    assert failed.count('has been running for over 60 seconds')==4
    assert 'EXIT=4294967295 END'in failed and 'cargo test --offline --doc START'not in failed
    diagnostic=safe(LOGS,accept['diagnostic']).read_text('utf8')
    results=json.loads(re.search(r'^RESULTS (.+)$',diagnostic,re.M).group(1))
    assert [r['exit']for r in results]==[101,0,101,0,0,0]
    assert diagnostic.count('left: Some("502 status code with empty body")')==2
    assert diagnostic.count('right: Some("401: bad key")')==2
    assert 'TIMEOUT_RESULT_NOT_A_TEST_PASS'not in diagnostic
    print('HTTP EVIDENCE first gate416fail/4hung/interrupted;serial AB fails101-passes0-fails101;3 extra isolated bypass passes. Only explicit child NO_PROXY, no system/source/thread/skip change.')
    gates=safe(LOGS,accept['gates']).read_text('utf8')
    assert json.loads(re.search(r'^ENVIRONMENT_OVERLAY (.+)$',gates,re.M).group(1))==overlay
    expected=['cargo fmt --all -- --check','cargo clippy --offline --all-targets -- -D warnings','cargo test --offline --all-targets','cargo test --offline --doc']
    assert re.findall(r'^COMMAND (.*?) START ',gates,re.M)==expected
    assert gates.count('EXIT=0 END')==4 and 'EXIT=101'not in gates
    for passed,ignored in [(2436,2),(27,0),(9,0),(5,1)]:
        assert f'test result: ok. {passed} passed; 0 failed; {ignored} ignored;'in gates
    print('GATES 4 original commands with recorded child loopback NO_PROXY exit0;2472 all-target passes=2436lib+27generator+9CLI;2 historical ignored;docs5pass/1historical ignored')
    repro=safe(LOGS,accept['repro']).read_text('utf8')
    assert repro.count('EXIT=0 END')==28
    artifacts=re.findall(r'^BYTE-IDENTICAL (\S+) (\d+) ([a-f0-9]{64})$',repro,re.M)
    assert len(artifacts)==len({a[0]for a in artifacts})==36
    preserved=0
    for rel,size,digest in artifacts:
        b=safe(REPO,rel).read_bytes();assert len(b)==int(size)and sha(b)==digest,rel
        if rel in old:
            assert digest==old[rel]['sha256'],rel;preserved+=1
    assert preserved==34
    assert 'ℹ tests 15'in repro and 'ℹ pass 15'in repro and 'ℹ fail 0'in repro
    previous_repro=(PREVIOUS/'files/docs/migration/validation/2026-09-24-214425-component-clipboard-oracle-repro.log').read_text('utf8')
    assert probe(repro)==probe(previous_repro)and len(probe(repro)['cases'])==30
    print('REPRO 36 artifacts byte-identical,old34 preserved,30 ANSI probes unchanged,15 real layout tests passed')
    subprocess.run([sys.executable,'docs/migration/tools/verify_component_screen_widgets_oracle.py'],cwd=REPO,check=True)
    for name in ['2026-09-24-220948-component-screen-widgets-test.log','2026-09-24-221216-component-screen-widgets-test.log']:
        text=(LOGS/name).read_text('utf8');assert '8 passed; 1 failed;'in text and 'EXIT=101'in text
    initial=(LOGS/'2026-09-24-2207-component-screen-widgets-initial-tests.log').read_text('utf8');assert 'E0106'in initial and 'TEST EXIT 101'in initial
    fixed=(LOGS/'2026-09-24-221303-component-screen-widgets-test.log').read_text('utf8');assert '9 passed; 0 failed;'in fixed and fixed.count('EXIT=0 END')==2
    print('FAILURES retained:oracle observer/service construction,initial compile,arena-observer failure,failed patch+same-test retry;accepted fixtures unchanged')
    for rel in DOCS:
        old_text=(PREVIOUS/'files'/rel).read_text('utf8');text=(REPO/rel).read_text('utf8');assert text.count('\ufffd')==old_text.count('\ufffd'),rel
    if args.handoff:
        for rel in DOCS-{'docs/migration/WORK_LOG.md','docs/migration/TUI_COMPATIBILITY.md','docs/migration/ORACLE_COVERAGE.md'}:
            text=(REPO/rel).read_text('utf8')
            assert 'component-screen-widgets'in text and 'checkpoint-2026-09-24-component-screen-widgets'in text,rel
            assert '全量迁移未完成'in text and '2472'in text and 'NO_PROXY'in text and '416'in text,rel
        before=(PREVIOUS/'files/docs/migration/TUI_COMPATIBILITY.md').read_text('utf8');current=(REPO/'docs/migration/TUI_COMPATIBILITY.md').read_text('utf8')
        old_line=next(l for l in before.splitlines()if l.startswith('Current mouse/focus/selection API status:'))
        new_line=next(l for l in current.splitlines()if l.startswith('Current mouse/focus/selection API status:'))
        assert current.startswith(before.replace(old_line,new_line,1))
        assert (REPO/'docs/migration/ORACLE_COVERAGE.md').read_bytes().startswith((PREVIOUS/'files/docs/migration/ORACLE_COVERAGE.md').read_bytes())
        root=(REPO.parent/'MIGRATION_HANDOFF.md').read_text('utf8')
        assert 'checkpoint-2026-09-24-component-screen-widgets'in root and '2472'in root and 'NO_PROXY'in root and '416'in root and '\ufffd'not in root
        assert not (REPO/'MIGRATION_HANDOFF.md').exists()
        assert git(REPO,'ls-files','--','docs/ROADMAP.md').strip()==b'docs/ROADMAP.md'
        assert not git(REPO,'diff','--','docs/ROADMAP.md')
        print('HANDOFF root/current pointers/status/UTF8/ledger prefixes intact;clean tracked ROADMAP not assumed archived;AGENTS preserved')
    print('PASS',datetime.now().astimezone().isoformat())
if __name__=='__main__':main()
