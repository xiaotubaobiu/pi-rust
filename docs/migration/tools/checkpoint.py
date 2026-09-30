"""Create a non-overwriting, hash-verified dirty-worktree handoff snapshot.

Usage from the Rust root (Python 3.9+):
  python docs/migration/tools/checkpoint.py --previous ../.migration-handoff/OLD \
    --destination ../.migration-handoff/NEW \
    --allow-existing-source src/tui/latex.rs --allow-existing-source ...

Reads Git and the sibling pi HEAD; never writes either Git index or upstream.
No deletes, staging, resetting, moving, or network calls. A partial destination
on failure is intentionally retained for forensic inspection, never overwritten.
"""
import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


def sha(data):
    return hashlib.sha256(data).hexdigest()


def stamp():
    return datetime.now().astimezone().isoformat(timespec='seconds')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--previous', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--allow-existing-source', action='append', default=[])
    parser.add_argument('--full-migration-complete', action='store_true',
                        help='record full_migration_complete=true in the manifest')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    workspace = repo.parent
    backups = (workspace / '.migration-handoff').resolve(strict=True)
    previous = args.previous.resolve(strict=True)
    destination = args.destination.resolve()
    for path in (previous, destination):
        if path.parent != backups:
            raise ValueError(f'checkpoint must be a direct child of {backups}: {path}')
    if destination.exists():
        raise FileExistsError(f'will not overwrite immutable checkpoint: {destination}')

    def git(*command):
        return subprocess.check_output(['git', '-C', str(repo), *command])

    def safe_path(base, rel):
        rel_path = Path(rel)
        if rel_path.is_absolute() or '..' in rel_path.parts:
            raise ValueError(f'unsafe relative path: {rel}')
        result = base / rel_path
        if not result.resolve().is_relative_to(base.resolve()):
            raise ValueError(f'path escapes base: {result}')
        if result.is_symlink():
            raise ValueError(f'symlink requires explicit handling: {result}')
        return result

    entry_bytes = (previous / 'manifest.json').read_bytes()
    entry_hash = sha(entry_bytes)
    if (previous / 'manifest.sha256').read_text(encoding='utf8').split()[0] != entry_hash:
        raise ValueError('previous manifest checksum mismatch')
    entry = json.loads(entry_bytes)
    old = {f['path']: f for f in entry['files']}
    if len(old) != len(entry['files']):
        raise ValueError('duplicate entry paths')
    verified = 0
    for item in entry['files']:
        file = safe_path(previous / 'files', item['path'])
        if item.get('sha256') is None:
            if file.exists():
                raise ValueError(f'deleted entry unexpectedly present: {file}')
        else:
            if sha(file.read_bytes()) != item['sha256']:
                raise ValueError(f'previous archived file changed: {file}')
            verified += 1
    for item in entry.get('evidence', []) + entry.get('supplemental', []):
        if sha(safe_path(previous, item['path']).read_bytes()) != item['sha256']:
            raise ValueError(f'previous supplemental/evidence changed: {item["path"]}')

    head = git('rev-parse', 'HEAD').decode().strip()
    if head != entry['head']:
        raise ValueError('Rust HEAD changed; audit before snapshot')
    if git('diff', '--cached', '--name-only', '-z'):
        raise ValueError('Git index is not empty; do not claim index preservation')
    upstream = subprocess.check_output(
        ['git', '-C', str(workspace / 'pi'), 'rev-parse', 'HEAD']).decode().strip()
    if upstream != entry['upstream_head']:
        raise ValueError('upstream HEAD changed; audit before snapshot')

    dirty = {p.decode('utf8') for p in git(
        'ls-files', '--modified', '--deleted', '--others', '--exclude-standard', '-z'
    ).split(b'\0') if p}
    allowed = set(args.allow_existing_source)
    unknown_allowed = allowed - old.keys()
    if unknown_allowed:
        raise ValueError(f'allow list must name inherited files: {unknown_allowed}')
    current = {}
    unrelated = 0
    for rel in sorted(dirty | old.keys()):
        file = safe_path(repo, rel)
        before = old.get(rel)
        data = file.read_bytes() if file.is_file() else None
        if file.exists() and data is None:
            raise ValueError(f'not a regular file: {rel}')
        digest = sha(data) if data is not None else None
        if before and before.get('sha256') is not None:
            is_source = rel.startswith('src/') or rel in ('Cargo.toml', 'Cargo.lock', 'build.rs')
            if is_source and rel not in allowed:
                if digest != before['sha256']:
                    raise ValueError(f'unrelated inherited source/build file changed: {rel}')
                unrelated += 1
        current[rel] = (data, digest, before)
    missing_allowed = {r for r in allowed if current[r][1] == old[r].get('sha256')}
    if missing_allowed:
        print(f'NOTE allowed inherited source unchanged: {sorted(missing_allowed)}')

    destination.mkdir()
    files = []
    for rel, (data, digest, before) in current.items():
        before_hash = before.get('sha256') if before else None
        if data is None:
            classification = 'still_deleted' if before and before_hash is None else 'deleted_since_entry'
        elif before is None:
            classification = 'new_since_entry'
        elif before_hash == digest:
            classification = 'preserved_from_entry'
        else:
            classification = 'modified_since_entry'
        item = {'path': rel, 'sha256': digest, 'classification': classification}
        if before:
            item['entry_sha256'] = before_hash
        if data is not None:
            file = safe_path(destination / 'files', rel)
            file.parent.mkdir(parents=True, exist_ok=True)
            with file.open('xb') as output:
                output.write(data)
            item['bytes'] = len(data)
            if sha(file.read_bytes()) != digest:
                raise ValueError(f'copy verification failed: {file}')
        else:
            item['historical_entry_sha256'] = before_hash or (
                before.get('historical_entry_sha256') if before else None)
        files.append(item)

    supplemental = destination / 'supplemental' / 'MIGRATION_HANDOFF.md'
    supplemental.parent.mkdir()
    shutil.copyfile(workspace / 'MIGRATION_HANDOFF.md', supplemental)
    supplemental_data = supplemental.read_bytes()
    evidence = []
    for name, data in [('status.txt', git('status', '--short', '--untracked-files=all')),
                       ('tracked.patch', git('diff', '--binary', '--no-ext-diff'))]:
        with (destination / name).open('xb') as output:
            output.write(data)
        evidence.append({'path': name, 'sha256': sha(data)})
    manifest = {
        'createdAt': stamp(), 'goal_status': 'active', 'full_migration_complete': bool(args.full_migration_complete),
        'head': head, 'upstream_head': upstream,
        'entry_checkpoint': previous.name, 'entry_manifest_sha256': entry_hash,
        'entry_files_verified': verified,
        'allowed_existing_source_changes': sorted(allowed),
        'unrelated_source_and_build_files_preserved': unrelated,
        'present_files': sum(f['sha256'] is not None for f in files),
        'classifications': dict(Counter(f['classification'] for f in files)),
        'files': files,
        'supplemental': [{'path': 'supplemental/MIGRATION_HANDOFF.md',
                          'bytes': len(supplemental_data), 'sha256': sha(supplemental_data)}],
        'evidence': evidence,
    }
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf8')
    with (destination / 'manifest.json').open('xb') as output:
        output.write(manifest_bytes)
    manifest_hash = sha(manifest_bytes)
    (destination / 'manifest.sha256').write_text(manifest_hash + '  manifest.json\n', encoding='utf8')
    for rel, (data, digest, _) in current.items():
        file = safe_path(repo, rel)
        actual = sha(file.read_bytes()) if file.is_file() else None
        if actual != digest:
            raise ValueError(f'live file changed during snapshot: {rel}')
    if sha((workspace / 'MIGRATION_HANDOFF.md').read_bytes()) != sha(supplemental_data):
        raise ValueError('root handoff changed during snapshot')
    if git('diff', '--cached', '--name-only', '-z'):
        raise ValueError('Git index changed during snapshot')
    verification = {
        'verifiedAt': stamp(), 'all_snapshot_file_hashes_match_live_worktree': True,
        'all_entry_file_hashes_verified': True, 'git_index_empty': True,
        'unrelated_source_and_build_files_preserved': unrelated,
        'manifest_sha256': manifest_hash, 'goal_status': 'active', 'full_migration_complete': bool(args.full_migration_complete),
    }
    (destination / 'verification.json').write_text(
        json.dumps(verification, indent=2) + '\n', encoding='utf8')
    print(json.dumps({k: v for k, v in manifest.items() if k not in ('files', 'supplemental', 'evidence')},
                     ensure_ascii=False, indent=2))
    print(json.dumps(verification, indent=2))


if __name__ == '__main__':
    main()
