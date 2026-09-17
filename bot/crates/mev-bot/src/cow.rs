//! Native CoW Protocol GPv2 order validation.
//!
//! This module is deliberately pure and offline. It authenticates the signed
//! order envelope and computes the canonical digest/UID, but it does not accept
//! orders from the network or build settlement calls. Those operations require
//! a configured chain-specific settlement address, durable idempotency state,
//! solver authorization, and exact-payload fork simulation.

use alloy_primitives::{keccak256, Address, B256, U256};
use anyhow::{bail, Context, Result};
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

const DOMAIN_TYPE: &[u8] =
    b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const ORDER_TYPE: &[u8] = b"Order(address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,bytes32 kind,bool partiallyFillable,bytes32 sellTokenBalance,bytes32 buyTokenBalance)";

/// The subset of a GPv2 order that the validator accepts from an external
/// source. Strings are retained at the boundary so malformed JSON cannot be
/// coerced into a different order.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CowOrderRequest {
    pub sell_token: String,
    pub buy_token: String,
    #[serde(default = "zero_address")]
    pub receiver: String,
    pub sell_amount: String,
    pub buy_amount: String,
    pub valid_to: u64,
    pub app_data: String,
    pub fee_amount: String,
    pub kind: String,
    pub partially_fillable: bool,
    pub sell_token_balance: String,
    pub buy_token_balance: String,
    pub signature: String,
    #[serde(default = "default_signing_scheme")]
    pub signing_scheme: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ValidatedCowOrder {
    pub digest: B256,
    pub uid: B256,
    pub owner: Address,
    pub sell_token: Address,
    pub buy_token: Address,
    pub receiver: Address,
    pub sell_amount: U256,
    pub buy_amount: U256,
    pub valid_to: u32,
    pub fee_amount: U256,
    pub partially_fillable: bool,
}

fn zero_address() -> String {
    format!("{:#x}", Address::ZERO)
}

fn default_signing_scheme() -> String {
    "eip712".to_string()
}

fn parse_address(value: &str, field: &str) -> Result<Address> {
    value
        .parse()
        .with_context(|| format!("invalid {field} address"))
}

fn parse_word(value: &str, field: &str) -> Result<B256> {
    value
        .parse()
        .with_context(|| format!("invalid {field} bytes32"))
}

fn parse_u256(value: &str, field: &str) -> Result<U256> {
    let value = value.strip_prefix("0x").unwrap_or(value);
    if value.is_empty() {
        bail!("{field} is empty");
    }
    if value.chars().all(|c| c.is_ascii_digit()) {
        value.parse().with_context(|| format!("invalid {field}"))
    } else {
        U256::from_str_radix(value, 16).with_context(|| format!("invalid {field}"))
    }
}

fn word_address(address: Address) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(address.as_slice());
    word
}

fn word_u256(value: U256) -> [u8; 32] {
    value.to_be_bytes()
}

fn eip712_digest(order: &CowOrderRequest, chain_id: u64, settlement: Address) -> Result<B256> {
    let sell_token = parse_address(&order.sell_token, "sellToken")?;
    let buy_token = parse_address(&order.buy_token, "buyToken")?;
    let receiver = parse_address(&order.receiver, "receiver")?;
    let sell_amount = parse_u256(&order.sell_amount, "sellAmount")?;
    let buy_amount = parse_u256(&order.buy_amount, "buyAmount")?;
    let fee_amount = parse_u256(&order.fee_amount, "feeAmount")?;
    let app_data = parse_word(&order.app_data, "appData")?;
    let kind = parse_word(&order.kind, "kind")?;
    let sell_balance = parse_word(&order.sell_token_balance, "sellTokenBalance")?;
    let buy_balance = parse_word(&order.buy_token_balance, "buyTokenBalance")?;

    let domain_type = keccak256(DOMAIN_TYPE);
    let mut domain = Vec::with_capacity(32 * 5);
    domain.extend_from_slice(domain_type.as_slice());
    domain.extend_from_slice(keccak256("Gnosis Protocol").as_slice());
    domain.extend_from_slice(keccak256("v2").as_slice());
    domain.extend_from_slice(&word_u256(U256::from(chain_id)));
    domain.extend_from_slice(&word_address(settlement));
    let domain_separator = keccak256(domain);

    let mut encoded = Vec::with_capacity(32 * 13);
    encoded.extend_from_slice(keccak256(ORDER_TYPE).as_slice());
    encoded.extend_from_slice(&word_address(sell_token));
    encoded.extend_from_slice(&word_address(buy_token));
    encoded.extend_from_slice(&word_address(receiver));
    encoded.extend_from_slice(&word_u256(sell_amount));
    encoded.extend_from_slice(&word_u256(buy_amount));
    encoded.extend_from_slice(&word_u256(U256::from(order.valid_to)));
    encoded.extend_from_slice(app_data.as_slice());
    encoded.extend_from_slice(&word_u256(fee_amount));
    encoded.extend_from_slice(kind.as_slice());
    encoded.extend_from_slice(&word_u256(U256::from(order.partially_fillable as u8)));
    encoded.extend_from_slice(sell_balance.as_slice());
    encoded.extend_from_slice(buy_balance.as_slice());
    let struct_hash = keccak256(encoded);

    let mut digest = Vec::with_capacity(66);
    digest.extend_from_slice(b"\x19\x01");
    digest.extend_from_slice(domain_separator.as_slice());
    digest.extend_from_slice(struct_hash.as_slice());
    Ok(keccak256(digest))
}

