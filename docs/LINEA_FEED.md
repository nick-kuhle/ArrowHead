# Linea feed and market map — verified provider notes

**Work order:** Linea pre-flight (build-first lane) of the ArrowHead derivation.
**Status:** probed live 2026-09-16 against the public Linea RPC; all addresses
below were read back from Chain during the probe (contracts, tokens, oracle
prices, pool reserves and impact probes). No keys, no trades.

## Sequencer / feed reality (verified)

- Linea has a **single sequencer** (ConsenSys/Linea) — no public mempool, no
  Flashblocks-style pending feed, no `eth_simulateV1` (probe → error -32601).
  The edge is therefore **post-sequencing reaction**, not preconfirmation.
- Sim path for Linea: local **anvil fork** + pinned-state `eth_call`
  (JerseyMikes already falls back to this when `eth_simulateV1` is absent).
- Endpoints: public RPC `https://rpc.linea.build` (HTTP; WSS `wss://rpc.linea.build`).
  Public = dev/shadow only (rate limited). A paid Linea RPC provider is the
  required follow-up for sustained runs; credential lands in env, never git.
- Chain identity verified: `chainId 0xe708` = **59144**.

## Verified contracts (all read back from Chain)

| System | Address | Verified via |
| --- | --- | --- |
| Lynex Factory (Solidly/ve3 fork) | `0xBc7695Fd00E3b32D08124b7a4287493aEE99f9ee` | `allPairsLength()=334`, `getFee(bool)` |
| Lynex RouterV2 | `0x610D2f07b7EdC67565160F587F37636194C34E74` | `factory()` → factory above |
| Etherex PairFactory (classic) | `0xC0b920f6f1d6122B8187c031554dc8194F644592` | `getPair` probes (empty results) |
| Etherex Router (classic) | `0x32dB39c56C171b4c96e974dDeDe8E42498929c54` | docs |
| EtherexV3Factory (Ramses V3 / UniV3 fork) | `0xAe334f70A7FC44FCC2df9e6A37BC032497Cf80f1` | `getPool(tokenA,tokenB,tickSpacing)` |
| Etherex SwapRouter | `0x8BE024b5c546B5d45CbB23163e1a4dca8fA5052A` | docs |
| Etherex UniversalRouter | `0x85974429677c2a701af470B82F3118e74307826e` | docs |
| Mendi Comptroller (Unitroller proxy) | `0x1b4D3b0421dDc1eB216D230Bc01527422Fb93103` | `getAllMarkets()` → 9 markets |
| Mendi Comptroller impl | `0x1a11669Ecf91692440Da95CC8A12DE80B1C3D9e3` | audit trail + source |
| ZeroLend Pool proxy (Aave V3 fork) | `0x2f9bB73a8e98793e26Cb2F6C4ad037BDf1C6B269` | `ADDRESSES_PROVIDER()` |
| ZeroLend PoolAddressesProvider | `0xC44827C51d00381ed4C52646aeAB45b455d200eB` | returned by pool proxy |
| ZeroLend AaveOracle | `0xFF679e5B4178A2f74A56f0e2c0e1FA1C80579385` | `getAssetPrice(WETH)` → `243532694501` (8 dp = $2435.33) |

ZeroLend periphery (docs-verified, unprobed): PoolConfigurator proxy
`0xf17218B09699d0F7145e40E771e72130FF616498`, PoolDataProvider
`0x67f93d36792c49a4493652B91ad4bD59f428AD15`.

## Verified tokens on Linea

WETH `0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f` (18) · USDT
`0xA219439258ca9da29E9Cc4cE5596924745e12B93` (6) · USDC (bridged)
`0x176211869cA2b568f2A7D4EE941E073a821EE1ff` (6) · DAI
`0x4AF15ec2A0BD43Db75dd04E62FAA3B8EF36b00d5` · WBTC
`0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4` · wstETH
`0xB5beDd42000b71FddE22D3eE8a79Bd49A568fC8F` · ezETH
`0x2416092f143378750bb29b79eD961ab195CcEea5` · weETH
`0x1Bf74C010E6320bab11e2e5A532b5AC15e0b8aA6` · wrsETH
`0xD2671165570f41BBB3B0097893300b6EB6101E6C`

## Mendi market map (cToken from `getAllMarkets()`, value read via `underlying()`)

