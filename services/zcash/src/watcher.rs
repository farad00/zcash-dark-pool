//! Private testnet watcher. Maintained wallet writes; pinned read-only metadata adapter.
//! No seed, spending key, signing, broadcast, or product credential interface.
use std::{
    collections::BTreeMap,
    env,
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use prost::Message;
use rand_core::OsRng;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Value, json};
use tonic::transport::{ClientTlsConfig, Endpoint};
use zcash_client_backend::{
    data_api::{
        Account, AccountPurpose, AccountSource, WalletRead, WalletWrite,
        chain::{BlockCache, BlockSource, error},
        scanning::ScanRange,
    },
    proto::{
        compact_formats::CompactBlock,
        service::{self, compact_tx_streamer_client::CompactTxStreamerClient},
    },
};
use zcash_client_sqlite::{WalletDb, util::SystemClock};
use zcash_keys::{address::UnifiedAddress, encoding::AddressCodec};
use zcash_protocol::consensus::{BlockHeight, Network};

use crate::{SpikeResult, TestnetWallet, issuance::hex};

#[path = "watcher_close.rs"]
mod close;
#[path = "watcher_connect.rs"]
pub mod connect;
#[path = "watcher_progress.rs"]
mod progress;

const MAX_FRAME: usize = 4_194_304;
const MAX_OUTPUTS: usize = 4096;
const MAX_BLOCK_BYTES: usize = 64 * 1024 * 1024;

