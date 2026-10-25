//! Closed wallet target binding; no database credentials or target creation.
use crate::SpikeResult;
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
};

const IDENTITIES: &str = include_str!("../../../db/target-identities.json");

fn same_path(a: &Path, b: &Path) -> bool {
    let a = a.to_string_lossy().replace('\\', "/");
    let b = b.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        a.eq_ignore_ascii_case(&b)
    } else {
        a == b
    }
}

pub fn resolve_wallet(
    env: &HashMap<String, String>,
    purpose: &str,
) -> SpikeResult<(PathBuf, Option<String>)> {
    if !["signer", "watcher"].contains(&purpose)
        || env.get("ZCASH_NETWORK").map(String::as_str) != Some("testnet")
    {
        return Err("wallet target rejected".into());
    }
    let path = PathBuf::from(env.get("WALLET_DB_PATH").ok_or("wallet target rejected")?);
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err("wallet target rejected".into());
    }
    match env.get("DARKPOOL_PG_ENV").map(String::as_str) {
        Some("TEST") => {
            let text = path.to_string_lossy().replace('\\', "/").to_lowercase();
            if env.get("DARKPOOL_TEST_ONLY").map(String::as_str) != Some("TEST_ONLY")
                || env.contains_key("DARKPOOL_LIVE_INSTANCE")
                || text.contains("/zcashdarkpooldev/postgres-live-evidence/")
                || text.contains("/zcashdarkpooldev/phase9/live_payment_v1/")
            {
                return Err("wallet target rejected".into());
            }
            Ok((path, None))
        }
        Some("TESTNET_OBSERVATION") => {
            // Additional fixed viewer-only binding; never aliases TEST, DEV or LIVE.
            let proposal: serde_json::Value = serde_json::from_str(include_str!(
                "../../rehearsal-preparation/target.proposed.json"
            ))?;
            let expected = PathBuf::from(
                proposal["paths"]["viewer_database"]
                    .as_str()
                    .ok_or("wallet target rejected")?,
            );
            if purpose != "watcher"
                || env.get("DARKPOOL_OBSERVATION_INSTANCE").map(String::as_str)
                    != Some("testnet_observation_v1")
                || env.get("FINANCIAL_AUTHORIZATION").map(String::as_str) != Some("NOT_GRANTED")
                || env.contains_key("DARKPOOL_TEST_ONLY")
                || env.contains_key("DARKPOOL_LIVE_INSTANCE")
                || !same_path(&path, &expected)
            {
                return Err("wallet target rejected".into());
            }
            Ok((expected, None))
        }
        Some("LIVE_EVIDENCE") => {
            let instance = env
                .get("DARKPOOL_LIVE_INSTANCE")
                .ok_or("wallet target rejected")?;
            let registry: serde_json::Value = serde_json::from_str(IDENTITIES)?;
            let entry = registry["LIVE_EVIDENCE"]
                .get(instance)
                .ok_or("wallet target rejected")?;
            if entry["preserved"].as_bool() != Some(false) || env.contains_key("DARKPOOL_TEST_ONLY")
            {
                return Err("wallet target rejected".into());
            }
            let mut expected =
                PathBuf::from(env.get("LOCALAPPDATA").ok_or("wallet target rejected")?);
            if !expected.is_absolute() {
                return Err("wallet target rejected".into());
            }
            expected.push("ZcashDarkPoolDev");
            for part in entry["protected_parts"]
                .as_array()
                .ok_or("wallet target rejected")?
            {
                expected.push(part.as_str().ok_or("wallet target rejected")?);
            }
            expected.push(if purpose == "signer" {
                "signer"
            } else {
                entry["watcher_directory"]
                    .as_str()
                    .ok_or("wallet target rejected")?
            });
            expected.push("data.sqlite");
            if !same_path(&path, &expected) {
                return Err("wallet target rejected".into());
            }
            Ok((expected, Some(instance.clone())))
        }
        _ => Err("wallet target rejected".into()),
    }
}

