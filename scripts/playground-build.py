#!/usr/bin/env python3
"""Submit only /src/lib.rs to Solana Playground; never deploy or send keys."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.error import URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--payload-only', action='store_true', help='write request without network access')
    args = parser.parse_args()
    source = (ROOT / 'programs/clear-milestone/src/lib.rs').read_text()
    payload = {'files': [['/src/lib.rs', source]]}
    output = ROOT / 'target/playground'
    output.mkdir(parents=True, exist_ok=True)
    (output / 'request.json').write_text(json.dumps(payload))
    (output / 'source.sha256').write_text(hashlib.sha256(source.encode()).hexdigest() + '\n')
    if args.payload_only:
        print(f'Prepared {output / "request.json"}; no build requested.')
        return 0
    request = Request('https://api.solpg.io/build', data=json.dumps(payload).encode(),
                      headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urlopen(request, timeout=55) as response:
            raw = response.read().decode()
        (output / 'response.json').write_text(raw)
        result = json.loads(raw)
    except (URLError, TimeoutError, ValueError) as error:
        print(f'Playground build unverified: {error}', file=sys.stderr)
        return 1
    diagnostics = result.get('stderr', '')
    print(diagnostics)
    # Fail closed: a 200 response or a UUID can also accompany a failed compilation.
    # Cached switchboard diagnostics precede the user crate compilation.
    if 'Compiling solpg' not in diagnostics:
        print('Missing user crate compilation marker; inspect response.json.', file=sys.stderr)
        return 1
    user_diagnostics = diagnostics.split('Compiling solpg', 1)[1]
    if re.search(r'\berror(?:\[|:)', user_diagnostics, re.IGNORECASE):
        print('Build failed; see target/playground/response.json.', file=sys.stderr)
        return 1
    if 'Finished' not in user_diagnostics or not result.get('idl'):
        print('No conclusive successful build evidence; inspect response.json.', file=sys.stderr)
        return 1
    print('Playground build completed; response and source digest saved. No deployment performed.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
