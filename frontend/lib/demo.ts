/** Small, strategy-neutral fixtures used when the bot API is unavailable. */

const hash = (n: number) => `0x${n.toString(16).padStart(8, "0").repeat(8).slice(0, 64)}`;
const now = () => Date.now();
const strategies = [
  "sandwich", "sandwich_v3", "jit", "atomic_arb", "liquidation",
  "liquidation_compound", "liquidation_morpho", "liquidation_maker", "oracle_frontrun",
];
const emptyFunnel = () => ({invocationsWithOutput: 0, invocationsEmpty: 0, candidatesEmitted: 0, gatedByRisk: 0, missingVictimRaw: 0, simulationsSucceeded: 0, simulationsReverted: 0, simulationsFailed: 0, submittable: 0});
const funnel = () => Object.fromEntries(strategies.map((strategy) => [strategy, emptyFunnel()]));

export function demoStatus(): any {
  return {
    chain: {id: 1, name: "ethereum"},
    head: {number: 23_180_420, hash: hash(9911), baseFeeWei: "8320000000", gasUsed: 16_942_113, timestamp: Math.floor(now() / 1000), ageMs: 3400},
    dataMode: "demo", mode: "simulation", liveArmed: true,
    strategies, risk: {minNetProfitWei: "1", maxPositionWei: "100000000000000000000", maxBaseFeeWei: "500000000000", bribeBps: 9000, killSwitchTripped: false, cumulativeNetWei: "0"},
    executor: "0x00000000000000000000000000000000000e0000", pools: 38,
    stats: {pendingSeen: 0, hintsSeen: 0, blocksSeen: 0, opportunities: 0, simulations: 0, submittable: 0, rejected: 0, reorgsSeen: 0, startedAtMs: now(), funnel: funnel(), funnelReplay: funnel(), sourceFunnels: {}},
    simBackends: {anvilFork: true, relayCallBundle: true}, inventory: {nonce: 0, ethWei: "0", wethWei: "0", availableWei: "0", gate: true}, latency: demoLatency(), demo: true,
  };
}

export function demoLatency(): any { return {budgetMs: 150, withinBudget: true, stages: {}}; }
export function demoCompetition(): any { return {summary: {rows: 0, truePositives: 0, falsePositives: 0, wouldOutbid: 0, victimsLanded: 0, meanInclusionP: 0}, recent: [], demo: true}; }
export function demoReorgs(): any[] { return []; }
export function demoFunnel(): any { return funnel(); }
export function demoFunnelReplay(): any { return funnel(); }
export function demoSeries(limit = 120): any[] { return Array.from({length: limit}, (_, i) => ({block: 23_180_420 - i, netWei: "0", cumulativeWei: "0", createdAtMs: now() - i * 12_000})); }
export function demoOpportunities(limit = 60): any[] { return Array.from({length: Math.min(limit, 0)}, () => ({})); }
export function demoSimulations(limit = 60): any[] { return Array.from({length: Math.min(limit, 0)}, () => ({})); }
export function demoPnl(): any { return {byStrategy: strategies.map((strategy) => ({strategy, simulations: 0, wins: 0, losses: 0, gross_profit_wei: "0", gas_spent_wei: "0", net_profit_wei: "0", best_net_wei: "0", worst_net_wei: "0", avg_latency_ms: 0})), totalNetWei: "0", demo: true}; }
export function demoRelayBids(limit = 25): any[] { return Array.from({length: Math.min(limit, 0)}, () => ({})); }
export function demoRelayBlocks(limit = 25): any[] { return Array.from({length: Math.min(limit, 0)}, () => ({})); }
export function demoRelayTxs(_blockNumber?: number, limit = 25): any[] { return Array.from({length: Math.min(limit, 0)}, () => ({})); }
export function demoEvent(i: number): any { return {kind: "pending", hash: hash(i), from: hash(i + 1).slice(0, 42), to: hash(i + 2).slice(0, 42), value: "0", gas: 0, source: "public_mempool", selector: "0x", seen_at_ms: now()}; }
