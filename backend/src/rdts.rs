use crate::model::Violation;
use bitcoin::blockdata::script::Instruction;
use bitcoin::{Block, OutPoint, ScriptBuf};
use std::collections::HashMap;

pub struct Verdict {
    pub verdict: String,
    pub rules: Vec<u8>,
    pub violations: Vec<Violation>,
}

/// Evaluate the RDTS rules over a parsed block, aggregating by (rule, kind) with a per-rule count.
///
/// Creation-side rules (1 and the output side of rule 2) always apply once RDTS exists. The input-side
/// rules (rule-2 witness items, and rules 3–7) are only meaningful **post-activation** — pre-activation
/// spends are exempt — so they're evaluated only when `activation_height` is set and `block_height`
/// has reached it. They're detected from the spending witness alone (annex, control-block size,
/// tapscript opcodes, oversized items); the one exception is rule 3 (spending an undefined witness
/// version), which needs the spent output's scriptPubKey — supplied via `prevouts` (resolved by the
/// ingest layer on regtest, where txindex is available). See PLAN.md §1/§4.4.
pub fn check_block(
    block: &Block,
    block_height: i64,
    activation_height: Option<i64>,
    prevouts: &HashMap<OutPoint, ScriptBuf>,
) -> Verdict {
    // (rule, kind) -> number of outputs/inputs that hit it.
    let mut counts: HashMap<(u8, &'static str), i64> = HashMap::new();
    let input_side = activation_height.map(|a| block_height >= a).unwrap_or(false);

    for tx in &block.txdata {
        // ---- creation side: output scripts (rule 1 + rule 2 outputs) ----
        for out in &tx.output {
            let spk = &out.script_pubkey;
            let len = spk.len();

            // Rule 1: output scriptPubKey > 34 bytes is invalid, unless OP_RETURN (then <= 83 ok).
            if len > 34 {
                if spk.is_op_return() {
                    if len > 83 {
                        *counts.entry((1, "OP_RETURN > 83 bytes")).or_insert(0) += 1;
                    }
                } else {
                    *counts.entry((1, "scriptPubKey > 34 bytes")).or_insert(0) += 1;
                }
            }

            // Rule 2 (creation side): any data push > 256 bytes in an output script.
            let mut max_push = 0usize;
            for ins in spk.instructions() {
                if let Ok(Instruction::PushBytes(pb)) = ins {
                    max_push = max_push.max(pb.len());
                }
            }
            if max_push > 256 {
                *counts.entry((2, "output data push > 256 bytes")).or_insert(0) += 1;
            }
        }

        // ---- input side: witness rules (2-witness, 3–7), post-activation only ----
        if !input_side || tx.is_coinbase() {
            continue;
        }
        for txin in &tx.input {
            let w = &txin.witness;

            // Rule 3: the spent output is an undefined witness program (v2–v16). Taproot (v1) and
            // segwit v0 are fine; P2A is v1. Needs the prevout scriptPubKey.
            if let Some(spk) = prevouts.get(&txin.previous_output) {
                if let Some(ver) = spk.witness_version() {
                    if ver.to_num() >= 2 {
                        *counts.entry((3, "spends undefined witness version")).or_insert(0) += 1;
                    }
                }
            }

            if w.is_empty() {
                continue;
            }
            let n = w.len();
            let annex = w.taproot_annex();
            let has_annex = annex.is_some();

            // Rule 4: a Taproot annex is present.
            if has_annex {
                *counts.entry((4, "Taproot annex")).or_insert(0) += 1;
            }

            if let Some(leaf) = w.taproot_leaf_script() {
                // Taproot script-path spend. Control block = last element (after any annex).
                if let Some(cb) = w.taproot_control_block() {
                    if cb.len() > 257 {
                        *counts.entry((5, "control block > 257 bytes")).or_insert(0) += 1;
                    }
                }
                // Scan the leaf script's opcodes (skipping push data).
                let (op_success, op_conditional) = scan_tapscript(leaf.script.as_bytes());
                if op_success {
                    *counts.entry((6, "OP_SUCCESS in tapscript")).or_insert(0) += 1;
                }
                if op_conditional {
                    *counts.entry((7, "OP_IF/OP_NOTIF in tapscript")).or_insert(0) += 1;
                }
                // Rule 2 (witness): oversized *argument* items — everything before the leaf script
                // (i.e. excluding the script, control block, and annex).
                let args_end = n.saturating_sub(if has_annex { 3 } else { 2 });
                let mut oversized = false;
                for el in w.iter().take(args_end) {
                    if el.len() > 256 {
                        oversized = true;
                        break;
                    }
                }
                if oversized {
                    *counts.entry((2, "witness item > 256 bytes")).or_insert(0) += 1;
                }
            } else {
                // Key-path / non-taproot: any witness item (bar the annex) over 256 bytes.
                let stack_end = if has_annex { n - 1 } else { n };
                if w.iter().take(stack_end).any(|el| el.len() > 256) {
                    *counts.entry((2, "witness item > 256 bytes")).or_insert(0) += 1;
                }
            }
        }
    }

    let mut violations: Vec<Violation> = counts
        .into_iter()
        .map(|((rule, kind), count)| Violation { rule, kind: kind.to_string(), count })
        .collect();
    violations.sort_by(|a, b| a.rule.cmp(&b.rule).then(b.count.cmp(&a.count)));

    let mut rules: Vec<u8> = violations.iter().map(|v| v.rule).collect();
    rules.sort_unstable();
    rules.dedup();

    let verdict = if violations.is_empty() {
        "pass".to_string()
    } else if activation_height.map(|a| block_height >= a).unwrap_or(false) {
        "invalid".to_string()
    } else {
        "would_violate".to_string()
    };

    Verdict { verdict, rules, violations }
}

/// Walk a tapscript's raw bytes opcode-by-opcode (skipping push payloads) and report whether it
/// contains (any OP_SUCCESSx, any OP_IF/OP_NOTIF). Per BIP342 a single OP_SUCCESSx anywhere — even in
/// an unexecuted branch — makes the script succeed, so presence (not execution) is the signal.
fn scan_tapscript(bytes: &[u8]) -> (bool, bool) {
    let mut i = 0usize;
    let mut op_success = false;
    let mut op_conditional = false;
    while i < bytes.len() {
        let op = bytes[i];
        i += 1;
        match op {
            0x01..=0x4b => i += op as usize,                       // OP_PUSHBYTES_N
            0x4c => {
                let l = *bytes.get(i).unwrap_or(&0) as usize;      // OP_PUSHDATA1
                i += 1 + l;
            }
            0x4d => {
                let l = bytes.get(i..i + 2).map(|s| u16::from_le_bytes([s[0], s[1]]) as usize).unwrap_or(0);
                i += 2 + l;                                        // OP_PUSHDATA2
            }
            0x4e => {
                let l = bytes
                    .get(i..i + 4)
                    .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as usize)
                    .unwrap_or(0);
                i += 4 + l;                                        // OP_PUSHDATA4
            }
            0x63 | 0x64 => op_conditional = true,                  // OP_IF / OP_NOTIF
            _ if is_op_success(op) => op_success = true,
            _ => {}
        }
    }
    (op_success, op_conditional)
}

/// The OP_SUCCESSx opcodes defined by BIP342.
fn is_op_success(op: u8) -> bool {
    matches!(op,
        80 | 98 | 126..=129 | 131..=134 | 137 | 138 | 141 | 142 | 149..=153 | 187..=254)
}
