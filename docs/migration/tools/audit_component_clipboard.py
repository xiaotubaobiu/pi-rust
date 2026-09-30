"""Read-only protection, gate, oracle and optional handoff audit for clipboard/flash and its narrow inherited trimEnd correction.
Never changes fixtures, Git, historical logs or the sibling upstream repository.
"""
import argparse
import hashlib
import json
import re
import subprocess
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PREVIOUS = REPO.parent / '.migration-handoff/checkpoint-2026-09-24-component-selection-paint'
ALLOWED = {'src/tui/mod.rs', 'src/tui/tests.rs', 'src/tui/components/mod.rs',
           'src/tui/utils.rs', 'src/tui/component_selection.rs'}
NEW_SOURCE = {'src/tui/component_clipboard.rs', 'src/tui/tests/component_clipboard.rs',
              'src/tui/component_clipboard/fixtures.json', 'src/tui/components/alt_screen_flash.rs'}
DOCS = {'HANDOFF.md', 'docs/migration/MIGRATION_STATUS.md', 'docs/migration/WORK_LOG.md',
        'docs/migration/NEXT_SESSION_PROMPT.md', 'docs/migration/NEXT_SLICE_PLAN.md',
        'docs/migration/TUI_COMPATIBILITY.md', 'docs/migration/ORACLE_COVERAGE.md'}
GATES = '2026-09-24-214225-component-clipboard-full-gates.log'
REPRO = '2026-09-24-214425-component-clipboard-oracle-repro.log'
LOGS = REPO / 'docs/migration/validation'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])


def safe(base, rel):
    p = base / rel
    assert not Path(rel).is_absolute() and '..' not in Path(rel).parts
    assert p.resolve().is_relative_to(base.resolve()) and not p.is_symlink(), rel
    return p


