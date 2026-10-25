//! Synthetic gRPC bodies, real maintained sync, real disposable WalletDb and production cache.
//! No sockets, live RPC, raw wallet-row writes, or changes to sync batches/cache bounds.
use super::*;
use http_body_util::{BodyExt, Full};
use std::{
    convert::Infallible,
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};
use tonic::{
    body::Body,
    codegen::{
        Bytes, Service,
        http::{HeaderMap, Request, Response},
    },
};
use zcash_client_backend::{
    data_api::{AccountBirthday, chain::ChainState, scanning::ScanPriority},
    proto::compact_formats::{ChainMetadata, CompactOrchardAction, CompactTx},
};
use zcash_primitives::block::BlockHash;
use zcash_protocol::consensus::{NetworkUpgrade, Parameters};

#[derive(Clone, Copy)]
enum ProgressMode {
    Complete,
    Empty,
    Short,
    ChildEmpty,
    ChildShort,
    Pending(usize),
    TreePending,
    TreeFailure,
    DownloadFailure,
    BareEof,
    LaterPending,
}
#[derive(Clone)]
struct ProgressRpc {
    tip: u32,
    mode: ProgressMode,
    ranges: Arc<Mutex<Vec<(u32, u32)>>>,
}
impl Service<Request<Body>> for ProgressRpc {
    type Response = Response<Body>;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;
    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
    fn call(&mut self, request: Request<Body>) -> Self::Future {
        let rpc = self.clone();
        Box::pin(async move {
            // Socket-free transport still yields, allowing only the harness deadline
            // to bound maintained empty/short retry loops.
            tokio::task::yield_now().await;
            let method = request.uri().path().rsplit('/').next().unwrap().to_owned();
            let bytes = request.into_body().collect().await.unwrap().to_bytes();
            let mut out = Vec::new();
            let mut pending = false;
            let mut status = "0";
            match method.as_str() {
                "GetSubtreeRoots" => {
                    // Canonical synthetic root messages ingested by maintained APIs,
                    // not SQL row edits. Shard metadata is necessary for Verify scheduling.
                    let birthday = Network::TestNetwork
                        .activation_height(NetworkUpgrade::Nu6_3)
                        .unwrap();
                    frame(
                        &service::SubtreeRoot {
                            root_hash: vec![0; 32],
                            completing_block_height: u64::from(u32::from(birthday) - 1),
                            completing_block_hash: hash(u32::from(birthday) - 1),
                        },
                        &mut out,
                    );
                }
                "GetLatestBlock" => frame(
                    &service::BlockId {
                        height: rpc.tip.into(),
                        hash: hash(rpc.tip),
                    },
                    &mut out,
                ),
                "GetBlockRange" => {
                    let r = service::BlockRange::decode(&bytes[5..]).unwrap();
                    let start = r.start.unwrap().height as u32;
                    let end = r.end.unwrap().height as u32;
                    let ordinal = {
                        let mut ranges = rpc.ranges.lock().unwrap();
                        ranges.push((start, end));
                        ranges.len()
                    };
                    let n = (end - start + 1) as usize;
                    let count = match rpc.mode {
                        // Child interruption fixtures pause at the next real Verify
                        // request after observing EMPTY/SHORT, eliminating a kill race
                        // with an unrelated later retry stage. No markers are injected.
                        ProgressMode::ChildEmpty | ProgressMode::ChildShort
                            if ordinal > 1 && n <= 10 =>
                        {
                            pending = true;
                            0
                        }
                        ProgressMode::Empty | ProgressMode::ChildEmpty => 0,
                        ProgressMode::Short | ProgressMode::ChildShort => n / 2,
                        ProgressMode::DownloadFailure => {
                            status = "13";
                            3.min(n)
                        }
                        ProgressMode::Pending(m) => {
                            pending = true;
                            m.min(n)
                        }
                        ProgressMode::LaterPending if ordinal == 4 => {
                            pending = true;
                            0
                        }
                        _ => n,
                    };
                    for h in start..start + count as u32 {
                        frame(&empty_block(h), &mut out);
                    }
                }
                "GetTreeState" => {
                    if matches!(rpc.mode, ProgressMode::TreePending) {
                        pending = true;
                    }
                    if matches!(rpc.mode, ProgressMode::TreeFailure) {
                        status = "13";
                    } else {
                        let id = service::BlockId::decode(&bytes[5..]).unwrap();
                        let mut display = hash(id.height as u32);
                        display.reverse();
                        frame(
                            &service::TreeState {
                                network: "test".into(),
                                height: id.height,
                                hash: hex(&display),
                                ..Default::default()
                            },
                            &mut out,
                        );
                    }
                }
                _ => panic!("unexpected closed fixture method"),
            }
            let mut trailers = HeaderMap::new();
            trailers.insert("grpc-status", status.parse().unwrap());
            let data = Full::new(Bytes::from(out));
            let body = if method == "GetBlockRange" && matches!(rpc.mode, ProgressMode::BareEof) {
                Body::new(data)
            } else {
                Body::new(data.with_trailers(async move {
                    if pending {
                        std::future::pending::<()>().await;
                    }
                    Some(Ok::<_, Infallible>(trailers))
                }))
            };
            Ok(Response::builder()
                .header("content-type", "application/grpc")
                .body(body)
                .unwrap())
        })
    }
}
fn progress_wallet(path: &Path) -> SpikeResult<u32> {
    let h = Network::TestNetwork
        .activation_height(NetworkUpgrade::Nu6_3)
        .unwrap();
    let mut wallet = crate::open_testnet_wallet(path)?;
    crate::import_view_only_account(
        &mut wallet,
        &crate::tests::ephemeral_viewing_key()?,
        &AccountBirthday::from_parts(
            ChainState::empty(h - 1, BlockHash(hash(u32::from(h) - 1).try_into().unwrap())),
            None,
        ),
    )?;
    Ok(u32::from(h))
}
async fn progress_run(
    path: &Path,
    tip: u32,
    mode: ProgressMode,
    enabled: bool,
) -> SpikeResult<(
    progress::Progress,
    Vec<(u32, u32)>,
    Vec<(&'static str, usize, usize)>,
    bool,
)> {
    let p = progress::Progress::new(path, false);
    let cache = MemoryCache::default();
    if enabled {
        cache.1.lock().unwrap().progress = Some(p.clone());
        p.begin();
    }
    let ranges = Arc::new(Mutex::new(Vec::new()));
    let rpc = ProgressRpc {
        tip,
        mode,
        ranges: ranges.clone(),
    };
    let mut wallet = crate::open_testnet_wallet(path)?;
    let success = if enabled {
        let mut client = CompactTxStreamerClient::new(progress::Observed {
            inner: rpc,
            progress: p.clone(),
        });
        let result = tokio::time::timeout(
            Duration::from_millis(if matches!(mode, ProgressMode::Complete) {
                10_000
            } else {
                1_000
            }),
            zcash_client_backend::sync::run(
                &mut client,
                &Network::TestNetwork,
                &cache,
                &mut wallet,
                200,
            ),
        )
        .await;
        match result {
            Ok(r) => {
                p.finish(r.is_ok());
                r.is_ok()
            }
            Err(_) => false,
        }
    } else {
        let mut client = CompactTxStreamerClient::new(rpc);
        zcash_client_backend::sync::run(
            &mut client,
            &Network::TestNetwork,
            &cache,
            &mut wallet,
            200,
        )
        .await
        .is_ok()
    };
    let ranges = ranges.lock().unwrap().clone();
    let events = cache.2.lock().unwrap().clone();
    Ok((p, ranges, events, success))
}
fn progress_rt() -> SpikeResult<tokio::runtime::Runtime> {
    Ok(tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?)
}
fn seed_progress_wallet(path: &Path) -> SpikeResult<u32> {
    let start = progress_wallet(path)?;
    let tip = start + 199;
    assert!(
        progress_rt()?
            .block_on(progress_run(path, tip, ProgressMode::Complete, false))?
            .3
    );
    Ok(tip)
}
#[test]
fn progress_real_empty_short_complete_and_pending() -> SpikeResult<()> {
    let rt = progress_rt()?;
    for (mode, expected, count, terminated) in [
        (ProgressMode::Empty, "EMPTY", 0, true),
        (ProgressMode::Short, "SHORT", 5, true),
        (ProgressMode::Complete, "COMPLETE", 200, true),
        (ProgressMode::BareEof, "COMPLETE", 200, true),
        (ProgressMode::DownloadFailure, "UNKNOWN", 3, true),
        (ProgressMode::Pending(0), "NONE", 0, false),
        (ProgressMode::Pending(3), "NONE", 3, false),
        (ProgressMode::Pending(10), "NONE", 10, false),
    ] {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("disposable.sqlite");
        let old = seed_progress_wallet(&path)?;
        let (p, _, _, success) = rt.block_on(progress_run(&path, old + 200, mode, true))?;
        let events = p.events();
        if matches!(mode, ProgressMode::Complete | ProgressMode::BareEof) {
            assert!(success);
            assert_eq!(p.snapshot()["stage"], "SYNC_COMPLETE");
            assert!(events.iter().any(|e| e["unit_kind"] == "VERIFY"
                && e["coverage"] == "COMPLETE"
                && e["received_count"] == 10));
        } else if terminated {
            assert!(events.iter().any(|e| e["coverage"] == expected
                && e["received_count"] == count
                && e["stream_terminated"] == true));
            if matches!(mode, ProgressMode::DownloadFailure) {
                assert!(!success);
                assert_eq!(p.snapshot()["maintained_returned"], true);
                assert_eq!(p.snapshot()["completed_unit_count"], 0);
                assert_ne!(p.snapshot()["last_completed_stage"], "DOWNLOAD");
            }
        } else {
            let s = p.snapshot();
            assert_eq!(s["stage"], "DOWNLOAD");
            assert_eq!(s["received_count"], count);
            assert_eq!(s["requested_count"], 10);
            assert_eq!(s["unit_kind"], "VERIFY");
            assert_eq!(s["stream_terminated"], false);
            assert_eq!(s["completed_unit_count"], 0);
            assert_eq!(s["maintained_returned"], false);
        }
    }
    Ok(())
}
#[test]
fn progress_real_tree_success_pending_and_failure() -> SpikeResult<()> {
    for mode in [
        ProgressMode::Complete,
        ProgressMode::TreePending,
        ProgressMode::TreeFailure,
    ] {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("disposable.sqlite");
        let old = seed_progress_wallet(&path)?;
        let (p, _, _, success) =
            progress_rt()?.block_on(progress_run(&path, old + 200, mode, true))?;
        if matches!(mode, ProgressMode::Complete) {
            assert!(success);
            assert!(p.events().iter().any(|e|e["last_completed_stage"]=="TREE_STATE" && e["stage"]=="SCAN_WORK"));
        } else {
            assert!(!success);
            assert_eq!(p.snapshot()["stage"], "TREE_STATE");
            assert_ne!(p.snapshot()["last_completed_stage"], "TREE_STATE");
            assert_eq!(p.snapshot()["completed_unit_count"], 0);
            assert_eq!(
                p.snapshot()["maintained_returned"],
                matches!(mode, ProgressMode::TreeFailure)
            );
        }
    }
    Ok(())
}
#[test]
fn progress_real_verify_then_multiple_units_and_later_stall() -> SpikeResult<()> {
    for mode in [ProgressMode::Complete, ProgressMode::LaterPending] {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("disposable.sqlite");
        let old = seed_progress_wallet(&path)?;
        let (p, ranges, _, success) =
            progress_rt()?.block_on(progress_run(&path, old + 610, mode, true))?;
        assert_eq!(
            ranges.iter().map(|(a, b)| b - a + 1).collect::<Vec<_>>(),
            vec![10, 200, 200, 200]
        );
        let events = p.events();
        for stage in [
            "UNIT_ENTER",
            "DOWNLOAD",
            "SCAN_WORK",
            "COMMIT_PENDING",
            "UNIT_COMPLETE",
        ] {
            assert!(
                events
                    .iter()
                    .any(|e| e["stage"] == stage && e["unit_kind"] == "VERIFY"),
                "missing real Verify boundary"
            );
        }
        assert!(
            events
                .iter()
                .any(|e| e["stage"] == "UNIT_ENTER" && e["unit_kind"] == "SCAN")
        );
        assert!(events.iter().any(|e| e["completed_unit_count"] == 1));
        assert_eq!(
            p.snapshot()["completed_unit_count"],
            if success { 4 } else { 3 }
        );
        assert_eq!(
            p.snapshot()["committed_block_count"],
            if success { 610 } else { 410 }
        );
        assert_eq!(
            p.snapshot()["stage"],
            if success { "SYNC_COMPLETE" } else { "DOWNLOAD" }
        );
    }
    Ok(())
}
fn logical_wallet(path: &Path) -> SpikeResult<Vec<Value>> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut query =
        conn.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")?;
    let tables = query
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut result = Vec::new();
    for table in tables {
        let sql = format!("SELECT * FROM \"{}\"", table.replace('"', "\"\""));
        let mut q = conn.prepare(&sql)?;
        let count = q.column_count();
        let mut rows = q.query([])?;
        let mut values = Vec::new();
        while let Some(row) = rows.next()? {
            let mut fields = Vec::new();
            for i in 0..count {
                fields.push(match row.get_ref(i)? {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Integer(n) => json!(n),
                    rusqlite::types::ValueRef::Real(n) => json!(n.to_bits()),
                    rusqlite::types::ValueRef::Text(s) => json!(hex(s)),
                    rusqlite::types::ValueRef::Blob(b) => json!(hex(b)),
                });
            }
            values.push(json!(fields));
        }
        values.sort_by_key(Value::to_string);
        result.push(json!([table, values]));
    }
    Ok(result)
}
#[test]
fn progress_enabled_disabled_real_wallet_semantic_equivalence() -> SpikeResult<()> {
    let dir = tempfile::tempdir()?;
    let base = dir.path().join("base.sqlite");
    let old = seed_progress_wallet(&base)?;
    let off = dir.path().join("off.sqlite");
    let on = dir.path().join("on.sqlite");
    std::fs::copy(&base, &off)?;
    std::fs::copy(&base, &on)?;
    let rt = progress_rt()?;
    let a = rt.block_on(progress_run(&off, old + 600, ProgressMode::Complete, false))?;
    let b = rt.block_on(progress_run(&on, old + 600, ProgressMode::Complete, true))?;
    assert!(a.3 && b.3);
    assert_eq!(a.1, b.1);
    assert_eq!(a.2, b.2);
    // Includes all three pool tree/checkpoint tables, transactions/outputs and final queue.
    // Avoid printing ephemeral viewing material if equality fails.
    assert!(
        logical_wallet(&off)? == logical_wallet(&on)?,
        "diagnostics changed logical wallet state"
    );
    Ok(())
}
#[test]
fn progress_os_child_writer_fixture() -> SpikeResult<()> {
    let Ok(stage) = env::var("DARKPOOL_PROGRESS_TEST_CHILD_STAGE") else {
        return Ok(());
    };
    let path = std::path::PathBuf::from(env::var("DARKPOOL_PROGRESS_TEST_WALLET")?);
    let old = seed_progress_wallet(&path)?;
    let p = progress::Progress::new(&path, true);
    let cache = MemoryCache::default();
    cache.1.lock().unwrap().progress = Some(p.clone());
    let rpc = ProgressRpc {
        tip: old + 200,
        mode: match stage.as_str() {
            "TREE_STATE" => ProgressMode::TreePending,
            "EMPTY" => ProgressMode::ChildEmpty,
            "SHORT" => ProgressMode::ChildShort,
            _ => ProgressMode::Pending(3),
        },
        ranges: Arc::default(),
    };
    let mut client = CompactTxStreamerClient::new(progress::Observed {
        inner: rpc,
        progress: p.clone(),
    });
    let mut wallet = crate::open_testnet_wallet(&path)?;
    p.begin();
    progress_rt()?.block_on(zcash_client_backend::sync::run(
        &mut client,
        &Network::TestNetwork,
        &cache,
        &mut wallet,
        200,
    ))?;
    Err("pending child fixture unexpectedly completed".into())
}
#[test]
fn progress_full_snapshot_encrypted_note_and_final_tip_equivalence() -> SpikeResult<()> {
    use zcash_client_backend::data_api::testing::{AddressType, IronwoodFvk, TestFvk};
    use zcash_protocol::value::Zatoshis;
    let dir = tempfile::tempdir()?;
    let base = dir.path().join("base.sqlite");
    let h = Network::TestNetwork
        .activation_height(NetworkUpgrade::Nu6_3)
        .unwrap();
    let start = u32::from(h);
    let target = start + 399;
    let viewing = crate::tests::ephemeral_viewing_key()?;
    let fvk = IronwoodFvk(viewing.orchard().unwrap().clone());
    let mut wallet = crate::open_testnet_wallet(&base)?;
    let account = crate::import_view_only_account(
        &mut wallet,
        &viewing,
        &AccountBirthday::from_parts(
            ChainState::empty(h - 1, BlockHash(hash(start - 1).try_into().unwrap())),
            None,
        ),
    )?;
    wallet.update_chain_tip(BlockHeight::from_u32(target))?;
    drop(wallet);
    let allocation = crate::issuance::allocate(
        &base,
        "offline",
        "offline",
        &"12".repeat(32),
        &"ab".repeat(32),
    )?;
    let index: [u8; 11] = bytes(&allocation.diversifier)?.try_into().unwrap();
    let mut tx = CompactTx {
        index: 7,
        txid: vec![0x25; 32],
        ..Default::default()
    };
    fvk.add_output(
        &mut tx,
        &Network::TestNetwork,
        BlockHeight::from_u32(target),
        None,
        AddressType::DiversifiedExternal(index.into()),
        Zatoshis::from_u64(1000)?,
        0,
        &mut OsRng,
    );
    let mut blocks: BTreeMap<_, _> = (start..=target + 2).map(|h| (h, empty_block(h))).collect();
    blocks.get_mut(&target).unwrap().vtx.push(tx);
    blocks
        .get_mut(&target)
        .unwrap()
        .chain_metadata
        .as_mut()
        .unwrap()
        .ironwood_commitment_tree_size = 1;
    let blocks = Arc::new(blocks);
    let context = json!({"network":"testnet","market_id":"offline","vault_context_ref":"offline","account_ref":account.expose_uuid().to_string(),"anchor_height":target-20,"anchor_hash":hex(&hash(target-20)),"closes_at_us":format!("{}.000000",(1_700_000_000u64+u64::from(target)-10)*1_000_000),"receipts":[],"unmapped":[]});
    let rt = progress_rt()?;
    let mut results = Vec::new();
    let mut states = Vec::new();
    let mut request_logs = Vec::new();
    for enabled in [false, true] {
        let path = dir
            .path()
            .join(if enabled { "on.sqlite" } else { "off.sqlite" });
        std::fs::copy(&base, &path)?;
        let diagnostics = DiagnosticState::default();
        let p = progress::Progress::new(&path, false);
        if enabled {
            diagnostics.lock().unwrap().progress = Some(p.clone());
        }
        let requests = Arc::new(Mutex::new(Vec::new()));
        let rpc = SnapshotRpc {
            tip: target,
            blocks: blocks.clone(),
            wallet: path.clone(),
            diagnostics: diagnostics.clone(),
            latest_calls: Arc::default(),
            caught_up: Arc::default(),
            requests: requests.clone(),
            canonical_h_checked: Arc::default(),
            case: SnapshotCase::Forward,
        };
        let mut result = if enabled {
            let transport = progress::Observed {
                inner: rpc,
                progress: p.clone(),
            };
            let mut client = CompactTxStreamerClient::with_interceptor(
                transport,
                StageInterceptor(diagnostics.clone()),
            );
            rt.block_on(synchronize_with_client(
                &path,
                &context,
                None,
                &diagnostics,
                &mut client,
            ))?
        } else {
            let mut client = CompactTxStreamerClient::with_interceptor(
                rpc,
                StageInterceptor(diagnostics.clone()),
            );
            rt.block_on(synchronize_with_client(
                &path,
                &context,
                None,
                &diagnostics,
                &mut client,
            ))?
        };
        assert_eq!(result["outputs"].as_array().unwrap().len(), 1);
        result["chain"]
            .as_object_mut()
            .unwrap()
            .remove("verified_at_epoch");
        if enabled {
            assert_eq!(p.snapshot()["stage"], "SYNC_COMPLETE");
            assert_eq!(p.snapshot()["completed_unit_count"], 2);
        } else {
            assert!(p.events().is_empty());
        }
        results.push(result);
        states.push(logical_wallet(&path)?);
        request_logs.push(requests.lock().unwrap().clone());
    }
    assert!(
        results[0] == results[1],
        "diagnostics changed private snapshot/economic observation"
    );
    assert!(
        states[0] == states[1],
        "diagnostics changed encrypted-note wallet/tree/checkpoint state"
    );
    assert_eq!(request_logs[0], request_logs[1]);
    Ok(())
}

