"""Read-only protection/gate audit for the 2026-09-24 component-focus slice.

Run from pi-rust: python docs/migration/tools/audit_component_focus.py
Only this slice's two explicitly listed inherited source files may differ from its entry snapshot.
No file installation, expectation rewriting, Git changes or network operations.
"""
import hashlib
import json
import re
import subprocess
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PREVIOUS = REPO.parent / '.migration-handoff/checkpoint-2026-09-24-component-overlay'
ALLOWED = {'src/tui/mod.rs', 'src/tui/tests.rs'}
NEW_SOURCE = {
    'src/tui/component_focus.rs', 'src/tui/component_focus/fixtures.json',
    'src/tui/tests/component_focus.rs',
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
    assert archived == 493, archived
    assert protected == 180, protected
    assert git(REPO, 'rev-parse', 'HEAD').decode().strip() == manifest['head']
    assert git(REPO.parent / 'pi', 'rev-parse', 'HEAD').decode().strip() == manifest['upstream_head']
    assert not git(REPO, 'diff', '--cached', '--name-only', '-z')
    print('ENTRY-ARCHIVE', archived, 'files/evidence/supplemental unchanged; manifest', sha(data))
    print('PROTECTED-SOURCE-BUILD', protected, 'HEADs unchanged; index empty; historical deletions retained')
    before = (PREVIOUS / 'files/docs/migration/WORK_LOG.md').read_bytes()
    work = (REPO / 'docs/migration/WORK_LOG.md').read_bytes()
    assert len(before) == 171829
    assert sha(before) == '542a2fb9cc733d5b2b6e444330a6cfbc2210716d66fd91cab841da820a6e8102'
    assert work.startswith(before)
    for length, digest in ((155716, 'edc687f392f90972602231e855dae8aca82aae6afa7dac2c0bd9dce51058a516'),
                           (143371, 'a0b27e696293ff779dd9003328c89d7ec045ada505a178e6fa8d28194c958953'),
                           (128257, 'bc967c8cc03d94504b8b3a6cb349e385928e092a77488dc7abb806c33d4eebe5')):
        assert sha(work[:length]) == digest, length
    print('WORK-LOG-PREFIX', len(before), sha(before), 'unchanged; current bytes', len(work))
    dirty = {x.decode('utf-8') for x in git(REPO, 'ls-files', '--modified', '--deleted', '--others', '--exclude-standard', '-z').split(b'\0') if x}
    fresh = {p for p in dirty - old.keys() if p.startswith('src/') or p in ('Cargo.toml', 'Cargo.lock', 'build.rs')}
    assert fresh == NEW_SOURCE, fresh
    for rel in sorted(ALLOWED | NEW_SOURCE):
        raw = (REPO / rel).read_bytes()
        source = raw.decode('utf-8')
        assert not re.search(r'\bunsafe\s*(?:\{|fn\b|impl\b|trait\b|extern\b)', source), rel
        print('SOURCE-SCOPE', rel, len(raw), sha(raw))
    for rel, declaration in (('src/tui/mod.rs', 'pub mod component_focus;'),
                             ('src/tui/tests.rs', 'mod component_focus;')):
        previous_lines = (PREVIOUS / 'files' / rel).read_text(encoding='utf-8').splitlines()
        current_lines = (REPO / rel).read_text(encoding='utf-8').splitlines()
        assert current_lines == previous_lines + ['', declaration], rel
    print('ALLOW-LIST-DIFFS only two module declarations added')
    assert (REPO.parent / 'MIGRATION_HANDOFF.md').is_file()
    assert not (REPO / 'MIGRATION_HANDOFF.md').exists()
    logs = REPO / 'docs/migration/validation'
    gates = (logs / '2026-09-24-193822-component-focus-full-gates.log').read_text(encoding='utf-8-sig')
    summaries = re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;', gates)
    assert summaries == [('2402', '0', '2'), ('27', '0', '0'), ('9', '0', '0'), ('5', '0', '1')], summaries
    assert gates.count('EXIT=0 END') == 4
    for line in gates.splitlines():
        if line.startswith(('COMMAND', 'test result:', 'EXIT=', 'FOUR GATES')):
            print(line)
    print('ALL-TARGETS 2438 passed,0 failed,2 ignored;DOC 5/0/1;10 new functions')
    repro = (logs / '2026-09-24-194107-component-focus-oracle-repro.log').read_text(encoding='utf-8-sig')
    assert repro.count('BYTE-IDENTICAL ') == 28
    assert repro.count('EXIT=0 END') == 20
    artifact_lines = re.findall(r'^BYTE-IDENTICAL (\S+) (\d+) ([a-f0-9]{64})$', repro, re.MULTILINE)
    assert len({row[0] for row in artifact_lines}) == 28
    preserved = 0
    for rel, size, digest in artifact_lines:
        current = safe(REPO, rel).read_bytes()
        assert len(current) == int(size) and sha(current) == digest, rel
        if rel in old:
            assert digest == old[rel]['sha256'], rel
            preserved += 1
    assert preserved == 26, preserved
    assert 'ℹ tests 15' in repro and 'ℹ pass 15' in repro and 'ℹ fail 0' in repro
    old_repro = (PREVIOUS / 'files/docs/migration/validation/2026-09-24-1856-component-overlay-oracle-repro.log').read_text(encoding='utf-8-sig')
    probes = probe_json(repro)
    assert probes == probe_json(old_repro) and len(probes['cases']) == 30
    print('REPRODUCTION 28 byte-identical artifacts;old26 preserved;30 ANSI probes identical;15 native layout tests passed')
    print('NATIVE FULL ALT-SCREEN TESTS NOT EXECUTED;4 focus-oracle consulted hashes are not tests')
    focus_fixture = json.loads((REPO / 'src/tui/component_focus/fixtures.json').read_bytes())
    assert {k: (len(v), sum(len(c['ops']) for c in v)) for k, v in focus_fixture.items()} == {
        'lifecycle': (23, 198), 'restore': (25, 189), 'visibility': (14, 132),
        'identity': (8, 86), 'composed': (10, 94), 'sequences': (24, 1069)}
    focus_proof = (logs / '2026-09-24-193751-component-focus-append-install-verify.log').read_text(encoding='utf-8')
    assert focus_proof.count('INITIAL-PASSED-PREFIX-UNCHANGED ') == 6
    assert focus_proof.count('EXIT=0 END') == 3
    assert 'test result: ok. 10 passed; 0 failed; 0 ignored;' in focus_proof
    for name in ('2026-09-24-192825-component-focus-initial-tests.log',
                 '2026-09-24-193120-component-focus-tests-retry.log'):
        data = (logs / name).read_bytes()
        print('FAILURE-AND-RETRY-EVIDENCE', name, len(data), sha(data))
    print('FOCUS 104 cases/1768 steps;6 initial passed prefixes preserved;10 tests;failure retained')
    print('PASS', datetime.now().astimezone().isoformat())


if __name__ == '__main__':
    main()