// Only these enums/numbers can cross the opt-in diagnostic IPC boundary.
#[derive(Clone, Copy, Debug, PartialEq)]
enum FailureClass {
    TlsConnect,
    RpcConnect,
    RpcTimeout,
    RpcStatus,
    RpcStream,
    RpcDecode,
    RpcMessageLimit,
    TreeState,
    ChainValidation,
    CacheLimit,
    HistoryLimit,
    CacheError,
    ScanError,
    SqliteBusy,
    SqliteError,
    CheckpointError,
    IncompleteSync,
    IpcFrame,
    Unknown,
}
impl FailureClass {
    fn name(self) -> &'static str {
        match self {
            Self::TlsConnect => "TLS_CONNECT",
            Self::RpcConnect => "RPC_CONNECT",
            Self::RpcTimeout => "RPC_TIMEOUT",
            Self::RpcStatus => "RPC_STATUS",
            Self::RpcStream => "RPC_STREAM",
            Self::RpcDecode => "RPC_DECODE",
            Self::RpcMessageLimit => "RPC_MESSAGE_LIMIT",
            Self::TreeState => "TREE_STATE",
            Self::ChainValidation => "CHAIN_VALIDATION",
            Self::CacheLimit => "CACHE_LIMIT",
            Self::HistoryLimit => "HISTORY_LIMIT",
            Self::CacheError => "CACHE_ERROR",
            Self::ScanError => "SCAN_ERROR",
            Self::SqliteBusy => "SQLITE_BUSY",
            Self::SqliteError => "SQLITE_ERROR",
            Self::CheckpointError => "CHECKPOINT_ERROR",
            Self::IncompleteSync => "INCOMPLETE_SYNC",
            Self::IpcFrame => "IPC_FRAME",
            Self::Unknown => "UNKNOWN",
        }
    }
}
// Explicit local guard provenance; never inferred from the last RPC stage.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Guard {
    BlockHeight,
    BlockHashShape,
    BlockPrevHashShape,
    TipAdvertisedHash,
    OutputBlockHash,
    OutputTxIndex,
    OutputTxId,
    FinalTipHeightChanged,
    FinalTipHashChanged,
    ReceiptContext,
    Clock,
    Other,
}
impl Guard {
    fn name(self) -> &'static str {
        match self {
            Self::BlockHeight => "BLOCK_HEIGHT",
            Self::BlockHashShape => "BLOCK_HASH_SHAPE",
            Self::BlockPrevHashShape => "BLOCK_PREV_HASH_SHAPE",
            Self::TipAdvertisedHash => "TIP_ADVERTISED_HASH",
            Self::OutputBlockHash => "OUTPUT_BLOCK_HASH",
            Self::OutputTxIndex => "OUTPUT_TX_INDEX",
            Self::OutputTxId => "OUTPUT_TX_ID",
            Self::FinalTipHeightChanged => "FINAL_TIP_HEIGHT_CHANGED",
            Self::FinalTipHashChanged => "FINAL_TIP_HASH_CHANGED",
            Self::ReceiptContext => "RECEIPT_CONTEXT",
            Self::Clock => "CLOCK",
            Self::Other => "OTHER",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum GuardPhase {
    Initial,
    Checkpoint,
    OutputInclusion,
    FinalTip,
    Other,
}
impl GuardPhase {
    fn name(self) -> &'static str {
        match self {
            Self::Initial => "INITIAL",
            Self::Checkpoint => "CHECKPOINT",
            Self::OutputInclusion => "OUTPUT_INCLUSION",
            Self::FinalTip => "FINAL_TIP",
            Self::Other => "OTHER",
        }
    }
}
#[derive(Debug)]
struct GuardFailure(Guard, GuardPhase);
impl std::fmt::Display for GuardFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("watcher unavailable")
    }
}
impl std::error::Error for GuardFailure {}
fn guard_error(guard: Guard, phase: GuardPhase) -> Box<dyn std::error::Error> {
    Box::new(GuardFailure(guard, phase))
}
#[derive(Clone, Debug)]
struct Diagnostic {
    progress: Option<progress::Progress>,
    class: FailureClass,
    stage: &'static str,
    guard: Guard,
    phase: GuardPhase,
    grpc_code: Option<i32>,
    sqlite_code: Option<i32>,
    range: Option<(u32, u32)>, // inclusive public range successfully inserted
    cache_blocks: usize,
    cache_bytes: usize,
}
impl Default for Diagnostic {
    fn default() -> Self {
        Self {
            progress: None,
            class: FailureClass::Unknown,
            stage: "START",
            guard: Guard::Other,
            phase: GuardPhase::Other,
            grpc_code: None,
            sqlite_code: None,
            range: None,
            cache_blocks: 0,
            cache_bytes: 0,
        }
    }
}
impl Diagnostic {
    fn value(&self) -> Value {
        json!({"class": self.class.name(), "stage": self.stage,
            "guard": self.guard.name(), "phase": self.phase.name(),
            "grpc_code": self.grpc_code, "sqlite_code": self.sqlite_code,
            "cached_range": self.range.map(|(start,end)| json!({"start":start,"end":end})),
            "cache_blocks":self.cache_blocks,"cache_bytes":self.cache_bytes})
    }
    fn classify(&mut self, err: &(dyn std::error::Error + 'static), fallback: FailureClass) {
        self.class = fallback;
        self.grpc_code = None;
        self.sqlite_code = None;
        self.guard = Guard::Other;
        self.phase = GuardPhase::Other;
        let mut source = Some(err);
        // Bounded traversal; never retain Display, Debug, payloads or metadata.
        for _ in 0..16 {
            let Some(e) = source else { break };
            if let Some(d) = e.downcast_ref::<DiagnosticFailure>() {
                *self = d.0.clone();
                return;
            }
            if let Some(GuardFailure(guard, phase)) = e.downcast_ref::<GuardFailure>() {
                self.guard = *guard;
                self.phase = *phase;
            }
            if let Some(s) = e.downcast_ref::<tonic::Status>() {
                self.grpc_code = Some(s.code() as i32);
                self.class = match s.code() {
                    tonic::Code::DeadlineExceeded => FailureClass::RpcTimeout,
                    // Tonic has no typed oversize/decode subtype. Recognize only its fixed
                    // local codec prefixes; no error text is retained or emitted.
                    tonic::Code::OutOfRange
                        if s.message()
                            .starts_with("Error, decoded message length too large:") =>
                    {
                        FailureClass::RpcMessageLimit
                    }
                    tonic::Code::Internal
                        if s.message()
                            .starts_with("failed to decode Protobuf message:") =>
                    {
                        FailureClass::RpcDecode
                    }
                    _ if fallback == FailureClass::RpcStream => FailureClass::RpcStream,
                    _ => FailureClass::RpcStatus,
                };
            }
            if let Some(rusqlite::Error::SqliteFailure(code, _)) =
                e.downcast_ref::<rusqlite::Error>()
            {
                self.sqlite_code = Some(code.extended_code);
                self.class = if matches!(
                    code.code,
                    rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                ) {
                    FailureClass::SqliteBusy
                } else {
                    FailureClass::SqliteError
                };
                return;
            }
            if e.is::<rusqlite::Error>() {
                self.class = FailureClass::SqliteError;
                return;
            }
            if e.is::<prost::DecodeError>() {
                self.class = FailureClass::RpcDecode;
            }
            if e.is::<rustls::Error>() {
                self.class = FailureClass::TlsConnect;
            }
            if let Some(e) = e.downcast_ref::<std::io::Error>() {
                if e.get_ref().is_some_and(|e| e.is::<rustls::Error>()) {
                    self.class = FailureClass::TlsConnect;
                }
                if e.get_ref().is_some_and(|e| e.is::<CacheLimit>()) {
                    self.class = FailureClass::CacheLimit;
                    return;
                }
                if e.kind() == std::io::ErrorKind::TimedOut {
                    self.class = FailureClass::RpcTimeout;
                }
            }
            source = e.source();
        }
    }
}
#[derive(Debug)]
struct DiagnosticFailure(Diagnostic);
impl std::fmt::Display for DiagnosticFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("watcher unavailable")
    }
}
impl std::error::Error for DiagnosticFailure {}
fn classify_failure(
    err: &(dyn std::error::Error + 'static),
    state: &DiagnosticState,
) -> Diagnostic {
    let mut failure = state.lock().unwrap().clone();
    let fallback = match failure.stage {
        "TLS_CONNECT" => FailureClass::TlsConnect,
        "RPC_CONNECT" => FailureClass::RpcConnect,
        "CHECKPOINT" => FailureClass::CheckpointError,
        "COMPLETE_CHECK" => FailureClass::IncompleteSync,
        "CLOSE_HISTORY" | "BLOCK" | "CHAIN_TIP" => FailureClass::ChainValidation,
        "BLOCK_RANGE" => FailureClass::RpcStream,
        "TREE_STATE" => FailureClass::TreeState,
        "CHAIN_INFO" | "RPC" => FailureClass::RpcStatus,
        "START" => FailureClass::IpcFrame,
        _ => FailureClass::Unknown,
    };
    failure.classify(err, fallback);
    failure
}
fn history_limit(state: &DiagnosticState, blocks: usize, bytes: usize) -> DiagnosticFailure {
    let mut d = state.lock().unwrap().clone();
    d.class = FailureClass::HistoryLimit;
    d.stage = "CLOSE_HISTORY";
    d.range = None;
    d.cache_blocks = blocks;
    d.cache_bytes = bytes;
    DiagnosticFailure(d)
}
#[derive(Debug)]
struct CacheLimit;
impl std::fmt::Display for CacheLimit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("bounded cache exceeded")
    }
}
impl std::error::Error for CacheLimit {}
type DiagnosticState = Arc<Mutex<Diagnostic>>;
#[derive(Clone)]
struct StageInterceptor(DiagnosticState);
impl tonic::service::Interceptor for StageInterceptor {
    fn call(&mut self, request: tonic::Request<()>) -> Result<tonic::Request<()>, tonic::Status> {
        if let Some(method) = request.extensions().get::<tonic::GrpcMethod>() {
            self.0.lock().unwrap().stage = match method.method() {
                "GetTreeState" => "TREE_STATE",
                "GetBlockRange" => "BLOCK_RANGE",
                "GetLatestBlock" => "CHAIN_TIP",
                "GetBlock" => "BLOCK",
                "GetSubtreeRoots" => "SUBTREE_ROOTS",
                "GetLightdInfo" => "CHAIN_INFO",
                _ => "RPC",
            };
        }
        Ok(request)
    }
}
fn sync_failure<C, D, T>(
    err: zcash_client_backend::sync::Error<C, D, T>,
    state: &DiagnosticState,
) -> DiagnosticFailure
where
    C: std::error::Error + 'static,
    D: std::error::Error + 'static,
    T: std::error::Error + 'static,
{
    use zcash_client_backend::sync::Error as E;
    let mut d = state.lock().unwrap().clone();
    match err {
        E::Cache(e) => d.classify(&e, FailureClass::CacheError),
        E::Scan(e) => {
            d.class = if e.is_continuity_error() {
                FailureClass::ChainValidation
            } else {
                FailureClass::ScanError
            }
        }
        E::Server(e) => {
            let fallback = if d.stage == "BLOCK_RANGE" {
                FailureClass::RpcStream
            } else {
                FailureClass::RpcStatus
            };
            d.classify(&e, fallback);
        }
        E::Wallet(e) => d.classify(&e, FailureClass::ScanError),
        E::WalletTrees(e) => d.classify(&e, FailureClass::CheckpointError),
        E::MisbehavingServer => {
            d.class = if d.stage == "TREE_STATE" {
                FailureClass::TreeState
            } else {
                FailureClass::ChainValidation
            }
        }
        _ => d.class = FailureClass::Unknown,
    }
    DiagnosticFailure(d)
}