fn hash(h: u32) -> Vec<u8> {
    let mut b = vec![0; 32];
    b[..4].copy_from_slice(&h.to_le_bytes());
    b
}
fn empty_block(h: u32) -> CompactBlock {
    CompactBlock {
        height: h.into(),
        hash: hash(h),
        prev_hash: hash(h - 1),
        time: 1_700_000_000 + h,
        chain_metadata: Some(ChainMetadata::default()),
        ..Default::default()
    }
}
fn frame<M: Message>(message: &M, out: &mut Vec<u8>) {
    let bytes = message.encode_to_vec();
    out.push(0);
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(&bytes);
}
#[derive(Clone)]
struct FixtureRpc {
    tip: u32,
    wallet: std::path::PathBuf,
    cache: Arc<MemoryCache>,
    completed: Arc<Mutex<Vec<(u32, usize, usize)>>>,
    message_size: Option<usize>,
}
impl Service<Request<Body>> for FixtureRpc {
    type Response = Response<Body>;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;
    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
    fn call(&mut self, request: Request<Body>) -> Self::Future {
        let fixture = self.clone();
        Box::pin(async move {
            let method = request.uri().path().rsplit('/').next().unwrap().to_owned();
            let data = request.into_body().collect().await.unwrap().to_bytes();
            let payload = &data[5..];
            let mut out = Vec::new();
            match method.as_str() {
                "GetSubtreeRoots" => {}
                "GetLatestBlock" => frame(
                    &service::BlockId {
                        height: fixture.tip.into(),
                        hash: hash(fixture.tip),
                    },
                    &mut out,
                ),
                "GetBlockRange" => {
                    let range = service::BlockRange::decode(payload).unwrap();
                    let start = range.start.unwrap().height as u32;
                    let end = range.end.unwrap().height as u32;
                    let conn = Connection::open_with_flags(
                        &fixture.wallet,
                        OpenFlags::SQLITE_OPEN_READ_ONLY,
                    )
                    .unwrap();
                    let height: Option<u32> = conn
                        .query_row("SELECT MAX(height) FROM blocks", [], |r| r.get(0))
                        .unwrap();
                    if let Some(height) = height {
                        let d = fixture.cache.1.lock().unwrap();
                        fixture.completed.lock().unwrap().push((
                            height,
                            d.cache_blocks,
                            d.cache_bytes,
                        ));
                    }
                    assert_eq!(end - start + 1, 200);
                    for h in start..=end {
                        frame(&empty_block(h), &mut out);
                    }
                }
                "GetTreeState" => {
                    let id = service::BlockId::decode(payload).unwrap();
                    let mut display_hash = hash(id.height as u32);
                    display_hash.reverse();
                    frame(
                        &service::TreeState {
                            network: "test".into(),
                            height: id.height,
                            hash: hex(&display_hash),
                            ..Default::default()
                        },
                        &mut out,
                    );
                }
                "GetBlock" => {
                    let mut b = empty_block(fixture.tip);
                    let target = fixture.message_size.unwrap();
                    if target == 0 {
                        // Valid gRPC envelope, malformed protobuf payload.
                        out.extend_from_slice(&[0, 0, 0, 0, 1, 255]);
                    } else {
                        // Header padding tests codec size only; this is not a consensus block fixture.
                        b.header.resize(target - b.encoded_len() - 5, 0);
                        assert_eq!(b.encoded_len(), target);
                        frame(&b, &mut out);
                    }
                }
                _ => panic!("unexpected synthetic method"),
            }
            let mut trailers = HeaderMap::new();
            trailers.insert("grpc-status", "0".parse().unwrap());
            let body = Full::new(Bytes::from(out))
                .with_trailers(async move { Some(Ok::<_, Infallible>(trailers)) });
            Ok(Response::builder()
                .header("content-type", "application/grpc")
                .body(Body::new(body))
                .unwrap())
        })
    }
}
struct FixtureResult {
    events: Vec<(&'static str, usize, usize)>,
    completed: Vec<(u32, usize, usize)>,
    scanned: u32,
    failure: Option<Diagnostic>,
    final_blocks: usize,
    final_bytes: usize,
    committed_blocks: u32,
}
fn run_fixture(n: u32) -> SpikeResult<FixtureResult> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("synthetic.sqlite");
    let h = Network::TestNetwork
        .activation_height(NetworkUpgrade::Nu6_3)
        .unwrap();
    let start = u32::from(h);
    let mut wallet = crate::open_testnet_wallet(&path)?;
    crate::import_view_only_account(
        &mut wallet,
        &crate::tests::ephemeral_viewing_key()?,
        &AccountBirthday::from_parts(
            ChainState::empty(h - 1, BlockHash(hash(start - 1).try_into().unwrap())),
            None,
        ),
    )?;
    let cache = Arc::new(MemoryCache::default());
    let completed = Arc::new(Mutex::new(Vec::new()));
    let rpc = FixtureRpc {
        tip: start + n - 1,
        wallet: path.clone(),
        cache: Arc::clone(&cache),
        completed: Arc::clone(&completed),
        message_size: None,
    };
    let mut client = CompactTxStreamerClient::new(rpc);
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = rt.block_on(zcash_client_backend::sync::run(
        &mut client,
        &Network::TestNetwork,
        cache.as_ref(),
        &mut wallet,
        200,
    ));
    let failure = result.err().map(|e| sync_failure(e, &cache.1).0);
    let scanned = u32::from(wallet.block_fully_scanned()?.unwrap().block_height()) - start + 1;
    let events = cache.2.lock().unwrap().clone();
    let completed = completed.lock().unwrap().clone();
    let blocks = cache.0.lock().unwrap();
    let final_blocks = blocks.len();
    let final_bytes = blocks.values().map(Message::encoded_len).sum();
    let read = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let committed_blocks = read.query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get(0))?;
    Ok(FixtureResult {
        events,
        completed,
        scanned,
        failure,
        final_blocks,
        final_bytes,
        committed_blocks,
    })
}
fn assert_maintained_batched_sync(n: u32) -> SpikeResult<()> {
    let result = run_fixture(n)?;
    assert!(result.failure.is_none(), "synthetic maintained sync failed");
    assert_eq!(result.scanned, n);
    assert_eq!(result.committed_blocks, n);
    assert_eq!(result.final_blocks, 0);
    assert_eq!(result.final_bytes, 0);
    let batches = n / 200;
    let start = u32::from(
        Network::TestNetwork
            .activation_height(NetworkUpgrade::Nu6_3)
            .unwrap(),
    );
    let batch_bytes = empty_block(start).encoded_len() * 200;
    assert_eq!(result.events.len(), batches as usize * 2);
    let (pairs, remainder) = result.events.as_chunks::<2>();
    assert!(remainder.is_empty());
    for pair in pairs {
        assert_eq!(
            *pair,
            [("CACHE_INSERT", 200, batch_bytes), ("CACHE_DELETE", 0, 0)]
        );
    }
    // Before the next download, prior scans have committed and their cache ranges
    // have already gone, although upstream still holds the completed result futures.
    assert_eq!(result.completed.len(), batches as usize - 1);
    for (i, &(height, blocks, bytes)) in result.completed.iter().enumerate() {
        assert_eq!(height, start + (i as u32 + 1) * 200 - 1);
        assert_eq!((blocks, bytes), (0, 0));
    }
    let max_blocks = result.events.iter().map(|e| e.1).max().unwrap();
    let max_bytes = result.events.iter().map(|e| e.2).max().unwrap();
    assert_eq!(max_blocks, 200);
    assert_eq!(max_bytes, batch_bytes);
    println!(
        "synthetic maintained sync: blocks={n}, committed_batches={batches}, max_resident={max_blocks}, max_encoded_bytes={max_bytes}, final_resident=0, final_bytes=0"
    );
    Ok(())
}
#[test]
fn maintained_sync_four_batches_delete_at_call_time() -> SpikeResult<()> {
    assert_maintained_batched_sync(800)
}
#[test]
fn maintained_sync_8400_completes_with_bounded_residency() -> SpikeResult<()> {
    assert_maintained_batched_sync(8400)
}
#[test]
fn maintained_sync_16800_headroom_has_same_residency() -> SpikeResult<()> {
    assert_maintained_batched_sync(16800)
}
fn range(start: u32, end: u32) -> ScanRange {
    ScanRange::from_parts(
        BlockHeight::from_u32(start)..BlockHeight::from_u32(end),
        ScanPriority::Historic,
    )
}
fn resident(cache: &MemoryCache) -> BTreeMap<u32, CompactBlock> {
    cache.0.lock().unwrap().clone()
}
fn assert_accounting(cache: &MemoryCache, blocks: &BTreeMap<u32, CompactBlock>) {
    let d = cache.1.lock().unwrap();
    assert_eq!(d.cache_blocks, blocks.len());
    assert_eq!(
        d.cache_bytes,
        blocks.values().map(Message::encoded_len).sum::<usize>()
    );
}
#[test]
fn unpolled_delete_removes_only_requested_blocks_and_accounts_immediately() -> SpikeResult<()> {
    let cache = MemoryCache::default();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    rt.block_on(cache.insert((100..106).map(empty_block).collect()))?;
    let before = resident(&cache);
    let pending = cache.delete(range(101, 104)); // Never poll or await this future.
    let after = resident(&cache);
    let expected = before
        .iter()
        .filter(|(h, _)| !(101..104).contains(*h))
        .map(|(h, b)| (*h, b.clone()))
        .collect();
    assert_eq!(after, expected);
    assert_eq!(
        after.keys().copied().collect::<Vec<_>>(),
        vec![100, 104, 105]
    );
    assert_accounting(&cache, &after);
    assert_eq!(cache.1.lock().unwrap().cache_blocks, 3);
    assert!(cache.1.lock().unwrap().cache_bytes < before.values().map(Message::encoded_len).sum());
    drop(pending);
    assert_eq!(resident(&cache), after);
    assert_accounting(&cache, &after);
    Ok(())
}
#[test]
fn delete_preserves_full_subset_absent_idempotent_and_boundary_semantics() -> SpikeResult<()> {
    let cache = MemoryCache::default();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let heights = [0, 1, 2, 3, u32::MAX - 1, u32::MAX];
    let blocks = heights
        .into_iter()
        .map(|h| CompactBlock {
            height: h.into(),
            hash: hash(h),
            ..Default::default()
        })
        .collect();
    rt.block_on(cache.insert(blocks))?;
    for (start, end, expected) in [
        (1, 3, vec![0, 3, u32::MAX - 1, u32::MAX]),
        (1, 3, vec![0, 3, u32::MAX - 1, u32::MAX]),
        (10, 20, vec![0, 3, u32::MAX - 1, u32::MAX]),
        (3, 3, vec![0, 3, u32::MAX - 1, u32::MAX]),
        (u32::MAX - 1, u32::MAX, vec![0, 3, u32::MAX]),
        (0, 4, vec![u32::MAX]),
    ] {
        let pending = cache.delete(range(start, end));
        let actual = resident(&cache);
        assert_eq!(actual.keys().copied().collect::<Vec<_>>(), expected);
        assert_accounting(&cache, &actual);
        rt.block_on(pending)?;
        assert_eq!(resident(&cache), actual);
    }
    // The exclusive upper boundary cannot include u32::MAX, matching the old
    // ScanRange contract. A normal representable full range removes all entries.
    let cache = MemoryCache::default();
    rt.block_on(cache.insert((100..106).map(empty_block).collect()))?;
    let pending = cache.delete(range(100, 106));
    assert!(resident(&cache).is_empty());
    assert_accounting(&cache, &resident(&cache));
    rt.block_on(pending)?;
    Ok(())
}
#[test]
fn immediate_delete_preserves_mutex_error_in_ready_future() -> SpikeResult<()> {
    let cache = MemoryCache::default();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    rt.block_on(cache.insert(vec![empty_block(100)]))?;
    let before = resident(&cache);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = cache.0.lock().unwrap();
            panic!("synthetic cache mutex poison");
        }))
        .is_err()
    );
    let pending = cache.delete(range(100, 101));
    assert_eq!(**cache.0.lock().unwrap_err().get_ref(), before);
    assert_accounting(&cache, &before);
    let error = rt.block_on(pending).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::Other);
    assert_eq!(error.to_string(), "cache unavailable");
    let error: zcash_client_backend::sync::Error<std::io::Error, std::io::Error, std::io::Error> =
        zcash_client_backend::sync::Error::Cache(error);
    assert_eq!(
        sync_failure(error, &cache.1).0.class,
        FailureClass::CacheError
    );
    Ok(())
}
#[test]
fn resident_block_limit_still_rejects_8193_without_deletion() -> SpikeResult<()> {
    let cache = MemoryCache::default();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    rt.block_on(cache.insert((5_000_000..5_008_192).map(empty_block).collect()))?;
    assert_eq!(cache.1.lock().unwrap().cache_blocks, 8192);
    let error = rt
        .block_on(cache.insert(vec![empty_block(5_008_192)]))
        .unwrap_err();
    let mut d = cache.1.lock().unwrap().clone();
    d.classify(&error, FailureClass::CacheError);
    assert_eq!(d.class, FailureClass::CacheLimit);
    assert_eq!(d.cache_blocks, 8193);
    Ok(())
}
#[test]
fn realistic_compact_shape_crosses_encoded_byte_bound() -> SpikeResult<()> {
    let cache = MemoryCache::default();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    // 100 transactions x 16 actions: 1600 fixed-width action descriptions/block.
    // Encodings have real compact-field sizes; cryptography is intentionally not scanned here.
    let action = CompactOrchardAction {
        nullifier: vec![1; 32],
        cmx: vec![2; 32],
        ephemeral_key: vec![3; 32],
        ciphertext: vec![4; 52],
    };
    let tx = CompactTx {
        txid: vec![5; 32],
        ironwood_actions: vec![action; 16],
        ..Default::default()
    };
    let mut block = empty_block(5_000_000);
    block.vtx = vec![tx; 100];
    let size = block.encoded_len();
    assert!(size < MAX_FRAME);
    assert!((200_000..300_000).contains(&size));
    let limit_blocks = MAX_BLOCK_BYTES / size;
    for i in 0..=limit_blocks {
        let mut b = block.clone();
        b.height += i as u64;
        let result = rt.block_on(cache.insert(vec![b]));
        if i < limit_blocks {
            result?
        } else {
            let mut d = cache.1.lock().unwrap().clone();
            d.classify(&result.unwrap_err(), FailureClass::CacheError);
            assert_eq!(d.class, FailureClass::CacheLimit);
            assert_eq!(d.cache_blocks, limit_blocks + 1);
            assert!(d.cache_bytes > MAX_BLOCK_BYTES);
            println!(
                "synthetic byte limit: per_block={size}, below={} blocks/{} bytes, above={} blocks/{} bytes",
                limit_blocks,
                limit_blocks * size,
                d.cache_blocks,
                d.cache_bytes
            );
        }
    }
    Ok(())
}
#[test]
fn tonic_default_message_boundary_is_preserved_and_classified() -> SpikeResult<()> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    for size in [MAX_FRAME - 1, MAX_FRAME + 1] {
        let rpc = FixtureRpc {
            tip: 5_000_000,
            wallet: Default::default(),
            cache: Arc::new(MemoryCache::default()),
            completed: Default::default(),
            message_size: Some(size),
        };
        let mut client = CompactTxStreamerClient::new(rpc);
        let result = rt.block_on(client.get_block(service::BlockId::default()));
        if size < MAX_FRAME {
            assert_eq!(result?.into_inner().encoded_len(), size);
        } else {
            let e = result.unwrap_err();
            let mut d = Diagnostic::default();
            d.classify(&e, FailureClass::RpcStatus);
            assert_eq!(d.class, FailureClass::RpcMessageLimit);
            assert_eq!(d.grpc_code, Some(11));
        }
    }
    Ok(())
}
#[test]
fn diagnostic_classes_use_codes_and_never_arbitrary_error_text() {
    let state = DiagnosticState::default();
    let history = history_limit(&state, 200, MAX_BLOCK_BYTES + 1);
    assert_eq!(history.0.class, FailureClass::HistoryLimit);
    assert_eq!(history.0.stage, "CLOSE_HISTORY");
    assert_eq!(history.0.cache_bytes, MAX_BLOCK_BYTES + 1);
    assert_eq!(history.0.range, None);
    let mut d = Diagnostic::default();
    d.classify(
        &tonic::Status::deadline_exceeded("SECRET"),
        FailureClass::RpcStatus,
    );
    assert_eq!(d.class, FailureClass::RpcTimeout);
    assert!(!d.value().to_string().contains("SECRET"));
    let error = rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(5), Some("SECRET".into()));
    d.classify(&error, FailureClass::ScanError);
    assert_eq!(d.class, FailureClass::SqliteBusy);
    assert_eq!(d.sqlite_code, Some(5));
    let error =
        rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(11), Some("SECRET".into()));
    d.classify(&error, FailureClass::ScanError);
    assert_eq!(d.class, FailureClass::SqliteError);
    assert!(!d.value().to_string().contains("SECRET"));
    d.classify(
        &rustls::Error::General("SECRET".into()),
        FailureClass::RpcConnect,
    );
    assert_eq!(d.class, FailureClass::TlsConnect);
    d.classify(
        &std::io::Error::other(rustls::Error::General("SECRET".into())),
        FailureClass::RpcConnect,
    );
    assert_eq!(d.class, FailureClass::TlsConnect);
    d.classify(
        &tonic::Status::unavailable("SECRET"),
        FailureClass::ChainValidation,
    );
    assert_eq!(d.class, FailureClass::RpcStatus);
    assert_eq!(d.grpc_code, Some(14));
    assert!(!d.value().to_string().contains("SECRET"));
}

