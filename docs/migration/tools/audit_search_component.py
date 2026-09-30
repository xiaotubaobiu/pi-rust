"""Read-only search UI source, frozen oracle, regressions, and pause handoff audit."""
import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
REPO = Path(__file__).resolve().parents[3]
PREVIOUS = REPO.parent / '.migration-handoff/checkpoint-2026-09-24-alt-screen-search-index'
LOGS = REPO / 'docs/migration/validation'
ALLOWED = {'src/tui/mod.rs', 'src/tui/utils.rs'}
NEW = {'src/tui/alt_screen_search_component.rs', 'src/tui/tests/alt_screen_search_component.rs', 'src/tui/alt_screen_search_component/fixtures.json', 'src/tui/alt_screen_search_component/width_vs16_fixtures.json', 'src/tui/utils/rgi_emoji_vs16.rs'}
DOCS = {'AGENTS.md', 'HANDOFF.md', 'docs/migration/MIGRATION_STATUS.md', 'docs/migration/WORK_LOG.md', 'docs/migration/NEXT_SESSION_PROMPT.md', 'docs/migration/NEXT_SLICE_PLAN.md', 'docs/migration/TUI_COMPATIBILITY.md', 'docs/migration/ORACLE_COVERAGE.md'}
def sha(b): return hashlib.sha256(b).hexdigest()
def git(root, *args): return subprocess.check_output(['git', '-C', str(root), *args])
def safe(root, rel):
    p = root / rel
    assert not Path(rel).is_absolute() and '..' not in Path(rel).parts and not p.is_symlink(), rel
    assert p.resolve().is_relative_to(root.resolve()), rel
    return p

