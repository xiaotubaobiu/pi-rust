"""Read-only Viewport layout/ScrollView/Kitty oracle reproducibility and provenance audit.

Run reference/layout/run.mjs first. No fixture installation or source writes.
An optional previous snapshot preserves each existing case section as a prefix.
"""
import argparse
import hashlib
import json
from pathlib import Path


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--previous', type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    paths = {
        'fixtures.json': 'src/tui/layout/fixtures.json',
        'source-manifest.json': 'docs/migration/reference/layout/source-manifest.json',
    }
    for generated, stored in paths.items():
        actual = (repo / 'target/layout-oracle' / generated).read_bytes()
        expected = (repo / stored).read_bytes()
        if actual != expected:
            raise SystemExit(f'REPRO MISMATCH: {generated} != {stored}')
        print('BYTE-IDENTICAL', stored, len(actual), sha(actual))
    manifest = json.loads((repo / paths['source-manifest.json']).read_bytes())
    fixture_bytes = (repo / paths['fixtures.json']).read_bytes()
    fixture = json.loads(fixture_bytes)
    metadata = manifest['artifacts']['fixtures.json']
    if sha(fixture_bytes) != metadata['sha256'] or len(fixture_bytes) != metadata['bytes']:
        raise SystemExit('MANIFEST FIXTURE MISMATCH')
    counts = {key: len(value) for key, value in fixture.items() if isinstance(value, list)}
    if counts != metadata['counts']:
        raise SystemExit(f'MANIFEST COUNTS MISMATCH: {counts}')
    generator = repo / 'docs/migration/reference/layout/generate-fixtures.mjs'
    if sha(generator.read_bytes()) != manifest['generatorSha256']:
        raise SystemExit('GENERATOR HASH MISMATCH')
    for name, digest in manifest['sources'].items():
        source = repo.parent / 'pi/packages/tui/src' / name
        if sha(source.read_bytes()) != digest:
            raise SystemExit(f'UPSTREAM SOURCE HASH MISMATCH: {name}')
    for name, digest in manifest['tests'].items():
        source = repo.parent / 'pi/packages/tui/test' / name
        if sha(source.read_bytes()) != digest:
            raise SystemExit(f'UPSTREAM TEST HASH MISMATCH: {name}')
    steps = sum(len(case['steps']) for case in fixture['cases'])
    print('LAYOUT-STEPS', steps, 'NATIVE-UPSTREAM-TEST-FILES', len(manifest['tests']))
    prefixes = 0
    if args.previous:
        previous = args.previous.resolve(strict=True)
        prior = previous / 'files' / paths['fixtures.json']
        if prior.is_file():
            old = json.loads(prior.read_bytes())
            for key, cases in old.items():
                if isinstance(cases, list):
                    if fixture.get(key, [])[:len(cases)] != cases:
                        raise SystemExit(f'HISTORICAL LAYOUT PREFIX CHANGED: {key}')
                    prefixes += 1
                    print('PREFIX-UNCHANGED', key, len(cases), 'cases')
        else:
            print('NO-PRIOR-LAYOUT-CORPUS', previous.name)
    print(f'PASS: 2 artifacts byte-identical; {len(manifest["sources"])} actual source hashes; '
          f'{prefixes} previous case prefixes; counts={counts}')


if __name__ == '__main__':
    main()
