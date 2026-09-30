"""Byte-compare the generated Markdown/LaTeX artifacts; never install fixtures.

Run both reference/{markdown,latex}/run.mjs scripts first. From any directory:
  python docs/migration/tools/verify_tui_oracles.py
  python docs/migration/tools/verify_tui_oracles.py --previous CHECKPOINT

The optional checkpoint verifies the three pre-source Markdown artifacts and
all five LaTeX artifacts remain unchanged; the source corpus/manifest are the
intentional additions/expansions of the source-lexer slices. The internal
inline-tail token corpus is also compared. Any source or inline-tail corpus
in the prior checkpoint must remain an identical complete case prefix.
"""
import argparse
import hashlib
import json
from pathlib import Path


ARTIFACTS = {
    'markdown': {
        'fixtures.json': 'src/tui/markdown_fixtures.json',
        'utf16-fixtures.json': 'src/tui/markdown_utf16_fixtures.json',
        'utf16-wrap-fixtures.json': 'src/tui/utils/utf16/wrap-fixtures.json',
        'source-utf16-fixtures.json': 'src/tui/markdown_source_utf16_fixtures.json',
        'inline-tail-fixtures.json': 'src/tui/markdown_inline_tail_fixtures.json',
        'source-fixtures.json': 'src/tui/markdown_source_fixtures.json',
        'source-manifest.json': 'docs/migration/reference/markdown/source-manifest.json',
    },
    'latex': {
        'tables.rs': 'src/tui/latex/tables.rs',
        'fixtures.json': 'src/tui/latex/fixtures.json',
        'utf16-domain.json': 'docs/migration/reference/latex/utf16-domain.json',
        'utf16-fixtures.json': 'src/tui/latex/utf16-fixtures.json',
        'source-manifest.json': 'docs/migration/reference/latex/source-manifest.json',
    },
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--previous', type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    previous = args.previous.resolve(strict=True) if args.previous else None
    compared = historical = prefixes = 0
    for kind, files in ARTIFACTS.items():
        for generated, stored in files.items():
            a = (repo / 'target' / (kind + '-oracle') / generated).read_bytes()
            b = (repo / stored).read_bytes()
            if a != b:
                raise SystemExit(f'REPRO MISMATCH: {kind}/{generated} != {stored}')
            if previous and (kind == 'latex' or generated not in (
                    'source-fixtures.json', 'source-utf16-fixtures.json', 'inline-tail-fixtures.json', 'source-manifest.json')):
                if b != (previous / 'files' / stored).read_bytes():
                    raise SystemExit(f'HISTORICAL ARTIFACT CHANGED: {stored}')
                historical += 1
            if previous and kind == 'markdown' and generated in (
                    'source-fixtures.json', 'source-utf16-fixtures.json', 'inline-tail-fixtures.json'):
                prior = previous / 'files' / stored
                if prior.is_file():
                    old_cases = json.loads(prior.read_bytes())['cases']
                    new_cases = json.loads(b)['cases']
                    if new_cases[:len(old_cases)] != old_cases:
                        raise SystemExit(f'HISTORICAL SOURCE PREFIX CHANGED: {stored}')
                    prefixes += 1
                    print('PREFIX-UNCHANGED', stored, len(old_cases), 'cases')
            compared += 1
            print('BYTE-IDENTICAL', stored, len(a), hashlib.sha256(a).hexdigest())
    print(f'PASS: {compared} generated/stored artifacts byte-identical; '
          f'{historical} historical artifacts and {prefixes} case prefixes checked')


if __name__ == '__main__':
    main()
