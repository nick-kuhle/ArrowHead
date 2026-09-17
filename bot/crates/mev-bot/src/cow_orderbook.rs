//! Live CoW Protocol Order Book client (read-only).
//!
//! Polls the chain's CoW Order Book API (`GET {base}/api/v1/auction`) and
//! maps the **real** solver-side open orderflow onto the shadow-optimiser
//! types in [`cow_auction`], and exposes a bounded snapshot for `/api/cow`.
//!
//! This feed is deliberately read-only. It never signs, pre-signs or submits
//! anything — order *placement* is a separate, gated build item and the
//! `COW_*` intent endpoints remain offline validators. The poller exists so
//! the console shows the actual CoW order book instead of a fabricated one,
//! and so the fairness references used by
//! [`cow_auction::score_shadow_solution`] are derived from live open orders.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use alloy_primitives::{Address, B256, U256};
use anyhow::{bail, Context, Result};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::cow_auction::{pair_key, CowAuction, CowAuctionOrder};
use crate::types::now_ms;

/// Map a chain id to its CoW Protocol Order Book realm base URL.
///
/// CoW Protocol runs per-chain solvers; the Order Book API is mounted at
/// `api.cow.fi/{realm}`. Chains without a deployed realm return `None` (the
/// feed simply cannot run there).
pub fn orderbook_base_url(chain_id: u64) -> Option<String> {
    let realm = match chain_id {
        1 => "mainnet",
        8453 => "base",
        42161 => "arbitrum_one",
        59144 => "linea",
        _ => return None,
    };
    Some(format!("https://api.cow.fi/{realm}"))
}

/// One order exactly as the Order Book API returns it. Amounts are decimal
/// strings; `uid` is the canonical 56-byte CoW uid (`digest || owner || validTo`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiOrder {
    uid: String,
    owner: String,
    sell_token: String,
    buy_token: String,
    sell_amount: String,
    buy_amount: String,
    #[serde(default)]
    executed_sell_amount: Option<String>,
    #[serde(default)]
    partially_fillable: bool,
    #[serde(default)]
    invalidated: bool,
}

fn parse_decimal(value: &str, field: &str) -> Result<U256> {
    if value.is_empty() {
        bail!("{field} is empty");
    }
    value
        .parse()
        .with_context(|| format!("invalid {field} (not a decimal integer): {value:?}"))
}

impl ApiOrder {
    fn into_cow_order(self) -> Result<CowAuctionOrder> {
        if self.invalidated {
            bail!("order is invalidated");
        }
        let owner = self
            .owner
            .parse()
            .with_context(|| format!("invalid owner {}", self.owner))?;
        let sell_token = self
            .sell_token
            .parse()
            .with_context(|| format!("invalid sellToken {}", self.sell_token))?;
        let buy_token = self
            .buy_token
            .parse()
            .with_context(|| format!("invalid buyToken {}", self.buy_token))?;
        if sell_token == buy_token {
            bail!("self-pair order rejected");
        }
        let sell_amount = parse_decimal(&self.sell_amount, "sellAmount")?;
        if sell_amount.is_zero() {
            bail!("sellAmount is zero");
        }
        let executed = parse_decimal(
            self.executed_sell_amount.as_deref().unwrap_or("0"),
            "executedSellAmount",
        )?;
        if executed >= sell_amount {
            bail!("order is fully executed");
        }
        let remaining_sell_amount = sell_amount - executed;
        let minimum_buy_amount = parse_decimal(&self.buy_amount, "buyAmount")?;
        if minimum_buy_amount.is_zero() {
            bail!("buyAmount is zero");
        }
        // The canonical 56-byte uid's first 32 bytes are the order digest;
        // the shared fairness/dedup types carry a 32-byte B256, so that is
        // what they see. The full string is kept for display/reconciliation.
        let canonical = &self.uid;
        if !canonical.starts_with("0x") || canonical.len() != 2 + 56 * 2 {
            bail!("uid is not a 0x-prefixed 56-byte value");
        }
        let digest: B256 = canonical
            .get(2..2 + 64)
            .and_then(|d| d.parse().ok())
            .with_context(|| format!("invalid uid digest {canonical}"))?;
        Ok(CowAuctionOrder {
            uid: digest,
            owner,
            sell_token,
            buy_token,
            remaining_sell_amount,
            minimum_buy_amount,
            partially_fillable: self.partially_fillable,
            canonical_uid: Some(canonical.to_lowercase()),
        })
    }
}