| # | cToken (market) | Underlying |
| --- | --- | --- |
| 0 | `0x333D8b480BDB25eA7Be4Dd87EEB359988CE1b30D` | USDC |
| 1 | `0xf669C3C03D9fdF4339e19214A749E52616300E89` | USDT |
| 2 | `0xAd7f33984bed10518012013D4aB0458D37FEE6F3` | WETH |
| 3 | `0x1f27f81C1D13Dd96A3b75d42e3d5d92b709869AA` | DAI |
| 4 | `0x9be5e24F05bBAfC28Da814bD59284878b388a40f` | WBTC |
| 5 | `0xCeEd853798ff1c95cEB4dC48f68394eb7A86A782` | wstETH |
| 6 | `0x8a90D208666Deec08123444F67Bf5B1836074a67` | ezETH |
| 7 | `0x9B4971aC84054597EDEd7Dc7b4b7E8A0c90753B5` | weETH |
| 8 | `0x109F4Af9ec6A5ede198f7A4d9d9d7390de29362A` | wrsETH |

Mendi is a **Compound V2 fork** with per-market cTokens and a Unitroller-style
comptroller — needs a new `liquidateBorrow` liquidator adapter. ZeroLend is a
**copy of Aave V3** — reuse the existing Aave geometry, point at the Linea pool.

## Depth map (live impact probes, 2026-09-16)

| Route | DEX / kind | one-way impact at 100k USDC / 0.01 WBTC / 1 WETH | Verdict |
| --- | --- | --- | --- |
| USDC→USDT stable | Lynex stable | 100k → 100,029.5 USDT (~0.03%) | **deep, tight — primary peg-arb lane** |
| USDC→USDT vol | Lynex volatile | 100k → 78.5k USDT (21%) | mispriced/shallow, avoid |
| WBTC→WETH vol | Lynex volatile | 0.01 WBTC → 0.3531 WETH (~fair) | healthy, usable |
| WBTC→WETH stable | Lynex stable | 0.01 WBTC → 0.0838 WETH (76% off) | avoid |
| WETH→USDC stable | Lynex stable | 1 WETH → 268 USDC (~90% off) | **ETH side threadbare (0.06 WETH)** |
| WETH→USDC vol | Lynex volatile | 1 WETH → 683 USDC (72% off) | shallow (0.4 WETH) |
| WETH→USDC V3 | EtherexV3 ts=200 | `liquidity()=0` | zero in-range LP |
| Etherex classic | all probed routes | no pairs at all | inactive |

Consequence for a $20–100 seed bot: **start on USD-pegs (Lynex USDC/USDT
stable) and WBTC/WETH volatile; do not count on ETH-side AMM depth until a
fresh depth survey says otherwise.** Keep route scoring impact-aware so a
shallow pair self-disqualifies instead of burning gas.

## Bot-facing contract (planned)

- `known::linea()` in `bot/crates/mev-bot/src/config.rs` (chain 59144).
- Lending witnesses: Mendi comptroller `getAllMarkets()` + cToken
  `underlying()`; ZeroLend oracle `getAssetPrice()` for debt/collateral USD.
- Executor on Linea is **self-funded profit-or-revert** — no known Balancer
  vault on Linea, so the Balancer-flashloan-only `MevExecutor` needs a
  self-funded mode in v1.
- All probes above are dry reads; nothing requires a signature/keys.

## Open items (integration-PR tickets, not blocking pre-flight)

1. Lynex RouterV2 `getAmountsOut` / `swapExactTokensForTokens` both reverted
   with empty data across every signature variant probed, while the same
   factory returns pairs and the pair-level `getAmountOut` works. Suspicion:
   router pairFor (CREATE2) hash mismatch. Decide pair-direct + executor vs
   router during the Linea profile PR; forks+sims will confirm before keys.
2. Etherex classic factory returned zero for all probed `getPair`s — confirm
   it isn't a different getter shape before classifying it dormant.
3. Fresh depth survey must run at go-live time (depth is dynamic; today's map
   is a snapshot).

## Explicitly out of scope (stop conditions honoured)

- Any preconfirmation/pending-state lane: does not exist on Linea; no attempt
  to emulate it or to front-run the sequencer.
- Flashloans of any kind on Linea until a vault is proven; v1 is self-funded.
- The router pairFor question stays a code ticket — no keyed transaction of
  any sort is sent from this dev environment.