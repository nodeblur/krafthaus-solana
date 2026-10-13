# Krafthaus Bound Contractor Payout

Pay for accepted work, with proof of why it was owed. This devnet-only prototype connects a fictional contractor agreement, a separately signed owner acceptance, a Decide decision and a bounded local payment. Public browser rehearsal: https://www.krafthaus.app/solana/bound-payout

## Rehearse one job in the browser

The public page shows one fictional agreement containing an obligation ID, invoice reference, milestone, delivery SHA-256, recipient, amount and devnet designation. Without owner acceptance, evaluation returns DEFER. The pre-signed synthetic acceptance binds the agreement hash and acceptance timestamp, and is checked against a separately pinned demonstration public key using the same cryptographic verifier as the local contractor wrapper. The synthetic signing key was discarded; the fixture does not attest to a real owner's identity. Invalid or changed evidence returns BLOCK.

Use **Remove acceptance** and **Check contractor invoice** to show DEFER, then **Try agent self-acceptance** and check again to show BLOCK. **Load demo-owner acceptance** and check to verify the signed fixture. **Rehearse one payout** creates one simulated receipt; checking and rehearsing again or using **Retry same invoice** returns that receipt with the payment count still one. This is a demonstration, not new Solana settlement: **no wallet, signer, executor endpoint or actual new payment** is available on the public page.

