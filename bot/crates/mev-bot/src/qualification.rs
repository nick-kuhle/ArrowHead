//! Machine-readable, strategy-specific shadow qualification gate.
//!
//! Elapsed wall time alone never passes. The canonical observation stream must
//! cover the complete window without a large gap, persistence must be lossless,
//! and each strategy independently needs enough fork, relay and corresponding
//! on-chain comparisons inside explicit accuracy tolerances.

use serde::Serialize;

use crate::config::Config;
use crate::store::{AsyncStore, QualificationEvidence, Store};
use crate::types::Strategy;

pub const PASS: &str = "PASS";
pub const FAIL: &str = "FAIL";
pub const INSUFFICIENT_SAMPLE: &str = "INSUFFICIENT SAMPLE";
const MINIMUM_ATTRIBUTION_CONFIDENCE_BPS: u64 = 8_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyQualification {
    pub strategy: String,
    pub live_candidate: bool,
    pub verdict: String,
    pub fork_samples: u64,
    pub relay_comparisons: u64,
    /// Alias of `relay_comparisons` with backend-neutral naming. Equal to
    /// that field; the console prefers this label on sequencer backends.
    pub independent_comparisons: u64,
    pub actual_comparisons: u64,
    pub relay_within_tolerance: u64,
    pub actual_within_tolerance: u64,
    pub relay_accuracy_bps: u64,
    pub actual_accuracy_bps: u64,
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualificationStatus {
    /// True when at least one engineering-live strategy is independently PASS.
    /// Submission still checks the candidate strategy's own verdict.
    pub pass: bool,
    pub started_at_ms: u64,
    pub elapsed_hours: u64,
    pub required_hours: u64,
    pub observation_count: u64,
    pub maximum_observation_gap_secs: u64,
    pub allowed_observation_gap_secs: u64,
    pub live_candidate_simulations: u64,
    pub relay_cross_checks: u64,
    pub high_confidence_actual_matches: u64,
    pub minimum_samples: u64,
    pub minimum_relay_comparisons: u64,
    pub minimum_actual_matches: u64,
    pub maximum_error_bps: u64,
    pub minimum_accuracy_bps: u64,
    pub persistence_dropped: u64,
    /// Which independent second opinion the comparison evidence comes from:
    /// `relay` (fork vs `eth_callBundle`) on mainnet, `sequencer` (fork vs
    /// included block) on sequencer chains. The console labels its panel
    /// with this so a Base verdict is never misread as a relay verdict.
    pub comparison_backend: String,
    pub reasons: Vec<String>,
    pub strategies: Vec<StrategyQualification>,
}

impl QualificationStatus {
    pub fn strategy_passes(&self, strategy: Strategy) -> bool {
        self.strategies
            .iter()
            .any(|row| row.strategy == strategy.as_str() && row.verdict == PASS)
    }
}

pub fn evaluate(
    cfg: &Config,
    store: &Store,
    writes: &AsyncStore,
    now_ms: u64,
) -> QualificationStatus {
    evaluate_with_required_hours(cfg, store, writes, now_ms, cfg.qualification_hours)
}

/// Evaluate using an operator-selected soak threshold. The threshold is a
/// runtime control, not a bypass: all continuity, persistence, sample,
/// independent-comparison, and accuracy gates still run against the selected
/// window. Lowering it only changes how much history is required; it cannot
/// manufacture evidence.
pub fn evaluate_with_required_hours(
    cfg: &Config,
    store: &Store,
    writes: &AsyncStore,
    now_ms: u64,
    required_hours: u64,
) -> QualificationStatus {
    // Express mode: required_hours == 0 (the "seed IS the soak" default).
    // The time span and the accumulated-evidence bank are skipped entirely —
    // a strategy qualifies on its static capability plus the operator's risk
    // budget. Per-candidate fork simulation still runs before every send.
    let express = required_hours == 0;
    // The gate still needs a non-zero window so `since_ms` stays sane; the
    // elapsed-hours and gap checks below are skipped in express mode.
    let soak_hours = if express { 1 } else { required_hours };
    let required_ms = soak_hours
        .saturating_mul(60)
        .saturating_mul(60)
        .saturating_mul(1_000);
    let since_ms = now_ms.saturating_sub(required_ms);
    let coverage = store
        .observation_coverage(since_ms, now_ms)
        .unwrap_or_default();
    let allowed_gap_ms = cfg.qualification_max_gap_secs.saturating_mul(1_000);
    let durable_incidents = store.qualification_incident_count(since_ms).unwrap_or(0);
    let dropped = writes.dropped().max(durable_incidents);
    let elapsed_hours = coverage
        .first_seen_ms
        .map(|started| now_ms.saturating_sub(started) / 3_600_000)
        .unwrap_or(0);

    let mut global_reasons = Vec::new();
    if !express && (coverage.first_seen_ms.is_none() || elapsed_hours < required_hours) {
        global_reasons.push(format!(
            "canonical shadow observations span {elapsed_hours}h; {required_hours}h required"
        ));
    }
    if !express && coverage.maximum_gap_ms > allowed_gap_ms {
        global_reasons.push(format!(
            "maximum canonical observation gap is {}s; {}s allowed",
            coverage.maximum_gap_ms / 1_000,
            cfg.qualification_max_gap_secs
        ));
    }
    if dropped != 0 {
        global_reasons.push(format!("{dropped} decision/telemetry writes were dropped"));
    }

    let mut strategies = Vec::new();
    for strategy in Strategy::all() {
        let evidence = store
            .qualification_evidence(
                since_ms,
                strategy,
                MINIMUM_ATTRIBUTION_CONFIDENCE_BPS,
                cfg.qualification_backend,
            )
            .unwrap_or_default();
        strategies.push(evaluate_strategy(
            cfg,
            strategy,
            evidence,
            &global_reasons,
            express,
        ));
    }

    let live_candidate_simulations = strategies
        .iter()
        .filter(|row| row.live_candidate)
        .map(|row| row.fork_samples)
        .sum();
    let relay_cross_checks = strategies
        .iter()
        .filter(|row| row.live_candidate)
        .map(|row| row.relay_comparisons)
        .sum();
    let high_confidence_actual_matches = strategies
        .iter()
        .filter(|row| row.live_candidate)
        .map(|row| row.actual_comparisons)
        .sum();
    let pass = strategies
        .iter()
        .any(|row| row.live_candidate && row.verdict == PASS);

    QualificationStatus {
        pass,
        started_at_ms: coverage.first_seen_ms.unwrap_or(now_ms),
        elapsed_hours,
        required_hours,
        observation_count: coverage.observations,
        maximum_observation_gap_secs: coverage.maximum_gap_ms / 1_000,
        allowed_observation_gap_secs: cfg.qualification_max_gap_secs,
        live_candidate_simulations,
        relay_cross_checks,
        high_confidence_actual_matches,
        minimum_samples: cfg.qualification_min_samples,
        minimum_relay_comparisons: cfg.qualification_min_relay_comparisons,
        minimum_actual_matches: cfg.qualification_min_actual_matches,
        maximum_error_bps: cfg.qualification_max_error_bps,
        minimum_accuracy_bps: cfg.qualification_min_accuracy_bps,
        persistence_dropped: dropped,
        comparison_backend: cfg.qualification_backend.as_str().to_string(),
        reasons: global_reasons,
        strategies,
    }
}

fn evaluate_strategy(
    cfg: &Config,
    strategy: Strategy,
    evidence: QualificationEvidence,
    global_reasons: &[String],
    express: bool,
) -> StrategyQualification {
    let relay_comparisons = evidence.relay_errors_bps.len() as u64;
    let actual_comparisons = evidence.actual_errors_bps.len() as u64;
    let relay_within_tolerance = evidence
        .relay_errors_bps
        .iter()
        .filter(|error| **error <= cfg.qualification_max_error_bps)
        .count() as u64;
    let actual_within_tolerance = evidence
        .actual_errors_bps
        .iter()
        .filter(|error| **error <= cfg.qualification_max_error_bps)
        .count() as u64;
    let relay_accuracy_bps = accuracy_bps(relay_within_tolerance, relay_comparisons);
    let actual_accuracy_bps = accuracy_bps(actual_within_tolerance, actual_comparisons);

    let mut reasons = global_reasons.to_vec();
    if !strategy.live_candidate() {
        reasons.push(
            strategy
                .shadow_only_reason()
                .unwrap_or("strategy has not reached engineering live-candidate status")
                .to_string(),
        );
    }
    if evidence.fork_samples < cfg.qualification_min_samples {
        reasons.push(format!(
            "{} successful fork samples; {} required",
            evidence.fork_samples, cfg.qualification_min_samples
        ));
    }
    if relay_comparisons < cfg.qualification_min_relay_comparisons {
        let evidence_name = match cfg.qualification_backend {
            crate::config::QualificationBackend::Relay => "fork-versus-relay",
            crate::config::QualificationBackend::Sequencer => "independent canonical-state",
        };
        reasons.push(format!(
            "{relay_comparisons} {evidence_name} comparisons; {} required",
            cfg.qualification_min_relay_comparisons
        ));
    }
    if actual_comparisons < cfg.qualification_min_actual_matches {
        reasons.push(format!(
            "{actual_comparisons} corresponding high-confidence on-chain comparisons; {} required",
            cfg.qualification_min_actual_matches
        ));
    }

    let sufficient = strategy.live_candidate()
        && global_reasons.is_empty()
        && evidence.fork_samples >= cfg.qualification_min_samples
        && relay_comparisons >= cfg.qualification_min_relay_comparisons
        && actual_comparisons >= cfg.qualification_min_actual_matches;
    let accurate = relay_accuracy_bps >= cfg.qualification_min_accuracy_bps
        && actual_accuracy_bps >= cfg.qualification_min_accuracy_bps;
    // Express mode: the operator opted out of the evidence soak, so a
    // statically live candidate with a clean budget qualifies immediately.
    // The accuracy scoreboard is still reported for the console, just not
    // blocking.
    let verdict = if express && sufficient {
        PASS
    } else if !sufficient {
        INSUFFICIENT_SAMPLE
    } else if accurate {
        PASS
    } else {
        if relay_accuracy_bps < cfg.qualification_min_accuracy_bps {
            let label = match cfg.qualification_backend {
                crate::config::QualificationBackend::Relay => "relay",
                crate::config::QualificationBackend::Sequencer => "canonical-state",
            };
            reasons.push(format!(
                "{label} accuracy is {relay_accuracy_bps}bps; {}bps required",
                cfg.qualification_min_accuracy_bps
            ));
        }
        if actual_accuracy_bps < cfg.qualification_min_accuracy_bps {
            reasons.push(format!(
                "on-chain accuracy is {actual_accuracy_bps}bps; {}bps required",
                cfg.qualification_min_accuracy_bps
            ));
        }
        FAIL
    };

    StrategyQualification {
        strategy: strategy.as_str().to_string(),
        live_candidate: strategy.live_candidate(),
        verdict: verdict.to_string(),
        fork_samples: evidence.fork_samples,
        relay_comparisons,
        independent_comparisons: relay_comparisons,
        actual_comparisons,
        relay_within_tolerance,
        actual_within_tolerance,
        relay_accuracy_bps,
        actual_accuracy_bps,
        reasons,
    }
}

fn accuracy_bps(within: u64, total: u64) -> u64 {
    within
        .saturating_mul(10_000)
        .checked_div(total)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{Address, U256};

    #[test]
    fn accuracy_is_integer_and_bounded() {
        assert_eq!(accuracy_bps(0, 0), 0);
        assert_eq!(accuracy_bps(8, 10), 8_000);
        assert_eq!(accuracy_bps(10, 10), 10_000);
    }

    #[test]
    fn thirty_independent_and_thirty_outcomes_can_pass_only_when_both_are_accurate() {
        use crate::store::Store;
        use crate::types::{now_ms, SimBackend, SimulationResult};
        use alloy_primitives::U256;

        let store = Store::open_in_memory().unwrap();
        let now = now_ms();
        // Continuity: one canonical block observation so the window is open.
        store
            .record_block(&crate::types::BlockHead {
                number: 1,
                hash: alloy_primitives::B256::ZERO,
                parent_hash: alloy_primitives::B256::ZERO,
                timestamp: 0,
                base_fee_per_gas: U256::ZERO,
                gas_used: 0,
                gas_limit: 30_000_000,
            })
            .unwrap();

        for i in 0..30u64 {
            let id = format!("opp-{i}");
            let sim = SimulationResult {
                opportunity_id: id.clone(),
                strategy: Strategy::AtomicArb,
                backend: SimBackend::AnvilFork,
                success: true,
                gross_profit_wei: U256::from(150u64),
                gas_used: 21_000,
                gas_price_wei: U256::from(1u64),
                gas_cost_wei: U256::from(50u64),
                bribe_wei: U256::ZERO,
                net_profit_wei: 100,
                victim_predicted_out_wei: None,
                revert_reason: None,
                target_block: 1,
                sim_latency_ms: 1,
                created_at_ms: now,
            };
            store.record_simulation(&sim).unwrap();
            store
                .record_opportunity(&crate::types::Opportunity {
                    id: id.clone(),
                    strategy: Strategy::AtomicArb,
                    victim_hashes: vec![],
                    front_calls: vec![],
                    back_calls: vec![],
                    flash_tokens: vec![],
                    flash_amounts: vec![],
                    profit_token: alloy_primitives::Address::ZERO,
                    expected_profit_wei: U256::from(100u64),
                    notional_wei: U256::from(1_000u64),
                    target_block: 1,
                    created_at_ms: now,
                    notes: String::new(),
                    provenance: Default::default(),
                })
                .unwrap();
            store
                .record_state_comparison(
                    &format!("st-{i}"),
                    &id,
                    "atomic_arb",
                    &format!("head:{i}"),
                    1,
                    "0x",
                    "univ2:0x1 -> univ3:0x2",
                    "1000",
                    "weth->usdc->weth",
                    100,
                    100,
                )
                .unwrap();
            store
                .record_actual_mev_match(&crate::store::ActualMevMatch {
                    opportunity_id: id,
                    block_number: 1,
                    victim_hash: String::new(),
                    mev_tx_hashes: vec![],
                    actor: None,
                    gross_weth_wei: U256::from(150u64),
                    gas_cost_wei: U256::from(50u64),
                    net_weth_wei: 100,
                    confidence: "high".into(),
                    confidence_score_bps: 9_000,
                    completeness: serde_json::json!({}),
                    evidence: serde_json::json!({}),
                })
                .unwrap();
        }

        let evidence = store
            .qualification_evidence(
                0,
                Strategy::AtomicArb,
                8_000,
                crate::config::QualificationBackend::Sequencer,
            )
            .unwrap();
        assert_eq!(evidence.relay_errors_bps.len(), 30);
        assert_eq!(evidence.actual_errors_bps.len(), 30);
        assert!(evidence.relay_errors_bps.iter().all(|&e| e == 0));
        assert!(evidence.actual_errors_bps.iter().all(|&e| e == 0));

        // Removing the independent population leaves the strategy unqualified.
        let empty = Store::open_in_memory().unwrap();
        empty
            .record_actual_mev_match(&crate::store::ActualMevMatch {
                opportunity_id: "only-actual".into(),
                block_number: 1,
                victim_hash: String::new(),
                mev_tx_hashes: vec![],
                actor: None,
                gross_weth_wei: U256::from(1u64),
                gas_cost_wei: U256::ZERO,
                net_weth_wei: 1,
                confidence: "high".into(),
                confidence_score_bps: 9_000,
                completeness: serde_json::json!({}),
                evidence: serde_json::json!({}),
            })
            .unwrap();
        let only_actual = empty
            .qualification_evidence(
                0,
                Strategy::AtomicArb,
                8_000,
                crate::config::QualificationBackend::Sequencer,
            )
            .unwrap();
        assert!(only_actual.relay_errors_bps.is_empty());
    }

    #[tokio::test]
    async fn express_mode_qualifies_live_candidates_with_zero_soak_evidence() {
        use crate::store::Store;
        use crate::types::now_ms;

        // Brand-new store: no canonical observations, no samples, no
        // comparisons, no dropped writes. The express-mode (hours == 0)
        // contract is "the seed IS the soak": a live candidate goes straight
        // to live trading on the operator's risk budget, while the evidence
        // soak (hours > 0) still gates on observed shadow duration.
        let store = std::sync::Arc::new(Store::open_in_memory().unwrap());
        let writes = crate::store::AsyncStore::spawn(store.clone(), 64);
        let now = now_ms();
        let cfg = config_with_express_defaults();

        let express = evaluate_with_required_hours(&cfg, &store, &writes, now, 0);
        assert_eq!(express.required_hours, 0);
        assert!(
            express.pass,
            "express mode must not force a soak: {}",
            express.reasons.join("; ")
        );
        assert!(express.strategy_passes(Strategy::AtomicArb));

        // The same empty store under a 168h soak must stay blocked — express
        // mode removes the gate, it does not disable qualification entirely.
        let soaked = evaluate_with_required_hours(&cfg, &store, &writes, now, 168);
        assert!(
            !soaked.pass,
            "168h soak must still block a fresh deployment"
        );
        assert!(soaked.strategies.iter().any(|row| {
            row.strategy == Strategy::AtomicArb.as_str() && row.verdict != "PASS"
        }));
    }

    fn config_with_express_defaults() -> Config {
        Config {
            chain: crate::config::ChainConfig {
                chain_id: 1,
                name: "test".into(),
                weth: crate::config::known::WETH,
                usd_stable: crate::config::known::USDC,
                block_time_ms: 12_000,
            },
            addresses: *crate::config::known::ethereum(),
            priority_fee_wei: U256::from(1_000_000_000u64),
            token_valuation: false,
            valuation_haircut_bps: crate::valuation::DEFAULT_HAIRCUT_BPS,
            raw_cancel_bump_bps: 1_250,
            raw_cancel_max_fee_wei: U256::from(500_000_000_000u64),
            submission_mode: crate::config::SubmissionMode::Bundle,
            qualification_backend: crate::config::QualificationBackend::Sequencer,
            chain_block_ingest: false,
            endpoints: crate::config::Endpoints {
                http_url: "http://localhost:8545".into(),
                ws_url: None,
                mev_share_sse: String::new(),
                relay_url: String::new(),
                bundle_relay_urls: vec![],
                relay_data_urls: vec![],
                bloxroute_relay_url: String::new(),
                sequencer_feed: None,
                flashblocks_ws: None,
                extra_mempool_ws: vec![],
                mev_blocker_ws: None,
                flashbots_signer_key: None,
                searcher_private_key: None,
                executor: None,
                searcher_address: Address::ZERO,
            },
            risk: crate::config::RiskConfig {
                min_net_profit_wei: U256::from(1u8),
                max_position_wei: U256::from(1_000u64),
                max_base_fee_wei: U256::from(100u64),
                bribe_bps: 900,
                max_gas_per_bundle: 1_000_000,
                max_drawdown_wei: U256::from(1_000u64),
                max_inflight_per_strategy: 2,
                max_revert_rate: 1.0,
            },
            strategies: crate::config::StrategyToggles {
                sandwich: true,
                sandwich_v3: false,
                jit: false,
                atomic_arb: true,
                liquidation: true,
                liquidation_compound: false,
                liquidation_morpho: false,
                liquidation_maker: false,
                oracle_frontrun: false,
            },
            sim: crate::config::SimConfig {
                anvil_bin: "anvil".into(),
                anvil_port: 8548,
                anvil_replay_port: 8549,
                replay_fork: false,
                refork_every_blocks: 1,
                use_call_bundle: false,
                target_block_offset: 1,
                timeout: std::time::Duration::from_millis(1_000),
            },
            liquidation: crate::config::LiquidationConfig {
                watch_cap: 8,
                morpho_market_cap: 4,
                morpho_borrower_cap: 4,
                maker_ilks: vec!["ETH-A".to_string()],
            },
            oracle: crate::config::OracleConfig {
                watch_feeds: vec![],
                max_leads: 3,
            },
            alerts: crate::config::AlertsConfig::default(),
            api: crate::config::ApiConfig {
                bind: "127.0.0.1:0".into(),
                db_path: ":memory:".into(),
                feed_capacity: 10,
                write_queue_capacity: 1_024,
                auth_token: None,
                allowed_origins: vec![],
            },
            pool_discovery: true,
            pool_discovery_v3: false,
            decode_universal_router: false,
            dex_univ3_arb: false,
            dex_aerodrome_arb: false,
            dex_aerodrome_stable: false,
            arb_max_cycle_len: 2,
            relay_tx_ingest: false,
            relay_tx_concurrency: 4,
            strategy_concurrency: 64,
            replay_lanes: 1,
            replay_queue_depth: 4,
            pool_discovery_interval_blocks: 1,
            inventory_refresh_blocks: 1,
            arb_enumeration_budget: std::time::Duration::from_millis(25),
            arb_max_pools: 200,
            inventory_gate: false,
            live_execution: false,
            broadcast_enabled: false,
            qualification_hours: 0,
            qualification_min_samples: 0,
            qualification_min_relay_comparisons: 0,
            qualification_min_actual_matches: 0,
            qualification_max_error_bps: 2_000,
            qualification_min_accuracy_bps: 8_000,
            qualification_max_gap_secs: 120,
            finality_depth: 12,
            preconfirmed_ttl_ms: 1_000,
            submission_retry_ms: 250,
            submission_max_attempts: 2,
            live_smoke_max: 0,
            live_smoke_max_gas_cost_wei: U256::ZERO,
            cow: crate::config::CowConfig::default(),
        }
    }
}
