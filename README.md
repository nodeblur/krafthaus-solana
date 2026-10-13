# Krafthaus — Bound Contractor Payouts

Accepted work → one exact payment attempt → one original receipt on retries.

Krafthaus is the workflow and execution layer. Decide is the rule-evaluation and record engine. Solana is the settlement rail. This repository is a **devnet-only prototype evaluation copy**, starting with one contractor-payment application; it is not finished production infrastructure.

## Try the live product

[Open the wallet-free contractor rehearsal](https://www.krafthaus.app/solana/bound-payout#try).

1. Remove acceptance and check the invoice: **DEFER**.
2. Try agent self-acceptance and check: **BLOCK**.
3. Load the pre-signed synthetic demo-owner record and check: **APPROVE**.
4. Rehearse one payout, then retry: the same **simulated** receipt, payment count **1**.

The browser checks a pinned synthetic owner's signature and maintains a simulated ledger. It never signs or sends a transfer. The separate [historical transaction lab](https://www.krafthaus.app/solana/bound-payout#bytes) lets judges change recipient or amount in recorded bytes. Matching an expired historical approval is not new spending authority.

## Run locally

Node.js 22+ is required. Read [RUNBOOK.md](RUNBOOK.md) before running the service or deliberately testing a devnet transfer.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
node contractor-local.cjs
```

This starts a loopback-only contractor service with fresh in-memory owner and devnet keys. It reads no existing wallet or service credential. The operator's terminal `accept` step is separate from the agent-facing HTTP API; there is no HTTP acceptance-issuer route. Use only free devnet SOL if deliberately funding a test. Never use real funds, mainnet or an existing wallet.

`npm start` launches the retained earlier raw executor, not the contractor acceptance workflow. Its qualifier is deliberately separate. Follow the runbook rather than treating the two entrypoints as interchangeable.

## How it works

- A fictional agreement binds obligation, invoice, milestone, delivery hash, recipient, amount and devnet designation.
- A separately configured trusted owner key verifies Ed25519 acceptance over the agreement hash and timestamp. An agent cannot set its own trusted issuer or replace evidence with `accepted: true`.
- The wrapper derives trusted facts for the existing Decide rulebook. Missing acceptance defers; invalid or changed evidence blocks.
- The local executor binds a short-lived approval to exact serialized Solana message bytes and refuses altered transactions before signing.
- A per-obligation reservation precedes asynchronous work. Repeated/concurrent requests retain an active approval or the original payment attempt/receipt rather than generating a second payout.
- Submitted or uncertain outcomes must reconcile the original attempt. The ledger is in memory: these guarantees **do not survive restart**.

Useful entrypoints: [contractor.cjs](contractor.cjs), [contractor-policy.mjs](contractor-policy.mjs), [contractor-local.cjs](contractor-local.cjs), [executor.cjs](executor.cjs), and their tests.

## Evidence, not implied settlement

- [contractor-qualification.json](contractor-qualification.json): actual source-matched Decide/unsigned-devnet qualification on October 12, 2026 at 19:23 UTC, including separately signed fictional acceptance, concurrent approval reuse and changed-byte refusals. **Fresh funded contractor settlement is pending**; the free faucet refused/quota-limited funding and the ephemeral signer was stopped.
- [qualification-evidence.json](qualification-evidence.json): an earlier executor's actual 0.001 test-SOL transfer, confirmed at slot 510306819, with receiver delta and network fee verified. [Historical Explorer receipt](https://explorer.solana.com/tx/tP7mREQaVfPWQhfixQNwUauqRcLVWEJmR3aWUwWrZBRUy2yBeBBc2eogQ22juLbXoppquCzuLA1w3z9EFACTk3Z?cluster=devnet). This predates the contractor layer and used the earlier runtime described in the runbook. It is not proof of current contractor settlement.
- The public browser receipt is always simulated, not a blockchain signature.
- [SHA256SUMS.txt](SHA256SUMS.txt) records the unchanged prototype files from the already-public reviewed [source download](https://www.krafthaus.app/solana/bound-payout/source.zip). This README is additional evaluation documentation.

## What is new since Frontier

The founder's previous [Krafthaus Frontier entry](https://colosseum.com/arena/projects/krafthaus), submission 13028, demonstrated deterministic decision packets and optional devnet Memo anchoring. [Its original public repository](https://github.com/nodeblur/krafthaus-colosseum-frontier) is prior-work evidence.

The existing Decide engine, verdicts, decision packets, Memo demo and wider business infrastructure are pre-existing. October 12, 2026 work adds the transaction-bound local executor and its historical devnet proof, then the contractor agreement, signed owner acceptance, per-obligation reservation/retry control and shared acceptance verifier used by the public rehearsal. The current copy is published for the Crypto World's Fair submission; publication time is not the implementation start time. OpenAI Codex assisted implementation, tests, review, research and documentation.

## Product direction and limits

The initial buyer hypothesis is a team whose agents prepare contractor payments after owner acceptance. A scoped workflow integration plus recurring operation/support is a hypothesis to validate, not an existing Solana pricing plan or transaction rake. Other agreement workflows are expansion ideas, not additional finished applications.

No production custody, durable crash recovery, onchain enforcement program, wallet-wide policy, objective work-quality proof, real-world recipient identity verification, SPL-token/swap support, native MCP/LLM-agent integration, token or paying-customer claim is made. The signature proves a configured key's assertion, not legal payment entitlement. Principal is capped separately from network fees. The pinned SDK's original audit had four moderate transitive advisories; this is not a production-security approval.

This is only the reviewed prototype already distributed publicly, plus this README. It excludes the wider private Krafthaus application, infrastructure configuration, customer data and credentials. Public evaluation source does not imply a new open-source license grant.
