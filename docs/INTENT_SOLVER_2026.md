# Intent Solver Boundary

**Status: foundation implemented, shadow ingestion not yet enabled.**

ArrowHead now contains a pure native CoW GPv2 order validator in
`bot/crates/mev-bot/src/cow.rs`. It computes the chain-specific EIP-712 digest,
recovers an EOA owner, derives the 56-byte order UID, and rejects expired,
overlong, malformed, non-ERC20, non-EIP712, zero-value, and fee-invalid orders.
An authenticated, opt-in `POST /api/intents/validate` shadow endpoint exposes
that validation result and durably deduplicates accepted shadow records in
SQLite. It does not quote, select a solver, or submit settlements yet.

## 2026 Market Position

The current solver market is not one generic “intent” market:

- **CoW Protocol:** batch-auction, user-signed GPv2 orders; solver competition,
  coincidence-of-wants, per-directed-pair fairness, and settlement-success
  accounting.
- **UniswapX:** chain-specific Dutch-order/filler markets with inventory and
  markout risk. It is not interchangeable with CoW.
- **ERC-7683 / Open Intents:** solver-facing resolution and cross-chain
  settlement interfaces, not a universal settlement contract or bridge.
- **OEV:** covered oracle feeds increasingly auction update rights through
  protocol-specific venues. An ordinary oracle back-run must not compete with a
  covered OEV auction or double-count its value.

The competitive edge is therefore route-specific inventory, exact simulation,
settlement reliability, bounded credit/finality risk, and realized markout data,
not simply supporting more JSON formats.

## Required Production Sequence

1. Promote `POST /api/intents/validate` into an authenticated, bounded
   `POST /api/intents` endpoint only after the persistence gates below pass.
2. Extend the SQLite shadow journal with full intent transitions and settlement
   records. Accepted intent state must never use the drop-on-full telemetry
   queue.
3. Add configured chain-specific CoW settlement addresses and solver
   authorization checks. No address is hard-coded as a universal deployment.
4. Add a CoW auction adapter (`solve`/`notify`) only after current onboarding,
   endpoint, custody, bond, and chain terms are recorded.
5. Implement a deterministic optimizer with per-pair references, fairness
   self-filtering, cost-adjusted surplus, gas/revert penalties, and no surplus
   shifting between orders.
6. Simulate the exact encoded settlement payload on a pinned fork before any
   response can be classified as executable.
7. Reuse nonce, inventory, risk, qualification, submission, and finality
   reconciliation only through an explicit intent lane. Never route signed
   user orders through pending-transaction victim strategies.
8. Add separate rows for CoW, UniswapX, ERC-7683, and OEV transport/auction
   qualification. A pass on one venue grants no pass on another.

## Security Invariants

- EIP-712 domain chain ID and settlement address are mandatory.
- The recovered owner, not a client-supplied owner field, is authoritative.
- Duplicate UID/digest submission is idempotent and cannot create a second fill.
- Expiry, maximum validity, nonce, receiver, token policy, and amount limits are
  checked before persistence or network I/O.
- User payloads may never become arbitrary `MevExecutor.Call[]` targets.
- Settlement calls may target only a configured, code-attested protocol contract.
- The exact signed payload simulated must equal the payload evaluated for send.
- Unknown auction, transport, refund, OEV, or finality outcomes fail closed.
- `svr_coverage: unknown` disables oracle-triggered rows; covered feeds use the
  protocol auction adapter rather than public-mempool racing.

## Source Notes

The design is informed by Aqua’s `MOUTHS.md`, `TRANSPORT.md`,
`PROTOCOL_REGISTRY.md`, and `RESEARCH_2026.md`. Aqua’s current repository is a
non-networked safety foundation: it has no CoW adapter, solver, signer, RPC,
persistence, OEV client, or transport submission implementation to transplant.
Its strongest reusable ideas are explicit lane/state identity, closed transport
semantics, fail-closed oracle coverage, and `revm`-screen/Anvil-authority
simulation discipline.

External protocol behavior must be revalidated before staging or production:
CoW onboarding and solver rules, settlement addresses, current auction scoring,
OEV venue terms, and ERC-7683 resolver/settler deployments are not constants.
