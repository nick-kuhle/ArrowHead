//! CoW-style shadow auction scoring.
//!
//! This is deliberately an optimizer boundary, not a settlement adapter. It
//! scores already-constructed candidate fills against the auction's directed
//! pair references, prices gas and expected revert loss, rejects duplicate
//! orders, and refuses unfair batches before any protocol submission exists.

use std::collections::{BTreeMap, BTreeSet};

use alloy_primitives::{Address, B256, U256};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

/// A directed token pair key. Direction matters in CoW's fairness comparison.
pub fn pair_key(sell_token: Address, buy_token: Address) -> String {
    format!("{sell_token:?}->{buy_token:?}").to_lowercase()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CowAuction {
    pub id: String,
    pub deadline_ms: u64,
    #[serde(default)]
    pub pair_references: BTreeMap<String, U256>,
    pub orders: Vec<CowAuctionOrder>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CowAuctionOrder {
    pub uid: B256,
    pub owner: Address,
    pub sell_token: Address,
    pub buy_token: Address,
    pub remaining_sell_amount: U256,
    pub minimum_buy_amount: U256,
    pub partially_fillable: bool,
}

/// A candidate produced by a route search. Route construction is intentionally
/// separate: a route must be simulated before it can be represented here.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CowFillCandidate {
    pub order_uid: B256,
    pub sell_token: Address,
    pub buy_token: Address,
    pub surplus_wei: U256,
    pub gas_cost_wei: U256,
    /// Conservative probability that the exact settlement reverts, in bps.
    pub revert_risk_bps: u16,
    /// Score before gas and expected revert loss. This is the value compared
    /// against the auction's directed-pair reference.
    pub pair_score_wei: U256,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CowShadowScore {
    pub auction_id: String,
    pub accepted: bool,
    pub fairness_self_rejected: bool,
    pub order_count: usize,
    pub gross_surplus_wei: U256,
    pub gas_cost_wei: U256,
    pub expected_revert_loss_wei: U256,
    pub cost_adjusted_score_wei: U256,
    pub reason: Option<String>,
}

fn expected_revert_loss(surplus: U256, risk_bps: u16) -> U256 {
    surplus * U256::from(risk_bps) / U256::from(10_000u64)
}

/// Evaluate a batch against the current CoW-style fairness and cost rules.
///
/// The function never returns an executable settlement payload. A successful
/// result only means the proposed fills survived local shadow scoring; exact
/// fork simulation and protocol settlement validation remain mandatory.
pub fn score_shadow_solution(
    auction: &CowAuction,
    candidates: &[CowFillCandidate],
) -> Result<CowShadowScore> {
    if candidates.is_empty() {
        bail!("auction has no proposed fills");
    }
    if auction.id.trim().is_empty() {
        bail!("auction id is empty");
    }
    let mut seen = BTreeSet::new();
    let mut gross = U256::ZERO;
    let mut gas = U256::ZERO;
    let mut revert_loss = U256::ZERO;
    let mut score = U256::ZERO;

    for candidate in candidates {
        if !seen.insert(candidate.order_uid) {
            bail!("order appears more than once in solution");
        }
        if candidate.sell_token == candidate.buy_token {
            bail!("solution contains a self-pair");
        }
        if candidate.revert_risk_bps > 10_000 {
            bail!("revert risk exceeds 10000 bps");
        }
        let key = pair_key(candidate.sell_token, candidate.buy_token);
        if let Some(reference) = auction.pair_references.get(&key) {
            if candidate.pair_score_wei < *reference {
                return Ok(CowShadowScore {
                    auction_id: auction.id.clone(),
                    accepted: false,
                    fairness_self_rejected: true,
                    order_count: candidates.len(),
                    gross_surplus_wei: gross,
                    gas_cost_wei: gas,
                    expected_revert_loss_wei: revert_loss,
                    cost_adjusted_score_wei: score,
                    reason: Some(format!("pair {key} is below the local reference")),
                });
            }
        }
        let loss = expected_revert_loss(candidate.surplus_wei, candidate.revert_risk_bps);
        gross += candidate.surplus_wei;
        gas += candidate.gas_cost_wei;
        revert_loss += loss;
        score += candidate
            .surplus_wei
            .saturating_sub(candidate.gas_cost_wei)
            .saturating_sub(loss);
    }

    if score.is_zero() {
        return Ok(CowShadowScore {
            auction_id: auction.id.clone(),
            accepted: false,
            fairness_self_rejected: false,
            order_count: candidates.len(),
            gross_surplus_wei: gross,
            gas_cost_wei: gas,
            expected_revert_loss_wei: revert_loss,
            cost_adjusted_score_wei: score,
            reason: Some("cost-adjusted score is not positive".into()),
        });
    }
    Ok(CowShadowScore {
        auction_id: auction.id.clone(),
        accepted: true,
        fairness_self_rejected: false,
        order_count: candidates.len(),
        gross_surplus_wei: gross,
        gas_cost_wei: gas,
        expected_revert_loss_wei: revert_loss,
        cost_adjusted_score_wei: score,
        reason: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn order() -> CowAuctionOrder {
        CowAuctionOrder {
            uid: B256::repeat_byte(1),
            owner: Address::repeat_byte(3),
            sell_token: Address::repeat_byte(4),
            buy_token: Address::repeat_byte(5),
            remaining_sell_amount: U256::from(100u64),
            minimum_buy_amount: U256::from(90u64),
            partially_fillable: false,
        }
    }

    fn candidate() -> CowFillCandidate {
        CowFillCandidate {
            order_uid: B256::repeat_byte(1),
            sell_token: Address::repeat_byte(4),
            buy_token: Address::repeat_byte(5),
            surplus_wei: U256::from(100u64),
            gas_cost_wei: U256::from(10u64),
            revert_risk_bps: 1_000,
            pair_score_wei: U256::from(100u64),
        }
    }

    #[test]
    fn rejects_a_candidate_below_the_directed_pair_reference() {
        let mut references = BTreeMap::new();
        references.insert(pair_key(Address::repeat_byte(4), Address::repeat_byte(5)), U256::from(101u64));
        let auction = CowAuction { id: "a1".into(), deadline_ms: 1, pair_references: references, orders: vec![order()] };
        let result = score_shadow_solution(&auction, &[candidate()]).unwrap();
        assert!(!result.accepted);
        assert!(result.fairness_self_rejected);
    }

    #[test]
    fn prices_gas_and_revert_risk_before_accepting() {
        let auction = CowAuction { id: "a1".into(), deadline_ms: 1, pair_references: BTreeMap::new(), orders: vec![order()] };
        let result = score_shadow_solution(&auction, &[candidate()]).unwrap();
        assert!(result.accepted);
        assert_eq!(result.gross_surplus_wei, U256::from(100u64));
        assert_eq!(result.gas_cost_wei, U256::from(10u64));
        assert_eq!(result.expected_revert_loss_wei, U256::from(10u64));
        assert_eq!(result.cost_adjusted_score_wei, U256::from(80u64));
    }

    #[test]
    fn duplicate_orders_are_rejected() {
        let auction = CowAuction { id: "a1".into(), deadline_ms: 1, pair_references: BTreeMap::new(), orders: vec![order()] };
        let error = score_shadow_solution(&auction, &[candidate(), candidate()]).unwrap_err();
        assert!(error.to_string().contains("more than once"));
    }
}
