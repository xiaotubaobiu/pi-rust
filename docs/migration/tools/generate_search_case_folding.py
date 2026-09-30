"""Offline Unicode17 C/S simple folding table generator (not search oracle outputs)."""
import hashlib
import sys
from pathlib import Path
REPO = Path(__file__).resolve().parents[3]
SOURCE = REPO / 'docs/migration/reference/alt-screen-search-index/unicode/CaseFolding-17.0.0.txt'
EXPECTED = 'ff8d8fefbf123574205085d6714c36149eb946d717a0c585c27f0f4ef58c4183'
def generate():
    raw = SOURCE.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == EXPECTED
    pairs = []
    for line in raw.decode('utf8').splitlines():
        text = line.split('#', 1)[0].strip()
        if not text:
            continue
        code, status, mapping, *_ = [p.strip() for p in text.split(';')]
        if status in ('C', 'S'):
            points = mapping.split()
            assert len(points) == 1
            pairs.append((int(code, 16), int(points[0], 16)))
    assert pairs == sorted(set(pairs))
    mappings = dict(pairs)
    assert all(target not in mappings for _, target in pairs), 'Must already be canonical/idempotent'
    header = '// Generated from Unicode 17.0.0 CaseFolding.txt, statuses C/S only.\n// Source SHA256: ' + EXPECTED + '\n// Unicode-3.0 license: docs/migration/reference/alt-screen-search-index/unicode/LICENSE.txt\n// Regenerate: python docs/migration/tools/generate_search_case_folding.py\n// This general Unicode data is not derived from search fixtures.\n\n'
    text = header + 'pub(super) const SIMPLE_FOLD: &[(u32, u32)] = &[\n'
    text += ''.join(f'    (0x{a:X}, 0x{b:X}),\n' for a, b in pairs) + '];\n'
    return text.encode(), len(pairs)
def main():
    data, count = generate()
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / 'target/alt-screen-search-oracle/simple_case_fold.rs'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    print('UNICODE17 C/S PAIRS', count, 'BYTES', len(data), 'SHA256', hashlib.sha256(data).hexdigest(), 'OUTPUT', out)
if __name__ == '__main__':
    main()
