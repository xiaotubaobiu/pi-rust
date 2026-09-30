"""Read-only protection/gate audit for the 2026-09-24 component-selection slice.

Six inherited files have exact signature/module-only permitted changes. All other
inherited source/build files, old28 artifacts and passed selection prefixes stay
unchanged. No fixture installation, Git mutation, network calls or file writes.
"""
import gzip
import hashlib
import json
import re
import subprocess
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PREVIOUS = REPO.parent / '.migration-handoff/checkpoint-2026-09-24-component-focus'
ALLOWED = {'src/tui/mod.rs', 'src/tui/tests.rs', 'src/tui/component_gesture.rs',
           'src/tui/tests/component_gesture.rs', 'src/tui/tests/component_overlay.rs',
           'src/tui/tests/component_focus.rs'}
NEW_SOURCE = {'src/tui/component_selection.rs', 'src/tui/component_selection/fixtures.json',
              'src/tui/tests/component_selection.rs'}
GATES = '2026-09-24-202716-component-selection-full-gates.log'
REPRO = '2026-09-24-202854-component-selection-oracle-repro.log'


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
    assert sha(data) == 'd1f94a38d70f8d01ac2159d0757c6b413f295a7a5838e5f23bf563d826f0c138'
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
        if (rel.startswith('src/') or rel in ('Cargo.toml', 'Cargo.lock', 'build.rs')) and rel not in ALLOWED:
            assert sha(safe(REPO, rel).read_bytes()) == item['sha256'], rel
            protected += 1
    for item in manifest.get('evidence', []) + manifest.get('supplemental', []):
        assert sha(safe(PREVIOUS, item['path']).read_bytes()) == item['sha256'], item['path']
    assert archived == 514, archived
    assert protected == 179, protected
    assert git(REPO, 'rev-parse', 'HEAD').decode().strip() == manifest['head']
    assert git(REPO.parent / 'pi', 'rev-parse', 'HEAD').decode().strip() == manifest['upstream_head']
    for repo in (REPO, REPO.parent / 'pi'):
        assert not git(repo, 'diff', '--cached', '--name-only', '-z'), repo
    print('ENTRY-ARCHIVE', archived, 'files/evidence/supplemental unchanged; manifest', sha(data))
    print('PROTECTED-SOURCE-BUILD', protected, 'HEADs unchanged; both indices empty; historical deletions retained')
    before = (PREVIOUS / 'files/docs/migration/WORK_LOG.md').read_bytes()
    work = (REPO / 'docs/migration/WORK_LOG.md').read_bytes()
    assert len(before) == 188843
    assert sha(before) == 'aab4eb10280fb41045bc29c024ea288501fd9eea796c59ad1e6eabf129743ce9'
    assert work.startswith(before)
    for length, digest in ((171829, '542a2fb9cc733d5b2b6e444330a6cfbc2210716d66fd91cab841da820a6e8102'),
                           (155716, 'edc687f392f90972602231e855dae8aca82aae6afa7dac2c0bd9dce51058a516'),
                           (143371, 'a0b27e696293ff779dd9003328c89d7ec045ada505a178e6fa8d28194c958953'),
                           (128257, 'bc967c8cc03d94504b8b3a6cb349e385928e092a77488dc7abb806c33d4eebe5')):
        assert sha(work[:length]) == digest, length
    print('WORK-LOG-PREFIX', len(before), sha(before), 'unchanged; current bytes', len(work))
    dirty = {x.decode('utf-8') for x in git(REPO, 'ls-files', '--modified', '--deleted', '--others', '--exclude-standard', '-z').split(b'\0') if x}
    fresh = {p for p in dirty - old.keys() if p.startswith('src/') or p in ('Cargo.toml', 'Cargo.lock', 'build.rs')}
    assert fresh == NEW_SOURCE, fresh
    for rel in sorted(ALLOWED | NEW_SOURCE):
        raw = (REPO / rel).read_bytes()
        assert not re.search(r'\bunsafe\s*(?:\{|fn\b|impl\b|trait\b|extern\b)', raw.decode('utf-8')), rel
        print('SOURCE-SCOPE', rel, len(raw), sha(raw))
    for rel in sorted(ALLOWED):
        previous = (PREVIOUS / 'files' / rel).read_text(encoding='utf-8')
        current = (REPO / rel).read_text(encoding='utf-8')
        if rel in ('src/tui/mod.rs', 'src/tui/tests.rs'):
            decl = 'pub mod component_selection;' if rel.endswith('/mod.rs') else 'mod component_selection;'
            assert current.splitlines() == previous.splitlines() + ['', decl], rel
        elif rel == 'src/tui/component_gesture.rs':
            needle = '    fn handle_selection_mouse_event(&mut self, raw: SgrMouseEvent);'
            replacement = ('    /// Selection receives this live controller so its release-click focus/capture\n'
                           '    /// effects are synchronous and persist in the ongoing mouse event stream.\n'
                           '    fn handle_selection_mouse_event(&mut self, raw: SgrMouseEvent, gesture: &mut ComponentGesture);')
            assert previous.count(needle) == 1
            previous = previous.replace(needle, replacement)
            needle = 'host.handle_selection_mouse_event(raw);'
            assert previous.count(needle) == 1
            assert current.splitlines() == previous.replace(needle, 'host.handle_selection_mouse_event(raw, self);').splitlines(), rel
        else:
            needle = 'fn handle_selection_mouse_event(&mut self, r: SgrMouseEvent) {'
            replacement = 'fn handle_selection_mouse_event(&mut self, r: SgrMouseEvent, _gesture: &mut ComponentGesture) {'
            assert previous.count(needle) == 1
            assert current.splitlines() == previous.replace(needle, replacement).splitlines(), rel
    print('ALLOW-LIST-DIFFS exactly2 module declarations;Gesture callback signature/call/2doc lines;3 test-host unused parameters')
    assert (REPO.parent / 'MIGRATION_HANDOFF.md').is_file()
    assert not (REPO / 'MIGRATION_HANDOFF.md').exists()
    logs = REPO / 'docs/migration/validation'
    gates = (logs / GATES).read_text(encoding='utf-8-sig')
    summaries = re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;', gates)
    assert summaries == [('2411', '0', '2'), ('27', '0', '0'), ('9', '0', '0'), ('5', '0', '1')], summaries
    assert gates.count('EXIT=0 END') == 4
    for line in gates.splitlines():
        if line.startswith(('COMMAND', 'test result:', 'EXIT=')):
            print(line)
    print('ALL-TARGETS 2447 passed,0 failed,2 ignored;DOC 5/0/1;9 new test functions')
    repro = (logs / REPRO).read_text(encoding='utf-8-sig')
    assert repro.count('BYTE-IDENTICAL ') == 30
    assert repro.count('EXIT=0 END') == 22
    artifact_lines = re.findall(r'^BYTE-IDENTICAL (\S+) (\d+) ([a-f0-9]{64})$', repro, re.MULTILINE)
    assert len({row[0] for row in artifact_lines}) == 30
    preserved = 0
    for rel, size, digest in artifact_lines:
        current = safe(REPO, rel).read_bytes()
        assert len(current) == int(size) and sha(current) == digest, rel
        if rel in old:
            assert digest == old[rel]['sha256'], rel
            preserved += 1
    assert preserved == 28, preserved
    assert 'ℹ tests 15' in repro and 'ℹ pass 15' in repro and 'ℹ fail 0' in repro
    old_repro = (PREVIOUS / 'files/docs/migration/validation/2026-09-24-194107-component-focus-oracle-repro.log').read_text(encoding='utf-8-sig')
    probes = probe_json(repro)
    assert probes == probe_json(old_repro) and len(probes['cases']) == 30
    print('REPRODUCTION 30 byte-identical artifacts;old28 preserved;30 ANSI probes identical;15 native layout tests passed')
    print('NATIVE FULL ALT-SCREEN TESTS NOT EXECUTED;4 selection-oracle consulted hashes are not tests')
    fixture = json.loads((REPO / 'src/tui/component_selection/fixtures.json').read_bytes())
    assert {k: (len(v), sum(len(c['ops']) for c in v)) for k, v in fixture.items() if isinstance(v, list)} == {
        'basic': (29, 123), 'ranges': (89, 326), 'scroll': (26, 219),
        'urls': (13, 55), 'composed': (21, 152), 'sequences': (16, 832)}
    assert len(fixture['wordSegments']) == 20
    historical = {}
    for version, expected_size, expected_hash in (
            ('initial-invalid-frame', 2972780, '4d3efa4cb89ed8dc248afc12accaf85dcbbf54184f045bd8ab3b0d47b0791f94'),
            ('initial-passed', 2999395, '32418f7dfcdb0176f040b24142c5820d6a957601cb8f884d84ffe7498e23abf2'),
            ('193-passed', 3198566, '4f2bf8b50261a9ae46d518f5ebf13580ba837617f22fd3b1948dad58f2c53f28')):
        raw = gzip.decompress((logs / f'component-selection-{version}-fixtures.json.gz').read_bytes())
        assert len(raw) == expected_size and sha(raw) == expected_hash, version
        meta = json.loads(gzip.decompress((logs / f'component-selection-{version}-source-manifest.json.gz').read_bytes()))
        assert meta['artifacts']['fixtures.json']['bytes'] == len(raw)
        assert meta['artifacts']['fixtures.json']['sha256'] == sha(raw)
        historical[version] = json.loads(raw)
        print('FORENSIC-CORPUS', version, len(raw), sha(raw))
        if version.endswith('passed'):
            for group, cases in historical[version].items():
                if isinstance(cases, list):
                    assert fixture[group][:len(cases)] == cases, (version, group)
                    print('PASSED-PREFIX-UNCHANGED', version, group, len(cases))
                else:
                    for line, segments in cases.items():
                        assert fixture[group][line] == segments, (version, line)
                    print('PASSED-SEGMENT-INPUTS-UNCHANGED', version, len(cases))
    invalid = historical['initial-invalid-frame']
    initial = historical['initial-passed']
    for group in ('basic', 'ranges', 'composed'):
        assert initial[group] == invalid[group], group
    for group in ('scroll', 'urls', 'sequences'):
        clean = lambda cases: [{k: v for k, v in c.items() if k != 'expected'} for c in cases]
        assert clean(initial[group]) == clean(invalid[group]), group
    bad_manifest = json.loads(gzip.decompress((logs / 'component-selection-initial-invalid-frame-source-manifest.json.gz').read_bytes()))
    assert sha((logs / 'component-selection-initial-invalid-frame-generator.mjs.txt').read_bytes()) == bad_manifest['generatorSha256']
    print('FRAME-SCHEMA-FIX all3 already-passed groups unchanged;all3 failing groups inputs unchanged;invalid generator retained')
    retry = (logs / '2026-09-24-202633-component-selection-capture-contract-retry.log').read_text(encoding='utf-8')
    assert retry.count('PASSED-PREFIX-UNCHANGED ') == 12
    assert retry.count('EXIT=0 END') == 5
    assert 'test result: ok. 9 passed; 0 failed; 0 ignored;' in retry
    for name in ('2026-09-24-201410-component-selection-initial-tests.log',
                 '2026-09-24-201507-component-selection-tests-compile-retry.log',
                 '2026-09-24-201735-component-selection-frame-schema-retry.log',
                 '2026-09-24-202005-component-selection-append-writer-diagnostic.log',
                 '2026-09-24-202116-component-selection-appended-tests.log',
                 '2026-09-24-202633-component-selection-capture-contract-retry.log'):
        raw = (logs / name).read_bytes()
        print('FAILURE-AND-RETRY-EVIDENCE', name, len(raw), sha(raw))
    print('SELECTION 194 cases/1707 steps;175+193 passed prefixes retained;20 externalIntl inputs;9 tests')
    print('PASS', datetime.now().astimezone().isoformat())


if __name__ == '__main__':
    main()
