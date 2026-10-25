//! Pre-allocation check only: opens existing SQLite read-only; no sync or derivation.
use crate::{SpikeResult, TestnetWallet};
use rand_core::OsRng;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use std::io::Read;
use zcash_client_backend::data_api::{Account, AccountPurpose, AccountSource, WalletRead};
use zcash_client_sqlite::{WalletDb, util::SystemClock};
use zcash_protocol::consensus::Network;

fn context(v: &Value) -> SpikeResult<(&str, &str, &str, u32)> {
    let o = v.as_object().ok_or("invalid unfunded context")?;
    if o.len() != 4
        || ![
            "market_id",
            "vault_context_ref",
            "account_ref",
            "anchor_height",
        ]
        .iter()
        .all(|k| o.contains_key(*k))
    {
        return Err("invalid unfunded context".into());
    }
    let text = |k| -> SpikeResult<&str> {
        let s = v[k].as_str().ok_or("invalid unfunded context")?;
        if s.is_empty() || s.len() > 8192 || s.chars().any(char::is_control) {
            return Err("invalid unfunded context".into());
        }
        Ok(s)
    };
    let height = u32::try_from(v["anchor_height"].as_u64().ok_or("invalid anchor")?)?;
    if height < 11 {
        return Err("invalid anchor".into());
    }
    Ok((
        text("market_id")?,
        text("vault_context_ref")?,
        text("account_ref")?,
        height,
    ))
}

pub fn check() -> SpikeResult<()> {
    let (path, _) = crate::live_target::configuration("watcher")?;
    if std::env::var("DARKPOOL_PG_ENV").as_deref() != Ok("TESTNET_OBSERVATION") {
        return Err("unfunded observation target only".into());
    }
    let mut bytes = Vec::new();
    std::io::stdin().take(32769).read_to_end(&mut bytes)?;
    if bytes.len() > 32768 {
        return Err("unfunded context too large".into());
    }
    let v: Value = serde_json::from_slice(&bytes)?;
    let (market, vault, expected, anchor) = context(&v)?;
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let wallet: TestnetWallet =
        WalletDb::from_connection(conn, Network::TestNetwork, SystemClock, OsRng);
    let ids = wallet.get_account_ids()?;
    let [id] = ids.as_slice() else {
        return Err("one view-only account required".into());
    };
    let a = wallet.get_account(*id)?.ok_or("account missing")?;
    if !matches!(
        a.source(),
        AccountSource::Imported {
            purpose: AccountPurpose::ViewOnly,
            ..
        }
    ) || id.expose_uuid().to_string() != expected
        || wallet.chain_height()?.is_none_or(|h| u32::from(h) < anchor)
    {
        return Err("unfunded viewer not prepared".into());
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='ext_darkpool_context' AND type='table')",
        [], |r| r.get(0),
    )?;
    if exists {
        let bound: Option<(String, String, String)> = conn
            .query_row(
                "SELECT market,vault,account FROM ext_darkpool_context WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some(b) = bound
            && b != (market.into(), vault.into(), expected.into())
        {
            return Err("unfunded journal mismatch".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::context;
    use serde_json::json;
    #[test]
    fn context_only_without_wallet_access() {
        let v =
            json!({"market_id":"m","vault_context_ref":"v","account_ref":"a","anchor_height":100});
        assert!(context(&v).is_ok());
        for v in [
            json!({}),
            json!({"market_id":"m","vault_context_ref":"v","account_ref":"a","anchor_height":10}),
            json!({"market_id":"m","vault_context_ref":"v","account_ref":"a","anchor_height":100,"seed":"forbidden"}),
        ] {
            assert!(context(&v).is_err());
        }
    }
}
