"""Independently verify an immutable handoff archive, optionally against live files.

No imports from the snapshot writer, Git mutations, resets, or fixture installs.
The only optional write is a NEW receipt directly under workspace/.migration-handoff.
Never tee output into the repository when verifying live sealed state.
"""
import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
from pathlib import Path
import subprocess

REPO = Path(__file__).resolve().parents[3]
BACKUPS = (REPO.parent / '.migration-handoff').resolve()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def safe(base, rel):
    p = base / rel
    assert not Path(rel).is_absolute() and '..' not in Path(rel).parts, rel
    assert p.resolve().is_relative_to(base.resolve()) and not p.is_symlink(), rel
    return p


def archive(path):
    raw = (path / 'manifest.json').read_bytes()
    digest = sha(raw)
    assert digest == (path / 'manifest.sha256').read_text(encoding='utf-8').split()[0]
    m = json.loads(raw)
    assert len({e['path'] for e in m['files']}) == len(m['files'])
    for e in m['files']:
        p = safe(path / 'files', e['path'])
        if e['sha256'] is None:
            assert not p.exists(), e['path']
        else:
            b = p.read_bytes()
            assert sha(b) == e['sha256'] and len(b) == e['bytes'], e['path']
    for e in m.get('evidence', []) + m.get('supplemental', []):
        assert sha(safe(path, e['path']).read_bytes()) == e['sha256'], e['path']
    assert sum(e['sha256'] is not None for e in m['files']) == m['present_files']
    assert dict(Counter(e['classification'] for e in m['files'])) == m['classifications']
    verification = json.loads((path / 'verification.json').read_bytes())
    assert verification['manifest_sha256'] == digest
    assert verification['all_snapshot_file_hashes_match_live_worktree'] is True
    return m, digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('checkpoint', type=Path)
    parser.add_argument('--archive-only', action='store_true')
    parser.add_argument('--receipt', type=Path)
    args = parser.parse_args()
    cp = args.checkpoint.resolve(strict=True)
    assert cp.parent == BACKUPS, cp
    receipt = args.receipt.resolve() if args.receipt else None
    if receipt:
        assert receipt.parent == BACKUPS and not receipt.exists(), receipt
    m, digest = archive(cp)
    prior_path = BACKUPS / m['entry_checkpoint']
    assert prior_path.resolve().parent == BACKUPS
    prior, prior_hash = archive(prior_path)
    assert prior_hash == m['entry_manifest_sha256']
    old = {e['path']: e for e in prior['files']}
    for e in m['files']:
        prev = old.get(e['path'])
        classification = ('still_deleted' if prev and prev['sha256'] is None else 'deleted_since_entry') if e['sha256'] is None else ('new_since_entry' if not prev else 'preserved_from_entry' if prev['sha256'] == e['sha256'] else 'modified_since_entry')
        assert e['classification'] == classification, e['path']
        if prev:
            assert e['entry_sha256'] == prev['sha256'], e['path']
    assert old.keys() <= {e['path'] for e in m['files']}
    warnings = []

    def git(repo, *a):
        result = subprocess.run(['git', '-C', str(repo), *a], capture_output=True, check=True)
        if result.stderr:
            warnings.append({'repo': repo.name, 'command': list(a), 'stderr': result.stderr.decode('utf-8')})
        return result.stdout

    if not args.archive_only:
        for e in m['files']:
            p = safe(REPO, e['path'])
            if e['sha256'] is None:
                assert not p.exists(), e['path']
            else:
                assert sha(p.read_bytes()) == e['sha256'], e['path']
        assert (REPO.parent / 'MIGRATION_HANDOFF.md').read_bytes() == (cp / 'supplemental/MIGRATION_HANDOFF.md').read_bytes()
        assert git(REPO, 'status', '--short', '--untracked-files=all') == (cp / 'status.txt').read_bytes()
        assert git(REPO, 'diff', '--binary', '--no-ext-diff') == (cp / 'tracked.patch').read_bytes()
        for repo, key in ((REPO, 'head'), (REPO.parent / 'pi', 'upstream_head')):
            assert git(repo, 'rev-parse', 'HEAD').decode().strip() == m[key]
            assert not git(repo, 'diff', '--cached', '--name-only', '-z')
    work = (cp / 'files/docs/migration/WORK_LOG.md').read_bytes()
    result = {'verifiedAt': datetime.now().astimezone().isoformat(), 'checkpoint': cp.name,
              'manifest_sha256': digest, 'archive_files_verified': m['present_files'],
              'historical_deletions_verified': sum(e['sha256'] is None for e in m['files']),
              'evidence_supplemental_and_previous_archive_verified': True,
              'live_files_status_diff_root_HEADs_and_indices_verified': not args.archive_only,
              'classifications': m['classifications'],
              'goal_status': m['goal_status'], 'full_migration_complete': m['full_migration_complete'],
              'work_log_bytes': len(work), 'work_log_sha256': sha(work), 'git_read_warnings': warnings}
    if receipt:
        with receipt.open('x', encoding='utf-8', newline='\n') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
            f.write('\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if receipt:
        print('RECEIPT', receipt)


if __name__ == '__main__':
    main()
