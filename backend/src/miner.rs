//! Miner / mining-pool identification from a block's coinbase transaction.
//!
//! The block header says nothing about who mined it — the identity lives in the coinbase transaction
//! (`txdata[0]`): pools stamp an ASCII tag into the coinbase scriptSig (e.g. `/Foundry USA Pool/`,
//! `/AntPool/`) and pay the reward to a well-known address. We surface both: a printable "coinbase
//! tag" (informative even for unknown pools) and, when we can match it, the pool name.
//!
//! Matching is best-effort by coinbase-tag substring first (covers the large majority of mainnet
//! blocks), then by payout address for a few pools whose tags are ambiguous or absent. This mirrors
//! how explorers (mempool.space's `pools.json`) attribute blocks; the list is intentionally compact
//! and easy to extend — add a `(name, &[tag substrings])` row or a `(address, name)` row.

use bitcoin::Block;

/// Known pools keyed by case-insensitive substrings found in the coinbase scriptSig ASCII. First
/// match wins, so order more specific tags before generic ones.
const POOL_TAGS: &[(&str, &[&str])] = &[
    ("Foundry USA", &["foundry usa", "/foundry"]),
    ("AntPool", &["antpool", "/antpool/"]),
    ("ViaBTC", &["viabtc", "/viabtc/"]),
    ("F2Pool", &["f2pool", "/f2pool/", "🐟", "七彩神仙鱼"]),
    ("Binance Pool", &["binance", "/binance/"]),
    ("Braiins Pool", &["braiins", "slush"]),
    ("MARA Pool", &["mara pool", "marapool", "/mara/"]),
    ("Luxor", &["luxor", "/luxor/"]),
    ("SBI Crypto", &["sbicrypto", "sbi crypto"]),
    ("SpiderPool", &["spiderpool", "/spider"]),
    ("SECPOOL", &["secpool"]),
    ("Poolin", &["poolin", "/poolin/"]),
    ("Ultimuspool", &["ultimus"]),
    ("Carbon Negative", &["carbon negative"]),
    ("OCEAN", &["ocean.xyz", "/ocean"]),
    ("WhitePool", &["whitepool"]),
    ("BTC.com", &["btc.com", "/btccom/"]),
    ("Bitdeer", &["bitdeer"]),
    ("NiceHash", &["nicehash"]),
    ("Solo CK", &["/solo.ckpool", "ckpool"]),
    ("Rawpool", &["rawpool"]),
    ("Terra Pool", &["terrapool", "terra pool"]),
];

/// A few pools identified by their canonical coinbase payout address, for cases where the tag alone
/// is unreliable. Matched against every coinbase output address.
const POOL_ADDRS: &[(&str, &str)] = &[
    ("bc1qxhmdufsvnuaaaer4ynz88fspdsxq2h9e9cetdj", "ViaBTC"),
    ("12dRugNcdxK39288NjcDV4GX7rMsKCGn6B", "AntPool"),
    ("1KFHE7w8BhaENAswwryaoccDb6qcT6DbYY", "F2Pool"),
];

pub struct Miner {
    /// Resolved pool name, if we could attribute it.
    pub name: Option<String>,
    /// Printable ASCII pulled from the coinbase scriptSig (trimmed). None if empty.
    pub tag: Option<String>,
}

/// Extract the human-readable pool tag from raw scriptSig bytes. Pools stamp an ASCII marker
/// (e.g. `/ViaBTC/Mined by …/`) as one contiguous run of printable bytes; the BIP34 height push,
/// extranonce and witness-commitment bytes are binary. Some of that binary lands in the printable
/// range by chance, so a byte-by-byte filter leaves a spray of junk (`m[u oX ;% h j K Y`). Instead
/// we keep only contiguous printable runs at least MIN_RUN long — the real tag is one long run; the
/// accidental-printable noise is a scatter of 1–3 char runs that drops out.
fn coinbase_tag(bytes: &[u8]) -> String {
    const MIN_RUN: usize = 4;
    let mut runs: Vec<String> = Vec::new();
    let mut cur = String::new();
    for &b in bytes {
        if (0x20..=0x7e).contains(&b) {
            cur.push(b as char);
        } else {
            let t = cur.trim();
            if t.chars().count() >= MIN_RUN {
                runs.push(t.to_string());
            }
            cur.clear();
        }
    }
    let t = cur.trim();
    if t.chars().count() >= MIN_RUN {
        runs.push(t.to_string());
    }
    runs.join(" ")
}

/// Identify the miner of a block from its coinbase transaction (best-effort).
pub fn identify(block: &Block) -> Miner {
    let Some(coinbase) = block.txdata.first() else {
        return Miner { name: None, tag: None };
    };

    // Coinbase tag: printable ASCII of the (single) coinbase input's scriptSig.
    let tag = coinbase
        .input
        .first()
        .map(|i| coinbase_tag(i.script_sig.as_bytes()))
        .filter(|s| !s.is_empty());

    // 1) Match by coinbase-tag substring (case-insensitive).
    let mut name: Option<String> = None;
    if let Some(t) = &tag {
        let lower = t.to_lowercase();
        for (pool, needles) in POOL_TAGS {
            if needles.iter().any(|n| lower.contains(&n.to_lowercase())) {
                name = Some((*pool).to_string());
                break;
            }
        }
    }

    // 2) Fall back to payout-address match against the coinbase outputs.
    if name.is_none() {
        'outer: for out in &coinbase.output {
            if let Ok(addr) = bitcoin::Address::from_script(&out.script_pubkey, bitcoin::Network::Bitcoin) {
                let a = addr.to_string();
                for (known, pool) in POOL_ADDRS {
                    if a == *known {
                        name = Some((*pool).to_string());
                        break 'outer;
                    }
                }
            }
        }
    }

    Miner { name, tag }
}
