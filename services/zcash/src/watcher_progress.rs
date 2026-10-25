//! Closed, opt-in observation of the real maintained path. Never owns wallet authority.
use http_body_util::{BodyExt, combinators::UnsyncBoxBody};
use prost::Message;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Value, json};
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{SyncSender, sync_channel},
    },
    task::{Context, Poll},
    time::{Duration, Instant},
};
use tonic::{
    body::Body,
    codegen::{
        Bytes, Service,
        http::{Request, Response},
    },
};
use zcash_client_backend::proto::service::BlockRange;

pub(super) const MAX_COUNTER: u64 = u32::MAX as u64;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Stage {
    Other,
    SyncEnter,
    RootImport,
    Tip,
    UnitEnter,
    Download,
    TreeState,
    ScanWork,
    CommitPending,
    UnitComplete,
    SyncComplete,
}
impl Stage {
    fn name(self) -> &'static str {
        match self {
            Self::Other => "OTHER",
            Self::SyncEnter => "SYNC_ENTER",
            Self::RootImport => "ROOT_IMPORT",
            Self::Tip => "TIP",
            Self::UnitEnter => "UNIT_ENTER",
            Self::Download => "DOWNLOAD",
            Self::TreeState => "TREE_STATE",
            Self::ScanWork => "SCAN_WORK",
            Self::CommitPending => "COMMIT_PENDING",
            Self::UnitComplete => "UNIT_COMPLETE",
            Self::SyncComplete => "SYNC_COMPLETE",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Coverage {
    None,
    Empty,
    Short,
    Complete,
    Unknown,
}
impl Coverage {
    fn name(self) -> &'static str {
        match self {
            Self::None => "NONE",
            Self::Empty => "EMPTY",
            Self::Short => "SHORT",
            Self::Complete => "COMPLETE",
            Self::Unknown => "UNKNOWN",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
    Other,
    Verify,
    Scan,
}
impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Other => "OTHER",
            Self::Verify => "VERIFY",
            Self::Scan => "SCAN",
        }
    }
}
#[derive(Debug)]
struct State {
    active: bool,
    returned: bool,
    stage: Stage,
    completed: Stage,
    coverage: Coverage,
    kind: Kind,
    requested: u64,
    received: u64,
    units: u64,
    committed: u64,
    sequence: u64,
    outcomes: [u64; 6], // Verify/Scan EMPTY, SHORT, COMPLETE survive coalesced retries.
    terminated: bool,
    passes: u8,
    processed: u64,
    start: Instant,
    changed: Instant,
    // Transient correlation only. These fields never cross IPC or enter a log.
    range: Option<(u64, u64)>,
    candidate: Option<(u64, u64, Kind)>,
    #[cfg(test)]
    events: Vec<Value>,
}
impl State {
    fn value(&self) -> Value {
        json!({"version":1,"profile":"MAINTAINED_SYNC","stage":self.stage.name(),"last_completed_stage":self.completed.name(),"coverage":self.coverage.name(),"unit_kind":self.kind.name(),"requested_count":self.requested,"received_count":self.received,"completed_unit_count":self.units,"committed_block_count":self.committed,"sequence":self.sequence,"elapsed_ms":self.start.elapsed().as_millis().min(MAX_COUNTER as u128) as u64,"last_progress_age_ms":self.changed.elapsed().as_millis().min(MAX_COUNTER as u128) as u64,"stream_terminated":self.terminated,"maintained_returned":self.returned,"verify_empty_count":self.outcomes[0],"verify_short_count":self.outcomes[1],"verify_complete_count":self.outcomes[2],"scan_empty_count":self.outcomes[3],"scan_short_count":self.outcomes[4],"scan_complete_count":self.outcomes[5]})
    }
}
struct Inner {
    state: Mutex<State>,
    path: PathBuf,
    stopped: AtomicBool,
}
#[derive(Clone)]
pub(super) struct Progress {
    inner: Arc<Inner>,
    notify: Option<SyncSender<()>>,
    writer: Arc<Mutex<Option<std::thread::JoinHandle<()>>>>,
}
impl std::fmt::Debug for Progress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ClosedProgress")
    }
}
impl Progress {
    pub(super) fn new(path: &Path, ipc: bool) -> Self {
        let now = Instant::now();
        let inner = Arc::new(Inner {
            path: path.to_owned(),
            stopped: AtomicBool::new(false),
            state: Mutex::new(State {
                active: false,
                returned: false,
                stage: Stage::Other,
                completed: Stage::Other,
                coverage: Coverage::None,
                kind: Kind::Other,
                requested: 0,
                received: 0,
                units: 0,
                committed: 0,
                sequence: 0,
                outcomes: [0; 6],
                terminated: false,
                passes: 0,
                processed: 0,
                start: now,
                changed: now,
                range: None,
                candidate: None,
                #[cfg(test)]
                events: Vec::new(),
            }),
        });
        let writer = Arc::new(Mutex::new(None));
        let notify = if ipc {
            let (tx, rx) = sync_channel(1);
            let state = Arc::clone(&inner);
            // One notification and one shared current record; no growing queue.
            let handle = std::thread::Builder::new().spawn(move || {
                while rx.recv().is_ok() {
                    std::thread::sleep(Duration::from_millis(25)); // Persistence rate only, never a sync deadline.
                    let value = state.state.lock().ok().map(|s| s.value());
                    if let Some(value) = value {
                        let _ = super::write_frame(
                            &mut std::io::stdout().lock(),
                            &json!({"progress":value}),
                        );
                    }
                    if state.stopped.load(Ordering::Relaxed) {
                        break;
                    }
                }
            });
            if let Ok(handle) = handle {
                *writer.lock().unwrap() = Some(handle);
                Some(tx)
            } else {
                None // Diagnostic writer startup must not change synchronization success.
            }
        } else {
            None
        };
        Self {
            inner,
            notify,
            writer,
        }
    }
    fn update(&self, f: impl FnOnce(&mut State)) {
        if let Ok(mut s) = self.inner.state.lock() {
            f(&mut s);
            s.sequence = s.sequence.saturating_add(1).min(MAX_COUNTER);
            s.changed = Instant::now();
            #[cfg(test)]
            {
                if s.events.len() < 8192 {
                    let value = s.value();
                    s.events.push(value);
                }
            }
        }
        if let Some(tx) = &self.notify {
            let _ = tx.try_send(());
        }
    }
    pub(super) fn begin(&self) {
        self.update(|s| {
            s.start = Instant::now();
            s.active = true;
            s.returned = false;
            s.stage = Stage::SyncEnter;
        });
    }
    pub(super) fn finish(&self, success: bool) {
        self.update(|s| {
            s.active = false;
            s.returned = true;
            if success {
                s.stage = Stage::SyncComplete;
                s.completed = Stage::SyncComplete;
            } else if !s.terminated {
                s.coverage = Coverage::Unknown;
                if s.stage == Stage::Download {
                    s.terminated = true;
                }
            }
        });
    }
    pub(super) fn shutdown(&self) {
        self.inner.stopped.store(true, Ordering::Relaxed);
        if let Some(tx) = &self.notify {
            let _ = tx.try_send(());
        }
        if let Some(handle) = self.writer.lock().unwrap().take() {
            let _ = handle.join();
        }
    }
    fn active(&self) -> bool {
        self.inner.state.lock().is_ok_and(|s| s.active)
    }
    pub(super) fn collected(&self, count: usize) {
        self.update(|s| {
            s.terminated = true;
            s.received = (count as u64).min(MAX_COUNTER);
            s.completed = Stage::Download;
            s.coverage = if s.range.is_none() {
                Coverage::Unknown
            } else if count == 0 {
                Coverage::Empty
            } else if (count as u64) < s.requested {
                Coverage::Short
            } else if count as u64 == s.requested {
                Coverage::Complete
            } else {
                Coverage::Unknown
            };
            let base = match s.kind {
                Kind::Verify => Some(0),
                Kind::Scan => Some(3),
                Kind::Other => None,
            };
            let offset = match s.coverage {
                Coverage::Empty => Some(0),
                Coverage::Short => Some(1),
                Coverage::Complete => Some(2),
                _ => None,
            };
            if let Some(index) = base.zip(offset).map(|(b, o)| b + o) {
                s.outcomes[index] = s.outcomes[index].saturating_add(1).min(MAX_COUNTER);
            }
        });
    }
    pub(super) fn scan_enter(&self) {
        self.update(|s| {
            s.completed = Stage::TreeState;
            s.stage = Stage::ScanWork;
            s.passes = s.passes.saturating_add(1);
        });
    }
    pub(super) fn scan_return(&self, count: usize, success: bool) {
        self.update(|s| {
            if !success {
                s.passes = 0;
                s.processed = 0;
            } else if s.passes == 2 {
                s.processed = (count as u64).min(MAX_COUNTER);
                s.completed = Stage::ScanWork;
                s.stage = Stage::CommitPending;
            }
        });
    }
    pub(super) fn durable(&self, start: u64, end: u64) {
        self.update(|s| {
            if s.passes == 2 && s.processed > 0 && s.range == Some((start, end)) {
                s.committed = s.committed.saturating_add(s.processed).min(MAX_COUNTER);
                if s.coverage == Coverage::Complete && s.processed == s.requested {
                    s.units = s.units.saturating_add(1).min(MAX_COUNTER);
                    s.completed = Stage::UnitComplete;
                    s.stage = Stage::UnitComplete;
                } else {
                    s.completed = Stage::CommitPending;
                    s.stage = Stage::Other;
                }
            }
            s.passes = 0;
            s.processed = 0;
        });
    }
    fn request(&self, method: &str) {
        // SQLite read is at Service call, never inside a body-poll callback.
        // Default SQLite busy wait is disabled for this separate read-only connection.
        let candidate = if method == "GetBlockRange" {
            self.queue_candidate()
        } else {
            None
        };
        self.update(|s| match method {
            "GetBlockRange" => {
                s.stage = Stage::UnitEnter;
                s.kind = candidate.map_or(Kind::Other, |x| x.2);
                s.candidate = candidate;
                s.range = None;
                s.requested = 0;
                s.received = 0;
                s.terminated = false;
                s.coverage = Coverage::None;
                s.passes = 0;
                s.processed = 0;
            }
            "GetTreeState" => s.stage = Stage::TreeState,
            "GetSubtreeRoots" => s.stage = Stage::RootImport,
            "GetLatestBlock" => s.stage = Stage::Tip,
            _ => {}
        });
        if method == "GetBlockRange" {
            self.update(|s| s.stage = Stage::Download);
        }
    }
    fn queue_candidate(&self) -> Option<(u64, u64, Kind)> {
        let c =
            Connection::open_with_flags(&self.inner.path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
        c.busy_timeout(Duration::ZERO).ok()?;
        c.query_row("SELECT block_range_start, block_range_end, priority FROM scan_queue WHERE priority > 10 ORDER BY priority DESC, block_range_start LIMIT 1",[],|r|{
            let priority:i64=r.get(2)?;
            Ok((r.get(0)?,r.get(1)?,match priority {60=>Kind::Verify,50=>Kind::Scan,_=>Kind::Other}))
        }).optional().ok().flatten()
    }
    fn range(&self, bytes: &[u8]) {
        let range = BlockRange::decode(bytes)
            .ok()
            .and_then(|r| Some((r.start?.height, r.end?.height.checked_add(1)?)));
        self.update(|s| {
            if let Some((start, end)) = range.filter(|(a, b)| b > a && b - a <= MAX_COUNTER) {
                s.range = Some((start, end));
                s.requested = end - start;
                s.kind = s
                    .candidate
                    .filter(|(a, b, _)| *a <= start && *b >= end)
                    .map_or(Kind::Other, |x| x.2);
            } else {
                s.coverage = Coverage::Unknown;
                s.kind = Kind::Other;
            }
        });
    }
    #[cfg(test)]
    pub(super) fn snapshot(&self) -> Value {
        self.inner.state.lock().unwrap().value()
    }
    #[cfg(test)]
    pub(super) fn events(&self) -> Vec<Value> {
        self.inner.state.lock().unwrap().events.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::{Empty, Full, StreamBody};
    use std::sync::atomic::AtomicUsize;
    use tonic::codegen::{
        Body as _,
        tokio_stream::{self, Stream},
    };
    struct Count<S> {
        stream: Pin<Box<S>>,
        polls: Arc<AtomicUsize>,
    }
    impl<S: Stream> Stream for Count<S> {
        type Item = S::Item;
        fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
            let this = self.get_mut();
            this.polls.fetch_add(1, Ordering::Relaxed);
            this.stream.as_mut().poll_next(cx)
        }
    }
    #[test]
    fn progress_body_forwarding_frames_trailers_errors_and_poll_count() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let a = Full::new(Bytes::from_static(b"abc"))
                .frame()
                .await
                .unwrap()
                .unwrap();
            let mut map = tonic::codegen::http::HeaderMap::new();
            map.insert("grpc-status", "0".parse().unwrap());
            let b = Empty::<Bytes>::new()
                .with_trailers(std::future::ready(Some(Ok::<_, std::convert::Infallible>(
                    map,
                ))))
                .frame()
                .await
                .unwrap()
                .unwrap();
            let original = tonic::Status::with_details(
                tonic::Code::Aborted,
                "synthetic",
                Bytes::from_static(b"fixture-details"),
            );
            let polls = Arc::new(AtomicUsize::new(0));
            let raw = StreamBody::new(Count {
                stream: Box::pin(tokio_stream::iter(vec![
                    Ok(a),
                    Ok(b),
                    Err(original.clone()),
                ])),
                polls: polls.clone(),
            });
            let hints = tonic::codegen::Body::size_hint(&raw);
            let before = (hints.lower(), hints.upper(), raw.is_end_stream());
            let p = Progress::new(Path::new("unused"), false);
            let mut wrapped = Body::new(observe(raw, p, false));
            assert_eq!(
                (
                    wrapped.size_hint().lower(),
                    wrapped.size_hint().upper(),
                    wrapped.is_end_stream()
                ),
                before
            );
            assert_eq!(
                wrapped.frame().await.unwrap().unwrap().into_data().unwrap(),
                Bytes::from_static(b"abc")
            );
            assert_eq!(
                wrapped
                    .frame()
                    .await
                    .unwrap()
                    .unwrap()
                    .into_trailers()
                    .unwrap()["grpc-status"],
                "0"
            );
            let error = wrapped.frame().await.unwrap().unwrap_err();
            assert_eq!(error.code(), original.code());
            assert_eq!(error.message(), original.message());
            assert_eq!(error.details(), original.details());
            assert_eq!(
                error.metadata().clone().into_headers(),
                original.metadata().clone().into_headers()
            );
            assert!(wrapped.frame().await.is_none());
            assert_eq!(polls.load(Ordering::Relaxed), 4);
            let full = Full::new(Bytes::from_static(b"fixed"));
            let hints = full.size_hint();
            let observed = observe(full, Progress::new(Path::new("unused"), false), false);
            assert_eq!(observed.size_hint().lower(), hints.lower());
            assert_eq!(observed.size_hint().upper(), hints.upper());
        });
    }
    #[test]
    fn progress_body_pending_is_not_eof_or_complete() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let p = Progress::new(Path::new("unused"), false);
            p.begin();
            p.update(|s| {
                s.stage = Stage::Download;
                s.requested = 1;
            });
            let raw = Full::new(Bytes::from_static(&[0, 0, 0, 0, 1, 42])).with_trailers(
                std::future::pending::<
                    Option<Result<tonic::codegen::http::HeaderMap, std::convert::Infallible>>,
                >(),
            );
            let mut observed = observe(raw, p.clone(), true);
            assert!(observed.frame().await.unwrap().is_ok());
            assert!(
                tokio::time::timeout(Duration::from_millis(10), observed.frame())
                    .await
                    .is_err()
            );
            assert_eq!(p.snapshot()["received_count"], 1);
            assert_eq!(p.snapshot()["stream_terminated"], false);
            assert_eq!(p.snapshot()["coverage"], "NONE");
        });
    }
    #[test]
    fn progress_fragmented_coalesced_envelopes_and_saturation() {
        let mut parser = Envelopes::default();
        let mut count = 0;
        for chunk in [&[0, 0][..], &[0, 0, 2, 7][..], &[8, 0, 0, 0, 0, 0][..]] {
            parser.feed(chunk, || count += 1);
        }
        assert_eq!(count, 2);
        assert_eq!(parser.used, 0);
        assert_eq!(parser.left, 0);
        parser.feed(&[3, 0, 0, 0, 0], || count += 1);
        assert!(parser.invalid);
        assert_eq!(count, 2);
        let p = Progress::new(Path::new("unused"), false);
        p.update(|s| {
            s.sequence = MAX_COUNTER;
            s.units = MAX_COUNTER;
            s.committed = MAX_COUNTER;
            s.passes = 2;
            s.processed = 10;
            s.requested = 10;
            s.range = Some((1, 11));
            s.coverage = Coverage::Complete;
            s.kind = Kind::Verify;
            s.outcomes = [MAX_COUNTER; 6];
        });
        p.durable(1, 11);
        p.collected(10);
        let s = p.snapshot();
        for key in ["sequence", "completed_unit_count", "committed_block_count"] {
            assert_eq!(s[key], MAX_COUNTER);
        }
        assert_eq!(p.snapshot()["verify_complete_count"], MAX_COUNTER);
        assert!(!s.to_string().contains("unused"));
    }
}

