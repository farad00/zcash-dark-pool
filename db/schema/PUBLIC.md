# Phase 5 public reader boundary

The public process uses only `darkpool_public.markets`, the existing Phase 3
security-barrier view. No migration or private/admin grant is added. Provisioning
is an owner-only maintenance operation, never an HTTP action. Prepare a dedicated
existing restricted PostgreSQL login and protected libpq authentication separately.
Do not hand the public process the maintenance credential or admin credential.

```powershell
node db/public-provision.mjs <existing-restricted-public-reader>
# Existing Windows maintenance helper:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/dev/product-db.ps1 provision-public -OperatorRole <existing-restricted-public-reader>
```

Provisioning grants only USAGE on `darkpool_public` and SELECT on its `markets`
view, transactionally. It refuses excess authority and rolls back proposed grants
without revoking preexisting rights. It creates no roles or credentials. The check
rejects role memberships (including NOINHERIT escalation paths), superuser,
CREATE DATABASE/ROLE, replication, BYPASSRLS, product/database/schema ownership,
schema creation, private/admin/migration usage, application-table DML, reads of
other application relations and product-function execution. PostgreSQL catalog
access and ordinary database CONNECT/TEMP defaults are not private-book grants.

The adapter repeats its check as the **actual authenticated session login**, not
SET ROLE over an owner session. Check and fixed query run together in `BEGIN READ
ONLY`, with a three-second statement timeout, three-second connection timeout,
eight-second subprocess deadline and two-MiB output limit. No SQL or identifiers
come from HTTP inputs. LIMIT 2 detects inherited multi-market state. PostgreSQL
diagnostics are discarded; adapter errors are fixed `Market unavailable` text.

`db/public-read.mjs` explicitly selects twelve fields from the view, renames the
public market ID and formats UTC instants without losing microsecond precision.
The web projection validates version, network, nine-state vocabulary, required
fields, finite UTC instants, ordered window, distinct nonempty YES/NO definitions,
bounded well-formed text, and nonempty bounded source/void arrays. The existing
admin's 8-KiB text and 32-entry resource bounds are reused; no economic limit or
policy is selected. Extra fields are never copied to response/page output.

Configure `ZCASH_NETWORK=testnet`, explicit `PGHOST=127.0.0.1`, `PGPORT`,
`PGDATABASE`, `PGUSER`, and protected libpq authentication (`PGPASSFILE` or private
runtime `PGPASSWORD`). No credentials in URL/argv. libpq role/service overrides,
`DATABASE_URL`, `DARKPOOL_ADMIN_INTERNAL`, and `WALLET_DB_PATH` fail closed. The
subprocess receives a narrow OS/libpq environment, excluding other authority
variables. Give the public service no wallet SQLite access or signer/viewing
material at the OS/container boundary; an environment filter is not OS isolation.

All book fields remain inaccessible: private tickets/payments/claims/settlements,
admin requests/revisions/audits, wallet mappings, amounts, counts, totals, odds,
destinations, blindings, commitments and authority. Resolution outcomes/evidence
and ledger publication need later authorized read surfaces and are not queried.
The actual owner remains trusted and can bypass grants or deliberately put private
strings in public text. This implementation is not owner-proof storage, encryption
at rest, log retention or backup encryption. Deploy separate identities, protect
credentials/files and configure PostgreSQL/proxy logging independently.

## Restricted-reader runtime capability

The public HTTP process may possess its dedicated reader credential and identity
configuration. It may execute only the approved public market read. It must not
receive owner, migration, admin, watcher, issuer or wallet authority.

`server.mjs` calls `createPublicReader` once before listening. The adapter binds
the isolated environment kind, canonical profile/data paths, marker, control-file
system identity, endpoint, database, login, credential and client executable.
It authenticates and checks reader privileges at startup. Each subsequent read
rechecks the original filesystem identity, server marker/database/endpoint, exact
session login and reader privileges. The returned frozen, zero-argument function
does not consult ambient environment variables or accept SQL/target arguments.
Failed startup binding leaves liveness available, with market reads unavailable
until restart; requests cannot repair or select a target.

`public-reader-runtime.mjs` knows only the two isolated reader deployments, never
HISTORICAL, maintenance databases or privileged operations. LIVE_EVIDENCE also
requires the fixed evidence database and `darkpool_live_read`. TEST readers use
their startup-configured database/login and must pass the same authenticated
reader-only SQL check. Generated fixture name and destructive acknowledgement
rules belong exclusively to the privileged TEST path; they are not public reader
authority. No public grants change.

`environment-identity.mjs` contains shared identity and SQL guard primitives only.
`environment.mjs` retains general privileged runtime validation, and
`environment-test.mjs` contains fixture names, acknowledgement and destructive SQL
validation. Neither privileged module is reachable from the public import graph.
HTTP handlers receive only the bound read function, never an SQL executor.

Existing environment variable names remain valid. Authentication must be an
explicit private `PGPASSWORD` or a protected `PGPASSFILE` containing only one
matching reader entry (comments/escaping supported). At startup the latter is
resolved to that one credential; no password-file path reaches the DB subprocess
and later file edits cannot change the running capability. An inherited default
password file is not used. Restart to intentionally change a reader target or
credential. The process must still run under the documented OS/file boundary.

`product-db.ps1 test-public` uses randomly named `darkpool_phase5_<16 hex>` databases
and `darkpool_public_<16 hex>` temporary authenticated logins, then removes only
those exact test resources. It never opens wallet SQLite, creates bearer secrets,
allocates addresses or transacts. No permanent dev reader/market is seeded.
