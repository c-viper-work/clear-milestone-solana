# Frontend verification · 2026-10-19

Implemented locally under the user's explicit authorization. No SSH, external Claude CLI,
private key export, on-chain deployment, airdrop or transaction was performed by the agent.
All changes remain uncommitted.

## Reproduce the offline checks

```sh
python3 scripts/check-frontend.py
```

Requires Python 3, Node (tested with v24.20.0), and `rustc`; no package install or network.
The Python script reads the **current** `programs/clear-milestone/src/lib.rs`, extracts all
seven instruction signatures, both account-meta layouts and the SprintEscrow field order,
and constructs independent Borsh/SHA-256 vectors with `struct` and `hashlib`. It derives a
PDA independently using SHA-256, Base58 and Ed25519 curve membership. Its temporary Rust
harness compiles the actual shared rules to provide the role/state/time and payout oracle.
The Node script loads the shipped IIFE and the actual `app/app.js` in an isolated VM.

Result: **750 Node assertions passed**, plus Python source/layout/HTML/checksum checks.

Coverage:

- JavaScript syntax, HTML target IDs, six action bindings, local dependency checksum.
- All seven discriminators, argument order, account-meta order/flags and serialized transactions.
- Maximum u64 sprint ID / principal, signed i64 boundary, invalid integer and SOL inputs.
- Exact UTF-8 hashing, variable URI layouts including empty, multilingual and 128-byte URIs.
- Account owner, discriminator, exact 386-byte allocation, UTF-8 validity, PDA seeds and bump.
- All eight tested status bytes × four roles × six actions × three deadline observations,
  compared with compiled Rust results; rounding and conservation through u64::MAX.
- Phantom/Solflare/Backpack provider selection (including both Backpack injection shapes).
- Mocked RPC with real local signature generation, wrong-network rejection before signing,
  wallet rejection, changed wallet message, chain failure, uncertain confirmation and no resend.
- Locally extracted Base58 signatures (independent Python vectors), lost broadcast responses
  for local and wallet signers, and signature delivery before confirmation with no resend.
- Four-address collision rejection; all four settlement splits; absent and data-bearing
  recipients; below/exact/above rent boundaries; zero payouts; signer self-top-up rejection;
  insufficient signer balance including fees/rent; top-ups ordered before settlement.
- Safe URI schemes and lossless RPC integers.

These checks establish static wire compatibility and offline behavior; they are **not** an
Anchor/SBF build, real wallet extension test, or Solana validator integration test.

## Optional browser smoke test

With an existing Playwright 1.58.2 / playwright-core installation and Chromium available:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core \
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node scripts/check-frontend-browser.cjs
```

The test routes a synthetic HTTPS origin to the local `app/` files and blocks all other
network requests. It verifies the real local CDN fallback, keyboard entry, synthetic wallet
connection rejection, judge signer switching, WebCrypto text/file hashes, reload key loss,
and desktop/mobile overflow. It saves screenshots to `/tmp` (or `SCREENSHOT_DIR`) for manual
visual review. This optional test does not replace the static checks or real Devnet flows.

**Not run successfully in this environment:** local HTTP listening is denied (`Operation not
permitted`), Chrome launch is rejected by the sandbox, and the browser-control interface lists
no available browsers. Desktop/mobile visual review, keyboard interaction and extension
compatibility therefore remain unverified. The smoke script itself passes Node syntax checking.

## Remaining integration acceptance

No actual deployed program ID was provided. Follow the scenarios in `README.md` with a fresh
sprint ID for approve (including pre-submission approval), cancellation, timeout and dispute.
Record actual signatures and decoded state; compare recipient balances with fees accounted
for. Check wrong signer, duplicate settlement, early claim, late dispute and URI boundaries.
A Devnet airdrop may be rate limited; the page reports the RPC error instead of retrying it.

The UI requests no transaction in the background. Pending actions disable editable inputs;
wallet account changes are handled, and the required signer is checked before signing.
A lost broadcast response or failed/uncertain confirmation keeps the local signature visible and instructs the user
to inspect Explorer before retrying. Account refresh failure clears the previously loaded
state and disables actions rather than presenting it as current evidence.
