"""Final read-only document/source audit of the component-selection handoff.

Run before checkpoint creation. Does not write files, install expectations or
modify Git. The first successful source/gate audit remains an immutable witness.
"""
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PREVIOUS = REPO.parent / '.migration-handoff/checkpoint-2026-09-24-component-focus'
ALLOWED_SOURCE = {'src/tui/mod.rs', 'src/tui/tests.rs', 'src/tui/component_gesture.rs',
                  'src/tui/tests/component_gesture.rs', 'src/tui/tests/component_overlay.rs',
                  'src/tui/tests/component_focus.rs'}
ALLOWED_DOCS = {'HANDOFF.md', 'docs/migration/MIGRATION_STATUS.md', 'docs/migration/WORK_LOG.md',
                'docs/migration/NEXT_SESSION_PROMPT.md', 'docs/migration/NEXT_SLICE_PLAN.md',
                'docs/migration/TUI_COMPATIBILITY.md', 'docs/migration/ORACLE_COVERAGE.md'}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def source_hashes(text):
    return {rel: (int(size), digest) for rel, size, digest in re.findall(
        r'^SOURCE-SCOPE (\S+) (\d+) ([a-f0-9]{64})$', text, re.MULTILINE)}


def main():
    print('START', datetime.now().astimezone().isoformat())
    result = subprocess.run([sys.executable, 'docs/migration/tools/audit_component_selection.py'],
                            cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            encoding='utf-8', errors='strict')
    print(result.stdout, end='')
    assert result.returncode == 0, result.returncode
    witness = (REPO / 'docs/migration/validation/2026-09-24-203142-component-selection-protection-audit.log').read_text(encoding='utf-8')
    expected = source_hashes(witness)
    assert len(expected) == 9
    assert source_hashes(result.stdout) == expected
    print('SOURCE-GATE-WITNESS all9 source-scope raw bytes unchanged since first passing protection audit')
    manifest = json.loads((PREVIOUS / 'manifest.json').read_bytes())
    unchanged = 0
    for entry in manifest['files']:
        rel = entry['path']
        if rel in ALLOWED_SOURCE | ALLOWED_DOCS:
            continue
        path = REPO / rel
        if entry.get('sha256') is None:
            assert not path.exists(), rel
        else:
            assert sha(path.read_bytes()) == entry['sha256'], rel
            unchanged += 1
    assert unchanged == 501, unchanged
    print('ALL-NONALLOW-INHERITED-FILES', unchanged, 'source/docs/build/validation bytes unchanged;deletions retained')
    docs = sorted(ALLOWED_DOCS | {'docs/migration/COMPONENT_SELECTION_WIP.md',
                                'docs/migration/reference/component-selection/README.md'})
    for rel in docs:
        raw = (REPO / rel).read_bytes()
        text = raw.decode('utf-8')
        expected_replacements = 4 if rel in ('docs/migration/WORK_LOG.md', 'docs/migration/TUI_COMPATIBILITY.md') else 0
        assert text.count('\ufffd') == expected_replacements, rel
        assert '194' in text and '1707' in text, rel
        assert not raw.startswith(b'\xef\xbb\xbf'), rel
        print('UTF8-DOCUMENT', rel, len(raw), sha(raw), 'historical-replacement-chars', expected_replacements)
    root = REPO.parent / 'MIGRATION_HANDOFF.md'
    text = root.read_bytes().decode('utf-8')
    assert '\ufffd' not in text
    assert '194' in text and '1707' in text and '全量迁移未完成' in text
    assert 'checkpoint-2026-09-24-component-selection' in text
    assert not (REPO / 'MIGRATION_HANDOFF.md').exists()
    print('ROOT-HANDOFF', root, len(root.read_bytes()), sha(root.read_bytes()))
    for rel in ('HANDOFF.md', 'docs/migration/MIGRATION_STATUS.md', 'docs/migration/NEXT_SESSION_PROMPT.md',
                'docs/migration/NEXT_SLICE_PLAN.md'):
        text = (REPO / rel).read_text(encoding='utf-8')
        assert 'checkpoint-2026-09-24-component-selection' in text, rel
        assert 'selection paint' in text, rel
    old_tui = (PREVIOUS / 'files/docs/migration/TUI_COMPATIBILITY.md').read_bytes()
    current_tui = (REPO / 'docs/migration/TUI_COMPATIBILITY.md').read_bytes()
    old_status = next(line for line in old_tui.splitlines() if line.startswith(b'Current mouse/focus API status:'))
    new_status = next(line for line in current_tui.splitlines() if line.startswith(b'Current mouse/focus/selection API status:'))
    assert current_tui.startswith(old_tui.replace(old_status, new_status))
    rel = 'docs/migration/ORACLE_COVERAGE.md'
    assert (REPO / rel).read_bytes().startswith((PREVIOUS / 'files' / rel).read_bytes())
    assert (REPO / 'AGENTS.md').read_bytes() == (PREVIOUS / 'files/AGENTS.md').read_bytes()
    assert subprocess.check_output(['git', 'ls-files', '--', 'docs/ROADMAP.md'], cwd=REPO).strip() == b'docs/ROADMAP.md'
    subprocess.run(['git', 'diff', '--exit-code', '--', 'docs/ROADMAP.md'], cwd=REPO, check=True)
    print('HISTORY ledger prefixes preserved;AGENTS unchanged;clean tracked ROADMAP verified against HEAD,not assumed archived')
    print('PASS', datetime.now().astimezone().isoformat())


if __name__ == '__main__':
    main()