def probe(text):
    tail = text.split('docs/migration/reference/markdown/probe-ansi-rejoin.mjs START ', 1)[1]
    return json.JSONDecoder().raw_decode(tail[tail.index('{'):])[0]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--handoff', action='store_true')
    args = parser.parse_args()
    print('START', datetime.now().astimezone().isoformat(), flush=True)
    raw = (PREVIOUS / 'manifest.json').read_bytes()
    assert sha(raw) == '94560e5b9afb685ce7774501c7e96856376610e413562033378655f48c2aa12a'
    assert sha(raw) == (PREVIOUS / 'manifest.sha256').read_text().split()[0]
    manifest = json.loads(raw)
    old = {e['path']: e for e in manifest['files']}
    archived = deleted = protected = unchanged = 0
    for rel, e in old.items():
        backup = safe(PREVIOUS / 'files', rel)
        live = safe(REPO, rel)
        if e['sha256'] is None:
            assert not backup.exists() and not live.exists(), rel
            deleted += 1
            continue
        assert sha(backup.read_bytes()) == e['sha256'], rel
        archived += 1
        if (rel.startswith('src/') or rel in ('Cargo.toml', 'Cargo.lock', 'build.rs')) and rel not in ALLOWED:
            assert sha(live.read_bytes()) == e['sha256'], rel
            protected += 1
        if rel not in ALLOWED | DOCS:
            assert sha(live.read_bytes()) == e['sha256'], rel
            unchanged += 1
    assert (archived, deleted, protected, unchanged) == (697, 1, 200, 687)
    for e in manifest['evidence'] + manifest['supplemental']:
        assert sha(safe(PREVIOUS, e['path']).read_bytes()) == e['sha256'], e['path']
    for root, key in [(REPO, 'head'), (REPO.parent / 'pi', 'upstream_head')]:
        assert git(root, 'rev-parse', 'HEAD').decode().strip() == manifest[key]
        assert not git(root, 'diff', '--cached', '--name-only', '-z')
    print('PRESERVED 697archive/1historical deletion;200nonallow source/build;687all nonallow inherited;HEADs/indices unchanged')
    before = (PREVIOUS / 'files/docs/migration/WORK_LOG.md').read_bytes()
    work = (REPO / 'docs/migration/WORK_LOG.md').read_bytes()
    assert len(before) == 256391 and sha(before) == 'e6cecee81dbb7fe8e606053f7fabf424c061d1a813811cd658468b33ee7d18c8'
    assert work.startswith(before)
    for length, digest in [(243321, 'e65b8efde92b95e2741c1d52fd57f4a75979f6c58837ed5e29ded89eb81b0cc0'), (233715, 'd41ab4e0eab716c331518543acca9767e2e800974e601b0a342e201d437674d8'), (217724, '5be28a816ab8225414b34bcf5bd8d91467affda87bb3b9b2ef4d50fd5e27c192'), (207211, '61ca26dc0ae40c1dfdc53c58ed1b159ba3bb2780e3c763878779d7f8d5aa31b5'), (188843, 'aab4eb10280fb41045bc29c024ea288501fd9eea796c59ad1e6eabf129743ce9'), (171829, '542a2fb9cc733d5b2b6e444330a6cfbc2210716d66fd91cab841da820a6e8102'), (155716, 'edc687f392f90972602231e855dae8aca82aae6afa7dac2c0bd9dce51058a516'), (143371, 'a0b27e696293ff779dd9003328c89d7ec045ada505a178e6fa8d28194c958953'), (128257, 'bc967c8cc03d94504b8b3a6cb349e385928e092a77488dc7abb806c33d4eebe5')]:
        assert sha(work[:length]) == digest, length
    print('WORK-LOG-PREFIX', len(before), sha(before), 'CURRENT', len(work), sha(work))
    rel = 'src/tui/mod.rs'
    assert (REPO / rel).read_bytes() == (PREVIOUS / 'files' / rel).read_bytes() + b'\npub mod alt_screen_search_component;\n'
    rel = 'src/tui/utils.rs'
    before_utils = (PREVIOUS / 'files' / rel).read_bytes()
    expected = before_utils.replace(b'mod rgi_emoji;\r\n', b'mod rgi_emoji;\r\nmod rgi_emoji_vs16;\r\n').replace(b'use self::rgi_emoji::is_rgi_emoji;', b'use self::rgi_emoji_vs16::is_rgi_emoji;')
    current = (REPO / rel).read_bytes()
    assert current == expected and b'\n' not in current.replace(b'\r\n', b''), rel
    dirty = {p.decode('utf8') for p in git(REPO, 'ls-files', '--modified', '--deleted', '--others', '--exclude-standard', '-z').split(b'\0') if p}
    assert {p for p in dirty - old.keys() if p.startswith('src/') or p in ('Cargo.toml', 'Cargo.lock', 'build.rs')} == NEW
    accept = json.loads((LOGS / 'search-component-acceptance.json').read_bytes())
    witness = json.loads(safe(LOGS, accept['witness']).read_bytes())
    assert set(witness['source']) == ALLOWED | NEW
    for rel in sorted(ALLOWED | NEW):
        b = (REPO / rel).read_bytes()
        assert witness['source'][rel] == {'bytes': len(b), 'sha256': sha(b)}, rel
        assert not re.search(r'\bunsafe\s*(?:\{|fn\b|impl\b|trait\b|extern\b)', b.decode('utf8')), rel
        print('SOURCE-WITNESS', rel, len(b), sha(b))
    for rel, digest in accept['evidence_sha256'].items():
        assert sha(safe(LOGS, rel).read_bytes()) == digest, rel
    overlay = {'NO_PROXY': 'localhost,127.0.0.1,::1'}
    assert witness['environment_overlay'] == accept['environment_overlay'] == overlay
    gates = safe(LOGS, accept['gates']).read_text('utf8')
    assert json.loads(re.search(r'^ENVIRONMENT_OVERLAY (.+)$', gates, re.M).group(1)) == overlay
    commands = ['cargo fmt --all -- --check', 'cargo clippy --offline --all-targets -- -D warnings', 'cargo test --offline --all-targets', 'cargo test --offline --doc']
    assert re.findall(r'^COMMAND (.*?) START ', gates, re.M) == commands
    assert gates.count('EXIT=0 END') == 4 and 'EXIT=101' not in gates
    for passed, ignored in [(2469, 2), (27, 0), (9, 0), (5, 1)]:
        assert f'test result: ok. {passed} passed; 0 failed; {ignored} ignored;' in gates
    print('GATES original4 exit0;2505all-target=2469lib+27generator+9CLI;2historical ignored;docs5pass/1historical ignored;child-only NO_PROXY')
    failed_gates = safe(LOGS, accept['first_failed_gates']).read_text('utf8')
    assert 'test result: FAILED. 2468 passed; 1 failed; 2 ignored;' in failed_gates
    assert 'Vertex AI requires a project ID.' in failed_gates and 'EXIT=101 END' in failed_gates
    assert re.findall(r'^COMMAND (.*?) START ', failed_gates, re.M) == commands[:3]
    failed_witness = json.loads(safe(LOGS, accept['first_failed_witness']).read_bytes())
    assert failed_witness['source'] == witness['source']
    assert failed_witness['environment_overlay'] == overlay
    isolated = safe(LOGS, accept['vertex_isolated']).read_text('utf8')
    assert 'test result: ok. 1 passed; 0 failed; 0 ignored;' in isolated and isolated.count('EXIT=0 END') == 1
    print('FIRST GATE FAILURE retained:1 Vertex missing project;isolated pass and unchanged full rerun pass;root cause NOT established/no AI fix')
    initial = safe(LOGS, accept['initial_failed_test']).read_text('utf8')
    assert 'test result: FAILED. 10 passed; 4 failed; 0 ignored;' in initial and 'EXIT=101 END' in initial
    assert all(f'"unicode-8-{w}"' in initial for w in [4, 5, 13, 24, 48])
    fixed = safe(LOGS, accept['corrected_test']).read_text('utf8')
    assert 'test result: ok. 16 passed; 0 failed; 0 ignored;' in fixed and fixed.count('EXIT=0 END') == 2
    first_freeze = json.loads((LOGS / 'search-component-first-test-evidence/freeze.json').read_bytes())
    vs_freeze = json.loads((LOGS / 'search-component-vs16-evidence/freeze.json').read_bytes())
    def test_time(text):
        return datetime.fromisoformat(re.search(r'COMMAND cargo test --offline --lib search_component -- --nocapture START (.+)', text).group(1))
    assert datetime.fromisoformat(first_freeze['recorded']) < test_time(initial)
    assert test_time(initial) < datetime.fromisoformat(vs_freeze['recorded']) < test_time(fixed)
    failure = LOGS / 'search-component-initial-failure-evidence'
    assert (failure / 'src/tui/utils.rs').read_bytes() == before_utils
    assert (failure / 'src/tui/alt_screen_search_component.rs').read_bytes() == (REPO / 'src/tui/alt_screen_search_component.rs').read_bytes()
    print('INITIAL FAILURES retained:5unicode fixture mismatches fixed by general scalar+VS16 property table;3NEW independent assertions corrected against actual-source rect/paste probes;frozen oracle unchanged')
    repro = safe(LOGS, accept['repro']).read_text('utf8')
    assert repro.count('EXIT=0 END') == 34
    artifacts = re.findall(r'^BYTE-IDENTICAL (\S+) (\d+) ([a-f0-9]{64})$', repro, re.M)
    assert len(artifacts) == len({a[0] for a in artifacts}) == 44
    preserved = 0
    for rel, size, digest in artifacts:
        b = safe(REPO, rel).read_bytes()
        assert len(b) == int(size) and sha(b) == digest, rel
        if rel in old:
            assert digest == old[rel]['sha256'], rel
            preserved += 1
    assert preserved == 39
    previous_repro = (PREVIOUS / 'files/docs/migration/validation/2026-09-24-231241-alt-screen-search-repro.log').read_text('utf8')
    assert probe(repro) == probe(previous_repro) and len(probe(repro)['cases']) == 30
    assert '\u2139 tests 15' in repro and '\u2139 pass 15' in repro and '\u2139 fail 0' in repro
    print('REPRO 34commands;44artifacts byte-identical/39inherited unchanged;30ANSI probes unchanged;15real native layout tests passed')
    subprocess.run([sys.executable, 'docs/migration/tools/verify_search_component_oracle.py'], cwd=REPO, check=True)
    for name in ['alt-screen-search-acceptance.json', 'component-screen-widgets-acceptance.json']:
        prior = json.loads((LOGS / name).read_bytes())
        for rel, digest in prior['evidence_sha256'].items():
            assert sha(safe(LOGS, rel).read_bytes()) == digest, rel
    prior = json.loads((LOGS / 'component-screen-widgets-acceptance.json').read_bytes())
    failed = safe(LOGS, prior['first_failed_gates']).read_text('utf8')
    assert len(re.findall(r'^test (.+?) \.\.\. FAILED$', failed, re.M)) == 416
    assert failed.count('has been running for over 60 seconds') == 4 and 'EXIT=4294967295 END' in failed
    ab = safe(LOGS, prior['diagnostic']).read_text('utf8')
    assert [r['exit'] for r in json.loads(re.search(r'^RESULTS (.+)$', ab, re.M).group(1))] == [101, 0, 101, 0, 0, 0]
    print('HISTORY retained:index CRLF audit failure/repair;Unicode HTTPS provenance;screen-widgets416fail/4hung/proxy AB. No history relabeled as a code fix.')
    for rel in DOCS:
        prior_text = (PREVIOUS / 'files' / rel).read_text('utf8')
        current_text = (REPO / rel).read_text('utf8')
        assert current_text.count('\ufffd') == prior_text.count('\ufffd'), rel
    if args.handoff:
        assert accept['pause_after_slice'] is True and accept['full_migration_complete'] is False
        cp = accept['planned_checkpoint']
        for rel in DOCS - {'AGENTS.md', 'docs/migration/WORK_LOG.md', 'docs/migration/TUI_COMPATIBILITY.md', 'docs/migration/ORACLE_COVERAGE.md'}:
            text = (REPO / rel).read_text('utf8')
            for marker in ['alt-screen-search-component', cp, '\u5168\u91cf\u8fc1\u79fb\u672a\u5b8c\u6210', '2505', 'NO_PROXY', '416', '\u6682\u505c']:
                assert marker in text, (rel, marker)
        agents = (REPO / 'AGENTS.md').read_text('utf8')
        assert 'PAUSE_REQUESTED' in agents and 'do not start another slice' in agents
        old_tui = (PREVIOUS / 'files/docs/migration/TUI_COMPATIBILITY.md').read_text('utf8')
        tui = (REPO / 'docs/migration/TUI_COMPATIBILITY.md').read_text('utf8')
        old_line = next(l for l in old_tui.splitlines() if l.startswith('Current mouse/focus/selection API status:'))
        new_line = next(l for l in tui.splitlines() if l.startswith('Current mouse/focus/selection API status:'))
        assert tui.startswith(old_tui.replace(old_line, new_line, 1))
        assert (REPO / 'docs/migration/ORACLE_COVERAGE.md').read_bytes().startswith((PREVIOUS / 'files/docs/migration/ORACLE_COVERAGE.md').read_bytes())
        root = (REPO.parent / 'MIGRATION_HANDOFF.md').read_text('utf8')
        for marker in [cp, '2505', 'NO_PROXY', '416', '\u6682\u505c']:
            assert marker in root, marker
        assert '\ufffd' not in root and not (REPO / 'MIGRATION_HANDOFF.md').exists()
        assert git(REPO, 'ls-files', '--', 'docs/ROADMAP.md').strip() == b'docs/ROADMAP.md'
        assert not git(REPO, 'diff', '--', 'docs/ROADMAP.md')
        print('HANDOFF pause requested/no next slice;full migration incomplete;portable pointers/counts/limits;append-only ledgers;ROADMAP clean tracked;pre-pause active manifest is not resume authorization')
    print('PASS', datetime.now().astimezone().isoformat())
if __name__ == '__main__': main()
