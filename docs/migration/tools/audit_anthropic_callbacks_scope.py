"""Read-only audit against the preserved Anthropic-entry snapshot and gate witness.

Run from the Rust root; stdout may be captured to a NEW log before sealing.
No Git writes, artifact regeneration, deletion, or network calls.
"""
import argparse
import hashlib
import json
import subprocess
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
WORKSPACE = REPO.parent
ENTRY = WORKSPACE / '.migration-handoff/checkpoint-0925-gen-wire'
DOC_CHANGES = {
    'AGENTS.md', 'HANDOFF.md', 'docs/migration/MIGRATION_STATUS.md',
    'docs/migration/NEXT_SESSION_PROMPT.md', 'docs/migration/NEXT_SLICE_PLAN.md',
    'docs/migration/RUNTIME_COMPATIBILITY.md', 'docs/migration/WORK_LOG.md',
}

def sha(data):
    return hashlib.sha256(data).hexdigest()

def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])

def source(path):
    return path.startswith('src/') or path in {'Cargo.toml', 'Cargo.lock', 'build.rs'}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gate-witness', type=Path, required=True)
    args = parser.parse_args()
    raw = (ENTRY / 'manifest.json').read_bytes()
    assert sha(raw) == (ENTRY / 'manifest.sha256').read_text().split()[0]
    manifest = json.loads(raw)
    old = {item['path']: item for item in manifest['files']}
    scope = set(json.loads((REPO / 'docs/migration/anthropic-callbacks-scope.json').read_bytes()))
    changed, preserved, historical = [], [], []
    for rel, item in old.items():
        archived = ENTRY / 'files' / rel
        live = REPO / rel
        if item['sha256'] is None:
            assert not archived.exists() and not live.exists(), rel
            historical.append(rel)
            continue
        assert sha(archived.read_bytes()) == item['sha256'], rel
        digest = sha(live.read_bytes())
        if digest == item['sha256']:
            preserved.append(rel)
        else:
            assert rel in scope or rel in DOC_CHANGES, ('unapproved inherited change', rel)
            changed.append(rel)
    dirty = {p.decode('utf8') for p in git(REPO, 'ls-files', '--modified', '--deleted', '--others', '--exclude-standard', '-z').split(b'\0') if p}
    new_source = sorted(rel for rel in dirty - old.keys() if source(rel))
    assert set(new_source) <= scope, ('unexpected new dirty source', set(new_source) - scope)
    assert git(REPO, 'rev-parse', 'HEAD').decode().strip() == manifest['head']
    assert git(WORKSPACE / 'pi', 'rev-parse', 'HEAD').decode().strip() == manifest['upstream_head']
    assert not git(REPO, 'diff', '--cached', '--name-only', '-z')
    assert not git(WORKSPACE / 'pi', 'diff', '--cached', '--name-only', '-z')
    work_rel = 'docs/migration/WORK_LOG.md'
    prefix = (ENTRY / 'files' / work_rel).read_bytes()
    work = (REPO / work_rel).read_bytes()
    assert work.startswith(prefix)
    assert len(prefix) == 366263
    assert sha(prefix) == 'd41c011df55150410f944058e737df700b2cc515f0b7e9d9e8af22a3204a62fa'
    utils = (REPO / 'src/tui/utils.rs').read_bytes()
    assert sha(utils) == old['src/tui/utils.rs']['sha256']
    assert utils.count(b'\n') == utils.count(b'\r\n') and utils.count(b'\r\n') > 0
    witness = json.loads(args.gate_witness.read_bytes())
    assert witness['stage'] == 'gates' and set(witness['sha256']) == scope
    for rel, digest in witness['sha256'].items():
        assert sha((REPO / rel).read_bytes()) == digest, ('gate source drift', rel)
    print(json.dumps({
        'auditedAt': datetime.now().astimezone().isoformat(), 'result': 'PASS',
        'entry': ENTRY.name, 'entry_manifest_sha256': sha(raw),
        'entry_archive_present_verified': len(preserved) + len(changed),
        'historical_deletions_verified': historical,
        'inherited_files_preserved': len(preserved),
        'non_scope_source_build_preserved': sum(source(rel) and rel not in scope for rel in preserved),
        'approved_inherited_changes': changed, 'new_source_paths': new_source,
        'heads_and_empty_indices_preserved': True,
        'work_log_prefix_bytes': len(prefix), 'work_log_prefix_sha256': sha(prefix),
        'work_log_current_bytes': len(work),
        'utils_crlf_bytes_unchanged': True,
        'gate_source_witness': str(args.gate_witness),
        'gate_scope_sources_verified': len(scope),
        'full_migration_complete': False,
    }, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