#[test]
fn malformed_protobuf_transport_is_classified_without_retaining_payload() -> SpikeResult<()> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let rpc = FixtureRpc {
        tip: 5_000_000,
        wallet: Default::default(),
        cache: Arc::new(MemoryCache::default()),
        completed: Default::default(),
        message_size: Some(0),
    };
    let mut client = CompactTxStreamerClient::new(rpc);
    let e = rt
        .block_on(client.get_block(service::BlockId::default()))
        .unwrap_err();
    let mut d = Diagnostic::default();
    d.classify(&e, FailureClass::RpcStatus);
    assert_eq!(d.class, FailureClass::RpcDecode);
    assert_eq!(d.grpc_code, Some(13));
    Ok(())
}

#[derive(Clone, Copy)]
enum SnapshotCase {
    NoOutputsLarge,
    MissingSeed,
    MissingSeedIncomplete,
    MissingSeedConflict,
    WitnessConflict,
    WitnessFirstConflict,
    TargetPrevConflict,
    MissingContainingBlock,
    UnmappedExternal,
    OutputActionIndex,
    Stable,
    Forward,
    ForwardOne,
    ForwardLarge,
    AdvancedFork,
    Behind,
    AdvancedBlockHeight,
    AdvancedBlockHash,
    AdvancedBlockPrevHash,
    CompleteHash,
    EqualHeightFork,
    AdvertisedHash,
    BlockHeight,
    BlockHash,
    BlockPrevHash,
    OutputIndex,
    OutputTxId,
}
#[derive(Clone)]
struct SnapshotRpc {
    tip: u32,
    blocks: Arc<BTreeMap<u32, CompactBlock>>,
    wallet: std::path::PathBuf,
    diagnostics: DiagnosticState,
    latest_calls: Arc<Mutex<usize>>,
    // Fully/max persisted, remaining work, cache blocks/bytes at close-history entry.
    caught_up: Arc<Mutex<Option<CatchupRecord>>>,
    requests: Arc<Mutex<Vec<(String, u32, u32)>>>,
    canonical_h_checked: Arc<Mutex<Option<SystemTime>>>,
    case: SnapshotCase,
}
type CatchupRecord = (u32, u32, usize, usize, usize);
impl Service<Request<Body>> for SnapshotRpc {
    type Response = Response<Body>;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;
    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
    fn call(&mut self, request: Request<Body>) -> Self::Future {
        let f = self.clone();
        Box::pin(async move {
            let method = request.uri().path().rsplit('/').next().unwrap().to_owned();
            let data = request.into_body().collect().await.unwrap().to_bytes();
            let payload = &data[5..];
            let mut out = Vec::new();
            match method.as_str() {
                "GetLightdInfo" => frame(
                    &service::LightdInfo {
                        chain_name: "test".into(),
                        ..Default::default()
                    },
                    &mut out,
                ),
                "GetSubtreeRoots" => {}
                "GetLatestBlock" => {
                    let mut calls = f.latest_calls.lock().unwrap();
                    *calls += 1;
                    let final_tip = *calls >= 3;
                    let height = if final_tip {
                        match f.case {
                            SnapshotCase::ForwardOne => f.tip + 1,
                            SnapshotCase::ForwardLarge => f.tip + 10_000,
                            SnapshotCase::Forward
                            | SnapshotCase::AdvancedFork
                            | SnapshotCase::AdvancedBlockHeight
                            | SnapshotCase::AdvancedBlockHash
                            | SnapshotCase::AdvancedBlockPrevHash => f.tip + 2,
                            SnapshotCase::Behind => f.tip - 1,
                            _ => f.tip,
                        }
                    } else {
                        f.tip
                    };
                    let mut advertised = hash(height);
                    if final_tip
                        && matches!(
                            f.case,
                            SnapshotCase::EqualHeightFork | SnapshotCase::AdvertisedHash
                        )
                    {
                        advertised[31] = 1;
                    }
                    if !final_tip && *calls == 1 && matches!(f.case, SnapshotCase::CompleteHash) {
                        advertised[31] = 1;
                    }
                    frame(
                        &service::BlockId {
                            height: height.into(),
                            hash: advertised,
                        },
                        &mut out,
                    );
                }
                "GetBlock" => {
                    let id = service::BlockId::decode(payload).unwrap();
                    let h = id.height as u32;
                    f.requests.lock().unwrap().push((method, h, h));
                    let mut b = f.blocks.get(&h).cloned().unwrap_or_else(|| empty_block(h));
                    let calls = *f.latest_calls.lock().unwrap();
                    let target_reads = f
                        .requests
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|(m, height, _)| m == "GetBlock" && *height == f.tip)
                        .count();
                    if calls == 2
                        && h == f.tip
                        && target_reads >= 3
                        && matches!(f.case, SnapshotCase::MissingContainingBlock)
                    {
                        return Ok(Response::builder()
                            .header("content-type", "application/grpc")
                            .header("grpc-status", "5")
                            .body(Body::new(Full::new(Bytes::new())))
                            .unwrap());
                    }
                    if calls == 2
                        && h == f.tip
                        && matches!(f.case, SnapshotCase::TargetPrevConflict)
                    {
                        b.prev_hash[31] ^= 1;
                    }
                    if calls >= 2 && h == f.tip {
                        match f.case {
                            SnapshotCase::OutputIndex => b.vtx[0].index += 1,
                            SnapshotCase::OutputActionIndex => b.vtx[0].ironwood_actions.clear(),
                            SnapshotCase::OutputTxId => b.vtx[0].txid[31] ^= 1,
                            _ => {}
                        }
                    }
                    if calls == 1 && h == f.tip && matches!(f.case, SnapshotCase::CompleteHash) {
                        b.hash[31] = 1;
                    }
                    if calls >= 3 {
                        match f.case {
                            SnapshotCase::EqualHeightFork => b.hash[31] = 1,
                            SnapshotCase::BlockHeight => b.height += 1,
                            SnapshotCase::BlockHash => {
                                b.hash.pop();
                            }
                            SnapshotCase::BlockPrevHash => {
                                b.prev_hash.pop();
                            }
                            _ => {}
                        }
                        if h == f.tip {
                            match f.case {
                                SnapshotCase::AdvancedFork => b.hash[31] = 1,
                                SnapshotCase::AdvancedBlockHeight => b.height += 1,
                                SnapshotCase::AdvancedBlockHash => {
                                    b.hash.pop();
                                }
                                SnapshotCase::AdvancedBlockPrevHash => {
                                    b.prev_hash.pop();
                                }
                                _ => {}
                            }
                            *f.canonical_h_checked.lock().unwrap() = Some(SystemTime::now());
                        }
                    }
                    frame(&b, &mut out);
                }
                "GetBlockRange" => {
                    let r = service::BlockRange::decode(payload).unwrap();
                    let start = r.start.unwrap().height as u32;
                    let end = r.end.unwrap().height as u32;
                    f.requests.lock().unwrap().push((method, start, end));
                    let read =
                        Connection::open_with_flags(&f.wallet, OpenFlags::SQLITE_OPEN_READ_ONLY)
                            .unwrap();
                    let max: Option<u32> = read
                        .query_row("SELECT MAX(height) FROM blocks", [], |r| r.get(0))
                        .unwrap();
                    let post_scan = max == Some(f.tip);
                    if post_scan {
                        assert!(
                            end - start < 13,
                            "post-sync full-span materialization returned"
                        );
                        let wallet = WalletDb::from_connection(
                            read,
                            Network::TestNetwork,
                            SystemClock,
                            OsRng,
                        );
                        let fully = u32::from(
                            wallet
                                .block_fully_scanned()
                                .unwrap()
                                .unwrap()
                                .block_height(),
                        );
                        let work = wallet.suggest_scan_ranges().unwrap().len();
                        let d = f.diagnostics.lock().unwrap();
                        *f.caught_up.lock().unwrap() =
                            Some((fully, max.unwrap(), work, d.cache_blocks, d.cache_bytes));
                    }
                    for h in start..=end {
                        if post_scan
                            && matches!(f.case, SnapshotCase::MissingSeedIncomplete)
                            && h == end
                        {
                            continue;
                        }
                        let mut b = f.blocks.get(&h).cloned().unwrap_or_else(|| empty_block(h));
                        if post_scan
                            && h == start
                            && matches!(f.case, SnapshotCase::WitnessFirstConflict)
                        {
                            b.prev_hash[31] ^= 1;
                        }
                        if post_scan
                            && h == start + 1
                            && (matches!(f.case, SnapshotCase::MissingSeedConflict)
                                || (matches!(f.case, SnapshotCase::WitnessConflict)
                                    && end - start == 12))
                        {
                            b.prev_hash[31] ^= 1;
                        }
                        if post_scan && h == f.tip {
                            match f.case {
                                SnapshotCase::OutputIndex => b.vtx[0].index += 1,
                                SnapshotCase::OutputTxId => b.vtx[0].txid[31] ^= 1,
                                _ => {}
                            }
                        }
                        frame(&b, &mut out);
                    }
                }
                "GetTreeState" => {
                    let id = service::BlockId::decode(payload).unwrap();
                    let mut display = hash(id.height as u32);
                    display.reverse();
                    // The encrypted note is in the final block: every batch-start frontier is empty.
                    frame(
                        &service::TreeState {
                            network: "test".into(),
                            height: id.height,
                            hash: hex(&display),
                            ..Default::default()
                        },
                        &mut out,
                    );
                }
                _ => panic!("unexpected offline snapshot method"),
            }
            let mut trailers = HeaderMap::new();
            trailers.insert("grpc-status", "0".parse().unwrap());
            let body = Full::new(Bytes::from(out))
                .with_trailers(async move { Some(Ok::<_, Infallible>(trailers)) });
            Ok(Response::builder()
                .header("content-type", "application/grpc")
                .body(Body::new(body))
                .unwrap())
        })
    }
}

