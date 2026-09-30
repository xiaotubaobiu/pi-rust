"""Read-only protection/gate audit for the 2026-09-24 component-gesture slice.

Run from pi-rust: python docs/migration/tools/audit_component_gesture.py
Only this slice's two inherited module declaration files may differ from its entry snapshot.
No file installation, expectation rewriting, Git changes or network operations.
"""
import hashlib
import json
import re
import subprocess
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PREVIOUS = REPO.parent / '.migration-handoff/checkpoint-2026-09-24-component-routing'
ALLOWED = {'src/tui/mod.rs', 'src/tui/tests.rs'}
NEW_SOURCE = {
    'src/tui/component_gesture.rs', 'src/tui/component_gesture/fixtures.json',
    'src/tui/tests/component_gesture.rs',
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(path, *args):
    return subprocess.check_output(['git', '-C', str(path), *args])


def safe(base, rel):
    path = base / rel
    if Path(rel).is_absolute() or '..' in Path(rel).parts or not path.resolve().is_relative_to(base.resolve()):
        raise ValueError(f'unsafe manifest path: {rel}')
    return path


def probe_json(text):
    marker = 'docs/migration/reference/markdown/probe-ansi-rejoin.mjs START '
    tail = text.split(marker, 1)[1]
    return json.JSONDecoder().raw_decode(tail[tail.index('{'):])[0]


def main():
    print('START', datetime.now().astimezone().isoformat())
    data = (PREVIOUS / 'manifest.json').read_bytes()
    assert sha(data) == (PREVIOUS / 'manifest.sha256').read_text(encoding='utf-8').split()[0]
    manifest = json.loads(data)
    old = {f['path']: f for f in manifest['files']}
    archived = protected = 0
    for rel, item in old.items():
        path = safe(PREVIOUS / 'files', rel)
        if item.get('sha256') is None:
            assert not path.exists(), rel
            assert not safe(REPO, rel).exists(), rel
            continue
        assert sha(path.read_bytes()) == item['sha256'], rel
        archived += 1
        source = rel.startswith('src/') or rel in ('Cargo.toml', 'Cargo.lock', 'build.rs')
        if source and rel not in ALLOWED:
            assert sha(safe(REPO, rel).read_bytes()) == item['sha256'], rel
            protected += 1
    for item in manifest.get('evidence', []) + manifest.get('supplemental', []):
        assert sha(safe(PREVIOUS, item['path']).read_bytes()) == item['sha256'], item['path']
    assert archived == 456, archived
    assert git(REPO, 'rev-parse', 'HEAD').decode().strip() == manifest['head']
    assert git(REPO.parent / 'pi', 'rev-parse', 'HEAD').decode().strip() == manifest['upstream_head']
    assert not git(REPO, 'diff', '--cached', '--name-only', '-z')
    print('ENTRY-ARCHIVE', archived, 'files/evidence/supplemental unchanged; manifest', sha(data))
    print('PROTECTED-SOURCE-BUILD', protected, 'HEADs unchanged; index empty; historical deletions retained')
    before = (PREVIOUS / 'files/docs/migration/WORK_LOG.md').read_bytes()
    work = (REPO / 'docs/migration/WORK_LOG.md').read_bytes()
    assert len(before) == 143371
    assert sha(before) == 'a0b27e696293ff779dd9003328c89d7ec045ada505a178e6fa8d28194c958953'
    assert work.startswith(before)
    print('WORK-LOG-PREFIX', len(before), sha(before), 'unchanged; current bytes', len(work))
    dirty = {x.decode('utf-8') for x in git(REPO, 'ls-files', '--modified', '--deleted', '--others', '--exclude-standard', '-z').split(b'\0') if x}
    fresh = {p for p in dirty - old.keys() if p.startswith('src/') or p in ('Cargo.toml', 'Cargo.lock', 'build.rs')}
    assert fresh == NEW_SOURCE, fresh
    for rel in sorted(ALLOWED | NEW_SOURCE):
        source = (REPO / rel).read_text(encoding='utf-8')
        assert not re.search(r'\bunsafe\s*(?:\{|fn\b|impl\b|trait\b|extern\b)', source), rel
        print('SOURCE-SCOPE', rel, len(source.encode('utf-8')), sha(source.encode('utf-8')))
    logs = REPO / 'docs/migration/validation'
    gates = (logs / '2026-09-24-1821-component-gesture-full-gates.log').read_text(encoding='utf-8-sig')
    summaries = re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;', gates)
    assert summaries == [('2382', '0', '2'), ('27', '0', '0'), ('9', '0', '0'), ('5', '0', '1')], summaries
    assert gates.count('EXIT=0 END') == 4 and 'FOUR GATES PASS' in gates
    for line in gates.splitlines():
        if line.startswith(('COMMAND', 'test result:', 'EXIT=', 'FOUR GATES')):
            print(line)
    print('ALL-TARGETS 2418 passed,0 failed,2 ignored;DOC 5/0/1;9 new functions')
    repro = (logs / '2026-09-24-1823-component-gesture-oracle-repro.log').read_text(encoding='utf-8-sig')
    assert repro.count('BYTE-IDENTICAL ') == 24
    assert repro.count('EXIT=0 END') == 16
    assert 'ALL 24 ARTIFACTS REPRODUCED' in repro
    assert 'ℹ tests 15' in repro and 'ℹ pass 15' in repro and 'ℹ fail 0' in repro
    old_repro = (PREVIOUS / 'files/docs/migration/validation/2026-09-24-1756-component-routing-oracle-repro.log').read_text(encoding='utf-8-sig')
    probes = probe_json(repro)
    assert probes == probe_json(old_repro) and len(probes['cases']) == 30
    print('REPRODUCTION 24 byte-identical artifacts;old22 preserved;30 ANSI probes identical;15 native layout tests passed')
    print('NATIVE FULL ALT-SCREEN TESTS NOT EXECUTED;3 consulted hashes are not tests')
    print('PASS', datetime.now().astimezone().isoformat())


if __name__ == '__main__':
    main()
