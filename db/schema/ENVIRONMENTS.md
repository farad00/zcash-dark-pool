# Local PostgreSQL environment isolation

HISTORICAL (55432) is retired, integrity-questioned evidence. Do not connect SQL,
start/stop it through development helpers, clone it, or use its contents as
bootstrap authority. Historical E/F classifications remain unchanged.

TEST uses `127.0.0.1:55433`, under
`%LOCALAPPDATA%/ZcashDarkPoolDev/postgres-test/data`. The inert reviewed registry
`db/target-identities.json` recognizes exactly two LIVE_EVIDENCE instances:

| Instance            | Port  | Canonical database                    | Runtime role prefix |
| ------------------- | ----- | ------------------------------------- | ------------------- |
| `phase9_payment_v1` | 55434 | `darkpool_phase9_evidence_payment_v1` | `darkpool_live_`    |
| `phase9_payment_v2` | 55435 | `darkpool_phase9_evidence_payment_v2` | `darkpool_live_v2_` |

Each PostgreSQL root is
`%LOCALAPPDATA%/ZcashDarkPoolDev/postgres-live-evidence/<exact-instance>`;
its data directory is `data`. No wildcard instance or database authorization is
accepted. Unknown/missing LIVE selectors and TEST with a LIVE selector fail closed.
`LOCALAPPDATA` is the existing trusted local OS base; there are no configurable
target-root/port/database overrides or connection-string selectors.

V1 is permanently preserved evidence only. Its system identifier remains
`7697706083887339692`, marker UUID `0c39a4b7-f37f-4fde-b81d-502d61724e52`, and
legacy marker bytes remain compatible. Its protected root is still
`%LOCALAPPDATA%/ZcashDarkPoolDev/phase9/live_payment_v1`, with `signer` and
`view-only`. The old unpaid ticket is excluded from future payment. Existing
normal lifecycle and single-market semantics are unchanged. Mutable component,
migration, provisioning and bootstrap entrypoints reject preserved V1.

V2's planned protected root is `<v2-PostgreSQL-root>/protected`, with separate
`signer/data.sqlite`, `watcher/data.sqlite` and `evidence`. Its six role names end
in `maintenance`, `owner`, `admin`, `watch`, `issue`, `read`; DPAPI credentials
are `<v2-root>/<role>.xml`, and any runtime passfile is `<v2-root>/<role>.pgpass`.
No credential, signer, watcher, PostgreSQL data, WAL or tablespace is shared.
V2 gets a fresh generated system identifier/marker, bound into its protected
profile; V1 and TEST identifiers/markers are explicitly reserved and rejected.
The existing TEST system identifier is `7697541254856017064` and marker UUID is
`8a0bf1f9-e2e5-4af4-b449-90ab32d950af`.

`postgres-isolated.ps1 -Kind LIVE_EVIDENCE -Instance phase9_payment_v2` produces
only a JSON plan; `-Plan` also explicitly requests a plan. It creates no directory
or credential and invokes no initdb. A future separately authorized execution
must explicitly add `-Create`. Existing roots (including nested credential or
wallet collisions), occupied ports and redirects fail before creation. V1 cannot
be initialized or completed again. TEST initialization remains explicit through
`-Kind TEST`. This source task does not authorize V2 creation or any live action.

The initializer requires bundled PostgreSQL 18.6, loopback, SCRAM, UTC and a new
random maintenance credential. A protected DACL permits the current Windows user,
SYSTEM and Administrators. DPAPI CLIXML stores credentials outside the repository
and OneDrive. It never copies another cluster. Keep maintenance credentials out
of application processes; provision independent restricted runtime logins.

All SQL clients require explicit `DARKPOOL_PG_ENV` and `DARKPOOL_PG_PROFILE`.
Profiles and a separate versioned marker bind environment, fixed port/path, UUID,
PostgreSQL system identifier, directory device/inode and maintenance identity.
Local checks reject missing/changed profiles, symlinks, changed directory identity
and a different `global/pg_control` identifier before spawning psql. Nonempty
tablespaces and redirected WAL are rejected. libpq target
overrides are rejected. The installed Windows x64 PostgreSQL control-file header
supplies the local 64-bit system identifier.

Before each application SQL script, a server check requires the exact database,
loopback port and the cluster marker in the owner-only shared comment on database
`postgres`. Only the fixed one-time bootstrap command initializes that comment,
after checking the server's actual system identifier and data path. Runtime roles
receive no new monitoring or introspection grants. This prevents target mistakes,
not deliberate subversion by an OS/database owner. The comment bridges local
identity to the running server without privileged control-function grants.

Every destructive fixture uses `db/test-fixtures.mjs`, which always requires TEST
plus `DARKPOOL_TEST_ONLY=TEST_ONLY`. Privileged Node fixture workers also require TEST at every
query boundary. Only generated fixture database/role names are allowed for fixture
CREATE/DROP. Retained and LIVE names are rejected. `phase9-tests.ps1` loads only
TEST credentials/profile and restores the caller's environment; no HISTORICAL
fallback exists. Direct npm database tests fail closed without the complete TEST
environment. SQL is trusted fixture code, not an adversarial arbitrary-SQL sandbox.

The public reader has a separate capability boundary: startup binds one isolated
reader target and authenticates its restricted login, then every read verifies
that same identity and grant surface. Its dependency closure contains shared
identity primitives but no general environment selector, TEST acknowledgement,
fixture name/SQL policy or cleanup helpers. The public read cannot create/drop
resources or acquire a privileged login. See [PUBLIC.md](PUBLIC.md).

Public startup reads inert allowlisted identity data only; it cannot import the
private target-management module. HTTP requests cannot select environment,
instance, database, credential, port or SQL. The restricted connection and
credential are copied once at startup and are immutable thereafter.

Private shells must set `DARKPOOL_LIVE_INSTANCE` explicitly, in addition to the
existing class/profile fields. `run-target.ps1 -Instance phase9_payment_v2
-Action <admin|issuer|watcher|public|migrate>` prints a plan by default. A future
authorized `-Run` loads only that instance's exact DPAPI role credential and
launches a clean environment. No launcher creates credentials. The watcher
receives only its exact viewing wallet; Rust allocator/watcher startup repeats
the closed wallet binding. LIVE allocator frames additionally carry the instance
before allocation; TEST retains its existing five-field frame. This also prevents
a V2 issuer using a legacy V1 allocator. `wallet-target.mjs` supplies only a pure
fixed signer initialization/view-import argument plan; actual preparation needs
separate authorization. Evidence wrappers reject cross-instance children,
preserved paths, traversal and filesystem redirects before capture.

Migrations 0001–0007 are unchanged. A future V2 applies them from scratch using
its selected identity; there is no migration 0008 or new economic policy. Offline
target tests use synthetic ordinary files under disposable temporary directories,
never a V2 PostgreSQL cluster. All destructive SQL tests still use TEST only.
Full builds/tests, public closure checks and the registry rejection matrix must
pass before requesting separate V2 creation authorization.

Use `phase9-tests.ps1 -Action watcher` / `-Action regressions` for PostgreSQL gates.
Run `node --test db/test/environment.test.mjs` for offline rejection proofs using
synthetic ordinary files, never live cluster connections. Migration/provisioning
commands select no default cluster/database and use the same guard. The retired
`postgres.ps1` rejects all actions.

Preserve logical and selected physical evidence for LIVE_EVIDENCE. PostgreSQL
catalog/cache/WAL churn is separate from application invariants; do not claim
whole-cluster byte identity or automatically classify internal churn benign.
