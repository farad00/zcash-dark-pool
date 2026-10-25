# Focused Phase 9 validation, version 1

This manifest describes future TEST-only payment-path validation. **It launches
nothing. Phase 9 LIVE financial operations remain STOPPED.** A manifest-ready
classification authorizes neither application suites nor V2 creation, provisioning,
payment, market mutation, reconciliation, payout or PostgreSQL lifecycle actions.
The complete R1/R2 gate remains blocked; this tooling does not replace it.

## Files and coverage

- `phase9-focused-v1.json`: exact argument arrays, ordered dependencies, test
  identities, expected assertions, payment requirements and reasons, source pins,
  preserved environment identities and explicit exclusions.
- `phase9-focused.mjs`: static verifier and evidence reader/reporter. The only
  subprocesses it can invoke are fixed read-only Git inventory commands. It imports
  TypeScript to parse test registrations, never any application/test module.
- `phase9-focused.test.mjs`: synthetic manifest/parser/reporter regressions. These
  generate ordinary text files, never a database, wallet, browser or RPC fixture.

The 37 ordered stages contain three build/type prerequisites and **342 exact test
identities: 66 Rust and 276 Node across 22 files**. All 12 required payment areas are
mapped: environment/target isolation, signer/watcher separation, fresh Orchard
issuance, exact ZIP-321, canonical receiver/output matching, three confirmations,
integer stake, replay, reorg/holds, schema/grants, admin/public reader, vault/backup.
Individual expected test names describe their assertions; each stage also records
the behavioral assertions and reason the complete existing suite is required.

Rust selection is the inherited 72-test inventory less six explicitly named
connect-only diagnostics. Three in-process TLS/hostname/root-trust tests are
included. The two outer PowerShell diagnostic timing tests are excluded from this
deposit scope, not repaired or reported PASS. Other production sync, cache, original-H,
close, inclusion, encrypted-note scan/reorg and passive-progress cases remain.
Unfiltered Node files preserve all existing scenarios, including rejection and
real TEST-PostgreSQL privilege cases. No application assertions are rewritten.

Static Node enumeration supports literal `test` registrations and the existing
finite literal name loops, without evaluating functions or importing suites. Rust
enumeration recognizes the existing test attributes and `snapshot_guard_test!`
invocations in their pinned source files. It is a syntax inventory, not compiler
discovery. Unknown shapes or changed source require explicit review. Expected
identities are not learned from an execution to make a failing run pass.

## Commands permitted in this implementation task

Use the existing bundled Node 24 executable (or the existing activated shell):

```powershell
node scripts/validation/phase9-focused.mjs check
node --test --test-concurrency=1 --test-reporter=tap scripts/validation/phase9-focused.test.mjs
```

Only the newly added tooling regression file is executed by the second command.
Do not substitute `npm test`, Rust tests or any application suite in this task.
Syntax/lint/format checks must likewise name only the new tooling files.

To record an entirely unexecuted plan, choose a fresh 32-lowercase-hex run ID:

```powershell
node scripts/validation/phase9-focused.mjs plan .tools/phase9-focused/run-<32-hex>/report.json
```

The command reserves a new run directory, writes one exclusive/fsynced report and
exits **2** for NOT RUN. It records actual Git revision plus a dirty-worktree
fingerprint over Git-visible file names/content, status and staged diff. All 342
application tests remain NOT RUN; environment verification and preservation are
NOT RUN in this plan artifact. The implementation-task preservation audit is
separate. A later results append changes the subsequent fingerprint legitimately;
the report refers to the source snapshot at its generation time.

## Future execution contract: separate authorization required

The manifest's commands are data for review, not shell snippets or an executor.
Each exact command uses repository cwd and a clean, reviewed TEST-only shell:
`DARKPOOL_PG_ENV=TEST`, `DARKPOOL_TEST_ONLY=TEST_ONLY`, testnet,
`127.0.0.1:55433`, maintenance database `postgres` and the existing protected TEST
maintenance identity/profile. Resolve binaries through the existing pinned local
tooling. Load credentials through the established protected helper, never this
manifest/reporter or logs. Remove LIVE selectors and libpq target overrides.
Fixtures retain their own TEST guard and generated database/role-name restrictions.
Credentials are not included in evidence JSON. No cluster restart/reinitialization
is a prerequisite or permitted fallback.

Run each stage once in manifest order, after all dependencies pass; first failure
stops the run. Every future stage needs externally established task-owned process
completion, with root exit followed by a successful native zero-active query.
Record the actual owned process identities and the query time. Root exit, later
empty global process lists, pipe close, process exit 0 and initializer
`run-bounded.mjs` semantics cannot substitute. This reporter implements **no
supervisor** and invents no descendant-drain timeout. Current broken Job Object
results cannot satisfy the import contract; safe future execution remains a
separate prerequisite. No native fixture, SQL or application command was run to
validate this tooling.

## Evidence schema and reporter

Import previously captured evidence using a repository-relative ordinary file:

```powershell
node scripts/validation/phase9-focused.mjs report .tools/phase9-focused-input/bundle.json .tools/phase9-focused/run-<32-hex>/report.json
```

