"use client";

import {useCallback, useEffect, useMemo, useState} from "react";
import EquityChart from "./EquityChart";
import LiveFeed from "./LiveFeed";
import ContractPanel from "./ContractPanel";
import GoLivePanel from "./GoLivePanel";
import EligibilityPanel from "./EligibilityPanel";
import RiskPanel from "./RiskPanel";
import FunnelPanel from "./FunnelPanel";
import RelayBlocksPanel from "./RelayBlocksPanel";
import Phase1Panel from "./Phase1Panel";
import ModeSwitch from "./ModeSwitch";
import ChainSwitcher from "./ChainSwitcher";
import Section from "./Section";
import ThemeToggle from "./ThemeToggle";
import DataPlanePanel from "./DataPlanePanel";
import WalletButton from "./WalletButton";
import CowPanel from "./CowPanel";
import {Icon, Pill, Stat} from "./ui";
import type {
  ActualMevResponse,
  CompetitionResponse,
  ExecutionResponse,
  OpportunityRow,
  PnlResponse,
  RelayBid,
  ReorgRow,
  SeriesPoint,
  SimulationRow,
  StatusResponse,
} from "@/lib/types";
import {
  ago,
  gwei,
  shortHash,
  signedEth,
  STRATEGY_COLOR,
  STRATEGY_LABEL,
  weiToEth,
} from "@/lib/format";
import {blockUrl, txUrl} from "@/lib/explorer";
import {useFeed} from "@/lib/feed";
import {onChainChange, readActiveChain, withChain} from "@/lib/chain";
import {useWallet} from "@/lib/wallet";

const CHAIN_ID_LABEL: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  42161: "Arbitrum",
  10: "Optimism",
  137: "Polygon",
  56: "BNB",
};
const labelFor = (id: number | null | undefined) =>
  id == null ? "an unknown chain" : CHAIN_ID_LABEL[id] ?? `chain ${id}`;

const SLUG_EXPECTED_CHAIN: Record<string, number> = {
  ethereum: 1,
  mainnet: 1,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
  bsc: 56,
};

const FEED_MAX = 400;
const POLL_MS = 4000;

const NAV: {id: string; icon: string; label: string}[] = [
  {id: "overview", icon: "pie", label: "Overview"},
  {id: "cow", icon: "swap", label: "CoW orders"},
  {id: "data-plane", icon: "activity", label: "Data plane"},
  {id: "pnl", icon: "arrow-up", label: "P/L"},
  {id: "activity", icon: "bolt", label: "Activity"},
  {id: "history", icon: "table", label: "Transactions"},
  {id: "validation", icon: "shield", label: "Validation"},
  {id: "relay", icon: "layers", label: "Relay"},
  {id: "funnel", icon: "activity", label: "Funnel"},
  {id: "risk", icon: "shield", label: "Controls"},
  {id: "golive", icon: "send", label: "Go live"},
  {id: "executor", icon: "wallet", label: "Executor"},
];

