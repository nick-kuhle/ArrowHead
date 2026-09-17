//! Native CoW Protocol GPv2 orders: canonical EIP-712 envelope, offline
//! validation, digest/UID computation, app-data hashing and settlement
//! calldata.
//!
//! Everything here is pure and offline — no HTTP, no signing key state. The
//! EIP-712 type is the *canonical* one the Order Book API signs (`string kind`,
//! `string *TokenBalance`), whose type hash is
//! `0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489`.
//! Do not regress this to the old `bytes32 kind` variant isolated in the
//! pre-API SDK: it produces a different digest and every modern signer would
//! reject it.
//!
//! The 56-byte uid is `digest(32) || owner(20) || validTo BE(4)`. `OrderUid`
//! keeps the whole 56 bytes — the historical `B256` truncation dropped the
//! owner/validTo suffix and made ids ambiguous.

use alloy_primitives::{keccak256, Address, B256, U256};
use anyhow::{bail, Context, Result};
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::signer::Signer;

/// Canonical EIP-712 domain type. Deterministic CREATE2 deploys keep the same
/// domain on every supported chain.
const DOMAIN_TYPE: &[u8] =
    b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
/// Canonical order type (string-encoded `kind` and balance sources).
const ORDER_TYPE: &[u8] = b"Order(address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,string kind,bool partiallyFillable,string sellTokenBalance,string buyTokenBalance)";
/// `keccak256(ORDER_TYPE)` — pinned so a regression in the type string is a
/// test failure, not a wrong signature.
pub const ORDER_TYPE_HASH: B256 = B256::new([
    0xd5, 0xa2, 0x5b, 0xa2, 0xe9, 0x70, 0x94, 0xad, 0x7d, 0x83, 0xdc, 0x28, 0xa6, 0x57, 0x2d, 0xa7,
    0x97, 0xd6, 0xb3, 0xe7, 0xfc, 0x66, 0x63, 0xbd, 0x93, 0xef, 0xb7, 0x89, 0xfc, 0x17, 0xe4, 0x89,
]);

/// Canonical `GPv2Settlement` address, identical on every CoW chain via
/// deterministic CREATE2 deployment (`0x9008D19f58AAbD9eD0D60971565AA8510560ab41`).
pub const SETTLEMENT_CONTRACT: Address = Address::new([
    0x90, 0x08, 0xd1, 0x9f, 0x58, 0xaa, 0xbd, 0x9e, 0xd0, 0xd6, 0x09, 0x71, 0x56, 0x5a, 0xa8, 0x51,
    0x05, 0x60, 0xab, 0x41,
]);

/// Canonical `VaultRelayer` address (`0xC92E8bdf79f0507f65a392b0ab4667716BFE0110`).
pub const VAULT_RELAYER: Address = Address::new([
    0xc9, 0x2e, 0x8b, 0xdf, 0x79, 0xf0, 0x50, 0x7f, 0x65, 0xa3, 0x92, 0xb0, 0xab, 0x46, 0x67, 0x71,
    0x6b, 0xfe, 0x01, 0x10,
]);

/// Order direction as the Order Book API spells it (lowercase on the wire).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CowOrderKind {
    Sell,
    Buy,
}

/// The subset of a GPv2 order the validator/signer accepts. Strings are
/// retained at the boundary so malformed JSON cannot be coerced into a
/// different order. `kind` is `"sell"`/`"buy"` and the balance sources are
/// `"erc20"`/`"internal"`/`"external"` — the raw wire strings, not their
/// hashed words.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
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
    #[serde(default)]
    pub signature: String,
    #[serde(default = "default_signing_scheme")]
    pub signing_scheme: String,
}

/// The canonical CoW order uid: `digest || owner || validTo` (56 bytes).
///
/// Serialises to the conventional 0x-prefixed hex string used across the
/// Order Book API.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct OrderUid([u8; 56]);

impl serde::Serialize for OrderUid {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> serde::Deserialize<'de> for OrderUid {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        value.parse().map_err(serde::de::Error::custom)
    }
}

impl OrderUid {
    pub fn from_bytes(bytes: [u8; 56]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 56] {
        &self.0
    }

