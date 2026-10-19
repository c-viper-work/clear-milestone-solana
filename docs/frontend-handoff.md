# Frontend implementation contract

Status: implemented locally in `app/` on 2026-10-19 under explicit user authorization
to use Codex without SSH or an external Claude CLI. Offline verification is available via
`python3 scripts/check-frontend.py`. Browser/extension and real Devnet flows remain unverified
in this restricted environment; no deployed program ID has been supplied.
Only `app/` and frontend-specific tests/configuration are in the frontend implementer's scope.
No secrets, deployment wallet, runtime data, paid service, or on-chain deployment is provided.

## Experience

Build a responsive, polished English/Polish-accented judge console in `app/index.html`,
`app/styles.css`, `app/app.js`. Suggested visual direction: warm off-white workspace,
forest-green primary actions, restrained violet Solana accents, large clear typography,
contract summary and activity log beside a six-action panel. Use accessible labels,
keyboard focus, mobile layout, pending/error feedback, and no fabricated live data.

Use pinned `@solana/web3.js` v1 browser IIFE from a CDN and a real checked-in local fallback
with its license. The original brief omits the library name; web3.js is the proposed choice.
Avoid a build requirement for viewing the page. Serve on localhost (WebCrypto secure context).

Connect Phantom, Solflare, Backpack or create three in-memory ephemeral judge keypairs
(client / contractor / arbiter). Role switching must select a real signer, never a simulated
role label. Warn that reload discards keys and access to remaining Devnet funds. Request
airdrops only on explicit clicks; surface rate limits. Never persist private keys.

Program ID must be entered after actual deployment: the source's declare_id is a placeholder,
not a claim of deployed code. Lock transactions to Devnet; when allowing custom RPC URLs,
verify the Devnet genesis hash before signing. Check the selected program is executable.

## Wire contract

Anchor instruction data: first 8 bytes of SHA-256(`global:<snake_case_instruction_name>`),
then Borsh arguments in order. Integers are little endian. Use BigInt for u64/i64; never
convert lamports or sprint IDs through JavaScript Number. Strings are u32 byte length + UTF-8.

PDA: `[UTF8("sprint"), client.toBytes(), contractor.toBytes(), sprintId_u64_le]` + program ID.

`initialize_sprint` account metas in order:
1. sprintEscrow writable, not signer
2. client writable, signer
3. contractor readonly, not signer
4. arbiter readonly, not signer
5. SystemProgram.programId readonly, not signer

Arguments: sprint_id u64, amount_lamports u64, kill_fee_bps u16, arbiter_fee_bps u16,
review_window_secs i64, spec_hash [u8;32].

All six other instructions use identical account metas:
1. sprintEscrow writable, not signer
2. actor readonly, signer (transaction fee payer will also become writable)
3. stored client writable, not signer
4. stored contractor writable, not signer
5. stored arbiter writable, not signer

| Instruction | Arguments | Authorized signer |
| --- | --- | --- |
| submit_deliverable | [u8;32] hash, String URI | contractor |
| approve_deliverable | none | client |
| claim_after_timeout | none | contractor |
| cancel_before_submission | none | client |
| raise_dispute | [u8;32] hash | client or contractor |
| resolve_dispute | u16 contractor_share_bps | arbiter |

Read and validate the account owner, PDA seeds, discriminator and data length before decoding.
SHA-256(`account:SprintEscrow`)[0..8] is the discriminator. Maximum allocation is **386 bytes**.

| Offset | Value |
| --- | --- |
| 0 | 8-byte discriminator |
| 8, 40, 72 | client, contractor, arbiter (32 bytes each) |
| 104, 112 | sprint_id, amount_lamports (u64) |
| 120, 122 | kill_fee_bps, arbiter_fee_bps (u16) |
| 124, 132, 140, 148 | review_window_secs, created_at, submitted_at, auto_release_at (i64) |
| 156, 188 | spec_hash, deliverable_hash (32 bytes each) |
| 220 | URI byte length L (u32, <=128) |
| 224 | L UTF-8 URI bytes |
| 224+L | dispute_hash (32 bytes) |
| 256+L, 257+L | status, bump (u8) |

The string is variable length; dispute/status/bump are NOT at fixed max-size offsets.
Use WebCrypto SHA-256 over exact spec UTF-8 bytes / selected deliverable file bytes /
dispute text bytes. No file upload is required or implied; URI hosting is separate.
Render untrusted text using textContent. URI links must allow only safe schemes.

Fetch state after confirmation and on explicit refresh; show slot/observation time.
Link signatures to `https://explorer.solana.com/tx/<signature>?cluster=devnet` and PDA to
`https://explorer.solana.com/address/<pda>?cluster=devnet`. Store/show the signature as soon
as broadcast succeeds or throws, using the locally extracted signature before sending. On ambiguous broadcast or confirmation, advise checking that signature rather
than automatically resending a potentially successful initialization.

Show actual rules and payout previews; disable irrelevant controls based on account state
and signer. Chain Clock is authoritative; browser countdowns are estimates. Show rent
separately from principal. There is no background auto-execution.

## Acceptance

Test instruction discriminators/encoding, maximum u64, variable UTF-8 URI account decoding,
invalid owner/discriminator, wallet rejection, failed confirmation, and all role/state actions.
Use synthetic buffers and mocked RPC for offline unit tests, clearly distinguished from
real Devnet evidence. Manually check desktop/mobile layout and keyboard navigation. Then
perform real Devnet flows with fresh sprint IDs for approve, cancel, timeout and dispute.
Do not claim integration verification without transaction signatures and decoded state.
