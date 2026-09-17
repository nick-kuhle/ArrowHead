# ArrowHead

> Lean, boring, multi-chain **arbitrage + liquidations + OEV** for Layer 2s.
> We go where the big bots don't bother. We lose pennies, not the seed.

ArrowHead is a single, fail-closed trading bot that lives on low-competition
(L2) chains and does three things, all of them *atomic* (a trade either makes
money or never happens):

1. **Arbitrage** — buy a token where it's a touch cheaper, sell it where it's
   a touch pricier, in one transaction. Zero money at risk: if the trade
   wouldn't clear a profit, the whole thing cancels itself.
2. **Liquidations** — when a borrower's collateral dips below the safety line,
   anyone can step in, repay their loan, and keep their collateral at a
   discount. Legal, boring, and where close attention beats raw speed.
3. **OEV** (oracle front-running, the good kind) — the moment a price oracle
   updates, positions that just became underwater are cleared *immediately*,
   before the crowd wakes up.

**Design rule: the seed capital IS the soak.** No 7-day probation, no
ceremony — you choose a number you're OK losing a few times, the bot respects a
firm budget, and we fine-tune from real results.

---

## The idea in one paragraph

Big MEV bots fight over the same few fat trades on Ethereum and Base. ArrowHead
ignores those fights. It watches the low-competition corners of several chains —
**Linea first**, then Base — where a $100 trade is still worth someone's while,
where a solo operator can catch liquidations the giants skip, and where gas
costs fractions of a cent so trying and being wrong is nearly free. Same DNA as
a Formula 1 team, driving a go-kart in a league nobody entered yet.

## What it is NOT

- **Not a token-sniper.** No memecoins, no new-launch gambling. (That lane was
  surgically removed — it loses long-term and we built the discipline to admit it.)
- **Not a cross-chain rebalancer.** Across-chain arb needs hours of bridge
  finality and money parked on both sides — a $5,000+ game. We stay *inside*
  each chain where trades are atomic and honest.
- **Not hype.** No promises, no stack of influencer bait. Just a bot that
  either clears its own bar or reverts.

---

## Chains

| Chain | Status | Venues |
|---|---|---|
| **Linea (59144)** | Profile wired in code — venue adapters pending | Lynex (Solidly) — not yet adapted · Etherex (concentrated custom tiers) · Mendi (Compound-V2) — not yet adapted · ZeroLend (Aave-V3 lending) |
| **Base (8453)** | Profile wired | Aerodrome, Uniswap V3, Aave V3, Morpho Blue, Compound V3 |
| **Ethereum (1)** | Profile wired | Uniswap V2/V3, Balancer, Aave V3, Compound V3, Maker |
| **Arbitrum (42161)** | Profile wired | Uniswap V2/V3, Balancer, Aave V3, Compound V3, Morpho Blue |

The same binary runs per chain; each chain gets its own env file, its own
wallet, its own budget. Run one chain or ten — nothing changes but a folder.

---

## Safety (the part that matters at $100)

1. **Profit-or-revert.** The on-chain executor measures the bookkeeping and
   reverts the *entire* transaction if profit is zero or negative. A losing
   trade doesn't get mined.
2. **Firm bot-side budget.** The per-chain trading budget (max position, max
   cumulative drawdown, kill switch) lives in the bot's risk engine and is
   checked before every send. It is *not* an on-chain cap: a compromised
   trading key can only ever profit-or-revert through the executor, but a
   compromised *bot* could raise its own budget. Inspect the engine's risk
   output before arming, and keep the owner key separate.
3. **One-time smoke.** Optional bounded live probes (a provably-tiny
   transaction each) verify signing→relay→executor end to end; then disarm
   and review. The seed IS the soak — live trading is not gated on a shadow
   window by default (express mode), so smoke is a habit, not a requirement.
4. **Kill switch.** One authenticated button (or one env line) stops live
   trading instantly; open positions are still managed to safety.
5. **Two keys, always separate.** Deploy/owner key never touches the trading
   hot key.

---

## How you run it (the short version)

```bash
make doctor          # is my box and config happy? (green checkmarks)
make verify          # contract <-> simulator <-> bot all agree, offline
sudo systemctl start arrowhead@linea   # run the Linea instance
```

Then open the console on `http://localhost:8080` and read it like a
thermostat: **green** = working normally, **amber** = check this, **red** =
it stopped itself on purpose. One clearly-labeled **STOP** button pauses live
trading. No jargon soup.

Detailed operator manuals live in [`docs/`](docs/).

---

## Repository layout

```
bot/crates/mev-bot      the bot (Rust) — detection, simulation, risk, sending
contracts/              MevExecutor + test ERC20s (Solidity, Foundry)
deploy/                 systemd units, docker compose, backup timers
docs/                   runbooks, risk model, per-chain feeds
make/                   build + verify glue
```

## License

MIT. Portions derived from [JerseyMikes](https://github.com/nick-kuhle/JerseyMikes)
© 2026 nick-kuhle.

---

*Nothing here is financial advice. ArrowHead trades real money only when you
point it at real money, and it can lose the seed. That is the deal. Read
[`docs/RISK.md`](docs/RISK.md) before you arm it.*