    /// The 32-byte order digest (first word of the uid).
    pub fn digest(&self) -> B256 {
        B256::from_slice(&self.0[0..32])
    }

    /// The 20-byte owner address.
    pub fn owner(&self) -> Address {
        Address::from_slice(&self.0[32..52])
    }

    /// The order's validity deadline (seconds since epoch, BE in the last 4).
    pub fn valid_to(&self) -> u32 {
        u32::from_be_bytes([self.0[52], self.0[53], self.0[54], self.0[55]])
    }
}

impl std::fmt::Display for OrderUid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&format!("0x{}", hex::encode(self.0)))
    }
}

impl std::str::FromStr for OrderUid {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        let clean = value.trim().strip_prefix("0x").unwrap_or(value.trim());
        let bytes = hex::decode(clean).context("invalid order uid hex")?;
        if bytes.len() != 56 {
            bail!("order uid must be 56 bytes, got {}", bytes.len());
        }
        let mut out = [0u8; 56];
        out.copy_from_slice(&bytes);
        Ok(Self(out))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ValidatedCowOrder {
    pub digest: B256,
    pub uid: OrderUid,
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

/// The wire form of `kind` and balance sources must be their lowercase
/// names; the EIP-712 words are the hashes of those names.
fn enum_word(value: &str, field: &str) -> Result<B256> {
    match value.to_ascii_lowercase().as_str() {
        "sell" | "buy" | "erc20" | "internal" | "external" => {}
        other => bail!("invalid {field} enum value {other:?}"),
    }
    Ok(keccak256(value.to_ascii_lowercase()))
}

/// The per-chain EIP-712 domain separator and order struct hash, folded into
/// the final signing digest `\x19\x01 ‖ domainSeparator ‖ structHash`.
pub fn order_digest(order: &CowOrderRequest, chain_id: u64, settlement: Address) -> Result<B256> {
    let sell_token = parse_address(&order.sell_token, "sellToken")?;
    let buy_token = parse_address(&order.buy_token, "buyToken")?;
    let receiver = parse_address(&order.receiver, "receiver")?;
    let sell_amount = parse_u256(&order.sell_amount, "sellAmount")?;
    let buy_amount = parse_u256(&order.buy_amount, "buyAmount")?;
    let fee_amount = parse_u256(&order.fee_amount, "feeAmount")?;
    let app_data = parse_word(&order.app_data, "appData")?;
    let kind = enum_word(&order.kind, "kind")?;
    let sell_balance = enum_word(&order.sell_token_balance, "sellTokenBalance")?;
    let buy_balance = enum_word(&order.buy_token_balance, "buyTokenBalance")?;

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

    let mut digest = Vec::with_capacity(66);
    digest.extend_from_slice(b"\x19\x01");
    digest.extend_from_slice(domain_separator.as_slice());
    digest.extend_from_slice(keccak256(encoded).as_slice());
    Ok(keccak256(digest))
}

/// Compute the canonical 56-byte uid for a signed order.
pub fn order_uid(digest: B256, owner: Address, valid_to: u64) -> OrderUid {
    let mut out = [0u8; 56];
    out[0..32].copy_from_slice(digest.as_slice());
    out[32..52].copy_from_slice(owner.as_slice());
    out[52..56].copy_from_slice(&(valid_to as u32).to_be_bytes());
    OrderUid(out)
}

/// Sign the order's EIP-712 digest with the searcher key and return the
/// 65-byte `r ‖ s ‖ v` signature (v = 27/28), hex-encoded with `0x`.
pub fn sign_order(order: &CowOrderRequest, chain_id: u64, settlement: Address, signer: &Signer) -> Result<(String, OrderUid)> {
    let digest = order_digest(order, chain_id, settlement)?;
    let owner = signer.address();
    let signature = signer.sign_hash_bytes(digest);
    let uid = order_uid(digest, owner, order.valid_to);
    Ok((format!("0x{}", hex::encode(signature)), uid))
}

/// The app-data hash sent in an order. An empty (metadata-less) order uses
/// the all-zeros bytes32; otherwise `0x00 ‖ keccak256(fullAppData)[1..]`
/// per the app-data proposal.
pub fn app_data_hash(full_app_data: Option<&str>) -> B256 {
    match full_app_data.map(str::trim) {
        Some(s) if !s.is_empty() => {
            let hash = keccak256(s.as_bytes());
            let mut out = [0u8; 32];
            out[1..].copy_from_slice(&hash.0[1..]);
            B256::from_slice(&out)
        }
        _ => B256::ZERO,
    }
}

/// `selector("invalidateOrder(bytes)") ‖ offset ‖ len ‖ paddedUid` — the
/// calldata for an on-chain order cancellation (132 bytes).
pub fn invalidate_order_calldata(uid: &OrderUid) -> Vec<u8> {
    let mut out = Vec::with_capacity(132);
    out.extend_from_slice(&keccak256(b"invalidateOrder(bytes)").0[0..4]);
    // ABI: selector ‖ offset(32) ‖ bytesLen(32) ‖ paddedUid(64). The offset
    // points at the start of the dynamic bytes value (right after the offset
    // word), and the data area is padded up to the next 32-byte word.
    out.extend_from_slice(&U256::from(32u32).to_be_bytes::<32>());
    out.extend_from_slice(&U256::from(uid.as_bytes().len()).to_be_bytes::<32>());
    out.extend_from_slice(uid.as_bytes());
    out.extend_from_slice(&[0u8; 8]);
    out
}

/// `selector("setPreSignature(bytes,bool)") ‖ offset ‖ bool ‖ len ‖ paddedUid`
/// (164 bytes) for a pre-sign order.
pub fn set_pre_signature_calldata(uid: &OrderUid, signed: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(164);
    out.extend_from_slice(&keccak256(b"setPreSignature(bytes,bool)").0[0..4]);
    // ABI: selector ‖ bytesOffset(32) ‖ bool(32) ‖ bytesLen(32) ‖ paddedUid(64).
    out.extend_from_slice(&U256::from(64u32).to_be_bytes::<32>());
    out.extend_from_slice(&U256::from(u8::from(signed)).to_be_bytes::<32>());
    out.extend_from_slice(&U256::from(uid.as_bytes().len()).to_be_bytes::<32>());
    out.extend_from_slice(uid.as_bytes());
    out.extend_from_slice(&[0u8; 8]);
    out
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
/// and pre-sign orders until their on-chain verification path is implemented;
/// placement in this crate is always `eip712` with its own signing key.
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
    if !matches!(
        order.kind.to_ascii_lowercase().as_str(),
        "sell" | "buy"
    ) {
        bail!("order kind must be \"sell\" or \"buy\"");
    }
    if !matches!(
        order.sell_token_balance.to_ascii_lowercase().as_str(),
        "erc20" | "internal" | "external"
    ) || !matches!(
        order.buy_token_balance.to_ascii_lowercase().as_str(),
        "erc20" | "internal" | "external"
    ) {
        bail!("only erc20/internal/external balance sources are supported");
    }
    // Digest construction double-checks every enum word.
    let digest = order_digest(order, chain_id, settlement)?;
    let owner = recover_owner(digest, &order.signature)?;
    let receiver = if receiver == Address::ZERO { owner } else { receiver };
    let uid = order_uid(digest, owner, order.valid_to);
    Ok(ValidatedCowOrder {
        digest,
        uid,
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
    fn canonical_type_hash_is_the_string_kind_one() {
        assert_eq!(keccak256(ORDER_TYPE), ORDER_TYPE_HASH);
        // Sanity: this is *not* the legacy bytes32-kind variant.
        let legacy = keccak256(b"Order(address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,bytes32 kind,bool partiallyFillable,bytes32 sellTokenBalance,bytes32 buyTokenBalance)");
        assert_ne!(legacy, ORDER_TYPE_HASH);
    }

    fn sample_order(valid_to: u64) -> CowOrderRequest {
        CowOrderRequest {
            sell_token: format!("{:#x}", Address::repeat_byte(1)),
            buy_token: format!("{:#x}", Address::repeat_byte(2)),
            receiver: zero_address(),
            sell_amount: "1000000".into(),
            buy_amount: "999000".into(),
            valid_to,
            app_data: format!("{:#x}", B256::ZERO),
            fee_amount: "50".into(),
            kind: "sell".into(),
            partially_fillable: false,
            sell_token_balance: "erc20".into(),
            buy_token_balance: "erc20".into(),
            signature: "0x00".into(),
            signing_scheme: "eip712".into(),
        }
    }

    #[test]
    fn digest_is_deterministic_and_chain_scoped() {
        let order = sample_order(1_700_000_000);
        let d1 = order_digest(&order, 1, SETTLEMENT_CONTRACT).unwrap();
        let d2 = order_digest(&order, 1, SETTLEMENT_CONTRACT).unwrap();
        assert_eq!(d1, d2);
        // The domain separator includes chainId, so digest differs per chain.
        assert_ne!(d1, order_digest(&order, 8453, SETTLEMENT_CONTRACT).unwrap());
        // Kind/buy/sell flip changes the struct hash.
        let mut buy = order.clone();
        buy.kind = "buy".into();
        assert_ne!(d1, order_digest(&buy, 1, SETTLEMENT_CONTRACT).unwrap());
    }

    #[test]
    fn uid_is_56_bytes_digest_owner_validto() {
        let order = sample_order(0x01020304);
        let digest = order_digest(&order, 1, SETTLEMENT_CONTRACT).unwrap();
        let owner = Address::repeat_byte(0xab);
        let uid = order_uid(digest, owner, order.valid_to);
        assert_eq!(uid.as_bytes().len(), 56);
        assert_eq!(uid.digest(), digest);
        assert_eq!(uid.owner(), owner);
        assert_eq!(uid.valid_to(), 0x01020304);
        let s = uid.to_string();
        assert!(s.starts_with("0x"));
        assert_eq!(s.len(), 2 + 56 * 2);
        let reparsed: OrderUid = s.parse().unwrap();
        assert_eq!(reparsed, uid);
    }

    #[test]
    fn app_data_hash_is_zero_word_for_empty_and_0x00_prefixed_otherwise() {
        assert_eq!(app_data_hash(None), B256::ZERO);
        assert_eq!(app_data_hash(Some("")), B256::ZERO);
        let hash = app_data_hash(Some("{\"appCode\":\"arrowhead\"}"));
        assert_eq!(hash.0[0], 0x00, "app data hash keeps the 0x00 prefix");
        assert_ne!(hash, B256::ZERO);
        // Deterministic.
        assert_eq!(hash, app_data_hash(Some("{\"appCode\":\"arrowhead\"}")));
    }

    #[test]
    fn invalidation_and_pre_sign_calldata_shape() {
        let uid = order_uid(B256::repeat_byte(7), Address::repeat_byte(8), 1_700_000_000);
        let invalidate = invalidate_order_calldata(&uid);
        assert_eq!(invalidate.len(), 132);
        assert_eq!(
            &invalidate[0..4],
            &keccak256(b"invalidateOrder(bytes)").0[0..4]
        );
        let pre_sign = set_pre_signature_calldata(&uid, true);
        assert_eq!(pre_sign.len(), 164);
        assert_eq!(
            &pre_sign[0..4],
            &keccak256(b"setPreSignature(bytes,bool)").0[0..4]
        );
    }

    #[test]
    fn signing_reproduces_owner_recovery() {
        let signer = Signer::simulation();
        let order = sample_order(1_700_000_000);
        let (signature, uid) = sign_order(&order, 1, SETTLEMENT_CONTRACT, &signer).unwrap();
        assert_eq!(uid.owner(), signer.address());
        let mut signed = order.clone();
        signed.signature = signature;
        let digest = order_digest(&signed, 1, SETTLEMENT_CONTRACT).unwrap();
        let recovered = recover_owner(digest, &signed.signature).unwrap();
        assert_eq!(recovered, signer.address());
        assert_eq!(uid.digest(), digest);
    }

    #[test]
    fn rejects_expired_and_non_eip712_orders() {
        let order = sample_order(10);
        assert!(validate_order(&order, 1, SETTLEMENT_CONTRACT, 10, 60).is_err());
        let mut eth_sign = sample_order(1_700_000_000);
        eth_sign.signing_scheme = "ethSign".into();
        assert!(validate_order(&eth_sign, 1, SETTLEMENT_CONTRACT, 0, 60).is_err());
    }
}