// Constant header storage; response payloads are skipped, never retained.
#[derive(Default)]
struct Envelopes {
    header: [u8; 5],
    used: usize,
    left: u32,
    invalid: bool,
}
impl Envelopes {
    fn feed(&mut self, mut data: &[u8], mut message: impl FnMut()) {
        while !data.is_empty() && !self.invalid {
            if self.left > 0 {
                let n = (self.left as usize).min(data.len());
                self.left -= n as u32;
                data = &data[n..];
                if self.left == 0 {
                    message();
                }
                continue;
            }
            let n = (5 - self.used).min(data.len());
            self.header[self.used..self.used + n].copy_from_slice(&data[..n]);
            self.used += n;
            data = &data[n..];
            if self.used == 5 {
                self.used = 0;
                self.invalid = self.header[0] > 1;
                self.left = u32::from_be_bytes(self.header[1..].try_into().unwrap());
                if !self.invalid && self.left == 0 {
                    message();
                }
            }
        }
    }
}
pub(super) fn observe<B>(
    body: B,
    progress: Progress,
    download: bool,
) -> UnsyncBoxBody<Bytes, B::Error>
where
    B: tonic::codegen::Body<Data = Bytes> + Send + 'static,
{
    let mut parser = Envelopes::default();
    let errors = progress.clone();
    body.inspect_frame(move |frame| {
        if let Some(data) = frame.data_ref() {
            let mut count = 0u64;
            parser.feed(data, || count = count.saturating_add(1));
            if download && (count > 0 || parser.invalid) {
                progress.update(|s| {
                    s.received = s.received.saturating_add(count).min(MAX_COUNTER);
                    if parser.invalid {
                        s.coverage = Coverage::Unknown;
                    }
                });
            }
        }
        // Collection/return is the authoritative termination boundary, including bare EOF.
    })
    .inspect_err(move |_| {
        errors.update(|s| s.coverage = Coverage::Unknown);
    })
    .boxed_unsync()
}