export default function Console() {
  const [chainSlug, setChainSlug] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [botDown, setBotDown] = useState(false);
  const [pnl, setPnl] = useState<PnlResponse | null>(null);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [sims, setSims] = useState<SimulationRow[]>([]);
  const [opps, setOpps] = useState<OpportunityRow[]>([]);
  const [bids, setBids] = useState<RelayBid[]>([]);
  const [competition, setCompetition] = useState<CompetitionResponse | null>(null);
  const [actualMev, setActualMev] = useState<ActualMevResponse | null>(null);
  const [executions, setExecutions] = useState<ExecutionResponse | null>(null);
  const [reorgs, setReorgs] = useState<ReorgRow[]>([]);
  const [feedFilter, setFeedFilter] = useState("all");
  const [strategyFilter, setStrategyFilter] = useState("all");
  const {events, connected} = useFeed(withChain("/api/stream", chainSlug), FEED_MAX);

  const load = useCallback(async () => {
    const get = async <T,>(p: string, fallback: T): Promise<T> => {
      try {
        const r = await fetch(withChain(`/api/bot/${p}`, chainSlug), {cache: "no-store"});
        if (!r.ok) return fallback;
        return (await r.json()) as T;
      } catch {
        return fallback;
      }
    };
    const statusPromise = get<StatusResponse | null>("status", null);
    const [s, p, se, si, op, rb, comp, actual, executionRows, rg] = await Promise.all([
      statusPromise,
      get<PnlResponse | null>("pnl", null),
      get<SeriesPoint[]>("pnl/series?limit=250", []),
      get<SimulationRow[]>("simulations?limit=120", []),
      get<OpportunityRow[]>("opportunities?limit=60", []),
      get<RelayBid[]>("relay-bids?limit=25", []),
      get<CompetitionResponse | null>("competition?limit=25", null),
      get<ActualMevResponse | null>("actual-mev?limit=25", null),
      get<ExecutionResponse | null>("executions?limit=25", null),
      get<ReorgRow[]>("reorgs?limit=15", []),
    ]);
    setBotDown(s === null);
    if (s) setStatus((prev) => keepIfSame(prev, s));
    if (p) setPnl((prev) => keepIfSame(prev, p));
    setSeries((prev) => keepIfSame(prev, Array.isArray(se) ? se : []));
    setSims((prev) => keepIfSame(prev, Array.isArray(si) ? si : []));
    setOpps((prev) => keepIfSame(prev, Array.isArray(op) ? op : []));
    setBids((prev) => keepIfSame(prev, Array.isArray(rb) ? rb : []));
    if (comp) setCompetition((prev) => keepIfSame(prev, comp));
    if (actual) setActualMev((prev) => keepIfSame(prev, actual));
    if (executionRows) setExecutions((prev) => keepIfSame(prev, executionRows));
    setReorgs((prev) => keepIfSame(prev, Array.isArray(rg) ? rg : []));
  }, [chainSlug]);

  useEffect(() => {
    setChainSlug(readActiveChain());
    return onChainChange(setChainSlug);
  }, []);

  const wallet = useWallet();

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const demo = Boolean(status?.demo);
  const chainId = status?.chain.id;
  const walletMismatch =
    wallet.address !== null &&
    wallet.chainId !== null &&
    chainId !== undefined &&
    wallet.chainId !== chainId;
  const registryMismatch =
    !demo &&
    chainSlug != null &&
    SLUG_EXPECTED_CHAIN[chainSlug] !== undefined &&
    chainId !== undefined &&
    SLUG_EXPECTED_CHAIN[chainSlug] !== chainId;

  useEffect(() => {
    if (typeof document === "undefined") return;
    const name = status?.chain.name ?? (chainSlug ? chainSlug[0].toUpperCase() + chainSlug.slice(1) : "");
    document.title = name ? `${name} · ArrowHead MEV terminal` : "ArrowHead — MEV terminal";
  }, [status?.chain.name, chainSlug]);

  const totalNet = pnl?.totalNetWei ?? "0";
  const filteredSims = useMemo(
    () => (strategyFilter === "all" ? sims : sims.filter((s) => s.strategy === strategyFilter)),
    [strategyFilter, sims]
  );
  const {winRate, totalSims} = useMemo(() => {
    const rows = pnl?.byStrategy ?? [];
    let w = 0;
    let n = 0;
    for (const r of rows) {
      w += r.wins;
      n += r.simulations;
    }
    return {winRate: n ? (100 * w) / n : 0, totalSims: n};
  }, [pnl]);

  const dataModeTone =
    status?.dataMode === "live_preconfirmation"
      ? "pos"
      : status?.dataMode === "live_canonical_only"
        ? "accent"
        : "warn";
  const dataModeLabel =
    status?.dataMode === "live_preconfirmation"
      ? "preconf live"
      : status?.dataMode === "live_canonical_only"
        ? "canonical only"
        : "data degraded";

  return (
    <div className="min-h-screen">
      {/* ── top bar ─────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:px-5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
              <Icon name="arrow-up" size={17} />
            </span>
            <div className="leading-tight">
              <div className="brand text-[15px] tracking-wide">ARROWHEAD</div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">MEV terminal</div>
            </div>
          </div>

          <ChainSwitcher />

          <ModeSwitch mode={status?.mode} armed={status?.liveArmed} demo={demo} onChanged={load} />

          <div className="flex items-center gap-2">
            {!botDown && status?.dataMode && (
              <Pill tone={dataModeTone} title={status.dataMode}><Icon name="activity" size={11} />{dataModeLabel}</Pill>
            )}
            {botDown && <Pill tone="neg" title="the bot answered HTTP 503 — nothing on this console is invented"><Icon name="alert" size={11} />offline</Pill>}
            <Pill
              tone={connected && !botDown ? "pos" : "neutral"}
              title={botDown && !connected ? "bot unreachable — no live feed" : connected ? "live feed subscribed" : "feed disconnected"}
            >
              <Icon name="bolt" size={11} className={connected && !botDown ? "live" : ""} />
              feed
            </Pill>
          </div>

          <div className="ml-auto flex items-center gap-2.5">
            <div className="hidden items-center gap-5 xl:flex">
              <HeadStat label="chain" value={status ? `${status.chain.name} · ${status.chain.id}` : "—"} />
              <HeadStat label="block" value={status ? `#${status.head.number}` : "—"} />
              <HeadStat label="base fee" value={status ? `${gwei(status.head.baseFeeWei)} gwei` : "—"} />
              <HeadStat label="kill switch" value={status?.risk.killSwitchTripped ? "TRIPPED" : "armed"} warn={status?.risk.killSwitchTripped} />
            </div>
            <WalletButton expectedChainId={chainId} />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-3 py-4 sm:px-5 space-y-3.5">
        <div key={chainSlug ?? "default"}>
          {/* ── banners ────────────────────────────────────────────── */}
          {walletMismatch && (
            <Banner tone="warn" icon="alert">
              wallet is on <strong>{labelFor(wallet.chainId)}</strong> — console is showing{" "}
              <strong>{status?.chain.name ?? labelFor(chainId)}</strong>. Chain-scoped actions (deploy, allowlist, fund) refuse until the wallet switches.
            </Banner>
          )}
          {registryMismatch && (
            <Banner tone="warn" icon="alert">
              console registry maps <strong>{chainSlug}</strong> to <strong>{labelFor(SLUG_EXPECTED_CHAIN[chainSlug!])}</strong>, but that bot URL answered for{" "}
              <strong>{status?.chain.name ?? labelFor(chainId)}</strong> (chain id {chainId}). Fix the CHAINS env entry, not the bot.
            </Banner>
          )}
          {botDown && (
            <Banner tone="neg" icon="alert">
              the <strong>{chainSlug ?? "default"}</strong> bot is offline — every panel below is empty because nothing is being invented to fill it. Start the bot (check{" "}
              <code>BOT_API_URL</code> / <code>CHAINS</code>) and the console comes alive by itself. No transaction can be sent while it is down.
            </Banner>
          )}

          {/* ── jump nav ───────────────────────────────────────────── */}
          <nav className="sticky top-[60px] z-30 -mx-3 flex items-center gap-1.5 overflow-x-auto px-3 py-1.5 sm:top-[56px]" aria-label="sections" style={{scrollbarWidth: "none"}}>
            {NAV.map((n) => (
              <a
                key={n.id}
                href={`#${n.id}`}
                className="inline-flex flex-none items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--panel)] px-3 py-1 text-[11.5px] font-semibold text-[var(--muted)] no-underline transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                <Icon name={n.icon} size={12} />
                {n.label}
              </a>
            ))}
          </nav>

          {/* ── overview KPI cards ──────────────────────────────────── */}
          <section id="overview" className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7" style={{scrollMarginTop: 8}}>
            <Stat label="simulated net P/L" value={`${signedEth(totalNet)} ETH`} tone={BigInt(totalNet) >= 0n ? "pos" : "neg"} sub="fork simulations only" icon="arrow-up" />
            <Stat label="win rate" value={`${winRate.toFixed(1)}%`} sub={`${totalSims} sims`} icon="pie" />
            <Stat label="opportunities" value={String(status?.stats.opportunities ?? 0)} sub={`${status?.stats.rejected ?? 0} risk-rejected`} icon="bolt" />
            <Stat label="would-submit" value={String(status?.stats.submittable ?? 0)} sub="net-positive bundles" tone="pos" icon="check" />
            <Stat label="mempool seen" value={(status?.stats.pendingSeen ?? 0).toLocaleString()} sub={`${status?.stats.hintsSeen ?? 0} mev-share hints`} icon="activity" />
            <Stat label="sim backends" value={`${status?.simBackends.anvilFork ? "fork" : "—"} / ${status?.simBackends.relayCallBundle ? "relay" : "—"}`} sub="anvil / eth_callBundle" icon="layers" />
            <Stat label="bloxroute blocks" value={(status?.stats.relayBlocksSeen ?? 0).toLocaleString()} sub={`${(status?.stats.relayTxsSeen ?? 0).toLocaleString()} delivered txs`} icon="table" />
          </section>

          {/* ── CoW order placement ─────────────────────────────────── */}
          <Section id="cow" icon="swap" title="CoW Protocol — order placement" subtitle="open orders · quote → sign → place → reconcile · live book">
            <CowPanel chainId={chainId} chainSlug={chainSlug} />
          </Section>

          {/* ── data plane diagnostics ──────────────────────────────── */}
          <Section id="data-plane" icon="activity" title="Data plane" subtitle="upstream RPC · canonical head · preconfirmation feed · candidates by source">
            <DataPlanePanel status={status} now={Date.now()} />
          </Section>

          {/* ── equity + strategies ─────────────────────────────────── */}
          <section id="pnl" className="grid grid-cols-1 gap-3 xl:grid-cols-3" style={{scrollMarginTop: 8}}>
            <Card xl className="xl:col-span-2">
              <div className="panel-head">
                <span className="flex items-center gap-2"><Icon name="arrow-up" size={14} /> cumulative simulated P/L (ETH)</span>
                <span className="muted">{series.length} blocks</span>
              </div>
              <EquityChart series={series} />
            </Card>
            <Card>
              <div className="panel-head"><span className="flex items-center gap-2"><Icon name="pie" size={14} /> per-strategy</span></div>
              <table className="grid">
                <thead>
                  <tr>
                    <th>strategy</th>
                    <th style={{textAlign: "right"}}>sims</th>
                    <th style={{textAlign: "right"}}>win</th>
                    <th style={{textAlign: "right"}}>net ETH</th>
                  </tr>
                </thead>
                <tbody>
                  {(pnl?.byStrategy ?? []).map((r) => (
                    <tr key={r.strategy}>
                      <td>
                        <span className="dot" style={{background: STRATEGY_COLOR[r.strategy], marginRight: 6}} />
                        {STRATEGY_LABEL[r.strategy] ?? r.strategy}
                      </td>
                      <td style={{textAlign: "right"}}>{r.simulations}</td>
                      <td style={{textAlign: "right"}}>{r.simulations ? `${((100 * r.wins) / r.simulations).toFixed(0)}%` : "—"}</td>
                      <td style={{textAlign: "right"}} className={BigInt(r.net_profit_wei) >= 0n ? "pos" : "neg"}>{signedEth(r.net_profit_wei)}</td>
                    </tr>
                  ))}
                  {!pnl?.byStrategy.length && (
                    <tr><td colSpan={4} className="muted text-center py-8">no data yet</td></tr>
                  )}
                </tbody>
              </table>
            </Card>
          </section>

          {/* ── feed + simulations ──────────────────────────────────── */}
          <Section
            id="activity"
            icon="bolt"
            title="Activity"
            subtitle="live tape · simulated transactions, newest first"
            right={
              <select className="ah-input !w-auto" value={strategyFilter} onChange={(e) => setStrategyFilter(e.target.value)} aria-label="filter by strategy">
                {["all", "sandwich", "sandwich_v3", "jit", "atomic_arb", "liquidation", "liquidation_compound", "liquidation_morpho", "liquidation_maker", "oracle_frontrun"].map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            }
          >
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              <div className="panel">
                <div className="panel-head">
                  <span className="flex items-center gap-2"><Icon name="bolt" size={14} /> live data feed</span>
                  <select className="ah-input !w-auto" value={feedFilter} onChange={(e) => setFeedFilter(e.target.value)} aria-label="filter feed by event type">
                    {["all", "pending", "block", "mev_share_hint", "opportunity", "simulation", "bundle", "relay", "relay_block", "reorg", "alert"].map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                </div>
                <LiveFeed events={events} filter={feedFilter} chainId={chainId} />
              </div>

              <div className="panel">
                <div className="panel-head"><span className="flex items-center gap-2"><Icon name="layers" size={14} /> simulated transaction history</span></div>
                <div style={{maxHeight: 480, overflowY: "auto"}}>
                  <table className="grid">
                    <thead>
                      <tr>
                        <th>age</th>
                        <th>strategy</th>
                        <th>backend</th>
                        <th style={{textAlign: "right"}}>gas</th>
                        <th style={{textAlign: "right"}}>gross</th>
                        <th style={{textAlign: "right"}}>net ETH</th>
                        <th>victim tx</th>
                        <th>result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSims.map((s, i) => {
                        const victim = s.victims ? s.victims.split(",")[0] : null;
                        const link = txUrl(chainId, victim);
                        return (
                          <tr key={`${s.opportunityId}-${i}`} title={s.notes}>
                            <td className="muted">{ago(s.createdAtMs)}</td>
                            <td style={{color: STRATEGY_COLOR[s.strategy]}}>{s.strategy}</td>
                            <td className="muted">{s.backend}</td>
                            <td style={{textAlign: "right"}}>{s.gasUsed.toLocaleString()}</td>
                            <td style={{textAlign: "right"}}>{weiToEth(s.grossWei, 5)}</td>
                            <td style={{textAlign: "right"}} className={BigInt(s.netWei) >= 0n ? "pos" : "neg"}>{signedEth(s.netWei)}</td>
                            <td>
                              {link && victim ? (
                                <a href={link} target="_blank" rel="noreferrer" title={`victim tx ${victim} — view on the block explorer`} className="no-underline">{shortHash(victim, 4)} ↗</a>
                              ) : <span className="muted">—</span>}
                            </td>
                            <td className={s.success ? "pos" : "muted"}><SimVerdict success={s.success} revertReason={s.revertReason} /></td>
                          </tr>
                        );
                      })}
                      {!filteredSims.length && <tr><td colSpan={8} className="muted text-center py-8">no simulations yet</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </Section>

          {/* ── opportunities + relay payloads ──────────────────────── */}
          <Section id="history" icon="table" title="Simulated transactions & opportunities" subtitle="newest first · plus relay payload prices">
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
              <div className="panel xl:col-span-2">
                <div className="panel-head"><span className="flex items-center gap-2"><Icon name="table" size={14} /> opportunities found</span></div>
                <div style={{maxHeight: 320, overflowY: "auto"}}>
                  <table className="grid">
                    <thead>
                      <tr>
                        <th>age</th>
                        <th>strategy</th>
                        <th style={{textAlign: "right"}}>expected</th>
                        <th style={{textAlign: "right"}}>notional</th>
                        <th>block</th>
                        <th>victim</th>
                        <th>notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {opps.map((o) => {
                        const victim = o.victims ? o.victims.split(",")[0] : null;
                        const victimLink = txUrl(chainId, victim);
                        const blockLink = blockUrl(chainId, o.targetBlock);
                        return (
                          <tr key={o.id}>
                            <td className="muted">{ago(o.createdAtMs)}</td>
                            <td style={{color: STRATEGY_COLOR[o.strategy]}}>{o.strategy}</td>
                            <td style={{textAlign: "right"}}>{weiToEth(o.expectedWei, 5)}</td>
                            <td style={{textAlign: "right"}}>{weiToEth(o.notionalWei, 3)}</td>
                            <td className="muted">
                              {blockLink ? <a href={blockLink} target="_blank" rel="noreferrer" title="view this block on the explorer">{o.targetBlock}</a> : o.targetBlock}
                            </td>
                            <td className="muted">
                              {victimLink && victim ? <a href={victimLink} target="_blank" rel="noreferrer" title={`victim tx ${victim}`} className="no-underline">{shortHash(victim)} ↗</a> : o.victims ? shortHash(victim) : "—"}
                            </td>
                            <td className="muted" style={{maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis"}} title={o.notes}>{o.notes}</td>
                          </tr>
                        );
                      })}
                      {!opps.length && <tr><td colSpan={7} className="muted text-center py-8">nothing yet</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="panel">
                <div className="panel-head"><span className="flex items-center gap-2"><Icon name="layers" size={14} /> relay payloads delivered</span></div>
                <div style={{maxHeight: 320, overflowY: "auto"}}>
                  <table className="grid">
                    <thead>
                      <tr>
                        <th>slot</th>
                        <th>relay</th>
                        <th style={{textAlign: "right"}}>value ETH</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bids.map((b) => (
                        <tr key={`${b.relay}-${b.slot}`}>
                          <td className="muted">{b.slot}</td>
                          <td>{safeHost(b.relay)}</td>
                          <td style={{textAlign: "right"}}>{weiToEth(b.valueWei, 4)}</td>
                        </tr>
                      ))}
                      {!bids.length && <tr><td colSpan={3} className="muted text-center py-8">no relay data</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </Section>

          <Section id="validation" icon="shield" title="Validation — latency & on-chain evidence" subtitle="decision-time simulations vs canonical blocks">
            <Phase1Panel latency={status?.latency} competition={competition} actualMev={actualMev} executions={executions} reorgs={reorgs} />
          </Section>

          <Section id="relay" icon="layers" title="Relay — delivered blocks" subtitle="what MEV sold for, block by block" defaultOpen={false}>
            <RelayBlocksPanel chainId={chainId} />
          </Section>

          <Section id="funnel" icon="activity" title="Strategy funnel" subtitle="why no opportunities? — with data">
            <FunnelPanel
              funnel={status?.stats.funnel ?? null}
              funnelReplay={status?.stats.funnelReplay ?? null}
              pendingSeen={status?.stats.pendingSeen ?? 0}
              hintsSeen={status?.stats.hintsSeen ?? 0}
              startedAtMs={status?.stats.startedAtMs}
              chainId={status?.chain.id}
            />
          </Section>

          <Section id="risk" icon="shield" title="Risk & strategy controls" subtitle="applies instantly — no restart">
            <RiskPanel killSwitchTripped={status?.risk.killSwitchTripped} />
          </Section>

          <Section
            id="golive"
            icon="send"
            title="Production go-live wizard · deploy & arm independently"
            subtitle="five-card wallet, executor, funding, pre-flight & live controls · docs/GO_LIVE.md"
            defaultOpen={false}
          >
            <div className="grid gap-3">
              <QualificationReport qualification={status?.qualification} />
              <EligibilityPanel enabled={status?.strategies} />
              <GoLivePanel executor={status?.executor ?? ""} armed={status?.liveArmed} chainId={chainId} />
            </div>
          </Section>

          <Section id="executor" icon="wallet" title="MevExecutor — on-chain control" subtitle={status ? shortHash(status.executor, 8) : "—"}>
            <ContractPanel executor={status?.executor ?? ""} chainId={chainId} />
          </Section>

          <footer className="rounded-2xl border border-[var(--line-soft)] bg-[var(--bg-subtle)] px-4 py-3 text-[11.5px] leading-relaxed text-[var(--muted)]">
            Broadcasting is disabled by default and stays fail-closed unless every arming, risk, inventory, and strategy qualification gate passes. See{" "}
            <code>docs/GO_LIVE.md</code> and <code>docs/RISK.md</code>. CoW orders are signed EIP-712 against the canonical CoW settlement contract, verified uid on return, and reconciled to fills — cancelled orders invalidate on-close, not in a cache.
          </footer>
        </div>
      </main>
    </div>
  );
}

function Card({children, xl, className}: {children: React.ReactNode; xl?: boolean; className?: string}) {
  return <div className={`panel min-w-0 ${className ?? ""}`}>{children}</div>;
}

function Banner({tone, icon, children}: {tone: "warn" | "neg"; icon: string; children: React.ReactNode}) {
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-xl border px-4 py-3 text-[12.5px]"
      style={{borderColor: `var(--${tone})`, background: `var(--${tone}-soft)`, color: `var(--${tone})`}}
    >
      <Icon name={icon} size={15} className="mt-0.5 flex-none" />
      <span>{children}</span>
    </div>
  );
}

function SimVerdict({success, revertReason}: {success: boolean; revertReason: string | null}) {
  if (success) return <>profitable</>;
  const reason = revertReason ?? "no edge";
  if (reason.startsWith("uncertified accounting")) {
    return <span style={{color: "var(--warn)"}} title={reason}>uncertified</span>;
  }
  return <span title={reason.length > 40 ? reason : undefined}>{reason.length > 40 ? `${reason.slice(0, 39)}…` : reason}</span>;
}

function QualificationReport({qualification}: {qualification: StatusResponse["qualification"]}) {
  const rows = qualification?.strategies ?? [];
  const comparisonLabel = qualification?.comparisonBackend === "sequencer" ? "independent state" : "relay";
  return (
    <div className="panel">
      <div className="panel-head">
        <span>
          strategy qualification
          {qualification?.comparisonBackend && <span className="muted ml-2">backend: {qualification.comparisonBackend}</span>}
        </span>
        <span className={qualification?.pass ? "pos" : "muted"} style={{fontSize: 12}}>
          {qualification ? `${qualification.elapsedHours}/${qualification.requiredHours}h · max gap ${qualification.maximumObservationGapSecs}s` : "waiting for bot"}
        </span>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>strategy</th>
            <th>verdict</th>
            <th style={{textAlign: "right"}}>fork</th>
            <th style={{textAlign: "right"}}>{comparisonLabel}</th>
            <th style={{textAlign: "right"}}>actual</th>
            <th style={{textAlign: "right"}}>{comparisonLabel} accuracy</th>
            <th style={{textAlign: "right"}}>actual accuracy</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.strategy} title={row.reasons.join("; ")}>
              <td>{STRATEGY_LABEL[row.strategy] ?? row.strategy}</td>
              <td className={row.verdict === "PASS" ? "pos" : row.verdict === "FAIL" ? "neg" : "muted"}>{row.verdict}</td>
              <td style={{textAlign: "right"}}>{row.forkSamples}</td>
              <td style={{textAlign: "right"}}>{row.independentComparisons ?? row.relayComparisons}</td>
              <td style={{textAlign: "right"}}>{row.actualComparisons}</td>
              <td style={{textAlign: "right"}}>{(row.relayAccuracyBps / 100).toFixed(1)}%</td>
              <td style={{textAlign: "right"}}>{(row.actualAccuracyBps / 100).toFixed(1)}%</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={7} className="muted text-center py-6">no qualification report yet</td></tr>}
        </tbody>
      </table>
      {(qualification?.reasons ?? []).map((reason) => (
        <div key={reason} className="muted px-4 pb-3 text-[11px]">• {reason}</div>
      ))}
    </div>
  );
}

function keepIfSame<T>(prev: T, next: T): T {
  try {
    return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
  } catch {
    return next;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return url;
  }
}

function HeadStat({label, value, warn}: {label: string; value: string; warn?: boolean}) {
  return (
    <div className="flex flex-col items-end">
      <span className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">{label}</span>
      <span className="text-[12.5px] font-semibold tabular-nums" style={{color: warn ? "var(--danger)" : "var(--text)"}}>{value}</span>
    </div>
  );
}