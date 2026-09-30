"""Read-only actual TuiAltScreen wheel/scrollbar oracle audit (no fixture installs)."""
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
    paths = {'fixtures.json': 'src/tui/viewport_mouse/fixtures.json',
             'source-manifest.json': 'docs/migration/reference/viewport-mouse/source-manifest.json'}
    for generated, stored in paths.items():
        actual = (repo / 'target/viewport-mouse-oracle' / generated).read_bytes()
        expected = (repo / stored).read_bytes()
        if actual != expected:
            raise SystemExit(f'REPRO MISMATCH: {generated} != {stored}')
        print('BYTE-IDENTICAL', stored, len(actual), sha(actual))
    manifest = json.loads((repo / paths['source-manifest.json']).read_bytes())
    data = (repo / paths['fixtures.json']).read_bytes()
    fixture = json.loads(data)
    metadata = manifest['artifacts']['fixtures.json']
    if len(data) != metadata['bytes'] or sha(data) != metadata['sha256']:
        raise SystemExit('MANIFEST FIXTURE MISMATCH')
    counts = {key: len(value) for key, value in fixture.items() if isinstance(value, list)}
    if counts != metadata['counts']:
        raise SystemExit(f'MANIFEST COUNTS MISMATCH: {counts}')
    if sha((repo / 'docs/migration/reference/viewport-mouse/generate-fixtures.mjs').read_bytes()) != manifest['generatorSha256']:
        raise SystemExit('GENERATOR HASH MISMATCH')
    for name, digest in manifest['sources'].items():
        if sha((repo.parent / 'pi/packages/tui/src' / name).read_bytes()) != digest:
            raise SystemExit(f'UPSTREAM SOURCE MISMATCH: {name}')
    for name, digest in manifest['referenceTests'].items():
        if sha((repo.parent / 'pi/packages/tui/test' / name).read_bytes()) != digest:
            raise SystemExit(f'UPSTREAM REFERENCE TEST MISMATCH: {name}')
    if manifest['nativeTestsExecuted'] is not False:
        raise SystemExit('Native full alt-screen tests are not part of this oracle')
    prefixes = 0
    if args.previous:
        previous = args.previous.resolve(strict=True)
        prior = previous / 'files' / paths['fixtures.json']
        if prior.is_file():
            old = json.loads(prior.read_bytes())
            for key, cases in old.items():
                if isinstance(cases, list):
                    if fixture.get(key, [])[:len(cases)] != cases:
                        raise SystemExit(f'HISTORICAL VIEWPORT-MOUSE PREFIX CHANGED: {key}')
                    prefixes += 1
                    print('PREFIX-UNCHANGED', key, len(cases), 'cases')
        else:
            print('NO-PRIOR-VIEWPORT-MOUSE-CORPUS', previous.name)
    print('ACTION-STEPS', sum(len(case['steps']) for case in fixture['cases']))
    print(f'PASS: 2 artifacts byte-identical; {len(manifest["sources"])} actual source hashes; '
          f'{len(manifest["referenceTests"])} consulted test files (NOT executed); '
          f'{prefixes} previous prefixes; counts={counts}')


if __name__ == '__main__':
    main()
