# Solana browser dependency

- Package: `@solana/web3.js@1.98.4`
- Original file: `package/lib/index.iife.min.js` from the npm tarball
- CDN: https://cdn.jsdelivr.net/npm/@solana/web3.js@1.98.4/lib/index.iife.min.js
- Tarball: https://registry.npmjs.org/@solana/web3.js/-/web3.js-1.98.4.tgz
- npm tarball integrity: `sha512-vv9lfnvjUsRiq//+j5pBdXig0IQdtzA0BRZ3bXEP4KaIyF1CcaydWqgyzQgfZMNIsWNWmG+AUHwPy4AHOD6gpw==`
- Local JavaScript SHA-256: `09cdbea951b2ed0e11bcbe3aeb1ee9f035f9fb51ed212aca645475ae82688cc3`
- License: `LICENSE-web3.txt` (MIT, unchanged from the package)

Extracted from the existing npm content-addressed cache after verifying its SHA-512.
The local file is the actual upstream IIFE, not a stub. `app.js` first tries the pinned
CDN and loads this local copy on error or an eight-second timeout. Viewing requires no build.