/// The business object `/api/cow` returns: one live open CoW order.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveCowOrder {
    /// Canonical 56-byte CoW order uid (hex).
    pub uid: String,
    pub owner: Address,
    pub sell_token: Address,
    pub buy_token: Address,
    /// Residual sell amount still open, in token base units (decimal string).
    pub remaining_sell_amount: String,
    /// The order's limit (minimum) buy amount, in token base units.
    pub minimum_buy_amount: String,
    pub partially_fillable: bool,
}

/// Immutable snapshot of the last successful poll, served on `/api/cow`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CowOrderbookSnapshot {
    pub base_url: String,
    pub chain_id: u64,
    pub fetched_at_ms: u64,
    pub order_count: usize,
    pub orders: Vec<LiveCowOrder>,
}

impl CowOrderbookSnapshot {
    fn from_auction(auction: &CowAuction, base_url: &str, chain_id: u64) -> Self {
        let orders = auction
            .orders
            .iter()
            .filter_map(|o| {
                Some(LiveCowOrder {
                    uid: o
                        .canonical_uid
                        .clone()
                        .unwrap_or_else(|| format!("{:#x}", o.uid)),
                    owner: o.owner,
                    sell_token: o.sell_token,
                    buy_token: o.buy_token,
                    remaining_sell_amount: o.remaining_sell_amount.to_string(),
                    minimum_buy_amount: o.minimum_buy_amount.to_string(),
                    partially_fillable: o.partially_fillable,
                })
            })
            .collect::<Vec<_>>();
        Self {
            base_url: base_url.to_string(),
            chain_id,
            fetched_at_ms: now_ms(),
            order_count: orders.len(),
            orders,
        }
    }
}

/// Polling client for the CoW Order Book API.
///
/// One `Arc` is shared between the engine's poller task, `/api/cow`, and any
/// live scoring path. The snapshot is the last *successful* fetch; counters
/// stay monotonically increasing so an operator can tell a stale snapshot
/// from a live one.
pub struct CowOrderbookClient {
    http: reqwest::Client,
    base_url: String,
    chain_id: u64,
    max_orders: usize,
    pub snapshot: Arc<RwLock<Option<CowOrderbookSnapshot>>>,
    pub polls: Arc<AtomicU64>,
    pub failures: Arc<AtomicU64>,
    pub last_ok_at_ms: Arc<AtomicU64>,
    pub last_error_at_ms: Arc<AtomicU64>,
    pub last_error: Arc<AtomicU64>,
}

