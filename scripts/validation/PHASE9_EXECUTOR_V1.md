# Focused Phase 9 executor CLI v1, completion contract v3

LIVE financial operations remain **STOPPED**. The fixed manifest remains
`phase9-focused-v1.json`, SHA-256
`5e01a728d362c098303e63b27c7d578112a51a5986284e564d67ec0e049f3986`:
342 tests (66 Rust, 276 Node), 12 required areas, 37 ordered stages.

The current producer emits native trace/ownership contract **3**. New execution
bundles use version **2** with completion_contract=3. The v2 validator and old
artifacts remain unchanged; old failures cannot be upgraded.

## Entry points and authorization

Use the bundled Node 24.21.0 executable. Offline/static entry:
`node scripts/validation/phase9-focused-executor-v1.mjs check`.

The application entry is still exactly:
`node scripts/validation/phase9-focused-executor-v1.mjs execute`.
**Do not invoke execute without separate application-validation authorization.**
It accepts no manifest, command, filter, timeout, target or retry override.
Implementation/offline approval does not authorize application suites, V2 or payment.

Offline native regressions require a fresh directory:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/validation/phase9-focused-native-v1.test.ps1 -ArtifactDirectory .tools/phase9-focused/<fresh-native-fixtures>
```

Only the finite disposable fixture executable and fixed .cmd fixture run.

For offline Node tooling, set FOCUSED_V3_OFFLINE_FIXTURES to those fresh v3 artifacts.
Set FOCUSED_OFFLINE_FIXTURES to retained genuine completion-v2 fixtures when running
the v2 compatibility files. These are validation-tooling files only:

```powershell
node --test --test-concurrency=1 --test-reporter=tap scripts/validation/phase9-focused-completion-v3.test.mjs scripts/validation/phase9-focused-completion-v2.test.mjs scripts/validation/phase9-focused-executor-v1.test.mjs scripts/validation/phase9-focused-reporting-v1.test.mjs scripts/validation/phase9-focused.test.mjs
```

Missing fixture evidence fails, never skips. Synthetic reporting adapters execute
the actual reporting control flow with inert launch/observation adapters and
explicit offline-fixture envelopes; they do not execute application commands.

## Native identity and ordering

Identity remains a real process handle plus PID, exact creation FILETIME and
IsProcessInJob membership. The original CreateProcessW handle binds the suspended
root. Actual executable image, exact arguments/scripts and before/after executable
and script digests must agree with the approved launch.

The private Job Object is non-inheritable, with exact native flags 0x2000 and no
breakaway. Assignment and verification precede resume. Descendants remain under
the approved direct-child policy.

A per-stage native journal records QueryPerformanceCounter begin/end brackets,
strict sequence numbers, session, actual thread ID and native call results.
QueryPerformanceFrequency and observer/controller native identities bind the
context. All proof-producing calls stay on the same observer thread. QPC is not
converted into UTC or labeled as a descendant's creation time.

Mandatory transitions cover stage begin, job readiness, suspended root creation,
assignment, native identity binding, launch verification, resume, signaled-handle
exit observation and rechecked identity, accounting, handle releases, cleanup and
stage end. A fresh successful zero-active query must start after root/retained
exit observations on the same continuously retained job handle.

The journal capacity is 32,768 proof-transition records. Overflow, missing events,
context changes, backward counters, malformed/native contradictory results or
incomplete finalization prevent acceptance. Equal QPC readings require proper
sequence and native state transitions; no tick padding or tolerance is used.

Native process handles stay retained through final release, allowing actual
CompareObjectHandles deduplication. A new acquisition is never merged merely by
PID/creation text or a recycled numeric handle. Exit identity is checked on the
same native object. Failed acquisitions remain explicit in the native trace.

Historical lifetime/retained/missing identity counts remain independent of native
tree completion. Unknown identities cannot be invented; retained identities must
all validate and count arithmetic must agree.

## UTC audit and compatibility

UTC strings and native FILETIME values retain full precision. UTC reversals are
reported as utc_anomalies separately from the required causal proof. No current
process identity is derived from DateTime.UtcNow or JavaScript Date ordering.

Completion-v3 replaces UTC causal comparisons with the native journal. Strict
creation-FILETIME/rendering equality, calendar/range checks and genuine native
results remain required. The legacy v2 validator is preserved for v2 artifacts;
a version flip or missing journal cannot upgrade old failed evidence.

QPC/session/frequency integers are exact strings validated with BigInt; counters
are compared only within their declared native worker context. No conversion
through Number, assumed tick frequency, UTC calibration or cross-worker QPC sort.

## Stage handoff and failure behavior

Before launch, request-N.json is created exclusively with exact stage/command,
native controller PID/creation identity and predecessor acceptance. The predecessor
link pins its ownership/session and persisted successful prefix report digest.
After genuine worker completion, the handoff pins the request, worker PID/exit,
observer session and native ownership digest. The reporter verifies these records
and accepted predecessor coverage before any successor can be accepted.

The executor preserves the original nonzero root exit. Missing native evidence,
failed accounting, active descendants, interruption, unsafe cleanup or forced
termination stays failure. Natural drain 2000 ms, failure cleanup 5000 ms and
driver fallback 8000 ms are unchanged. Cleanup addresses only the owned job or
original unassigned suspended root; there is no global PID/name/port sweep.

Every real stage requires native trace version 3 and a completed worker matching
the native observer PID. Root exit alone, a zero notification, closing a job or
zero reached after forced termination cannot prove natural completion.

## Environment, artifacts and limits

The worker clears inherited PG*, DARKPOOL_* and ZCASH_* selectors, then loads only
the existing protected TEST maintenance identity at 127.0.0.1:55433. No target or
credential override exists. OLD LIVE/55434 and HISTORICAL are preserved; V2 must
remain absent with 55435 closed. The observer uses no SQL or lifecycle actions.

The reporter keeps all strict manifest/TAP/libtest identity/count checks and
source/environment/preservation checks. Missing, skipped, duplicate or unexpected
cases cannot become PASS. Source fingerprint, exclusive output paths, stage logs,
native journal/ownership digests, requests and prefix/final reports remain retained.

QPC orders observer verifications backed by native object semantics. It does not
recover exact historical creation instants or guarantee lossless notification
delivery. Source-pinned native production is trusted locally; serialized hashes
and counters are not remote attestation against a malicious same-user OS owner.
Job Objects do not contain unreviewed broker/service-created external processes.

This focused infrastructure does not replace or repair the blocked complete
R1/R2 gate and proves no genuine payment acceptance or shielded settlement.
