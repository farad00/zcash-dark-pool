# Individual issued-ticket backup and restore

Open **http://127.0.0.1:3001/backup** on the exact vault/issuance origin and browser
profile holding the credential. Both the static vault host and issuance host serve
this page. Build using `npm.cmd run build:web`; existing startup instructions are
in [VAULT.md](VAULT.md) and [ISSUANCE.md](ISSUANCE.md). Their checkpoint descriptions
of deferred export/import are superseded only by this explicitly approved scope.
The Phase 5 public host has no backup route or credential API.

Export applies to one completed Phase 7 issuance with successful local finalization.
Drafts, reserved/COMPLETING attempts and generic internal local bindings are not
exportable. Older Phase 7 finalized records have no completion marker: use the
existing same-attempt issuance retry once before exporting. This is a deliberate
issuance request, not a network request made by export. New successful issuance
saves the local completion marker automatically. If its save fails, keep browser
data and retry the same attempt; no export is enabled prematurely.

Use **Export individual backup** and confirm the bearer warning. Download name:
`darkpool-ticket-backup.json`. The file is plaintext, unencrypted bearer authority.
Anyone with a usable copy may later exercise eligible claim/refund authority.
Import does not revoke earlier copies; this app cannot revoke stolen copies.
Keep it private, including against Downloads/OneDrive/device backup/messaging and
screenshot exposure. No automatic export, cloud upload, clipboard, QR or recovery
string exists. Download initiation does not establish that the file was retained.

Choose one file and select **Restore selected file**. Import is entirely local and
works without a server connection, including after close. Successful import says:
**Credential restored. Server status has not been checked.** It does not establish
funding, payment, acceptance, eligibility, unclaimed status or server restoration.
Restored V1 credentials can be re-exported without claiming issuer authentication.
A backup's commitment is a consistency check, not a server signature.

The exact nine required V1 fields are `format`, `backup_version`, `version`,
`network`, `claim_commitment_profile`, `market_id`, `ticket_id`, `claim_secret_hex`
and `claim_commitment`. No other fields are allowed. The format is
`darkpool-ticket-backup`, both versions are 1, network is testnet and the commitment
profile is `DARKPOOL_CLAIM_V1_ID_FRAME_1`. Secret bytes, ticket ID and commitment use
64 lowercase hex characters. Market ID is preserved exactly. Import accepts at
most 65,536 bytes, strict UTF-8 with JSON whitespace only (no leading BOM), one
flat object and no duplicate decoded property names. Unsupported/malformed values
are rejected without trimming, normalizing, repairing or replacing credentials.

Identical identity/secret imports report **Already stored**. Identity conflicts,
secret reuse across identities and a matching secret in a draft are rejected.
New independent credentials get fresh browser-local keys. Existing vault corruption,
unsupported metadata and write failures preserve existing data. Import never opens
or writes the separate pending-attempt database and never resets server state.
An identical import does not upgrade an existing unmarked internal/legacy binding;
that original binding still requires deliberate same-attempt issuance recovery.

The backup preserves the original secret and authoritative IDs for later claims.
It omits the issuance token, side/stake, receiving UA, payment/receipt mappings and
status. It cannot recover the Phase 7 retry capability or reconstruct the payment
screen. Server issuance with a lost reply or failed local finalization remains a
non-portable gap: losing local storage before completion/export can still lose
claim capability. There is no identity-based recovery or bypass.

The frozen future claim/refund protocol is unchanged. Backup operations never
send the secret to a server; later approved claim verification may submit it.
No payment, claim or refund flow is implemented here, and Phase 8 has not begun.

Run `npm.cmd run test:backup` for the isolated real-browser backup suite. Results,
storage details and scope limits: [TICKET_BACKUP_RESULTS.md](../../docs/TICKET_BACKUP_RESULTS.md).