fn field<'a>(v: &'a Value, key: &str) -> SpikeResult<&'a str> {
    v[key]
        .as_str()
        .ok_or_else(|| "invalid watcher context".into())
}
fn bytes(value: &str) -> SpikeResult<Vec<u8>> {
    if !value.len().is_multiple_of(2)
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("invalid private encoding".into());
    }
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).map_err(Into::into))
        .collect()
}
fn identity(v: &Value) -> String {
    format!(
        "{}:{}:{}",
        v["txid"].as_str().unwrap_or(""),
        v["pool"].as_str().unwrap_or(""),
        v["output_index"]
    )
}

fn open_existing(path: &Path, context: &Value) -> SpikeResult<TestnetWallet> {
    if !path.is_file() || context["network"] != "testnet" {
        return Err("existing testnet wallet required".into());
    }
    if bytes(field(context, "anchor_hash")?)?.len() != 32 {
        return Err("anchor missing".into());
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch("PRAGMA synchronous=FULL;")?;
    rusqlite::vtab::array::load_module(&conn)?;
    // Runtime never initializes or migrates the wallet. Provisioning is separate.
    let wallet = WalletDb::from_connection(conn, Network::TestNetwork, SystemClock, OsRng);
    let ids = wallet.get_account_ids()?;
    let [account] = ids.as_slice() else {
        return Err("one view-only account required".into());
    };
    let a = wallet.get_account(*account)?.ok_or("account missing")?;
    if !matches!(
        a.source(),
        AccountSource::Imported {
            purpose: AccountPurpose::ViewOnly,
            ..
        }
    ) || account.expose_uuid().to_string() != field(context, "account_ref")?
    {
        return Err("view-only context mismatch".into());
    }
    let read = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let binding: (String, String, String) = read.query_row(
        "SELECT market,vault,account FROM ext_darkpool_context WHERE singleton=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if binding
        != (
            field(context, "market_id")?.into(),
            field(context, "vault_context_ref")?.into(),
            field(context, "account_ref")?.into(),
        )
    {
        return Err("allocation context mismatch".into());
    }
    Ok(wallet)
}

/// Read complete received history, including spent notes. No memo/key/note-secret columns.
pub fn observations(path: &Path, context: &Value) -> SpikeResult<Vec<Value>> {
    let _validated = open_existing(path, context)?;
    let read = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    read.busy_timeout(Duration::from_secs(5))?;
    read.execute_batch("BEGIN;")?;
    let mut query = read.prepare(
        "SELECT t.txid,r.pool,r.output_index,r.value,r.is_change,a.key_scope,a.diversifier_index_be,a.address,
          t.mined_height,b.hash,b.time,t.tx_index
         FROM v_received_outputs r JOIN transactions t ON t.id_tx=r.transaction_id
         LEFT JOIN addresses a ON a.id=r.address_id LEFT JOIN blocks b ON b.height=t.mined_height
         ORDER BY t.txid,r.pool,r.output_index LIMIT 4097")?;
    let mut rows = query.query([])?;
    let mut output = Vec::new();
    while let Some(r) = rows.next()? {
        if output.len() == MAX_OUTPUTS {
            return Err("bounded snapshot exceeded".into());
        }
        let pool: i64 = r.get(1)?;
        if pool == 0 {
            return Err("unexpected transparent receiving state".into());
        }
        let pool = match pool {
            2 => "SAPLING",
            3 => "ORCHARD",
            4 => "IRONWOOD",
            _ => return Err("unsupported pool".into()),
        };
        let txid: Vec<u8> = r.get(0)?;
        let value: i64 = r.get(3)?;
        if txid.len() != 32 || value < 0 {
            return Err("invalid observed output".into());
        }
        let scope: Option<i64> = r.get(5)?;
        let index_be: Option<Vec<u8>> = r.get(6)?;
        let actual_ua: Option<String> = r.get(7)?;
        let mut allocation: Option<(String, String, String, String)> = None;
        if scope == Some(0)
            && pool != "SAPLING"
            && let (Some(mut index), Some(address)) = (index_be, actual_ua)
        {
            if index.len() != 11 {
                return Err("invalid diversifier metadata".into());
            }
            index.reverse(); // Maintained addresses store BE; allocation journal stores LE index bytes.
            let index = hex(&index);
            allocation = read.query_row("SELECT ticket,commitment,ua,diversifier FROM ext_darkpool_allocations WHERE diversifier=?1", [&index],
                    |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
            if let Some((_, _, ref ua, _)) = allocation {
                let actual = UnifiedAddress::decode(&Network::TestNetwork, &address)?;
                let issued = UnifiedAddress::decode(&Network::TestNetwork, ua)?;
                if issued.orchard().is_none()
                    || issued.sapling().is_some()
                    || issued.transparent().is_some()
                    || actual.orchard() != issued.orchard()
                {
                    return Err("receiver allocation conflict".into());
                }
            }
        }
        let mined: Option<i64> = r.get(8)?;
        let hash: Option<Vec<u8>> = r.get(9)?;
        let time: Option<i64> = r.get(10)?;
        let tx_index: Option<i64> = r.get(11)?;
        let is_change: bool = r.get(4)?;
        let mut note = json!({"txid":hex(&txid),"pool":pool,"output_index":r.get::<_,i64>(2)?,
            "amount_zat":value.to_string(),"is_change":is_change,"key_scope":scope,"present":true,
            "receiver_verified":allocation.is_some() && !is_change,"canonical":false,
            "block_height":mined,"block_hash":hash.map(|h| hex(&h)),"block_time":time,"tx_index":tx_index,
            "receiver_ref":null,"diversifier_ref":null,"ticket_id":null,"journal_commitment":null});
        if let Some((ticket, commitment, ua, index)) = allocation {
            note["receiver_ref"] = json!(ua);
            note["diversifier_ref"] = json!(format!("external:{index}"));
            note["ticket_id"] = json!(ticket);
            note["journal_commitment"] = json!(commitment);
        }
        output.push(note);
    }
    drop(rows);
    drop(query);
    read.execute_batch("ROLLBACK;")?;
    Ok(output)
}

#[derive(Default)]
struct MemoryCache(
    Mutex<BTreeMap<u32, CompactBlock>>,
    DiagnosticState,
    #[cfg(test)] Mutex<Vec<(&'static str, usize, usize)>>,
);
impl MemoryCache {
    fn progress(&self) -> Option<progress::Progress> {
        self.1.lock().ok().and_then(|d| d.progress.clone())
    }
    fn record(&self, blocks: &BTreeMap<u32, CompactBlock>, stage: &'static str) {
        let count = blocks.len();
        let bytes = blocks.values().map(Message::encoded_len).sum();
        let mut d = self.1.lock().unwrap();
        d.stage = stage;
        d.cache_blocks = count;
        d.cache_bytes = bytes;
        #[cfg(test)]
        self.2.lock().unwrap().push((stage, count, bytes));
    }
}
impl BlockSource for MemoryCache {
    type Error = std::io::Error;
    fn with_blocks<F, W>(
        &self,
        from: Option<BlockHeight>,
        limit: Option<usize>,
        mut f: F,
    ) -> Result<(), error::Error<W, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), error::Error<W, Self::Error>>,
    {
        let blocks = self
            .0
            .lock()
            .map_err(|_| error::Error::BlockSource(std::io::Error::other("cache unavailable")))?;
        self.1.lock().unwrap().stage = "SCAN";
        let progress = self.progress();
        if let Some(p) = &progress {
            p.scan_enter();
        }
        let mut processed = 0;
        let result = (|| {
            for (_, b) in blocks
                .range(from.map(u32::from).unwrap_or(0)..)
                .take(limit.unwrap_or(usize::MAX))
            {
                f(b.clone())?;
                processed += 1;
            }
            Ok(())
        })();
        if let Some(p) = &progress {
            p.scan_return(processed, result.is_ok());
        }
        result
    }
}
#[async_trait]
impl BlockCache for MemoryCache {
    fn get_tip_height(
        &self,
        range: Option<&ScanRange>,
    ) -> Result<Option<BlockHeight>, Self::Error> {
        let blocks = self
            .0
            .lock()
            .map_err(|_| std::io::Error::other("cache unavailable"))?;
        Ok(blocks
            .keys()
            .rev()
            .find(|h| range.is_none_or(|r| r.block_range().contains(&BlockHeight::from_u32(**h))))
            .copied()
            .map(BlockHeight::from_u32))
    }
    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        let blocks = self
            .0
            .lock()
            .map_err(|_| std::io::Error::other("cache unavailable"))?;
        let mut result = Vec::new();
        for h in u32::from(range.block_range().start)..u32::from(range.block_range().end) {
            let b = blocks
                .get(&h)
                .ok_or_else(|| std::io::Error::other("cache gap"))?;
            result.push(b.clone());
        }
        Ok(result)
    }
    async fn insert(&self, values: Vec<CompactBlock>) -> Result<(), Self::Error> {
        if let Some(p) = self.progress() {
            p.collected(values.len());
        }
        let mut blocks = self
            .0
            .lock()
            .map_err(|_| std::io::Error::other("cache unavailable"))?;
        self.1.lock().unwrap().range = values.first().zip(values.last()).and_then(|(a, b)| {
            Some((u32::try_from(a.height).ok()?, u32::try_from(b.height).ok()?))
        });
        for b in values {
            let h = u32::try_from(b.height)
                .map_err(|_| std::io::Error::other("invalid cache height"))?;
            blocks.insert(h, b);
        }
        self.record(&blocks, "CACHE_INSERT");
        if blocks.len() > 8192
            || blocks.values().map(Message::encoded_len).sum::<usize>() > MAX_BLOCK_BYTES
        {
            return Err(std::io::Error::other(CacheLimit));
        }
        Ok(())
    }
    fn delete<'life0, 'async_trait>(
        &'life0 self,
        range: ScanRange,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(), Self::Error>> + Send + 'async_trait>,
    >
    where
        'life0: 'async_trait,
        Self: 'async_trait,
    {
        // Maintained sync queues these futures. Complete deletion and accounting
        // at call time, even when the ready result is retained or dropped unpolled.
        let result = (|| {
            let mut blocks = self
                .0
                .lock()
                .map_err(|_| std::io::Error::other("cache unavailable"))?;
            blocks.retain(|h, _| !range.block_range().contains(&BlockHeight::from_u32(*h)));
            self.record(&blocks, "CACHE_DELETE");
            if let Some(p) = self.progress() {
                p.durable(
                    u64::from(u32::from(range.block_range().start)),
                    u64::from(u32::from(range.block_range().end)),
                );
            }
            Ok(())
        })();
        Box::pin(std::future::ready(result))
    }
}

async fn block<T>(
    client: &mut CompactTxStreamerClient<T>,
    height: u32,
    phase: GuardPhase,
) -> SpikeResult<CompactBlock>
where
    T: tonic::client::GrpcService<tonic::body::Body>,
    T::Error: Into<tonic::codegen::StdError>,
    T::ResponseBody: tonic::codegen::Body<Data = tonic::codegen::Bytes> + Send + 'static,
    <T::ResponseBody as tonic::codegen::Body>::Error: Into<tonic::codegen::StdError> + Send,
{
    let b = client
        .get_block(service::BlockId {
            height: u64::from(height),
            hash: vec![],
        })
        .await?
        .into_inner();
    if b.height != u64::from(height) {
        return Err(guard_error(Guard::BlockHeight, phase));
    }
    if b.hash.len() != 32 {
        return Err(guard_error(Guard::BlockHashShape, phase));
    }
    if b.prev_hash.len() != 32 {
        return Err(guard_error(Guard::BlockPrevHashShape, phase));
    }
    Ok(b)
}
async fn tip<T>(
    client: &mut CompactTxStreamerClient<T>,
    phase: GuardPhase,
) -> SpikeResult<(u32, Vec<u8>)>
where
    T: tonic::client::GrpcService<tonic::body::Body>,
    T::Error: Into<tonic::codegen::StdError>,
    T::ResponseBody: tonic::codegen::Body<Data = tonic::codegen::Bytes> + Send + 'static,
    <T::ResponseBody as tonic::codegen::Body>::Error: Into<tonic::codegen::StdError> + Send,
{
    let b = client
        .get_latest_block(service::ChainSpec::default())
        .await?
        .into_inner();
    let height = u32::try_from(b.height).map_err(|_| guard_error(Guard::Other, phase))?;
    let canonical = block(client, height, phase).await?;
    if !b.hash.is_empty() && b.hash != canonical.hash {
        return Err(guard_error(Guard::TipAdvertisedHash, phase));
    }
    Ok((height, canonical.hash))
}

fn checkpoint_matches(wallet: &TestnetWallet, remote: &CompactBlock) -> SpikeResult<bool> {
    Ok(wallet
        .block_metadata(BlockHeight::from_u32(u32::try_from(remote.height)?))?
        .is_some_and(|m| m.block_hash().0.as_slice() == remote.hash))
}
#[derive(Debug, PartialEq)]
enum CheckpointAction {
    Current,
    Lagging,
    Diverged,
}
fn reviewed_rescan(
    wallet: &mut TestnetWallet,
    path: &Path,
    context: &Value,
    rescan: u32,
    anchor: u32,
    tip: u32,
    authorized: bool,
) -> SpikeResult<()> {
    if !authorized
        || rescan < anchor
        || rescan > tip
        || wallet
            .block_max_scanned()?
            .is_none_or(|b| u32::from(b.block_height()) < rescan)
    {
        return Err("reviewed rescan required".into());
    }
    let before = observations(path, context)?;
    if before.iter().any(|o| {
        !context["receipts"]
            .as_array()
            .is_some_and(|items| items.iter().any(|r| identity(r) == identity(o)))
            && !context["unmapped"]
                .as_array()
                .is_some_and(|items| items.iter().any(|r| identity(r) == identity(o)))
    }) {
        return Err("rescan observation acknowledgement required".into());
    }
    wallet.truncate_to_height(BlockHeight::from_u32(rescan))?;
    Ok(())
}
fn checkpoint_action(
    wallet: &TestnetWallet,
    remote: &CompactBlock,
    tip_height: u32,
) -> SpikeResult<CheckpointAction> {
    let max = wallet.block_max_scanned()?.ok_or("checkpoint missing")?;
    let max_height = u32::from(max.block_height());
    if remote.height != u64::from(max_height.min(tip_height)) {
        return Err("checkpoint mismatch".into());
    }
    Ok(if !checkpoint_matches(wallet, remote)? {
        CheckpointAction::Diverged
    } else if tip_height < max_height {
        CheckpointAction::Lagging
    } else {
        CheckpointAction::Current
    })
}

fn tls_endpoint(endpoint: &str) -> SpikeResult<Endpoint> {
    Ok(Endpoint::from_shared(endpoint.to_owned())?
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .tls_config(ClientTlsConfig::new().with_webpki_roots())?)
}

fn validate_output_inclusion(o: &mut Value, b: &CompactBlock) -> SpikeResult<()> {
    let phase = GuardPhase::OutputInclusion;
    if o["block_hash"].as_str() != Some(hex(&b.hash).as_str()) {
        return Err(guard_error(Guard::OutputBlockHash, phase));
    }
    let index = o["tx_index"]
        .as_u64()
        .and_then(|i| usize::try_from(i).ok())
        .ok_or_else(|| guard_error(Guard::OutputTxIndex, phase))?;
    // Compact indices include omitted transactions; search the actual index field.
    let tx = b
        .vtx
        .iter()
        .find(|tx| usize::try_from(tx.index).ok() == Some(index))
        .ok_or_else(|| guard_error(Guard::OutputTxIndex, phase))?;
    let txid = field(o, "txid").map_err(|_| guard_error(Guard::OutputTxId, phase))?;
    if hex(&tx.txid) != txid {
        return Err(guard_error(Guard::OutputTxId, phase));
    }
    let output_index = o["output_index"]
        .as_u64()
        .ok_or_else(|| guard_error(Guard::OutputTxIndex, phase))?;
    let count = match o["pool"].as_str() {
        Some("SAPLING") => tx.outputs.len(),
        Some("ORCHARD") => tx.actions.len(),
        Some("IRONWOOD") => tx.ironwood_actions.len(),
        _ => return Err("unsupported receiving pool".into()),
    };
    if output_index >= count as u64 {
        return Err(guard_error(Guard::OutputTxIndex, phase));
    }
    o["block_time"] = json!(b.time);
    o["canonical"] = json!(true);
    Ok(())
}

fn receipt_context(context: &Value) -> SpikeResult<&Vec<Value>> {
    context["receipts"]
        .as_array()
        .ok_or_else(|| guard_error(Guard::ReceiptContext, GuardPhase::OutputInclusion))
}

fn verification_epoch(now: SystemTime) -> SpikeResult<u64> {
    now.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| guard_error(Guard::Clock, GuardPhase::FinalTip))
}

async fn synchronize(
    path: &Path,
    context: &Value,
    endpoint: &str,
    rescan: Option<u32>,
    diagnostics: &DiagnosticState,
) -> SpikeResult<Value> {
    if !endpoint.starts_with("https://") || field(context, "endpoint_ref")? != endpoint {
        return Err("endpoint binding mismatch".into());
    }
    diagnostics.lock().unwrap().stage = "TLS_CONNECT";
    let connector = tls_endpoint(endpoint)?;
    diagnostics.lock().unwrap().stage = "RPC_CONNECT";
    let channel = connector.connect().await?;
    if env::var("DARKPOOL_WATCHER_DIAGNOSTIC_IPC").as_deref() == Ok("1") {
        let progress = progress::Progress::new(path, true);
        diagnostics.lock().unwrap().progress = Some(progress.clone());
        let transport = progress::Observed {
            inner: channel,
            progress: progress.clone(),
        };
        let mut client = CompactTxStreamerClient::with_interceptor(
            transport,
            StageInterceptor(Arc::clone(diagnostics)),
        );
        let result = synchronize_with_client(path, context, rescan, diagnostics, &mut client).await;
        progress.shutdown();
        return result;
    }
    let mut client = CompactTxStreamerClient::with_interceptor(
        channel,
        StageInterceptor(Arc::clone(diagnostics)),
    );
    synchronize_with_client(path, context, rescan, diagnostics, &mut client).await
}

// Private injectable transport: production and socket-free tests execute this same policy.
async fn synchronize_with_client<T>(
    path: &Path,
    context: &Value,
    rescan: Option<u32>,
    diagnostics: &DiagnosticState,
    client: &mut CompactTxStreamerClient<T>,
) -> SpikeResult<Value>
where
    T: tonic::client::GrpcService<tonic::body::Body>,
    T::Error: Into<tonic::codegen::StdError>,
    T::ResponseBody: tonic::codegen::Body<Data = tonic::codegen::Bytes> + Send + 'static,
    <T::ResponseBody as tonic::codegen::Body>::Error: Into<tonic::codegen::StdError> + Send,
{
    let info = client
        .get_lightd_info(service::Empty {})
        .await?
        .into_inner();
    if info.chain_name != "test" && info.chain_name != "testnet" {
        return Err("official testnet required".into());
    }
    let mut wallet = open_existing(path, context)?;
    let (height, hash) = tip(client, GuardPhase::Initial).await?;
    let anchor = context["anchor_height"]
        .as_u64()
        .and_then(|h| u32::try_from(h).ok())
        .ok_or_else(|| guard_error(Guard::Other, GuardPhase::Initial))?;
    if height < anchor {
        return Err(guard_error(Guard::Other, GuardPhase::Initial));
    }
    let anchor_block = block(client, anchor, GuardPhase::Initial).await?;
    if hex(&anchor_block.hash) != field(context, "anchor_hash")? {
        return Ok(json!({"stop_reason":"ANCHOR_CONFLICT"}));
    }
    if let Some(rescan) = rescan {
        diagnostics.lock().unwrap().stage = "CHECKPOINT";
        reviewed_rescan(
            &mut wallet,
            path,
            context,
            rescan,
            anchor,
            height,
            env::var("DARKPOOL_WATCHER_RESCAN_REVIEW").as_deref() == Ok("1"),
        )?;
    }
    // Explicit verification handles equal-height and shorter forks, even without a new scan range.
    diagnostics.lock().unwrap().stage = "CHECKPOINT";
    if let Some(max) = wallet.block_max_scanned()? {
        let compare = u32::from(max.block_height()).min(height);
        let remote = block(client, compare, GuardPhase::Checkpoint).await?;
        diagnostics.lock().unwrap().stage = "CHECKPOINT";
        let action = checkpoint_action(&wallet, &remote, height)?;
        if action == CheckpointAction::Lagging {
            return Err("lagging endpoint".into());
        }
        if action == CheckpointAction::Diverged {
            let mut common = compare;
            loop {
                let remote = block(client, common, GuardPhase::Checkpoint).await?;
                diagnostics.lock().unwrap().stage = "CHECKPOINT";
                if checkpoint_matches(&wallet, &remote)? {
                    break;
                }
                if common <= anchor {
                    return Ok(json!({"stop_reason":"ANCHOR_CONFLICT"}));
                }
                common -= 1;
            }
            wallet.truncate_to_height(BlockHeight::from_u32(common))?;
            wallet.update_chain_tip(BlockHeight::from_u32(height))?;
        }
    }
    let cache = MemoryCache(
        Mutex::default(),
        Arc::clone(diagnostics),
        #[cfg(test)]
        Mutex::default(),
    );
    let progress = cache.progress();
    if let Some(p) = &progress {
        p.begin();
    }
    let maintained_result =
        zcash_client_backend::sync::run(client, &Network::TestNetwork, &cache, &mut wallet, 200)
            .await;
    if let Some(p) = &progress {
        p.finish(maintained_result.is_ok());
    }
    maintained_result.map_err(|e| sync_failure(e, diagnostics))?;
    diagnostics.lock().unwrap().stage = "COMPLETE_CHECK";
    let fully = wallet.block_fully_scanned()?.ok_or("scan incomplete")?;
    if u32::from(fully.block_height()) != height || fully.block_hash().0.as_slice() != hash {
        return Err("scan snapshot changed".into());
    }
    let mut outputs = observations(path, context)?;
    diagnostics.lock().unwrap().stage = "CLOSE_HISTORY";
    let close_proof = close::build(path, context, height, &hash, client).await?;
    let mut inclusion_blocks = BTreeMap::new();
    let mut required: BTreeMap<u32, Vec<usize>> = BTreeMap::new();
    for (index, o) in outputs.iter().enumerate() {
        if let Some(h) = o["block_height"].as_u64() {
            let h = u32::try_from(h)
                .map_err(|_| guard_error(Guard::Other, GuardPhase::OutputInclusion))?;
            if h > height {
                return Err(guard_error(Guard::Other, GuardPhase::OutputInclusion));
            }
            required.entry(h).or_default().push(index);
        }
    }
    let mut inclusion_bytes = 0usize;
    let inclusion_read = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    inclusion_read.busy_timeout(Duration::from_secs(5))?;
    for (h, indices) in required {
        let b = block(client, h, GuardPhase::OutputInclusion).await?;
        inclusion_bytes = inclusion_bytes
            .checked_add(b.encoded_len())
            .ok_or("inclusion byte limit")?;
        if inclusion_bytes > MAX_BLOCK_BYTES {
            return Err(history_limit(diagnostics, inclusion_blocks.len(), inclusion_bytes).into());
        }
        for index in indices {
            validate_output_inclusion(&mut outputs[index], &b)?;
        }
        close::check_inclusion(&inclusion_read, &b)?;
        inclusion_blocks.insert(h, close::inclusion(&b));
    }
    // Retained observations missing from current wallet must be explicitly reconciled.
    for old in receipt_context(context)? {
        if outputs.iter().any(|o| identity(o) == identity(old)) {
            continue;
        }
        let mut orphan = old.clone();
        orphan["present"] = json!(false);
        orphan["canonical"] = json!(false);
        orphan["is_change"] = json!(false);
        orphan["key_scope"] = json!(0);
        orphan["receiver_verified"] = json!(true);
        if let Some(h) = old["block_height"].as_u64()
            && h <= u64::from(height)
        {
            let b = block(client, u32::try_from(h)?, GuardPhase::OutputInclusion).await?;
            if old["block_hash"].as_str() == Some(hex(&b.hash).as_str()) {
                return Ok(json!({"stop_reason":"RESTORE_REVIEW"}));
            }
        }
        outputs.push(orphan);
    }
    let (end_height, end_hash) = tip(client, GuardPhase::FinalTip).await?;
    if end_height < height {
        return Err(guard_error(
            Guard::FinalTipHeightChanged,
            GuardPhase::FinalTip,
        ));
    }
    // Keep the original scan target: a newer tip requires a fresh canonical-H check.
    let target_hash = if end_height == height {
        end_hash
    } else {
        block(client, height, GuardPhase::FinalTip).await?.hash
    };
    if target_hash != hash {
        return Err(guard_error(
            Guard::FinalTipHashChanged,
            GuardPhase::FinalTip,
        ));
    }
    let now = verification_epoch(SystemTime::now())?;
    // Timestamp text is rendered by PostgreSQL from integer epoch seconds.
    let verified_at = format!("{}", now);
    Ok(
        json!({"outputs":outputs,"chain":{"complete":true,"verified":true,"tip_height":height,"tip_hash":hex(&hash),
        "scanned_height":height,"scanned_hash":hex(&hash),"anchor_hash":hex(&anchor_block.hash),
        "verified_at_epoch":verified_at,"close_proof":close_proof,"inclusion_blocks":inclusion_blocks.into_values().collect::<Vec<_>>()}}),
    )
}

fn lock(path: &Path) -> SpikeResult<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0); // Kernel-owned exclusive handle; released after crashes.
        Ok(options.open(path.with_extension("watcher-lock"))?)
    }
    #[cfg(not(windows))]
    {
        let _ = options;
        let _ = path;
        Err("this MVP watcher lock requires Windows".into())
    }
}
fn read_frame(reader: &mut impl Read) -> SpikeResult<Option<Value>> {
    let mut first = [0; 1];
    if reader.read(&mut first)? == 0 {
        return Ok(None);
    }
    let mut length = [0; 4];
    length[0] = first[0];
    reader.read_exact(&mut length[1..])?;
    let n = u32::from_be_bytes(length) as usize;
    if n == 0 || n > MAX_FRAME {
        return Err("invalid private frame".into());
    }
    let mut data = vec![0; n];
    reader.read_exact(&mut data)?;
    Ok(Some(serde_json::from_slice(&data)?))
}
fn write_frame(writer: &mut impl Write, value: &Value) -> SpikeResult<()> {
    let data = serde_json::to_vec(value)?;
    if data.is_empty() || data.len() > MAX_FRAME {
        return Err("bounded private frame exceeded".into());
    }
    writer.write_all(&u32::try_from(data.len())?.to_be_bytes())?;
    writer.write_all(&data)?;
    writer.flush()?;
    Ok(())
}
pub fn serve() -> SpikeResult<()> {
    if env::var("ZCASH_NETWORK").as_deref() != Ok("testnet") {
        return Err("testnet required".into());
    }
    let (path, _) = crate::live_target::configuration("watcher")?;
    let endpoint = env::var("CHAIN_ENDPOINT")?;
    let path = Path::new(&path);
    if !path.is_file() {
        return Err("provisioned wallet required".into());
    }
    let _lock = lock(path)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let mut input = std::io::stdin().lock();
    let mut retained = false;
    loop {
        let request = match read_frame(&mut input) {
            Ok(Some(request)) => request,
            Ok(None) => break,
            Err(_) => {
                if env::var("DARKPOOL_WATCHER_DIAGNOSTIC_IPC").as_deref() == Ok("1") {
                    let failure = Diagnostic {
                        class: FailureClass::IpcFrame,
                        stage: "IPC",
                        ..Default::default()
                    };
                    write_frame(
                        &mut std::io::stdout().lock(),
                        &json!({"error":true,"diagnostic":failure.value()}),
                    )?;
                }
                return Err("watcher unavailable".into());
            }
        };
        let diagnostics = DiagnosticState::default();
        let context = &request["context"];
        let result = (|| -> SpikeResult<Value> {
            match request["operation"].as_str() {
                Some("observe") => {
                    diagnostics.lock().unwrap().stage = "OBSERVE";
                    retained = true;
                    Ok(json!({"outputs":observations(path,context)?}))
                }
                Some("sync") if retained => {
                    retained = false;
                    let rescan = if request["rescan_height"].is_null() {
                        None
                    } else {
                        Some(u32::try_from(
                            request["rescan_height"].as_u64().ok_or("invalid rescan")?,
                        )?)
                    };
                    runtime.block_on(synchronize(path, context, &endpoint, rescan, &diagnostics))
                }
                _ => Err("observation preflight required".into()),
            }
        })();
        match result {
            Ok(value) => write_frame(&mut std::io::stdout().lock(), &value)?,
            Err(e) => {
                let failure = classify_failure(e.as_ref(), &diagnostics);
                let mut frame = json!({"error":true});
                if env::var("DARKPOOL_WATCHER_DIAGNOSTIC_IPC").as_deref() == Ok("1") {
                    frame["diagnostic"] = failure.value();
                }
                write_frame(&mut std::io::stdout().lock(), &frame)?;
                return Err("watcher unavailable".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "watcher_sync_tests.rs"]
mod sync_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tls_construction_in_fresh_process() -> SpikeResult<()> {
        const CHILD: &str = "DARKPOOL_TLS_CONSTRUCTION_TEST_CHILD";
        if env::var(CHILD).as_deref() == Ok("1") {
            // No provider installation or other test setup runs in this process.
            // This is the exact connector construction used by synchronize.
            let _endpoint = tls_endpoint("https://127.0.0.1:1")?;
            return Ok(());
        }
        let output = std::process::Command::new(env::current_exe()?)
            .args([
                "--exact",
                "watcher::tests::tls_construction_in_fresh_process",
            ])
            .env(CHILD, "1")
            .output()?;
        assert!(
            output.status.success(),
            "fresh-process TLS construction failed"
        );
        Ok(())
    }
    #[test]
    fn frames_are_bounded_and_do_not_use_logs() -> SpikeResult<()> {
        let value = json!({"operation":"observe"});
        let mut data = Vec::new();
        write_frame(&mut data, &value)?;
        assert_eq!(read_frame(&mut data.as_slice())?, Some(value));
        assert!(read_frame(&mut [0, 64, 0, 1].as_slice()).is_err());
        assert!(read_frame(&mut [0, 0, 0, 1, b'{'].as_slice()).is_err());
        Ok(())
    }
    #[test]
    fn missing_wallet_never_recreated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.sqlite");
        assert!(observations(&path, &json!({"network":"testnet"})).is_err());
        assert!(!path.exists());
    }
    #[test]
    fn byte_encodings_are_explicit() -> SpikeResult<()> {
        assert_eq!(bytes("0001feff")?, vec![0, 1, 254, 255]);
        assert!(bytes("0G").is_err());
        assert!(bytes("0").is_err());
        Ok(())
    }

    // Genuine encrypted synthetic notes, scanned/rewound by the pinned maintained
    // wallet. No SQL insertion into wallet note/transaction/block tables.
    #[test]
    fn maintained_ironwood_receiver_scan_restart_and_reorg() -> SpikeResult<()> {
        use crate::{import_view_only_account, open_testnet_wallet, tests::ephemeral_viewing_key};
        use zcash_client_backend::{
            data_api::{
                AccountBirthday,
                chain::{ChainState, scan_cached_blocks},
                testing::{AddressType, IronwoodFvk, TestFvk},
            },
            proto::compact_formats::{ChainMetadata, CompactTx},
        };
        use zcash_primitives::block::BlockHash;
        use zcash_protocol::{
            consensus::{NetworkUpgrade, Parameters},
            value::Zatoshis,
        };
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("view.sqlite");
        let network = Network::TestNetwork;
        let h = network
            .activation_height(NetworkUpgrade::Nu6_3)
            .ok_or("activation")?;
        let viewing = ephemeral_viewing_key()?;
        let fvk = IronwoodFvk(viewing.orchard().ok_or("orchard")?.clone());
        let initial = ChainState::empty(h - 1, BlockHash([0; 32]));
        let mut wallet = open_testnet_wallet(&path)?;
        let account = import_view_only_account(
            &mut wallet,
            &viewing,
            &AccountBirthday::from_parts(initial.clone(), None),
        )?;
        wallet.update_chain_tip(h + 2)?;
        drop(wallet);
        let ticket = "12".repeat(32);
        let commitment = "ab".repeat(32);
        let allocation = crate::issuance::allocate(&path, "m9", "v9", &ticket, &commitment)?;
        let index: [u8; 11] = bytes(&allocation.diversifier)?
            .try_into()
            .map_err(|_| "index")?;
        let mut tx = CompactTx {
            index: 7,
            txid: vec![0x25; 32],
            ..Default::default()
        };
        let nullifier = fvk.add_output(
            &mut tx,
            &network,
            h + 1,
            None,
            AddressType::DiversifiedExternal(index.into()),
            Zatoshis::from_u64(1000)?,
            0,
            &mut OsRng,
        );
        // A second note to an unissued receiver remains unmapped, not guessed by amount.
        fvk.add_output(
            &mut tx,
            &network,
            h + 1,
            None,
            AddressType::DiversifiedExternal(999u32.into()),
            Zatoshis::from_u64(1000)?,
            0,
            &mut OsRng,
        );
        let mut spending = CompactTx {
            index: 8,
            txid: vec![0x26; 32],
            ..Default::default()
        };
        fvk.add_spend(&mut spending, nullifier, &mut OsRng);
        let cache = MemoryCache::default();
        let mut blocks = Vec::new();
        for offset in 0..3u32 {
            blocks.push(CompactBlock {
                height: u64::from(h + offset),
                hash: vec![offset as u8 + 1; 32],
                prev_hash: vec![offset as u8; 32],
                time: 1800000000 + offset,
                vtx: if offset == 1 {
                    vec![tx.clone()]
                } else if offset == 2 {
                    vec![spending.clone()]
                } else {
                    vec![]
                },
                chain_metadata: Some(ChainMetadata {
                    sapling_commitment_tree_size: 0,
                    orchard_commitment_tree_size: 0,
                    ironwood_commitment_tree_size: if offset == 0 {
                        0
                    } else if offset == 1 {
                        2
                    } else {
                        3
                    },
                }),
                ..Default::default()
            });
        }
        for b in &blocks {
            cache
                .0
                .lock()
                .unwrap()
                .insert(u32::try_from(b.height)?, b.clone());
        }
        let context = json!({"network":"testnet","market_id":"m9","vault_context_ref":"v9","account_ref":account.expose_uuid().to_string(),"anchor_hash":"01".repeat(32)});
        let mut wallet = open_existing(&path, &context)?;
        scan_cached_blocks(&network, &cache, &mut wallet, h, &initial, 1)?;
        scan_cached_blocks(
            &network,
            &cache,
            &mut wallet,
            h + 1,
            &ChainState::empty(h, BlockHash([1; 32])),
            2,
        )?;
        let notes = observations(&path, &context)?;
        assert_eq!(notes.len(), 2);
        let mapped = notes
            .iter()
            .find(|n| n["receiver_verified"] == true)
            .ok_or("mapping")?;
        assert_eq!(mapped["ticket_id"], ticket);
        assert_eq!(mapped["receiver_ref"], allocation.ua);
        assert_eq!(mapped["pool"], "IRONWOOD");
        assert_eq!(mapped["tx_index"], 7);
        assert_eq!(mapped["amount_zat"], "1000");
        assert_eq!(mapped["output_index"], 0);
        assert!(
            notes
                .iter()
                .any(|n| n["receiver_verified"] == false && n["ticket_id"].is_null())
        );
        assert!(checkpoint_matches(&wallet, &blocks[2])?);
        assert_eq!(
            checkpoint_action(&wallet, &blocks[2], u32::from(h + 2))?,
            CheckpointAction::Current
        );
        let mut equal_fork = blocks[2].clone();
        equal_fork.hash = vec![0xaa; 32];
        assert!(!checkpoint_matches(&wallet, &equal_fork)?);
        assert_eq!(
            checkpoint_action(&wallet, &equal_fork, u32::from(h + 2))?,
            CheckpointAction::Diverged
        );
        let mut shorter_fork = blocks[1].clone();
        shorter_fork.hash = vec![0xbb; 32];
        assert!(!checkpoint_matches(&wallet, &shorter_fork)?);
        assert_eq!(
            checkpoint_action(&wallet, &shorter_fork, u32::from(h + 1))?,
            CheckpointAction::Diverged
        );
        assert_eq!(
            checkpoint_action(&wallet, &blocks[1], u32::from(h + 1))?,
            CheckpointAction::Lagging
        );
        drop(wallet);
        assert_eq!(observations(&path, &context)?, notes); // Restart uses persisted history.
        let mut wallet = open_existing(&path, &context)?;
        assert!(
            reviewed_rescan(
                &mut wallet,
                &path,
                &context,
                u32::from(h),
                u32::from(h),
                u32::from(h + 2),
                true
            )
            .is_err()
        );
        let retained_context = json!({"receipts":notes,"unmapped":[]});
        let mut acknowledged = context.clone();
        acknowledged["receipts"] = retained_context["receipts"].clone();
        acknowledged["unmapped"] = json!([]);
        assert!(
            reviewed_rescan(
                &mut wallet,
                &path,
                &acknowledged,
                u32::from(h),
                u32::from(h),
                u32::from(h + 2),
                false
            )
            .is_err()
        );
        reviewed_rescan(
            &mut wallet,
            &path,
            &acknowledged,
            u32::from(h),
            u32::from(h),
            u32::from(h + 2),
            true,
        )?;
        let after = observations(&path, &context)?;
        assert!(after.iter().all(|n| n["block_height"].is_null()));
        // The preflight snapshot retains identity and principal even when wallet
        // rewind loses or de-mines the observation.
        assert_eq!(mapped["block_height"], u32::from(h + 1));
        assert_eq!(mapped["amount_zat"], "1000");
        let remine_state = ChainState::empty(h, BlockHash([1; 32]));
        cache
            .0
            .lock()
            .unwrap()
            .insert(u32::from(h + 1), shorter_fork.clone());
        cache.0.lock().unwrap().remove(&u32::from(h + 2));
        wallet.update_chain_tip(h + 1)?;
        scan_cached_blocks(&network, &cache, &mut wallet, h + 1, &remine_state, 1)?;
        let remined = observations(&path, &context)?;
        assert_eq!(
            remined
                .iter()
                .find(|n| n["receiver_verified"] == true)
                .ok_or("remined")?["block_hash"],
            hex(&shorter_fork.hash)
        );
        assert_eq!(
            identity(mapped),
            identity(
                remined
                    .iter()
                    .find(|n| n["receiver_verified"] == true)
                    .unwrap()
            )
        );
        Ok(())
    }
    #[test]
    fn exclusive_kernel_lock_releases_on_handle_drop() -> SpikeResult<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("wallet.sqlite");
        let first = lock(&path)?;
        assert!(lock(&path).is_err());
        drop(first);
        let _next = lock(&path)?;
        Ok(())
    }
}