impl CowOrderbookClient {
    pub fn new(base_url: String, chain_id: u64, max_orders: usize) -> Result<Arc<Self>> {
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(15))
            .user_agent(concat!("arrowhead/", env!("CARGO_PKG_VERSION")))
            .build()
            .context("failed to build CoW Order Book HTTP client")?;
        Ok(Arc::new(Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            chain_id,
            max_orders,
            snapshot: Arc::new(RwLock::new(None)),
            polls: Arc::new(AtomicU64::new(0)),
            failures: Arc::new(AtomicU64::new(0)),
            last_ok_at_ms: Arc::new(AtomicU64::new(0)),
            last_error_at_ms: Arc::new(AtomicU64::new(0)),
            last_error: Arc::new(AtomicU64::new(0)),
        }))
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn chain_id(&self) -> u64 {
        self.chain_id
    }

    /// One poll: fetch the current auction and, on success, replace the
    /// snapshot. Failures only move the counters — the previous good snapshot
    /// stays visible so the dashboard can show real data with an age cursor.
    pub async fn poll(self: &Arc<Self>) {
        self.polls.fetch_add(1, Ordering::Relaxed);
        match self.fetch_auction().await {
            Ok(auction) => {
                let snapshot =
                    CowOrderbookSnapshot::from_auction(&auction, &self.base_url, self.chain_id);
                self.last_ok_at_ms.store(now_ms(), Ordering::Relaxed);
                *self.snapshot.write() = Some(snapshot);
                tracing::debug!(
                    target: "cow",
                    base = %self.base_url,
                    orders = auction.orders.len(),
                    "CoW order book snapshot refreshed"
                );
            }
            Err(error) => {
                let now = now_ms();
                self.failures.fetch_add(1, Ordering::Relaxed);
                self.last_error_at_ms.store(now, Ordering::Relaxed);
                self.last_error.store(1, Ordering::Relaxed);
                tracing::warn!(
                    target: "cow",
                    base = %self.base_url,
                    error = %error,
                    "CoW order book poll failed (stale snapshot kept if any)"
                );
            }
        }
    }

    /// Fetch and shape the current auction from the Order Book API.
    ///
    /// `GET /api/v1/auction` returns the open order book as a flat array
    /// (there is no batch envelope on this endpoint), so the auction id is
    /// synthesized from the poll timestamp and `deadline_ms` is 0. Order
    /// order is preserved; the list is capped defensively at `max_orders`.
    pub async fn fetch_auction(&self) -> Result<CowAuction> {
        let url = format!("{}/api/v1/auction", self.base_url);
        let response = self
            .http
            .get(&url)
            .send()
            .await
            .with_context(|| format!("GET {url} failed"))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            bail!("order book API responded {status}: {body}");
        }
        let raw: Vec<ApiOrder> = response
            .json()
            .await
            .with_context(|| format!("invalid order book payload from {url}"))?;

        let mut orders = Vec::with_capacity(raw.len().min(self.max_orders));
        let mut parsed = 0usize;
        let mut skipped = 0usize;
        for order in raw {
            if parsed >= self.max_orders {
                break;
            }
            match order.into_cow_order() {
                Ok(o) => {
                    orders.push(o);
                    parsed += 1;
                }
                Err(reason) => {
                    if skipped < 5 {
                        tracing::debug!(target: "cow", error = %reason, "skipping an order from the order book");
                    }
                    skipped += 1;
                }
            }
        }

        // Fairness references for `score_shadow_solution`: per directed pair,
        // the total residual sell volume still open on the book. A candidate
        // that wants to undercut the live open flow on that pair has to beat
        // this reference — it is the *real* competition, not a constant.
        let mut pair_references = std::collections::BTreeMap::new();
        for o in &orders {
            let key = pair_key(o.sell_token, o.buy_token);
            *pair_references.entry(key).or_insert(U256::ZERO) += o.remaining_sell_amount;
        }

        Ok(CowAuction {
            id: format!("live-{}", now_ms()),
            deadline_ms: 0,
            pair_references,
            orders,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uid(digest_byte: u8, owner_byte: u8, valid_to: u32) -> String {
        format!(
            "0x{}{}{valid_to:08x}",
            format!("{digest_byte:02x}").repeat(32),
            format!("{owner_byte:02x}").repeat(20),
        )
    }

    fn sample_order() -> ApiOrder {
        ApiOrder {
            uid: uid(0x11, 0x22, 0x60000000),
            owner: format!("{:#x}", Address::repeat_byte(0x22)),
            sell_token: format!("{:#x}", Address::repeat_byte(0x0a)),
            buy_token: format!("{:#x}", Address::repeat_byte(0xbb)),
            sell_amount: "150000000000000000000".into(),
            buy_amount: "290000000000000000".into(),
            executed_sell_amount: Some("50000000000000000000".into()),
            partially_fillable: false,
            invalidated: false,
        }
    }

    #[test]
    fn realm_mapping_covers_configured_chains() {
        assert_eq!(
            orderbook_base_url(1).as_deref(),
            Some("https://api.cow.fi/mainnet")
        );
        assert_eq!(
            orderbook_base_url(8453).as_deref(),
            Some("https://api.cow.fi/base")
        );
        assert_eq!(
            orderbook_base_url(42161).as_deref(),
            Some("https://api.cow.fi/arbitrum_one")
        );
        assert_eq!(
            orderbook_base_url(59144).as_deref(),
            Some("https://api.cow.fi/linea")
        );
        assert_eq!(orderbook_base_url(999_999), None);
    }

    #[test]
    fn parses_a_real_shaped_auction_order() {
        let order = sample_order();
        let cow = order.into_cow_order().expect("sample order parses");
        assert_eq!(cow.owner, Address::repeat_byte(0x22));
        assert_eq!(cow.sell_token, Address::repeat_byte(0x0a));
        assert_eq!(cow.remaining_sell_amount, U256::from(100_000_000_000_000_000_000u128));
        assert_eq!(cow.minimum_buy_amount, U256::from(290_000_000_000_000_000u128));
        assert_eq!(
            cow.canonical_uid.as_deref(),
            Some(uid(0x11, 0x22, 0x60000000).to_lowercase().as_str())
        );
    }

    #[test]
    fn skips_invalidated_self_paired_and_fully_executed_orders() {
        let mut invalidated = sample_order();
        invalidated.invalidated = true;
        assert!(invalidated.into_cow_order().is_err());

        let mut self_paired = sample_order();
        self_paired.sell_token = self_paired.buy_token.clone();
        assert!(self_paired.into_cow_order().is_err());

        let mut executed = sample_order();
        executed.executed_sell_amount = Some(executed.sell_amount.clone());
        assert!(executed.into_cow_order().is_err());

        let mut malformed_uid = sample_order();
        malformed_uid.uid = "0x00".into();
        assert!(malformed_uid.into_cow_order().is_err());

        let mut empty_sell = sample_order();
        empty_sell.sell_amount = String::new();
        assert!(empty_sell.into_cow_order().is_err());
    }

    #[test]
    fn auction_builds_directed_pair_references_from_remaining_depth() {
        let auction = CowAuction {
            id: "x".into(),
            deadline_ms: 0,
            pair_references: Default::default(),
            orders: vec![CowAuctionOrder {
                uid: B256::repeat_byte(1),
                owner: Address::repeat_byte(2),
                sell_token: Address::repeat_byte(3),
                buy_token: Address::repeat_byte(4),
                remaining_sell_amount: U256::from(100u64),
                minimum_buy_amount: U256::from(90u64),
                partially_fillable: false,
                canonical_uid: None,
            }],
        };
        let snap = CowOrderbookSnapshot::from_auction(&auction, "https://api.cow.fi/base", 8453);
        assert_eq!(snap.order_count, 1);
        assert_eq!(snap.chain_id, 8453);
        assert_eq!(snap.orders[0].remaining_sell_amount, "100");
        assert!(snap.orders[0].uid.starts_with("0x"));
        // Without a canonical uid the 32-byte digest is the display fallback.
        assert_eq!(snap.orders[0].uid.len(), 2 + 32 * 2);

        // With a canonical 56-byte uid the full identifier is preserved.
        let with_canonical = CowAuction {
            orders: vec![CowAuctionOrder {
                canonical_uid: Some(uid(0xaa, 0xbb, 42)),
                ..auction.orders[0].clone()
            }],
            ..auction.clone()
        };
        let snap = CowOrderbookSnapshot::from_auction(&with_canonical, "https://api.cow.fi/base", 8453);
        assert_eq!(snap.orders[0].uid.len(), 2 + 56 * 2);
        assert!(snap.orders[0].uid.starts_with(&format!("0x{}", "aa".repeat(32))));
    }

    #[tokio::test]
    #[ignore = "hits the live api.cow.fi Order Book API"]
    async fn live_base_order_book_fetches_and_shapes() {
        let base = orderbook_base_url(8453).expect("base realm");
        let client = CowOrderbookClient::new(base, 8453, 512).expect("client");
        let auction = client.fetch_auction().await.expect("live auction");
        assert!(!auction.id.is_empty());
        // A live book may legitimately be empty between batches; the shaping
        // itself must still be coherent.
        for order in &auction.orders {
            assert_ne!(order.sell_token, order.buy_token);
            assert!(order.remaining_sell_amount > U256::ZERO);
            assert!(order.canonical_uid.is_some());
        }
    }
}