fn snapshot_fixture(case: SnapshotCase, n: u32) -> SpikeResult<(Result<Value, Diagnostic>, u32)> {
    use zcash_client_backend::data_api::testing::{AddressType, IronwoodFvk, TestFvk};
    use zcash_protocol::value::Zatoshis;
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("offline-snapshot.sqlite");
    let h = Network::TestNetwork
        .activation_height(NetworkUpgrade::Nu6_3)
        .unwrap();
    let start = u32::from(h);
    let target = start + n - 1;
    let no_outputs = matches!(case, SnapshotCase::NoOutputsLarge);
    let anchor = if no_outputs
        || matches!(
            case,
            SnapshotCase::MissingSeed
                | SnapshotCase::MissingSeedIncomplete
                | SnapshotCase::MissingSeedConflict
                | SnapshotCase::WitnessConflict
        ) {
        start
    } else {
        target - 20
    };
    let viewing = crate::tests::ephemeral_viewing_key()?;
    let fvk = IronwoodFvk(viewing.orchard().unwrap().clone());
    let mut wallet = crate::open_testnet_wallet(&path)?;
    let account = crate::import_view_only_account(
        &mut wallet,
        &viewing,
        &AccountBirthday::from_parts(
            ChainState::empty(h - 1, BlockHash(hash(start - 1).try_into().unwrap())),
            None,
        ),
    )?;
    wallet.update_chain_tip(BlockHeight::from_u32(target))?;
    drop(wallet);
    // Disposable synthetic allocation only; no product DB or preserved journal is involved.
    let allocation = crate::issuance::allocate(
        &path,
        "offline",
        "offline",
        &"12".repeat(32),
        &"ab".repeat(32),
    )?;
    let mut index: [u8; 11] = bytes(&allocation.diversifier)?.try_into().unwrap();
    if matches!(case, SnapshotCase::UnmappedExternal) {
        index[0] ^= 128;
    }
    let mut tx = CompactTx {
        index: 7,
        txid: vec![0x25; 32],
        ..Default::default()
    };
    fvk.add_output(
        &mut tx,
        &Network::TestNetwork,
        BlockHeight::from_u32(target),
        None,
        AddressType::DiversifiedExternal(index.into()),
        Zatoshis::from_u64(1000)?,
        0,
        &mut OsRng,
    );
    let mut blocks: BTreeMap<_, _> = (start..=target + 2).map(|h| (h, empty_block(h))).collect();
    for b in blocks.range_mut(target..).filter(|_| !no_outputs) {
        b.1.chain_metadata
            .as_mut()
            .unwrap()
            .ironwood_commitment_tree_size = 1;
    }
    let last = blocks.get_mut(&target).unwrap();
    if !no_outputs {
        last.vtx = vec![tx];
    }
    last.chain_metadata
        .as_mut()
        .unwrap()
        .ironwood_commitment_tree_size = u32::from(!no_outputs);
    let diagnostics = DiagnosticState::default();
    let caught_up = Arc::new(Mutex::new(None));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let canonical_h_checked = Arc::new(Mutex::new(None));
    let latest_calls = Arc::new(Mutex::new(0));
    let blocks = Arc::new(blocks);
    let rpc = SnapshotRpc {
        tip: target,
        blocks: Arc::clone(&blocks),
        wallet: path.clone(),
        diagnostics: Arc::clone(&diagnostics),
        latest_calls: Arc::clone(&latest_calls),
        caught_up: Arc::clone(&caught_up),
        requests: Arc::clone(&requests),
        canonical_h_checked: Arc::clone(&canonical_h_checked),
        case,
    };
    let mut client =
        CompactTxStreamerClient::with_interceptor(rpc, StageInterceptor(Arc::clone(&diagnostics)));
    let context = json!({"network":"testnet", "market_id":"offline", "vault_context_ref":"offline",
        "account_ref":account.expose_uuid().to_string(), "anchor_height":anchor,
        "anchor_hash":hex(&hash(anchor)), "closes_at_us":format!("{}.000000",(1_700_000_000u64+u64::from(anchor)+10)*1_000_000), "receipts":[], "unmapped":[]});
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = rt.block_on(synchronize_with_client(
        &path,
        &context,
        None,
        &diagnostics,
        &mut client,
    ));
    // Forward growth extends the same hash-linked chain; the original H is unchanged.
    assert_eq!(blocks[&target].hash, hash(target));
    assert_eq!(blocks[&(target + 1)].prev_hash, blocks[&target].hash);
    assert_eq!(blocks[&(target + 2)].prev_hash, blocks[&(target + 1)].hash);
    // Every case proves catch-up, empty required work and 0/0 cache BEFORE the failing/successful checks.
    if matches!(case, SnapshotCase::CompleteHash) {
        assert!(caught_up.lock().unwrap().is_none());
        assert_eq!(*latest_calls.lock().unwrap(), 2);
        assert!(canonical_h_checked.lock().unwrap().is_none());
    } else {
        assert_eq!(*caught_up.lock().unwrap(), Some((target, target, 0, 0, 0)));
    }
    // Neither maintained scan nor close history requests any successor block range.
    assert!(
        requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _, _)| m == "GetBlockRange")
            .all(|(_, _, end)| *end <= target)
    );
    if let Ok(snapshot) = &result {
        let block_requests: Vec<u32> = requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, _, _)| method == "GetBlock")
            .map(|(_, height, _)| *height)
            .collect();
        let growth = match case {
            SnapshotCase::ForwardOne => 1,
            SnapshotCase::Forward => 2,
            SnapshotCase::ForwardLarge => 10_000,
            _ => 0,
        };
        if growth > 0 {
            assert_eq!(
                &block_requests[block_requests.len() - 2..],
                &[target + growth, target]
            );
        } else {
            assert_eq!(block_requests.last(), Some(&target));
        }
        let checked = canonical_h_checked
            .lock()
            .unwrap()
            .expect("final canonical H fetched");
        let epoch = snapshot["chain"]["verified_at_epoch"]
            .as_str()
            .unwrap()
            .parse::<u64>()?;
        assert!(epoch >= checked.duration_since(UNIX_EPOCH)?.as_secs());
        assert_eq!(snapshot["chain"]["tip_height"], target);
        assert_eq!(snapshot["chain"]["scanned_height"], target);
        assert_eq!(snapshot["chain"]["tip_hash"], hex(&hash(target)));
        assert_eq!(snapshot["chain"]["scanned_hash"], hex(&hash(target)));
        let history = snapshot["chain"]["close_proof"]["window"]
            .as_array()
            .unwrap();
        assert_eq!(history.len(), 13);
        assert!(history.last().unwrap()["height"].as_u64().unwrap() <= u64::from(target));
        assert!(
            history
                .iter()
                .all(|b| b["height"].as_u64().unwrap() <= u64::from(target))
        );
        if !no_outputs {
            let output = &snapshot["outputs"][0];
            assert_eq!(output["block_height"], target);
            assert_eq!(output["block_time"], 1_700_000_000u64 + u64::from(target));
            assert_eq!(output["amount_zat"], "1000");
            assert_eq!(output["canonical"], true);
            // This H note remains one confirmation, below the unchanged three-confirmation rule.
            let depth = snapshot["chain"]["tip_height"].as_u64().unwrap()
                - output["block_height"].as_u64().unwrap()
                + 1;
            assert_eq!(depth, 1);
            assert!(depth < 3);
        } else {
            assert!(snapshot["outputs"].as_array().unwrap().is_empty());
            assert!(serde_json::to_vec(snapshot)?.len() < 16_384);
            assert_eq!(
                snapshot["chain"]["close_proof"]["window"]
                    .as_array()
                    .unwrap()
                    .len(),
                13
            );
            assert!(snapshot["chain"].get("mtp_blocks").is_none());
        }
    }
    if no_outputs && let Ok(path) = env::var("DARKPOOL_BOUNDED_CLOSE_EXPORT") {
        std::fs::write(format!("{path}.context"),json!({"anchor":anchor,"close":1_700_000_000u64+u64::from(anchor)+10,"account_ref":context["account_ref"],"market_id":context["market_id"],"vault_context_ref":context["vault_context_ref"]}).to_string())?;
    }
    let result = result.map_err(|e| classify_failure(e.as_ref(), &diagnostics));
    if let Err(d) = &result {
        let value = d.value();
        assert_eq!(value.as_object().unwrap().len(), 9);
        assert!(!value.to_string().contains("output inclusion mismatch"));
        assert_eq!((d.cache_blocks, d.cache_bytes), (0, 0));
    }
    Ok((result, target))
}