The source manifest is always the fixed version-1 file. Input, logs and native
observation files are bounded, hash-checked, relative ordinary files; absolute
paths, traversal, symlinks and redirected ancestors are rejected. Log references
are relative to the bundle's parent. Output must match the exact new run namespace
shown above. Even an empty existing run directory is refused. No historical
evidence is overwritten, and no raw log/error contents are copied into reports.

Top-level JSON fields (all required, unknown fields rejected):

| Field                           | Meaning                                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                       | Exactly 1.                                                                                                                                                                                         |
| `evidence_class`                | `application-evidence`, `offline-fixture` or `plan-only`. Synthetic fixtures cannot yield `application_validation_pass=true`.                                                                      |
| `manifest_sha256`               | SHA-256 of the exact manifest bytes.                                                                                                                                                               |
| `source_before`, `source_after` | Objects with `revision` and `dirty_worktree_sha256`; must agree with one another and reporter's actual current Git/file snapshot. A supplied source override is allowed only for offline fixtures. |
| `execution_environment`         | Exact closed TEST environment projection used in the regression fixture; no passwords, passfile contents, wallet paths or LIVE selector. Null only for plan-only.                                  |
| `environments`                  | Before/after TEST and OLD LIVE identities; HISTORICAL zero-SQL/lifecycle declarations; V2 absent/not-created/no-listener. Null only for plan-only.                                                 |
| `preservation`                  | Before/after maps for all eight pinned preservation groups. Each group maps stable nonsecret file aliases to SHA-256. Alias sets, exact counts and hashes must agree. Null only for plan-only.     |
| `stages`                        | Ordered executed prefix, or empty. Missing suffix is explicitly NOT RUN.                                                                                                                           |

TEST and OLD LIVE identity objects contain `system_identifier`, `cluster_id`,
`port`, `pid`, `process_start_utc`, `path_sha256`, `executable_sha256`,
`profile_sha256`, `marker_sha256`, and
`evidence_class="native-file-observation"`. This version binds the preserved
TEST PID 24984 and OLD LIVE PID 22968. A legitimate later process replacement
requires review/versioning, not editing an execution to match. No OLD LIVE or
HISTORICAL SQL is needed to supply native/file preservation observations. Actual
TEST database guards and grants are exercised by the existing application suites
only when separately authorized; the reporter does not execute those checks.

Each stage record has exactly `id`, `command`, `started_utc`, `ended_utc`,
`exit_code`, `stdout`, `stderr`, `ownership`. A stream object is `{path,sha256}`.
Ownership contains `root_pid`, `root_exit_observed`, `root_exit_utc`, `query_succeeded`,
`active_processes`, `owned_processes`, `zero_query_utc`, `evidence_path`,
`evidence_sha256`. The referenced native JSON must exactly match those observation
fields excluding its path/digest. The successful zero query must follow recorded
root exit inside the stage interval; stages cannot overlap. Missing/failed/nonzero native accounting
blocks PASS. Process cleanup is **externally supplied evidence**, not a measured
guarantee from this reporter. The synthetic complete-bundle fixture in the new
regression is a concrete schema example, not real execution evidence.

The reporter parses actual per-test TAP/libtest records and validates names,
duplicates, plan/summary counts, Rust filtered count and successful exit. It does
not trust a caller's PASS flag. SKIP/TODO/ignored tests remain NOT RUN and fail
their stage. Cancelled, missing, duplicate or unexpected results, stale source,
changed command, out-of-order records, bad native evidence and preservation
changes fail closed. Unknown/truncated output fails rather than being guessed.
TAP diagnostics may contain application messages privately; reports retain only
expected identities, counts, fixed error codes, hashes and metadata.

Report status is PASS, FAIL or NOT RUN. It records expected/actual counts,
per-test states, first failure, source/environment/preservation evidence and scope.
If malformed evidence prevents determining test execution, the executed count is
null with `tests_execution_known=false`; zero is not invented. A partial successful
prefix is NOT RUN overall. A complete offline fixture may report parser-level PASS
but always has `application_validation_pass=false`. CLI exit 0 requires complete
valid `application-evidence`; exit 2 means NOT RUN, exit 1 means failure or
synthetic-only evidence. All reports retain `live_authorized=false`,
`v2_authorized=false`, `complete_gate=BLOCKED_UNCHANGED`.

## Limits and outstanding risks

This tooling checks coverage/completeness and consistency of supplied evidence.
It does not cryptographically attest that an operator's logs/native/hash inventories
are honest; a malicious evidence producer or same-user OS/database owner remains
outside that boundary. Raw evidence must be captured and retained by an authorized,
reviewed execution process. A claimed zero query without that observation cannot
be reconstructed by this reporter. Log hashes prove byte identity, not actual
test execution or sound native supervision.

No application results, V2 ACL/role/wallet setup, genuine shielded payment,
three-confirmation acceptance, live replay/rescan or deployment privacy evidence
are established by manifest regressions. No-payment synchronization remains
separate from funded acceptance. Later ledger, oracle, settlement, claims, genuine
shielded payout/refund, solvency, signer-plan integration, FROST and production
security remain outside this focused deposit gate. These gaps still block the
corresponding demo milestones. Manifest completeness is not Phase 9 completion,
payment readiness, complete-gate PASS or permission to use funds.
