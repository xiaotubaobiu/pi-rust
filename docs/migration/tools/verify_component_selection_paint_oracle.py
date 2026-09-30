"""Read-only actual TuiAltScreen component-selection-paint oracle audit (no fixture installs)."""
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
    paths = {'fixtures.json': 'src/tui/component_selection_paint/fixtures.json',
             'source-manifest.json': 'docs/migration/reference/component-selection-paint/source-manifest.json'}
    for generated, stored in paths.items():
        actual = (repo / 'target/component-selection-paint-oracle' / generated).read_bytes()
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
    if sha((repo / 'docs/migration/reference/component-selection-paint/generate-fixtures.mjs').read_bytes()) != manifest['generatorSha256']:
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
                        raise SystemExit(f'HISTORICAL COMPONENT-SELECTION-PAINT PREFIX CHANGED: {key}')
                    prefixes += 1
                    print('PREFIX-UNCHANGED', key, len(cases), 'cases')
        else:
            print('NO-PRIOR-COMPONENT-SELECTION-PAINT-CORPUS', previous.name)
    steps = {key: sum(len(case['ops']) for case in cases) for key, cases in fixture.items() if isinstance(cases, list)}
    for key, cases in fixture.items():
        if not isinstance(cases, list):
            continue
        for case in cases:
            if len(case['ops']) != len(case['expected']):
                raise SystemExit(f'STEP COUNT MISMATCH: {key}/{case["name"]}')
    if len(manifest['sources']) != 22 or len(manifest['referenceTests']) != 4:
        raise SystemExit('Wrong oracle source coverage')
    if not manifest['scope'].startswith('Actual complete TuiAltScreen applySelectionHighlight/applySelection methods'):
        raise SystemExit('Incorrect scope metadata')
    segments = fixture['wordSegments']
    assert isinstance(segments, dict) and segments
    for line, parts in segments.items():
        assert ''.join(p['text'] for p in parts) == line, line
        assert all(isinstance(p['isWordLike'], bool) for p in parts), line
    print('EXTERNAL-INTL-SEGMENTATION-SERVICE-INPUTS', len(segments), 'not a Rust ICU proof')
    print('STEPS', steps, 'TOTAL', sum(steps.values()))
    print('TOTAL-CASES', sum(counts.values()))
    print(f'PASS: 2 artifacts byte-identical; {len(manifest["sources"])} actual source hashes; '
          f'{len(manifest["referenceTests"])} consulted test files (NOT executed); '
          f'{prefixes} previous prefixes; counts={counts}')


if __name__ == '__main__':
    main()
