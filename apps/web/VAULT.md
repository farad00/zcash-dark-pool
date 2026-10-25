# Phase 6 local ticket vault

Run from the repository root with the existing tools activated:

```powershell
$env:ZCASH_NETWORK = 'testnet'
npm.cmd run dev:vault
```

Open **http://127.0.0.1:3001/**. Keep this exact origin and browser profile: a
different hostname, scheme, port or profile has different browser storage. The
Phase 5 public market remains on its separate origin, normally port 3000.
`VAULT_PORT` changes the vault port; it does not migrate credentials.

This separate loopback static host has no PostgreSQL, wallet, participant API,
account or portfolio service. Its assets are built from local source and the
already pinned protocol/hash implementation. CSP permits local modules/styles
and prohibits connections, forms, frames and inline scripts. No remote assets,
analytics, cookies, service worker or cloud sync are added. Public market reads
and their database grants remain unchanged.

“Create local draft” generates and persists one fresh secret on this browser.
A draft has no server ticket ID, market binding, commitment, side, stake or payment
state. It is not a submitted prediction. The UI can list and explicitly delete
local records; deletion always asks for confirmation. Cancelling preserves the
credential. Storage errors never automatically clear or recreate existing data.

There is no participant UI for finalizing a draft. `finalize(localId, context)` is
an internal local primitive for a future trusted issuance caller that already has
the final market and ticket IDs. It retains the original secret, derives the
approved V1 commitment and atomically saves the binding. It issues no ID and
implements no handshake. Synthetic tests exercise this primitive; they are not
server-issued or funded tickets. A finalized local binding alone cannot establish
payment, acceptance or claim eligibility.

The in-memory `readCredential(localId)` primitive returns raw secret bytes to
future local claim logic. It supplies no portable encoding, file download, QR,
copy-to-clipboard or network submission. `list()` and deletion confirmation
callbacks receive summaries without secrets or commitments. Final IDs and secrets
never enter DOM attributes, URLs or requests.

**Export/import/recovery are DEFERRED by explicit user approval for Phase 6.**
IMPLEMENTATION_PLAN §11 still requires them; this scoped deferral does not satisfy
or remove that requirement. Revisit the format after Phase 7 establishes issuance
and final identity semantics. No backup format is defined now.

The ticket secret controls claim/refund capability. Losing or clearing browser
storage or device data can cause permanent loss of locally held claim capability.
The server cannot recover a claim secret. Anyone obtaining a finalized credential
may control its value. IndexedDB is ordinary browser storage, unencrypted by this
app and not hardware-backed. Extensions, malware, same-origin script compromise,
browser-profile backups and device compromise can expose it. Private browsing,
browser eviction, disk/quota failure and user clearing can destroy it. Deletion
does not promise forensic erasure. No funded participation exists in this phase.

`npm.cmd run test:phase6` builds and runs the local browser/HTTP/privacy checks.
An installed Chromium browser is required; set `BROWSER_PATH` if not discovered.
Browser tests use a new temporary profile, actual IndexedDB and synthetic fixtures,
then remove only that profile. They never open a participant's existing browser
profile. Windows sandbox restrictions can require an approved browser launch.
See [Phase 6 results](../../docs/PHASE6_RESULTS.md) for exact evidence and limits.