pub fn configuration(purpose: &str) -> SpikeResult<(PathBuf, Option<String>)> {
    let resolved = resolve_wallet(&std::env::vars().collect(), purpose)?;
    for ancestor in resolved.0.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err("wallet target rejected".into());
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return Err("wallet target rejected".into());
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn observation_fixed_viewer_only_binding_without_wallet_access() {
        let mut env = HashMap::from([
            ("ZCASH_NETWORK".into(), "testnet".into()),
            ("DARKPOOL_PG_ENV".into(), "TESTNET_OBSERVATION".into()),
            (
                "DARKPOOL_OBSERVATION_INSTANCE".into(),
                "testnet_observation_v1".into(),
            ),
            ("FINANCIAL_AUTHORIZATION".into(), "NOT_GRANTED".into()),
            (
                "WALLET_DB_PATH".into(),
                r"C:\ProgramData\ZcashDarkPoolRehearsal\testnet_observation_v1\viewer\data.sqlite"
                    .into(),
            ),
        ]);
        assert!(resolve_wallet(&env, "watcher").is_ok());
        assert!(resolve_wallet(&env, "signer").is_err());
        for (key, value) in [
            ("DARKPOOL_LIVE_INSTANCE", "phase9_payment_v2"),
            ("DARKPOOL_TEST_ONLY", "TEST_ONLY"),
            ("FINANCIAL_AUTHORIZATION", "GRANTED"),
            ("ZCASH_NETWORK", "mainnet"),
        ] {
            let mut changed = env.clone();
            changed.insert(key.into(), value.into());
            assert!(resolve_wallet(&changed, "watcher").is_err());
        }
        env.insert(
            "WALLET_DB_PATH".into(),
            r"C:\Users\example\protected\data.sqlite".into(),
        );
        assert!(resolve_wallet(&env, "watcher").is_err());
    }
    fn v2(purpose: &str) -> HashMap<String, String> {
        let base = std::env::temp_dir().join("darkpool-target-identity-only");
        let path = base
            .join("ZcashDarkPoolDev/postgres-live-evidence/phase9_payment_v2/protected")
            .join(purpose)
            .join("data.sqlite");
        HashMap::from([
            ("LOCALAPPDATA".into(), base.to_string_lossy().into()),
            ("ZCASH_NETWORK".into(), "testnet".into()),
            ("DARKPOOL_PG_ENV".into(), "LIVE_EVIDENCE".into()),
            ("DARKPOOL_LIVE_INSTANCE".into(), "phase9_payment_v2".into()),
            ("WALLET_DB_PATH".into(), path.to_string_lossy().into()),
        ])
    }
    #[test]
    fn approved_v2_watcher_and_signer_are_distinct_without_creating_resources() {
        let watcher = resolve_wallet(&v2("watcher"), "watcher").unwrap();
        let signer = resolve_wallet(&v2("signer"), "signer").unwrap();
        assert_ne!(watcher.0, signer.0);
        assert_eq!(watcher.1.as_deref(), Some("phase9_payment_v2"));
    }
    #[test]
    fn wallet_bindings_reject_unknown_preserved_and_cross_instance_paths() {
        let env = v2("watcher");
        for instance in [
            "phase9_payment_v1",
            "phase9_payment_v3",
            "../phase9_payment_v2",
            "",
        ] {
            let mut changed = env.clone();
            changed.insert("DARKPOOL_LIVE_INSTANCE".into(), instance.into());
            assert!(resolve_wallet(&changed, "watcher").is_err());
        }
        let mut changed = env.clone();
        changed.insert(
            "WALLET_DB_PATH".into(),
            env["WALLET_DB_PATH"].replace("phase9_payment_v2", "phase9_payment_v1"),
        );
        assert!(resolve_wallet(&changed, "watcher").is_err());
        assert!(resolve_wallet(&v2("signer"), "watcher").is_err());
        assert!(resolve_wallet(&v2("watcher"), "signer").is_err());
    }
    #[test]
    fn destructive_test_and_historical_cannot_select_live_wallets() {
        for kind in ["TEST", "HISTORICAL"] {
            let mut env = v2("watcher");
            env.insert("DARKPOOL_PG_ENV".into(), kind.into());
            env.insert("DARKPOOL_TEST_ONLY".into(), "TEST_ONLY".into());
            env.remove("DARKPOOL_LIVE_INSTANCE");
            assert!(resolve_wallet(&env, "watcher").is_err());
        }
    }
}