#[test]
fn production_snapshot_stable_tip_after_8400_block_catchup() -> SpikeResult<()> {
    let (result, target) = snapshot_fixture(SnapshotCase::Stable, 8400)?;
    let snapshot = result.map_err(|_| "offline snapshot failed")?;
    assert_eq!(snapshot["chain"]["complete"], true);
    assert_eq!(snapshot["chain"]["verified"], true);
    assert_eq!(snapshot["chain"]["tip_height"], target);
    assert_eq!(snapshot["chain"]["scanned_height"], target);
    assert_eq!(snapshot["chain"]["tip_hash"], hex(&hash(target)));
    assert_eq!(
        snapshot["chain"]["scanned_hash"],
        snapshot["chain"]["tip_hash"]
    );
    assert_eq!(
        snapshot["chain"]["close_proof"]["window"]
            .as_array()
            .unwrap()
            .len(),
        13
    );
    assert_eq!(snapshot["outputs"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["outputs"][0]["canonical"], true);
    assert_eq!(snapshot["outputs"][0]["receiver_verified"], true);
    assert_eq!(snapshot["outputs"][0]["tx_index"], 7);
    assert!(
        snapshot["chain"]["verified_at_epoch"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .is_ok()
    );
    let mut framed = Vec::new();
    write_frame(&mut framed, &snapshot)?;
    assert_eq!(read_frame(&mut framed.as_slice())?, Some(snapshot));
    Ok(())
}
fn assert_snapshot_guard(case: SnapshotCase, guard: Guard, phase: GuardPhase) -> SpikeResult<()> {
    let (result, _) = snapshot_fixture(case, 800)?;
    let d = result.expect_err("expected current production guard");
    assert_eq!((d.guard, d.phase), (guard, phase));
    if phase == GuardPhase::FinalTip {
        assert_eq!((d.class, d.stage), (FailureClass::ChainValidation, "BLOCK"));
    } else {
        // Preserve the historical fallback for inclusion inside close history.
        assert_eq!((d.class, d.stage), (FailureClass::ChainValidation, "BLOCK"));
    }
    Ok(())
}
macro_rules! snapshot_guard_test {
    ($name:ident, $case:ident, $guard:ident, $phase:ident) => {
        #[test]
        fn $name() -> SpikeResult<()> {
            assert_snapshot_guard(SnapshotCase::$case, Guard::$guard, GuardPhase::$phase)
        }
    };
}
#[test]
fn production_forward_tip_h_plus_two_passes() -> SpikeResult<()> {
    assert!(snapshot_fixture(SnapshotCase::Forward, 800)?.0.is_ok());
    Ok(())
}
#[test]
fn production_forward_tip_h_plus_one_passes() -> SpikeResult<()> {
    assert!(snapshot_fixture(SnapshotCase::ForwardOne, 800)?.0.is_ok());
    Ok(())
}
#[test]
fn production_forward_tip_h_plus_10000_passes_without_successor_scan() -> SpikeResult<()> {
    assert!(snapshot_fixture(SnapshotCase::ForwardLarge, 800)?.0.is_ok());
    Ok(())
}
snapshot_guard_test!(
    production_advanced_tip_h_reorg,
    AdvancedFork,
    FinalTipHashChanged,
    FinalTip
);
snapshot_guard_test!(
    production_final_tip_behind,
    Behind,
    FinalTipHeightChanged,
    FinalTip
);
snapshot_guard_test!(
    production_advanced_canonical_h_height,
    AdvancedBlockHeight,
    BlockHeight,
    FinalTip
);
snapshot_guard_test!(
    production_advanced_canonical_h_hash_shape,
    AdvancedBlockHash,
    BlockHashShape,
    FinalTip
);
snapshot_guard_test!(
    production_advanced_canonical_h_prev_hash_shape,
    AdvancedBlockPrevHash,
    BlockPrevHashShape,
    FinalTip
);
#[test]
fn production_complete_check_mismatch_prevents_final_recheck() -> SpikeResult<()> {
    let (result, _) = snapshot_fixture(SnapshotCase::CompleteHash, 800)?;
    let d = result.expect_err("COMPLETE_CHECK must remain exact");
    assert_eq!(
        (d.class, d.stage),
        (FailureClass::IncompleteSync, "COMPLETE_CHECK")
    );
    assert_eq!((d.guard, d.phase), (Guard::Other, GuardPhase::Other));
    Ok(())
}
snapshot_guard_test!(
    production_equal_height_hash_change,
    EqualHeightFork,
    FinalTipHashChanged,
    FinalTip
);
snapshot_guard_test!(
    production_final_advertised_hash_mismatch,
    AdvertisedHash,
    TipAdvertisedHash,
    FinalTip
);
snapshot_guard_test!(
    production_postscan_block_height,
    BlockHeight,
    BlockHeight,
    FinalTip
);
snapshot_guard_test!(
    production_postscan_block_hash_shape,
    BlockHash,
    BlockHashShape,
    FinalTip
);
snapshot_guard_test!(
    production_postscan_prev_hash_shape,
    BlockPrevHash,
    BlockPrevHashShape,
    FinalTip
);
snapshot_guard_test!(
    production_output_index_absent,
    OutputIndex,
    OutputTxIndex,
    OutputInclusion
);
snapshot_guard_test!(
    production_output_txid_mismatch,
    OutputTxId,
    OutputTxId,
    OutputInclusion
);

#[test]
fn production_output_helper_hash_and_input_guards() -> SpikeResult<()> {
    // A hash change inside the full fixture's history window is rejected earlier
    // by wallet-chain consistency. Exercise the SAME production inclusion helper.
    let mut b = empty_block(5_000_000);
    b.vtx = vec![CompactTx {
        index: 7,
        txid: vec![0x25; 32],
        ironwood_actions: vec![CompactOrchardAction::default()],
        ..Default::default()
    }];
    let o = json!({"block_hash":hex(&b.hash), "tx_index":7, "txid":hex(&b.vtx[0].txid),"pool":"IRONWOOD","output_index":0});
    let state = DiagnosticState::default();
    state.lock().unwrap().stage = "BLOCK";
    let mut valid = o.clone();
    validate_output_inclusion(&mut valid, &b)?;
    assert_eq!(valid["canonical"], true);
    for (key, value, guard) in [
        ("block_hash", json!("different"), Guard::OutputBlockHash),
        ("tx_index", Value::Null, Guard::OutputTxIndex),
        ("tx_index", json!(-1), Guard::OutputTxIndex),
        ("txid", Value::Null, Guard::OutputTxId),
        ("output_index", Value::Null, Guard::OutputTxIndex),
        ("output_index", json!(-1), Guard::OutputTxIndex),
        ("output_index", json!(1), Guard::OutputTxIndex),
    ] {
        let mut bad = o.clone();
        bad[key] = value;
        let error = validate_output_inclusion(&mut bad, &b).unwrap_err();
        let d = classify_failure(error.as_ref(), &state);
        assert_eq!((d.guard, d.phase), (guard, GuardPhase::OutputInclusion));
        assert_eq!((d.class, d.stage), (FailureClass::ChainValidation, "BLOCK"));
    }
    Ok(())
}

#[test]
fn explicit_clock_receipts_and_unassigned_guards_ignore_stale_stage() -> SpikeResult<()> {
    let state = DiagnosticState::default();
    state.lock().unwrap().stage = "BLOCK";
    for (error, guard, phase) in [
        (
            verification_epoch(UNIX_EPOCH - Duration::from_secs(1)).unwrap_err(),
            Guard::Clock,
            GuardPhase::FinalTip,
        ),
        (
            receipt_context(&json!({"receipts":null})).unwrap_err(),
            Guard::ReceiptContext,
            GuardPhase::OutputInclusion,
        ),
        (
            Box::<dyn std::error::Error>::from("SECRET"),
            Guard::Other,
            GuardPhase::Other,
        ),
    ] {
        let d = classify_failure(error.as_ref(), &state);
        assert_eq!((d.guard, d.phase), (guard, phase));
        assert_eq!(d.stage, "BLOCK");
        assert!(!d.value().to_string().contains("SECRET"));
    }
    assert_eq!(verification_epoch(UNIX_EPOCH)?, 0);
    assert!(receipt_context(&json!({"receipts":[]}))?.is_empty());
    Ok(())
}

#[test]
fn typed_failures_clear_prior_guard_and_preserve_codes() {
    let mut d = Diagnostic {
        guard: Guard::BlockHeight,
        phase: GuardPhase::FinalTip,
        ..Default::default()
    };
    d.classify(
        &tonic::Status::unavailable("SECRET"),
        FailureClass::ChainValidation,
    );
    assert_eq!(
        (d.class, d.grpc_code, d.guard, d.phase),
        (
            FailureClass::RpcStatus,
            Some(14),
            Guard::Other,
            GuardPhase::Other
        )
    );
    d.classify(
        &rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(5), Some("SECRET".into())),
        FailureClass::ChainValidation,
    );
    assert_eq!(
        (d.class, d.sqlite_code, d.guard),
        (FailureClass::SqliteBusy, Some(5), Guard::Other)
    );
    d.classify(
        &std::io::Error::other(CacheLimit),
        FailureClass::ChainValidation,
    );
    assert_eq!((d.class, d.guard), (FailureClass::CacheLimit, Guard::Other));
    d.classify(
        &rustls::Error::General("SECRET".into()),
        FailureClass::ChainValidation,
    );
    assert_eq!((d.class, d.guard), (FailureClass::TlsConnect, Guard::Other));
    assert!(!d.value().to_string().contains("SECRET"));
}

#[test]
fn block_guard_phase_is_explicit_for_initial_checkpoint_and_outputs() -> SpikeResult<()> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    for phase in [
        GuardPhase::Initial,
        GuardPhase::Checkpoint,
        GuardPhase::OutputInclusion,
    ] {
        for (case, guard) in [
            (SnapshotCase::BlockHeight, Guard::BlockHeight),
            (SnapshotCase::BlockHash, Guard::BlockHashShape),
            (SnapshotCase::BlockPrevHash, Guard::BlockPrevHashShape),
        ] {
            let diagnostics = DiagnosticState::default();
            let rpc = SnapshotRpc {
                tip: 5_000_000,
                blocks: Default::default(),
                wallet: Default::default(),
                diagnostics: Arc::clone(&diagnostics),
                latest_calls: Arc::new(Mutex::new(3)),
                caught_up: Default::default(),
                requests: Default::default(),
                canonical_h_checked: Default::default(),
                case,
            };
            let mut client = CompactTxStreamerClient::with_interceptor(
                rpc,
                StageInterceptor(Arc::clone(&diagnostics)),
            );
            let error = rt
                .block_on(block(&mut client, 5_000_000, phase))
                .unwrap_err();
            let d = classify_failure(error.as_ref(), &diagnostics);
            assert_eq!((d.guard, d.phase), (guard, phase));
            assert_eq!(d.stage, "BLOCK");
        }
    }
    Ok(())
}

