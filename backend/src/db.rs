use crate::model::Block;
use anyhow::Result;
use rusqlite::{params, Connection};

pub fn open(path: &str) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS block (
            hash           TEXT PRIMARY KEY,
            height         INTEGER NOT NULL,
            prev_hash      TEXT,
            time           INTEGER,
            size           INTEGER,
            weight         INTEGER,
            tx_count       INTEGER,
            version        INTEGER,
            signals_110    INTEGER NOT NULL,
            rdts_verdict   TEXT NOT NULL,
            rdts_rule_hits TEXT,
            violations     TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_block_height ON block(height);",
    )?;
    // Migrations for columns added after the table shipped to production. ALTER TABLE ADD COLUMN errors
    // if the column already exists, so run each best-effort and ignore the "duplicate column" error —
    // this keeps the existing forkwars.db (with its cached history) in place, no rebuild needed.
    for col in ["miner TEXT", "coinbase_tag TEXT"] {
        let _ = conn.execute(&format!("ALTER TABLE block ADD COLUMN {col}"), []);
    }
    Ok(conn)
}

pub fn upsert(conn: &Connection, b: &Block) -> Result<()> {
    let rules = serde_json::to_string(&b.rdts_rule_hits).unwrap_or_else(|_| "[]".into());
    let vios = serde_json::to_string(&b.violations).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT OR REPLACE INTO block
         (hash,height,prev_hash,time,size,weight,tx_count,version,signals_110,rdts_verdict,rdts_rule_hits,violations,miner,coinbase_tag)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![
            b.hash, b.height, b.prev_hash, b.time, b.size, b.weight, b.tx_count, b.version,
            b.signals_110 as i64, b.rdts_verdict, rules, vios, b.miner, b.coinbase_tag
        ],
    )?;
    Ok(())
}

pub fn load_all(conn: &Connection) -> Result<Vec<Block>> {
    let mut stmt = conn.prepare(
        "SELECT hash,height,prev_hash,time,size,weight,tx_count,version,signals_110,rdts_verdict,rdts_rule_hits,violations,miner,coinbase_tag FROM block",
    )?;
    let rows = stmt.query_map([], |r| {
        let rules_s: String = r.get::<_, Option<String>>(10)?.unwrap_or_else(|| "[]".into());
        let vios_s: String = r.get::<_, Option<String>>(11)?.unwrap_or_else(|| "[]".into());
        Ok(Block {
            hash: r.get(0)?,
            height: r.get(1)?,
            prev_hash: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            time: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
            size: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
            weight: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
            tx_count: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
            version: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
            signals_110: r.get::<_, i64>(8)? != 0,
            rdts_verdict: r.get(9)?,
            rdts_rule_hits: serde_json::from_str(&rules_s).unwrap_or_default(),
            violations: serde_json::from_str(&vios_s).unwrap_or_default(),
            miner: r.get::<_, Option<String>>(12)?,
            coinbase_tag: r.get::<_, Option<String>>(13)?,
        })
    })?;
    let mut out = Vec::new();
    for b in rows.flatten() {
        out.push(b);
    }
    Ok(out)
}

pub fn clear(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM block", [])?;
    Ok(())
}
