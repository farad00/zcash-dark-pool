# Public market read surface — Phase 5

A minimal server-rendered market page using the existing Node scaffold, protocol
status vocabulary and PostgreSQL public view. No browser JavaScript, third-party
assets, analytics, cookies or participant account. CSS uses local system fonts.

| Route         | Methods   | Behavior                                                                            |
| ------------- | --------- | ----------------------------------------------------------------------------------- |
| `/`           | GET, HEAD | Public rules and stored market status; DRAFT explicitly does not accept predictions |
| `/api/market` | GET, HEAD | `{ "market": PublicMarket }`, with explicit runtime projection                      |
| `/market.css` | GET, HEAD | Local stylesheet only                                                               |
| `/health`     | GET       | Existing scaffold liveness response; not database/market readiness                  |

The sole market is selected without any caller-supplied ID, side, field list or
query. No market yields 404. Multiple, malformed, unavailable or invalid market
rows yield 503. Invalid request targets/query strings/bodies yield generic 400;
mutation methods on public read routes yield 405; unimplemented routes yield 404.
Errors never include requests, SQL, server diagnostics, connection details or
records. HEAD has no body. Public responses are `no-store` with CSP, `nosniff`
and `no-referrer`. There is no CORS grant. At most four market reads run at once;
the adapter bounds time/output, and additional reads fail safely.

Only the twelve existing PublicMarket fields are returned: `market_id`, `version`,
`network`, `question`, `yes_definition`, `no_definition`, `opens_at`, `closes_at`,
`resolution_rule`, `resolution_sources`, `void_conditions`, `status`. The DB view's
public `id` maps to `market_id`. UTC strings preserve PostgreSQL microseconds;
that display/JSON adaptation does not decide chain eligibility. No optional count,
separate description, policy detail, resolution result or ledger publication is
invented. Source strings render as escaped text, including URLs, without fetching
or embedding them. Status comes from storage; elapsed time never changes it.

No prediction form, disabled/mock action, secret generation, local vault, ticket,
wallet, payment, invoice, claim, refund or portfolio endpoint exists. OPEN and all
other Phase 4 deferred operations remain blocked. Later-state rendering tests use
synthetic owner fixtures and prove vocabulary only, not lifecycle execution.

## Run locally

First build with `npm.cmd run build:web` after activating the existing tools.
Provision a separate restricted public-reader login as described in
[PUBLIC.md](../../db/schema/PUBLIC.md). Do not reuse the maintenance or admin login.
Configure only explicit testnet, loopback libpq reader settings and protected
authentication in the public process, then run:

```powershell
$env:ZCASH_NETWORK = 'testnet'
$env:PGHOST = '127.0.0.1'
$env:PGPORT = '55434'
$env:PGDATABASE = 'darkpool_phase9_evidence_payment_v1'
$env:PGUSER = 'darkpool_live_read'
$env:DARKPOOL_PG_ENV = 'LIVE_EVIDENCE'
$env:DARKPOOL_PG_PROFILE = Join-Path $env:LOCALAPPDATA 'ZcashDarkPoolDev/postgres-live-evidence/phase9_payment_v1/profile.json'
# Configure a protected PGPASSFILE privately; never commit credentials.
npm.cmd run dev:web
```

Bind is 127.0.0.1, port 3000 by default. No `.env` file is loaded. Missing reader
configuration leaves liveness available and returns generic market-unavailable
pages. No market or persistent credentials are auto-created. Use the existing
internal admin CLI to configure the actual proposition as DRAFT; Phase 5 does not
invent event rules. The public server never imports that CLI or maintenance tools.

The example requires a separately authorized, already-provisioned isolated
environment; it does not authorize creating one. TEST fixtures use their own
restricted logins/databases on 55433. The server binds the reader once at startup,
including the credential, canonical profile and cluster identity. Each read still
checks that identity and reader grants. Requests cannot select targets or SQL;
environment/password-file changes require a restart. `PGPASSFILE` must contain
only the one matching reader credential. Failed startup binding stays unavailable
until restart. See [the capability boundary](../../db/schema/PUBLIC.md#restricted-reader-runtime-capability).

Use a separate environment and service identity without wallet files, seeds,
spending/viewing keys, UFVKs or signer material. Code cannot enforce operating-system
file isolation against processes running as the same Windows user. The loopback
implementation is a development surface, not a production deployment/audit.

## Checks

`npm.cmd run test:web` runs public unit/HTTP tests and the unchanged admin HTTP
boundary regression. `scripts/dev/product-db.ps1 test-public` runs real authenticated
PostgreSQL/HTTP tests against disposable synthetic databases/readers. Root commands
include `test:phase5`, `test:phase5-db`, `build:web`, `lint:web`, and `format:check:web`.
See [Phase 5 results](../../docs/PHASE5_RESULTS.md) for actual results and scope.

Phase 4 internal CLI documentation remains in [ADMIN.md](../../db/schema/ADMIN.md).
Phase 6 adds a separate browser-only static local vault; see [VAULT.md](VAULT.md).
The Phase 5 public process remains unchanged. Phase 7 adds issuance on the separate
local vault origin; see [ISSUANCE.md](ISSUANCE.md). Individual issued-ticket backup
and restore are now available there; see [TICKET_BACKUP.md](TICKET_BACKUP.md).
Payments and Phase 8 remain unimplemented. VAULT.md and ISSUANCE.md retain the
historical scope and deferrals at their respective checkpoints.

## PostgreSQL target isolation

Use the explicit protected LIVE_EVIDENCE profile on port 55434 for separately authorized operations; tests use TEST on 55433. HISTORICAL is retired and must not be connected. See the [environment guide](../../db/schema/ENVIRONMENTS.md). Existing runtime privilege checks remain mandatory.
