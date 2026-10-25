# Phase 7 local issuance integration

The new issuance host serves the existing Phase 6 vault modules and a minimal
draft-issuance page. It is separate from the Phase 5 public market host and has
one generic `POST /api/issuance` operation. Private side and amount travel only
in JSON reservation bodies, never route names, queries, address metadata or
memos. No ZIP-321 payment request, QR code or payment destination display is built.

Use the same exact browser origin as Phase 6, normally
`http://127.0.0.1:3001`. Stop the static vault host and start this host on that
origin so the existing IndexedDB credentials remain available. Changing host or
port changes browser storage; there is no import or identity-based recovery.

Node configuration: `APP_ENV=development`, `DARKPOOL_ISSUANCE_INTERNAL=1`,
`ZCASH_NETWORK=testnet`, loopback `PGHOST`, `PGPORT`, `PGDATABASE`, dedicated
issuance `PGUSER` with protected password/passfile, `ALLOCATION_PORT`,
`ALLOCATION_AUTH`, optional `PSQL_PATH` and `VAULT_PORT` (default 3001).
Do not supply owner/admin credentials, `DATABASE_URL`, wallet paths or keys.
Start with `npm run dev:issuance` after configuring the separate allocator and
provisioning the restricted database role. Admin OPEN is still blocked; this is
not authorization to open/fund a real market with unresolved policies.

The host binds loopback, requires exact same Origin/Host and JSON, rejects query
strings, bounds request bodies and concurrent operations, sends no CORS grants,
and applies no-store/referrer/CSP protections. It has no request/access logging or
analytics. Errors expose fixed codes only; success responses are strictly
allowlisted. Deploying behind proxies or publicly exposing this development host
requires separate work, including preserving these privacy and origin guards.

## Browser sequence

1. Use the existing vault to save the original 32-byte secret in a local draft.
2. Save a separate fresh random issuance token and immutable selection in the
   browser's `darkpool-pending-issuance` IndexedDB before any reservation request.
3. Reserve the server ID. Save the returned 64 lowercase hexadecimal ID locally.
4. Compute the unchanged approved commitment from the real market ID, real ticket
   ID and original secret. Send only the commitment, profile, token and ticket ID.
5. Validate the exact ISSUED response, then call the existing atomic/idempotent
   vault finalization primitive. Never generate another claim secret.

Pending storage is private browser state, not an export or backup format. Its
local draft ID and browser-only SHA-256 secret tag detect stale draft correlation;
neither is sent to the server. The token is unique to one attempt and retained
for same-attempt recovery, including if the reservation reply, issued reply or
local finalization write is lost. Concurrent browser operations converge through
IndexedDB transactions and the server's immutable attempt binding.

Use **Retry saved attempt** after a failure; changing market, side or amount
requires an independent draft/attempt. Keep the same browser data. Tokens grant
no claim/refund authority; ticket ID alone grants none either. The UI never
renders the raw secret, token, commitment or receiving address. Finalization
means only that the local credential is bound to a durable issued ticket. It
does not establish funding, acceptance, confirmation or claim eligibility.

Export/import/recovery formats remain deferred. Clearing browser data loses the
secret and pending token; the operator has no identity-based replacement secret.
The Phase 6 vault format and finalization primitive remain unchanged.
