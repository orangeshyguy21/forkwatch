use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::time::Duration;

/// Minimal blocking JSON-RPC client for bitcoind (works for Core and Knots).
#[derive(Clone)]
pub struct Rpc {
    url: String,
    auth: String,
    agent: ureq::Agent,
}

impl Rpc {
    pub fn new(url: &str, user: &str, pass: &str) -> Self {
        let auth = format!("Basic {}", STANDARD.encode(format!("{user}:{pass}")));
        // A short CONNECT timeout separate from the overall timeout: a blackholed node (firewall drop,
        // wedged bitcoind not accepting) fails fast here instead of consuming the full 30s per call.
        // Three-plus serial calls each stalling 30s would push a poll past READY_MAX_STALE and flap
        // the container's readiness/health — an availability loss while the *other* node is fine.
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(4))
            .timeout(Duration::from_secs(30))
            .build();
        Rpc { url: url.to_string(), auth, agent }
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value> {
        let body = json!({"jsonrpc":"1.0","id":"forkwars","method":method,"params":params});
        let resp = match self
            .agent
            .post(&self.url)
            .set("Authorization", &self.auth)
            .set("Content-Type", "application/json")
            .send_json(body)
        {
            Ok(r) => r,
            // bitcoind returns HTTP 500 with a JSON body on RPC errors.
            Err(ureq::Error::Status(_, r)) => r,
            Err(e) => return Err(anyhow!("rpc transport error ({method}): {e}")),
        };
        let v: Value = resp
            .into_json()
            .map_err(|e| anyhow!("rpc decode error ({method}): {e}"))?;
        if !v.get("error").map(|e| e.is_null()).unwrap_or(true) {
            return Err(anyhow!("rpc error ({method}): {}", v["error"]));
        }
        Ok(v.get("result").cloned().unwrap_or(Value::Null))
    }
}