#[test]
fn bounded_close_missing_seed_recovery_and_conflicting_incomplete_witnesses() -> SpikeResult<()> {
    assert!(snapshot_fixture(SnapshotCase::MissingSeed, 400)?.0.is_ok());
    for case in [
        SnapshotCase::MissingSeedIncomplete,
        SnapshotCase::MissingSeedConflict,
        SnapshotCase::WitnessConflict,
        SnapshotCase::WitnessFirstConflict,
        SnapshotCase::TargetPrevConflict,
        SnapshotCase::MissingContainingBlock,
        SnapshotCase::OutputActionIndex,
    ] {
        assert!(snapshot_fixture(case, 400)?.0.is_err());
    }
    Ok(())
}
#[test]
fn bounded_close_unmapped_external_note_keeps_complete_inclusion() -> SpikeResult<()> {
    let (snapshot, _) = snapshot_fixture(SnapshotCase::UnmappedExternal, 400)?;
    let snapshot = snapshot.map_err(|_| "unmapped snapshot failed")?;
    assert!(snapshot["outputs"][0]["ticket_id"].is_null());
    assert_eq!(snapshot["outputs"][0]["canonical"], true);
    assert_eq!(snapshot["outputs"][0]["key_scope"], 0);
    assert_eq!(
        snapshot["chain"]["inclusion_blocks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    Ok(())
}
#[test]
fn bounded_close_large_no_payment_and_export_frame_fixture() -> SpikeResult<()> {
    let (result, h) = snapshot_fixture(SnapshotCase::NoOutputsLarge, 30_000)?;
    let snapshot = result.map_err(|_| "large no-payment snapshot failed")?;
    let proof = &snapshot["chain"]["close_proof"];
    let a = proof["anchor_window"].as_array().unwrap().last().unwrap()["height"]
        .as_u64()
        .unwrap();
    assert!(u64::from(h) - a + 11 > 28_813);
    assert!(snapshot["outputs"].as_array().unwrap().is_empty());
    assert_eq!(proof["window"].as_array().unwrap().len(), 13);
    let mut frame = Vec::new();
    write_frame(&mut frame, &snapshot)?;
    assert!(frame.len() < 16_384);
    if let Ok(path) = env::var("DARKPOOL_BOUNDED_CLOSE_EXPORT") {
        // Disposable fixture output, never a production wallet/CLI path.
        std::fs::write(&path, &frame)?;
    }
    Ok(())
}