fn recover_owner(digest: B256, signature: &str) -> Result<Address> {
    let encoded = signature.strip_prefix("0x").unwrap_or(signature);
    let bytes = hex::decode(encoded).context("invalid signature hex")?;
    if bytes.len() != 65 {
        bail!("only 65-byte EIP-712 signatures are supported");
    }
    let sig = Signature::from_slice(&bytes[..64]).context("invalid ECDSA signature")?;
    let recovery = match bytes[64] {
        0 | 27 => RecoveryId::try_from(0).unwrap(),
        1 | 28 => RecoveryId::try_from(1).unwrap(),
        _ => bail!("invalid ECDSA recovery id"),
    };
    let key = VerifyingKey::recover_from_prehash(digest.as_slice(), &sig, recovery)
        .context("signature does not recover an owner")?;
    let point = key.to_encoded_point(false);
    Ok(Address::from_slice(&keccak256(&point.as_bytes()[1..])[12..]))
}

/// Validate a native GPv2 EIP-712 order against one configured chain and
/// settlement deployment. This deliberately rejects smart-contract signatures
/// and pre-sign orders until their on-chain verification path is implemented.
pub fn validate_order(
    order: &CowOrderRequest,
    chain_id: u64,
    settlement: Address,
    now_secs: u64,
    max_validity_secs: u64,
) -> Result<ValidatedCowOrder> {
    if !order.signing_scheme.eq_ignore_ascii_case("eip712") {
        bail!("only EIP-712 signingScheme is supported");
    }
    if settlement == Address::ZERO {
        bail!("CoW settlement address is not configured");
    }
    let sell_token = parse_address(&order.sell_token, "sellToken")?;
    let buy_token = parse_address(&order.buy_token, "buyToken")?;
    if sell_token == buy_token {
        bail!("sellToken and buyToken must differ");
    }
    let receiver = parse_address(&order.receiver, "receiver")?;
    let sell_amount = parse_u256(&order.sell_amount, "sellAmount")?;
    let buy_amount = parse_u256(&order.buy_amount, "buyAmount")?;
    let fee_amount = parse_u256(&order.fee_amount, "feeAmount")?;
    if sell_amount.is_zero() || buy_amount.is_zero() {
        bail!("sellAmount and buyAmount must be non-zero");
    }
    if fee_amount > sell_amount {
        bail!("feeAmount exceeds sellAmount");
    }
    if order.valid_to <= now_secs {
        bail!("order is expired");
    }
    if order.valid_to - now_secs > max_validity_secs {
        bail!("order validity exceeds configured limit");
    }
    let expected_kind = if order.kind.eq_ignore_ascii_case("sell") {
        keccak256("sell")
    } else if order.kind.eq_ignore_ascii_case("buy") {
        keccak256("buy")
    } else {
        parse_word(&order.kind, "kind")?
    };
    let actual_kind = parse_word(&order.kind, "kind")?;
    if actual_kind != expected_kind {
        bail!("unsupported order kind");
    }
    let erc20 = keccak256("erc20");
    if parse_word(&order.sell_token_balance, "sellTokenBalance")? != erc20
        || parse_word(&order.buy_token_balance, "buyTokenBalance")? != erc20
    {
        bail!("only ERC-20 balance sources are supported");
    }
    let digest = eip712_digest(order, chain_id, settlement)?;
    let owner = recover_owner(digest, &order.signature)?;
    let receiver = if receiver == Address::ZERO { owner } else { receiver };
    let mut uid = Vec::with_capacity(56);
    uid.extend_from_slice(digest.as_slice());
    uid.extend_from_slice(owner.as_slice());
    uid.extend_from_slice(&(order.valid_to as u32).to_be_bytes());
    Ok(ValidatedCowOrder {
        digest,
        uid: B256::from_slice(&uid),
        owner,
        sell_token,
        buy_token,
        receiver,
        sell_amount,
        buy_amount,
        valid_to: order.valid_to as u32,
        fee_amount,
        partially_fillable: order.partially_fillable,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_expired_and_non_eip712_orders_before_signature_work() {
        let order = CowOrderRequest {
            sell_token: format!("{:#x}", Address::repeat_byte(1)),
            buy_token: format!("{:#x}", Address::repeat_byte(2)),
            receiver: zero_address(),
            sell_amount: "1".into(),
            buy_amount: "1".into(),
            valid_to: 10,
            app_data: format!("{:#x}", B256::ZERO),
            fee_amount: "0".into(),
            kind: format!("{:#x}", keccak256("sell")),
            partially_fillable: false,
            sell_token_balance: format!("{:#x}", keccak256("erc20")),
            buy_token_balance: format!("{:#x}", keccak256("erc20")),
            signature: "0x00".into(),
            signing_scheme: "eth_sign".into(),
        };
        assert!(validate_order(&order, 1, Address::repeat_byte(9), 10, 60).is_err());
    }
}