def probe(text):
    tail = text.split('docs/migration/reference/markdown/probe-ansi-rejoin.mjs START ', 1)[1]
    return json.JSONDecoder().raw_decode(tail[tail.index('{'):])[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--handoff', action='store_true')
    args = parser.parse_args()
    print('START', datetime.now().astimezone().isoformat())
    raw = (PREVIOUS / 'manifest.json').read_bytes()
    assert sha(raw) == 'af1a56f495847a3c0e32d2ffc92ac28374b12b8f8725ffb32c9ad4f56fbf1fde'
    assert sha(raw) == (PREVIOUS / 'manifest.sha256').read_text().split()[0]
    m = json.loads(raw)
    old = {e['path']: e for e in m['files']}
    archived = protected = all_unchanged = 0
    for rel, e in old.items():
        path = safe(PREVIOUS / 'files', rel)
        live = safe(REPO, rel)
        if e['sha256'] is None:
            assert not path.exists() and not live.exists(), rel
            continue
        assert sha(path.read_bytes()) == e['sha256'], rel
        archived += 1
        if (rel.startswith('src/') or rel in ('Cargo.toml', 'Cargo.lock', 'build.rs')) and rel not in ALLOWED:
            assert sha(live.read_bytes()) == e['sha256'], rel
            protected += 1
        if rel not in ALLOWED | DOCS:
            assert sha(live.read_bytes()) == e['sha256'], rel
            all_unchanged += 1
    for e in m['evidence'] + m['supplemental']:
        assert sha(safe(PREVIOUS, e['path']).read_bytes()) == e['sha256'], e['path']
    assert (archived, protected, all_unchanged) == (569, 186, 557)
    for repo, key in ((REPO, 'head'), (REPO.parent / 'pi', 'upstream_head')):
        assert git(repo, 'rev-parse', 'HEAD').decode().strip() == m[key]
        assert not git(repo, 'diff', '--cached', '--name-only', '-z')
    print('ENTRY', archived, 'archive/evidence/supplemental unchanged; both HEADs unchanged and indices empty')
    print('PROTECTED', protected, 'source/build files and', all_unchanged, 'all nonallow inherited files unchanged')
    before = (PREVIOUS / 'files/docs/migration/WORK_LOG.md').read_bytes()
    work = (REPO / 'docs/migration/WORK_LOG.md').read_bytes()
    assert len(before) == 217724 and sha(before) == '5be28a816ab8225414b34bcf5bd8d91467affda87bb3b9b2ef4d50fd5e27c192'
    assert work.startswith(before)
    for length, digest in ((207211, '61ca26dc0ae40c1dfdc53c58ed1b159ba3bb2780e3c763878779d7f8d5aa31b5'),
                           (188843, 'aab4eb10280fb41045bc29c024ea288501fd9eea796c59ad1e6eabf129743ce9'),
                           (171829, '542a2fb9cc733d5b2b6e444330a6cfbc2210716d66fd91cab841da820a6e8102'),
                           (155716, 'edc687f392f90972602231e855dae8aca82aae6afa7dac2c0bd9dce51058a516'),
                           (143371, 'a0b27e696293ff779dd9003328c89d7ec045ada505a178e6fa8d28194c958953'),
                           (128257, 'bc967c8cc03d94504b8b3a6cb349e385928e092a77488dc7abb806c33d4eebe5')):
        assert sha(work[:length]) == digest, length
    print('WORK-LOG-PREFIX', len(before), sha(before), 'unchanged; current', len(work), sha(work))
    dirty = {p.decode('utf-8') for p in git(REPO, 'ls-files', '--modified', '--deleted', '--others', '--exclude-standard', '-z').split(b'\0') if p}
    fresh = {p for p in dirty - old.keys() if p.startswith('src/') or p in ('Cargo.toml', 'Cargo.lock', 'build.rs')}
    assert fresh == NEW_SOURCE, fresh
    witness = json.loads((LOGS / 'component-clipboard-accepted-source.json').read_bytes())
    assert witness['gates'] == GATES and set(witness['source']) == ALLOWED | NEW_SOURCE
    for rel in sorted(ALLOWED | NEW_SOURCE):
        b = (REPO / rel).read_bytes()
        assert witness['source'][rel] == {'bytes': len(b), 'sha256': sha(b)}, rel
        assert not re.search(r'\bunsafe\s*(?:\{|fn\b|impl\b|trait\b|extern\b)', b.decode('utf-8')), rel
        print('SOURCE-SCOPE', rel, len(b), sha(b))
    declarations = {'src/tui/mod.rs': 'pub mod component_clipboard;',
                    'src/tui/tests.rs': 'mod component_clipboard;',
                    'src/tui/components/mod.rs': 'pub mod alt_screen_flash;'}
    for rel, decl in declarations.items():
        old_text = (PREVIOUS / 'files' / rel).read_text(encoding='utf-8')
        new_text = (REPO / rel).read_text(encoding='utf-8')
        assert new_text.splitlines() == old_text.splitlines() + ['', decl], rel
    rel = 'src/tui/utils.rs'
    old_text = (PREVIOUS / 'files' / rel).read_text(encoding='utf-8')
    assert old_text.count('fn js_trim_end(s: &str) -> &str {') == 1
    assert (REPO / rel).read_text(encoding='utf-8') == old_text.replace(
        'fn js_trim_end(s: &str) -> &str {', 'pub(crate) fn js_trim_end(s: &str) -> &str {')
    rel = 'src/tui/component_selection.rs'
    old_text = (PREVIOUS / 'files' / rel).read_text(encoding='utf-8')
    assert old_text.count('is_js_space_unicode') == 2
    assert (REPO / rel).read_text(encoding='utf-8') == old_text.replace(
        'get_osc8_link_at_column, is_js_space_unicode, slice_by_column,',
        'get_osc8_link_at_column, js_trim_end, slice_by_column,').replace(
        'plain.trim_end_matches(is_js_space_unicode).to_owned()', 'js_trim_end(&plain).to_owned()')
    print('SOURCE-CHANGES only3 module declarations + exact2-file trimEnd fix;4 new sources;all9 gate-witness hashes unchanged;no unsafe')
    gates = (LOGS / GATES).read_text(encoding='utf-8')
    assert gates.count('EXIT=0 END') == 5 and 'EXIT=101' not in gates
    for n, ignored in ((2427, 2), (27, 0), (9, 0), (5, 1)):
        assert f'test result: ok. {n} passed; 0 failed; {ignored} ignored;' in gates
    for command in ('cargo fmt --all -- --check', 'cargo clippy --offline --all-targets -- -D warnings',
                    'cargo test --offline --all-targets', 'cargo test --offline --doc'):
        assert f'COMMAND {command} START ' in gates, command
    print('GATES fmt/clippy/all-targets/doc exit0;2463 tests passed/0failed/2ignored;doc5passed/1ignored')
    repro = (LOGS / REPRO).read_text(encoding='utf-8')
    assert repro.count('EXIT=0 END') == 26 and repro.count('BYTE-IDENTICAL ') == 34
    artifacts = re.findall(r'^BYTE-IDENTICAL (\S+) (\d+) ([a-f0-9]{64})$', repro, re.MULTILINE)
    assert len(artifacts) == len({a[0] for a in artifacts}) == 34
    preserved = 0
    for rel, size, digest in artifacts:
        b = safe(REPO, rel).read_bytes()
        assert len(b) == int(size) and sha(b) == digest, rel
        if rel in old:
            assert digest == old[rel]['sha256'], rel
            preserved += 1
    assert preserved == 32
    assert 'ℹ tests 15' in repro and 'ℹ pass 15' in repro and 'ℹ fail 0' in repro
    old_repro = (PREVIOUS / 'files/docs/migration/validation/2026-09-24-210213-component-selection-paint-oracle-repro.log').read_text(encoding='utf-8')
    assert probe(repro) == probe(old_repro) and len(probe(repro)['cases']) == 30
    print('REPRO 34 artifacts byte-identical;old32 unchanged;30 ANSI probes unchanged;15 native layout tests passed')
    fixture_path = 'src/tui/component_clipboard/fixtures.json'
    f = json.loads((REPO / fixture_path).read_bytes())
    assert {k: (len(v), sum(len(c['ops']) for c in v)) for k, v in f.items() if isinstance(v, list)} == {
        'delivery': (35, 151), 'osc52': (97, 291), 'selection': (85, 501), 'flashes': (128, 748), 'sequences': (10, 190)}
    assert len(f['wordSegments']) == 34
    assert sha((REPO / fixture_path).read_bytes()) == 'c7c3effa66f27d5d3c9353b98811ca7f422a28fdd37ec2f33a5e5bbbe08f9918'
    meta = json.loads((REPO / 'docs/migration/reference/component-clipboard/source-manifest.json').read_bytes())
    assert meta['nativeTestsExecuted'] is False
    assert meta['upstreamHead'] == m['upstream_head']
    assert meta['generatorSha256'] == sha((REPO / 'docs/migration/reference/component-clipboard/generate-fixtures.mjs').read_bytes())
    for group, base in (('sources', 'src'), ('referenceTests', 'test')):
        for rel, digest in meta[group].items():
            assert sha((REPO.parent / 'pi/packages/tui' / base / rel).read_bytes()) == digest, rel
    assert (len(meta['sources']), len(meta['referenceTests'])) == (22, 4)
    frozen_dir = LOGS / 'component-clipboard-first-test-evidence'
    frozen_raw = (frozen_dir / fixture_path).read_bytes()
    assert sha(frozen_raw) == 'a8025dae4681d9177c0a4226467c5b3c363edd24ae88f103ff70562ba116d6a4'
    for key, values in json.loads(frozen_raw).items():
        if isinstance(values, list):
            assert f[key][:len(values)] == values, key
        else:
            assert all(f[key].get(k) == v for k, v in values.items())
    for rel in ('src/tui/component_selection.rs', 'src/tui/utils.rs'):
        assert (frozen_dir / rel).read_bytes() == (PREVIOUS / 'files' / rel).read_bytes(), rel
    frozen_meta = json.loads((frozen_dir / 'docs/migration/reference/component-clipboard/source-manifest.json').read_bytes())
    assert frozen_meta['artifacts']['fixtures.json']['sha256'] == sha(frozen_raw)
    assert frozen_meta['generatorSha256'] == sha((frozen_dir / 'docs/migration/reference/component-clipboard/generate-fixtures.mjs').read_bytes())
    for name in ('2026-09-24-213103-component-clipboard-initial-tests.log',
                 '2026-09-24-213721-component-clipboard-trimend-retry.log'):
        text = (LOGS / name).read_text(encoding='utf-8')
        assert '7 passed; 1 failed;' in text and 'active-spaces-true' in text and 'EXIT=101' in text
    for name in ('2026-09-24-213827-component-clipboard-trimend-applied-retry.log',
                 '2026-09-24-214031-component-clipboard-trimend-regression-tests.log'):
        text = (LOGS / name).read_text(encoding='utf-8')
        assert 'test result: ok. 8 passed; 0 failed; 0 ignored;' in text and text.count('EXIT=0 END') == 3
    print('CLIPBOARD 355cases/1881steps;5 differential+3contracts=8functions;34 external Intl inputs;frozen297prefixes unchanged;58 appended regressions;full native suite NOT executed')
    print('FAILURES initial7pass/1fail and unapplied retry retained;exact production trimEnd repair passed;initial observer correction retained separately')
    initial = (LOGS / '2026-09-24-205335-component-selection-paint-initial-tests.log').read_text(encoding='utf-8')
    retry = (LOGS / '2026-09-24-205541-component-selection-paint-accessor-retry.log').read_text(encoding='utf-8')
    assert 'E0599' in initial and 'scroll_top' in initial and 'EXIT=101' in initial
    assert 'test result: ok. 8 passed; 0 failed; 0 ignored;' in retry
    failed = (LOGS / '2026-09-24-205750-component-selection-paint-full-gates.log').read_text(encoding='utf-8')
    isolated = (LOGS / '2026-09-24-210119-component-selection-paint-vertex-diagnostic-repeats.log').read_text(encoding='utf-8')
    assert '2418 passed; 1 failed; 2 ignored;' in failed and 'gemini-2.5-flash-lite Medium' in failed and 'EXIT=101' in failed
    assert isolated.count('test result: ok. 1 passed; 0 failed; 0 ignored;') == 5
    assert isolated.count('EXIT=0 END') == 5
    for rel in ('src/ai/api/google_vertex/mod.rs', 'src/ai/api/google_shared.rs', 'src/ai/api/openai_completions/request.rs'):
        assert not git(REPO, 'diff', '--', rel), rel
    print('FAILURE-RECORDS accessor compile fix retained;unmodified Vertex failure +5isolated passes +exact standard retry retained;cause NOT proven')
    if args.handoff:
        for rel in sorted(DOCS | {'docs/migration/COMPONENT_CLIPBOARD_WIP.md', 'docs/migration/reference/component-clipboard/README.md'}):
            b = (REPO / rel).read_bytes(); text = b.decode('utf-8')
            count = 4 if rel in ('docs/migration/WORK_LOG.md', 'docs/migration/TUI_COMPATIBILITY.md') else 0
            assert not b.startswith(b'\xef\xbb\xbf') and text.count('\ufffd') == count, rel
            assert '355' in text and '1881' in text, rel
            print('UTF8-DOCUMENT', rel, len(b), sha(b), 'historical-replacement-chars', count)
        root = (REPO.parent / 'MIGRATION_HANDOFF.md').read_bytes()
        assert '\ufffd' not in root.decode('utf-8') and '全量迁移未完成' in root.decode('utf-8')
        for rel in ('HANDOFF.md', 'docs/migration/MIGRATION_STATUS.md', 'docs/migration/NEXT_SESSION_PROMPT.md', 'docs/migration/NEXT_SLICE_PLAN.md'):
            text = (REPO / rel).read_text(encoding='utf-8')
            assert 'checkpoint-2026-09-24-component-clipboard' in text and 'clipboard' in text, rel
        assert 'checkpoint-2026-09-24-component-clipboard' in root.decode('utf-8')
        assert not (REPO / 'MIGRATION_HANDOFF.md').exists()
        old_tui = (PREVIOUS / 'files/docs/migration/TUI_COMPATIBILITY.md').read_bytes()
        current_tui = (REPO / 'docs/migration/TUI_COMPATIBILITY.md').read_bytes()
        first = next(x for x in old_tui.splitlines() if x.startswith(b'Current mouse/focus/selection API status:'))
        last = next(x for x in current_tui.splitlines() if x.startswith(b'Current mouse/focus/selection API status:'))
        assert current_tui.startswith(old_tui.replace(first, last))
        rel = 'docs/migration/ORACLE_COVERAGE.md'
        assert (REPO / rel).read_bytes().startswith((PREVIOUS / 'files' / rel).read_bytes())
        assert git(REPO, 'ls-files', '--', 'docs/ROADMAP.md').strip() == b'docs/ROADMAP.md'
        assert not git(REPO, 'diff', '--', 'docs/ROADMAP.md')
        print('HANDOFF root present;all current entry pointers/UTF8/prefixes preserved;AGENTS unchanged;clean tracked ROADMAP not assumed archived')
    print('PASS', datetime.now().astimezone().isoformat())


if __name__ == '__main__':
    main()