The retained [historical transaction lab](https://www.krafthaus.app/solana/bound-payout#bytes) edits exact amount/recipient bytes and computes SHA-256. Matching an old recorded message cannot renew its expired approval. The earlier Frontier decision-packet/Memo demo remains linked separately.

## Run the separate local contractor wrapper

Unzip the reviewed source download, enter `solana-bound-devnet-20261012`, then install and check it:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

Start the contractor entrypoint from the extracted directory:

```sh
node contractor-local.cjs
```

Node 22+ is required. `contractor-local.cjs` starts a separate loopback-only contractor service and owner console; `contractor.cjs` wraps the existing transaction executor. The operator process generates a fresh owner acceptance key, devnet signer and recipient, keeps private keys in memory and reads no existing wallet or service credential. It prints the local URL, fictional agreement and public policy/key information. The trusted owner public key is configured when the contractor wrapper is constructed, never selected by a proposal's caller or acceptance record.

1. Inspect the printed agreement: one obligation, invoice, milestone, delivery SHA-256, recipient, amount and devnet designation. Retain its exact agreement hash.
2. Use the printed loopback URL to propose without acceptance through `POST /api/prepare`. Verify DEFER and no transaction signing or broadcast.
3. In the **operator process's stdin**, enter `accept`. This explicit owner step signs the exact agreement hash and acceptance timestamp and prints the acceptance record for handoff. It is separate from agent-facing proposals; the HTTP service has no acceptance-issuer route and startup state contains no acceptance.
4. Submit that record as `{acceptance: ...}` to `POST /api/prepare`. The wrapper verifies the trusted signature and unchanged agreement before obtaining the real Decide approval and transaction-bound local approval.
5. Deliberately invoke `POST /api/execute` with the returned approval ID and unchanged transaction while its 60-second approval is live. Reconcile that original approval through `GET /api/receipt` rather than making a replacement payment.
6. Prepare the same obligation again while approval is live: reuse that approval. After execution, reuse the original receipt/result/signature. An unused expired approval or known unsubmitted preflight refusal may be renewed; once submission has begun, or its outcome is uncertain, keep reconciling the original attempt.

The loopback API also supports `GET /api/state`; writes require the local demonstration intent header and the expected JSON shape, Host and Origin. Follow the client shape in `contractor-local.cjs` rather than opening the service to another host. For a controlled Node qualification, `startContractorDemo({decide, ...})` returns the service and workflow plus a separate `ownerConsole.accept()` method; the owner step is never exposed over HTTP.

Fund only the newly displayed devnet address with free test SOL if deliberately exercising settlement. Never use real money or a mainnet wallet. Stop before faucet consent requesting repository/organization/write access. A faucet failure is not permission to purchase funding or use a paid fallback.

## Local authority and payment controls

The acceptance is an Ed25519 signature over a record binding the agreement hash and acceptance timestamp. Missing acceptance returns DEFER. An invalid signature, untrusted signer, malformed record or changed agreement returns BLOCK. An `accepted: true` flag is not acceptance evidence. The signature proves that the configured owner's key accepted that exact agreement; it does not prove objective work quality, real-world identity or legal payment entitlement.

The per-obligation ledger reserves before asynchronous proposal work so concurrent attempts cannot each obtain a new payment. Repeated preparation reuses one active approval or the original execution receipt instead of creating a **new** payment. An unused expired approval or known unsubmitted preflight refusal may be renewed, but submission or uncertainty prevents a replacement. Repeated execution and reconciliation retain the original attempt and signature. A newly signed acceptance timestamp for the same agreement does not reset that ledger. These guarantees apply only within the running local process; they do not survive restart.

The local mandate permits one allowlisted address, at most 0.001 test SOL per transfer, at most 0.003 per session and 32 approval records. The session limit covers principal, not fees. Each approval lasts 60 seconds and binds the exact serialized legacy Solana message, including fee payer, recipient, amount, blockhash, instructions and decision-linked Memo. Caller-supplied signatures are rejected.

After a verified prepare, edit amount or recipient bytes in the returned transaction before execution: the executor must return `TRANSACTION_CHANGED` before signing. Changing the agreement instead fails its owner-acceptance check. The retained raw executor refuses a 0.002 proposal with `AMOUNT_OUTSIDE_POLICY`. An expired transaction approval cannot execute. For an unchanged approved transfer, the local executor checks devnet genesis, block height and balance, signs for simulation, checks its result and expiry, then submits once. Confirmation requires the exact chain message, valid signature and principal-plus-fee/recipient balance deltas. A send response or simulation is not confirmation.

## Retained executor demonstration

The earlier local HTTP executor remains a separate transaction-bound demonstration. It is not the contractor acceptance issuer and its old qualifier does not prove the new acceptance or obligation layer:

```sh
npm start
```

The server binds only to `127.0.0.1` and prints its local URL. It creates a fresh in-memory devnet signer and recipient at every start. Its machine-client options are below; replace PORT with that server's displayed port:

```sh
node qualify.cjs http://127.0.0.1:PORT --unsigned-only
# This next command deliberately submits one 0.001 test-SOL transfer if funded:
node qualify.cjs http://127.0.0.1:PORT
```

These commands exercise the earlier executor only. The funded command deliberately submits one 0.001 test-SOL transfer if funded; re-running its qualifier creates a fresh proposal. Use the contractor wrapper to exercise obligation-level duplicate protection. After an uncertain broadcast, reconcile the original signature; do not propose a replacement payment. Restart loses keys, approvals, obligation state and pending reconciliation: this is not production custody or crash recovery.

## What is observed versus illustrated

**Fresh contractor unsigned integration verified at 2026-10-12 19:23 UTC.** The frozen local source obtained real Decide record `dec_6af5d0308fccb5a446c4ffc4` and an unsigned devnet message after separately signed fictional owner acceptance. Missing acceptance returned DEFER; an agent boolean returned BLOCK; concurrent preparation reused one approval; changed amount and recipient bytes both returned `TRANSACTION_CHANGED`. The public `contractor-qualification.json` contains the signed public acceptance, trace, unsigned message and exact source fingerprints. The legacy Decide inputs are explicitly interpreted as single-owner acceptance and allowlisted-address matching, not DAO quorum or recipient identity verification.

**Fresh contractor settlement remains pending.** The RPC faucet refused, and the official free faucet reported its two-requests-per-eight-hours quota. No contractor transaction was signed/broadcast or claimed confirmed. The fresh signer process was stopped and its in-memory keys discarded. A completed unsigned/test run cannot establish onchain settlement; add a funded result only after observing a new controlled contractor flow and exact chain evidence. Use free devnet funding only. The browser receipt is always simulated.

`qualification-evidence.json` records an earlier actual October 12, 2026 executor transfer, confirmed at slot 510306819, with 1,000,000 lamports received and 5,000 lamports network fee. Changed amount/recipient were refused before signing, and identical retry retained one signature. Independent chain decoding verified its message hash, signatures and balance changes. This receipt **predates the contractor acceptance layer** and is not proof that the new layer settled onchain. Historical public transaction:

https://explorer.solana.com/tx/tP7mREQaVfPWQhfixQNwUauqRcLVWEJmR3aWUwWrZBRUy2yBeBBc2eogQ22juLbXoppquCzuLA1w3z9EFACTk3Z?cluster=devnet

The historical signer ran SDK 1.91.1 before the final in-process input-copy safeguard. Later tests and independent chain decoding used pinned 1.98.4. The old receipt is not a source-matched funded run of the current contractor wrapper. Remote HTTP callers could not mutate the server's parsed request object during awaits.

The public contractor rehearsal checks a synthetic acceptance and maintains a simulated browser ledger. Its receipt is labeled simulated and never presented as a chain signature. The historical lab checks SHA-256 over recorded transaction bytes. Neither browser flow signs, invokes an agent, broadcasts a payment or reads fresh chain state.

## Boundaries and product direction

- Enforcement is local executor enforcement, not a wallet-wide policy or onchain program. A key controlled outside the executor can bypass it.
- Native legacy SOL transfers only: no SPL tokens, swaps, versioned transactions or arbitrary programs.
- The fixed allowlist does not verify real-world recipient identity or a DAO/multisig quorum. The Decide quorum input reflects the fictional local mandate only.
- Owner acceptance is operator-defined. It attests to one agreement and timestamp, not objective delivery quality. The public fixture's pre-signed acceptance is synthetic and grants no real authority.
- Approval and obligation state are in memory. Per-obligation deduplication is a running-process guarantee, not restart-safe custody or recovery.
- A local HTTP qualifier is not a native MCP/LLM-agent test. An MCP adapter is a possible integration, not a verified feature here.
- No hosted custody, durable state, mainnet operation, token, paying customer or recurring Solana plan is claimed.
- SDK 1.98.4 has four moderate transitive advisories and no high/critical entries at the original audit. Fixed-endpoint fetch is used instead of the SDK's RPC client. Do not treat this as production security approval.

Krafthaus is the customer workflow surface and execution adapter. Decide evaluates rules and returns records; Solana provides the settlement rail. The buyer hypothesis is an operations team paying contractors after owner acceptance, with evidence explaining why each obligation was paid and protection against duplicate attempts. The prospective business is scoped workflow installation plus recurring operation/support. No new token or compulsory transaction fee is introduced. Existing Workflow App Sprint scope, prices, Decide billing and MCP behavior remain unchanged; no paying-customer or demand claim is made for this prototype.

## Development disclosure

The public ZIP is an explicit reviewed asset, not a build-time side effect. Regenerate it whenever an allowlisted prototype input or this runbook changes, then validate all archive checksums:

```sh
node --input-type=module -e 'import {writeBoundPayoutSource} from "./scripts/build-bound-payout-source.mjs"; writeBoundPayoutSource(process.cwd(), process.cwd());'
npm run test:bound-payout
```

The raw experiment directory is excluded from hosting; the download is its intentional public distribution boundary. No hosting credential is required to assemble or check this artifact.

The existing Solana decision-packet/Memo demo was submitted to Frontier and predates the current hackathon. This round adds the transaction-bound local executor and historical devnet evidence, then the contractor agreement, signed owner acceptance, obligation ledger, shared verifier and coherent public rehearsal. No hackathon registration, video upload or submission is implied by publishing this page. Judge repository access and final owner submission remain separate.