#[derive(Clone)]
pub(super) struct Observed<T> {
    pub(super) inner: T,
    pub(super) progress: Progress,
}
impl<T> Service<Request<Body>> for Observed<T>
where
    T: Service<Request<Body>, Response = Response<Body>> + Send + 'static,
    T::Future: Send + 'static,
{
    type Response = Response<Body>;
    type Error = T::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;
    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }
    fn call(&mut self, mut request: Request<Body>) -> Self::Future {
        if !self.progress.active() {
            return Box::pin(self.inner.call(request));
        }
        let method = request.uri().path().rsplit('/').next().unwrap_or("");
        let download = method == "GetBlockRange";
        let tree = method == "GetTreeState";
        self.progress.request(method);
        if download {
            let progress = self.progress.clone();
            let mut bytes = Vec::with_capacity(1024);
            let mut invalid = false;
            let mut parsed = false;
            let body = std::mem::replace(request.body_mut(), Body::empty());
            *request.body_mut() = Body::new(body.inspect_frame(move |frame| {
                if let Some(data) = frame.data_ref() {
                    if invalid || parsed {
                        return;
                    }
                    if bytes.len() + data.len() > 1024 {
                        invalid = true;
                        return;
                    }
                    bytes.extend_from_slice(data);
                    if bytes.len() >= 5 {
                        let n = u32::from_be_bytes(bytes[1..5].try_into().unwrap()) as usize;
                        if n > 1019 || bytes[0] != 0 {
                            invalid = true;
                            return;
                        }
                        if bytes.len() == n + 5 {
                            progress.range(&bytes[5..]);
                            bytes.clear();
                            parsed = true;
                        }
                    }
                }
            }));
        }
        let future = self.inner.call(request);
        let progress = self.progress.clone();
        Box::pin(async move {
            let response = future.await?;
            if download || tree {
                Ok(response.map(|b| Body::new(observe(b, progress, download))))
            } else {
                Ok(response)
            }
        })
    }
}
