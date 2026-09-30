"""Read-only protection/gate audit for the 2026-09-24 component-overlay slice.

Run from pi-rust: python docs/migration/tools/audit_component_overlay.py
Only this slice's seven explicitly listed inherited source files may differ from its entry snapshot.
No file installation, expectation rewriting, Git changes or network operations.
"""
import hashlib
import json
import re
import subprocess
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PREVIOUS = REPO.parent / '.migration-handoff/checkpoint-2026-09-24-component-gesture'
ALLOWED = {
    'src/tui/component.rs', 'src/tui/component_mouse.rs',
    'src/tui/components/container.rs', 'src/tui/components/stack.rs',
    'src/tui/components/scroll_view.rs', 'src/tui/mod.rs', 'src/tui/tests.rs',
}
NEW_SOURCE = {
    'src/tui/component_overlay.rs', 'src/tui/component_overlay/fixtures.json',
    'src/tui/tests/component_overlay.rs',
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
    assert archived == 473, archived
    assert protected == 172, protected
    assert git(REPO, 'rev-parse', 'HEAD').decode().strip() == manifest['head']
    assert git(REPO.parent / 'pi', 'rev-parse', 'HEAD').decode().strip() == manifest['upstream_head']
    assert not git(REPO, 'diff', '--cached', '--name-only', '-z')
    print('ENTRY-ARCHIVE', archived, 'files/evidence/supplemental unchanged; manifest', sha(data))
    print('PROTECTED-SOURCE-BUILD', protected, 'HEADs unchanged; index empty; historical deletions retained')
    before = (PREVIOUS / 'files/docs/migration/WORK_LOG.md').read_bytes()
    work = (REPO / 'docs/migration/WORK_LOG.md').read_bytes()
    assert len(before) == 155716
    assert sha(before) == 'edc687f392f90972602231e855dae8aca82aae6afa7dac2c0bd9dce51058a516'
    assert work.startswith(before)
    for length, digest in ((143371, 'a0b27e696293ff779dd9003328c89d7ec045ada505a178e6fa8d28194c958953'),
                           (128257, 'bc967c8cc03d94504b8b3a6cb349e385928e092a77488dc7abb806c33d4eebe5')):
        assert sha(work[:length]) == digest, length
    print('WORK-LOG-PREFIX', len(before), sha(before), 'unchanged; current bytes', len(work))
    dirty = {x.decode('utf-8') for x in git(REPO, 'ls-files', '--modified', '--deleted', '--others', '--exclude-standard', '-z').split(b'\0') if x}
    fresh = {p for p in dirty - old.keys() if p.startswith('src/') or p in ('Cargo.toml', 'Cargo.lock', 'build.rs')}
    assert fresh == NEW_SOURCE, fresh
    for rel in sorted(ALLOWED | NEW_SOURCE):
        source = (REPO / rel).read_text(encoding='utf-8')
        assert not re.search(r'\bunsafe\s*(?:\{|fn\b|impl\b|trait\b|extern\b)', source), rel
        print('SOURCE-SCOPE', rel, len(source.encode('utf-8')), sha(source.encode('utf-8')))
    logs = REPO / 'docs/migration/validation'
    gates = (logs / '2026-09-24-1853-component-overlay-full-gates.log').read_text(encoding='utf-8-sig')
    summaries = re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;', gates)
    assert summaries == [('2392', '0', '2'), ('27', '0', '0'), ('9', '0', '0'), ('5', '0', '1')], summaries
    assert gates.count('EXIT=0 END') == 4 and 'FOUR GATES PASS' in gates
    for line in gates.splitlines():
        if line.startswith(('COMMAND', 'test result:', 'EXIT=', 'FOUR GATES')):
            print(line)
    print('ALL-TARGETS 2428 passed,0 failed,2 ignored;DOC 5/0/1;10 new functions')
    repro = (logs / '2026-09-24-1856-component-overlay-oracle-repro.log').read_text(encoding='utf-8-sig')
    assert repro.count('BYTE-IDENTICAL ') == 26
    assert repro.count('EXIT=0 END') == 18
    assert 'ALL 26 ARTIFACTS REPRODUCED' in repro
    artifact_lines = re.findall(r'^BYTE-IDENTICAL (\S+) (\d+) ([a-f0-9]{64})$', repro, re.MULTILINE)
    assert len({row[0] for row in artifact_lines}) == 26
    preserved = 0
    for rel, size, digest in artifact_lines:
        current = safe(REPO, rel).read_bytes()
        assert len(current) == int(size) and sha(current) == digest, rel
        if rel in old:
            assert digest == old[rel]['sha256'], rel
            preserved += 1
    assert preserved == 24, preserved
    assert 'ℹ tests 15' in repro and 'ℹ pass 15' in repro and 'ℹ fail 0' in repro
    old_repro = (PREVIOUS / 'files/docs/migration/validation/2026-09-24-1823-component-gesture-oracle-repro.log').read_text(encoding='utf-8-sig')
    probes = probe_json(repro)
    assert probes == probe_json(old_repro) and len(probes['cases']) == 30
    print('REPRODUCTION 26 byte-identical artifacts;old24 preserved;30 ANSI probes identical;15 native layout tests passed')
    print('NATIVE FULL ALT-SCREEN TESTS NOT EXECUTED;3 consulted hashes are not tests')
    print('PASS', datetime.now().astimezone().isoformat())


if __name__ == '__main__':
    main()
