# On-demand Computer B witness

This is a technically separated witness under common human control. It is **not
independent third-party attestation**, a financial authorization or a proof that
the private ledger is complete. No daemon, scheduled task, background service or
continuous Computer B connection is required. A static public archive must stay
available after B shuts down.

For the separately approved **artifact-existence-only** timestamp workflow of the
already signed synthetic acknowledgement, see [ARTIFACT_TIMESTAMP.md](ARTIFACT_TIMESTAMP.md).
Use its separate entry point; do not run the ordinary witness query/timestamp
commands or change capture-bound trust. The expired 900-second publication
window remains expired, production trust UNAVAILABLE and financial authority NOT_GRANTED.

## Existing synthetic record: capture-preserving signing exception (2026-10-23)

This supersedes the general sign instructions below **only** for record
`d36d8cbf3534280b0a01b56f1dd553fd318635a81f5a3d035c2db214f6dfeb75`.
Implementation/test approval is not permission to upload or use B's real key.
Do not run capture again, initialize a key, edit a retained record, change the
configuration or clear any lock/attempt marker.

The exception requires B's original approved configuration file SHA-256
`df3047845f92ecbee3c3ce031229cf34363a01bc64e604c7f863fa465111cf72`
and normalized configuration SHA-256
`ce055bbd67ba4fa20bfba2a34e3f2de55cdafb70551283b6ce3e4341fed91a73`,
including UNAVAILABLE trust, the approved witness SPKI, exact synthetic market,
repository ID 1427973036, main branch, synthetic path, envelope digest and commit
`90e83e50bcc9bdf54f1f2963d988be18a94262e4`. This does not change the
captured configuration hash, observation time, record ID or witness identity.

`synthetic-signing.mjs` creates an explicitly nonfinancial acknowledgement:
profile `DARKPOOL_SYNTHETIC_WITNESS_ACK_V1`, Ed25519 over ASCII
`DARKPOOL_SYNTHETIC_WITNESS_ACK_V1` followed by one NUL byte followed by the
existing canonical JSON encoding of its statement. The statement binds the
original observation, repository ID/branch/path/commit, envelope hash, archive
URL, witness ID and configuration hash. It includes scope/evidence class
SYNTHETIC_TEST_ONLY, financial_authorization NOT_GRANTED and
third_party_independence NO. The string NO follows the unchanged canonicalizer's
string/integer/object subset; CLI status separately reports Boolean false.
Its distinct profile, domain and statement schema are deliberately incompatible
with production receipts, even under a separately configured READY policy.
`trustProfile()`, production signature/receipt verification and financial
authorization are unchanged. Query, timestamp, verify and export remain blocked
for the unavailable-trust observation. This increment does not complete a TSA
round trip; preserving an old observation can also exceed the existing 900-second
TSA lag bound. Do not renew its time or weaken that bound.

Signing requires anonymous HTTP 200 with the exact 240 envelope bytes at the
capture's original archive URL. Redirects, compression, different bytes, a BOM,
newline, missing hosting or network ambiguity stop without private-key access.
The same availability check applies to an idempotent retry. It uses only B's
existing encrypted key; its decrypted public SPKI must match. Restricted storage
checks and the exclusive operation lock remain in place. Fresh B clock/audit
checks run before the GET, after it and after DPAPI/key parsing. The original
capture time is never replaced by this new clock check. These clock reports are
operator observations, not authenticated UTC evidence.

Only a new `acknowledgement.json` and nonfinancial audit records are created.
Existing valid acknowledgements are verified, never overwritten or re-signed.
Partial/conflicting acknowledgements and crash locks must be preserved for
manual review. A crash before any acknowledgement was durably retained cannot
prove whether an in-memory signature was computed; no automatic retry or repair
is supplied. Existing keys, capture/context/envelope files and older evidence
are not rewritten. As before, the filesystem owner can alter unsigned local
records; this is not an independent integrity attestation of pre-sign history.

### Source-only update on B

Unpack the new package into a **new sibling source directory**, outside the
existing witness state. Retain the previous package. Verify the manifest SHA-256
against A's separately supplied hash, then every listed source/public file.
There are 27 allowlisted package files plus SHA256SUMS.json. Do not merge any
package content into `%LOCALAPPDATA%\ZcashDarkPoolCommitmentWitness`, copy state
from another computer, or use init-key. Keep B's original public config/handoff,
clock reports and attempt markers. Use the unchanged approved capture config
retained in B's previous package, through its absolute path. The bundled proposed
configuration is a different template: raw SHA-256
`43170dc16445d99f6ae97ed43fef428eeecc892a016603baa9f3e10fe2142ed6`,
normalized SHA-256
`681d420bf1cac096f2e89dc94a7ce446a35c7bba8f623841f21d7547481421de`.
It is intentionally ineligible for this existing record. Do not copy it over B's
approved file, edit either file, or rewrite capture.trust_sha256. The previously
provided one-shot signing block selected this wrong template and is superseded.
Hash the three existing capture files read-only before and after the eventual
operation. No state migration is required: the new source uses the same fixed
LOCALAPPDATA state path and existing key/record.

### Configuration mismatch diagnosis — read-only next action

The wrong template enters WitnessStore.loadCapture -> captureOnlyValid ->
validateCapture, where capture.trust_sha256 (`ce055...`) differs from the
normalized template (`681d...`). syntheticSigningCaptureValid is not reached.
Merely choosing the correct file was insufficient in package 93138997... because
its signing settings also pinned `681d...`. Both the raw approved-file hash and
original normalized hash are now pinned; the capture/config/key are unchanged.
The exact B file is not available on A. Its supplied hash bindings are pinned,
not independently reconstructed or claimed as tested B bytes. Synthetic tests
use explicitly isolated fixture-pin copies, never an operational test override.

B reports OpenSSL 3.5.9. A binary upgrade at an unchanged path alone does not
change configuration hashes. Hashes prove these configs differ, but do not
identify which JSON fields differ. No TLS, TSA, root/CRL pin or timing decision
is changed to accommodate a version. The new diagnostic does not execute OpenSSL.

After verifying the NEW source manifest and all files, run only this command
from the new package root, using the original config's absolute path:

```powershell
$ErrorActionPreference = 'Stop'
$approvedCaptureConfig = (Resolve-Path -LiteralPath (Read-Host 'Full path to the unchanged approved capture configuration in the previous package')).Path
if ((Get-FileHash -LiteralPath $approvedCaptureConfig -Algorithm SHA256).Hash -ne 'DF3047845F92ECBEE3C3CE031229CF34363A01BC64E604C7F863FA465111CF72') { throw 'Wrong configuration; STOP' }
node.exe tools/commitment-witness/check-signing-config.mjs $approvedCaptureConfig
if ($LASTEXITCODE -ne 0) { throw 'Read-only check failed; preserve all files and STOP' }
```

Success is exactly `{"stage":"READ_ONLY_CONFIG_AND_CAPTURE","status":"PASS"}`.
Return that result before another signing attempt. Failure prints only a fixed
stage and PASS/FAIL, never exceptions, paths, config values or encrypted key
contents. The diagnostic checks file hash, strict JSON, normalized hash,
synthetic bindings, original capture/context/envelope and existing public key
identity through the real read-only loader, then refuses any acknowledgement,
lock or signing marker. It never decrypts a key, signs, writes, repairs, captures
a clock, accesses hosting or submits a timestamp. It does not prove current ACL,
clock/hosting freshness or signer decryptability, and is not signing approval.

### Separate public archive upload plan — NOT executed or authorized here

Only **envelope.json**, 240 bytes, SHA-256
`657516b70067fa75c284359428acb75d92fb300a7b136133c3865a3d56843a2c`,
needs hosting before signing. Do not upload capture.json, context.json, clocks,
audit, exports, keys, credentials, or the source package. In the existing Pages
repository `0xfarad/commitment-witness` (ID 1428218674), preserve this relative
path under the configured Pages root:

```text
common-control/4c2823572181e400eff4bfb70548a06f9d578e00d2d2175f1306564d5587558a/1427973036/main/d36d8cbf3534280b0a01b56f1dd553fd318635a81f5a3d035c2db214f6dfeb75/657516b70067fa75c284359428acb75d92fb300a7b136133c3865a3d56843a2c/envelope.json
```

The resulting URL must be `https://0xfarad.github.io/commitment-witness/`
followed by that relative path, exactly matching capture.json's archive_url.
A separate hash-verified upload plan and one-file staging tree are supplied by
A. Compare its manifest and envelope with B's retained envelope first. After
separate upload approval, inspect the destination: stop on an unexpected existing
file or ambiguous result. Upload only the byte-preserving JSON file through B's
archive account, without using an editor that adds a newline. Retain the archive
commit reference and anonymously verify exact public bytes after Pages deploys.
This is common-control hosting, not third-party attestation or authorization.

After the new read-only check succeeds, a separately reviewed one-shot sign
command must use `$approvedCaptureConfig`, never the bundled template. No signing
command is authorized in this diagnosis increment. Stop on error/ambiguity and
retain every artifact. No query,
timestamp, export, archive upload or financial transition is implied by signing.

This package uses only Node builtins, Windows PowerShell and OpenSSL. Install
stable Node >=24.21.0 and <25.0.0 and reviewed OpenSSL 3.5.8 separately on B; no npm packages,
private project checkout, wallet, database or GitHub publisher token is needed.
Review the source/manifest and compare the manifest SHA-256 through a separate
trusted channel before running it. An unsigned manifest alone is not provenance.

FreeTSA hardening additionally requires `services/publication/openssl.mjs`,
`rfc3161.mjs` and `tst-policy.mjs` in the same relative package layout. Old exported
packages must be rebuilt and their source manifest reverified. No key regeneration
is needed. READY trust now requires versioned `tsa_verification` pins and current
CRL fetch records. `freetsa-testnet.proposed.json` is unapproved public candidate
material, never financial authorization; Computer A's trust remains UNAVAILABLE.

An offline, no-key/no-network timestamp diagnostic is available after separate
approval to obtain real evidence:

```powershell
node tools/commitment-witness/verify-timestamp.mjs services/publication/freetsa-testnet.proposed.json public-timestamp-input.json new-timestamp-audit.json
```

Input has exactly `query`, `reply`, `data` (canonical base64 of original TSQ, TSR
and exact public acknowledgement bytes), `observed_at`, `locked_at`, `clock_checks`
only. The executable comes from A's locally retained `witness-public.json`, never
from evidence. Clock checks contain one record per `COMPUTER_A` and
`COMPUTER_B`: normalized `source`, UTC `checked_at`, integer `offset_milliseconds`,
and SHA-256 `report_sha256` of the retained raw time-check report. Reports must be
within five minutes and offsets within 30 seconds. They are operator observations,
not authenticated UTC proof. Retain reports separately; never include private
participant/wallet data. The exclusive-create audit contains hashes/pins and clock
records, not raw inputs. It is labeled RFC3161-only and cannot become a publication
receipt. This command never requests a timestamp, verifies a witness signature,
publishes anything, accesses a database or grants financial authority.

The full external publication API requires both clock records and a successful
durable `recordClockAudit` callback. The CLI now supplies these through
`operational.mjs`; unavailable/stale reports and failed audit writes still block
success. Capture/sign/query require `-ClockB <report-directory>`;
timestamp/verify/export also require `-ClockA <received-A-report-directory>`.
Use fresh, exclusive directories for each read-only clock observation:

```powershell
node tools/commitment-witness/clock-cli.mjs COMPUTER_B new-B-clock-directory
```

This only measures `w32tm /stripchart` against `time.cloudflare.com`: it does not
set time or start a service. It retains the raw report and its hash, requires at
least two of three samples within 30 seconds, and labels them unauthenticated
operator observations. Send only the public clock-report directory between A/B;
both reports must be less than five minutes old for full verification. These
measurements are not proof of UTC or of independent human control.

The approved synthetic destination/configuration is under `synthetic/`.
`testnet/synthetic/roundtrip-2026-10-21.json` accepts only its exact zero-ticket
`SYNTHETIC_TEST_ONLY` envelope in the interactive CLI; it cannot initialize a key.
The proposed configuration remains UNAVAILABLE and must not be relabeled as
financial trust. Existing production configuration is unchanged. Consult the
2026-10-21 synthetic round-trip section of `docs/MVP_INTEGRATION_RUNBOOK.md` on A
for the approval-gated two-computer sequence. The older examples below need the
new clock arguments; they are not permission to execute signing/submission.

## Synthetic capture without activated trust

The capture-only capability accepts the existing proposed configuration with
`trust.status: "UNAVAILABLE"`. It is restricted to repository ID `1427973036`,
`farad00/zcash-dark-pool-commitments`, branch `main`, path
`testnet/synthetic/roundtrip-2026-10-21.json`, policy
`common_control_synthetic_roundtrip_20261021`, the exact approved synthetic
envelope, pinned Computer B SPKI, and `0xfarad.github.io/commitment-witness`
archive binding. This is public observation under common human control.

Capture still checks the commit against branch HEAD before and after anonymous
commit/tree/blob retrieval, exact canonical content and digest, stored public
witness identity, restricted Windows storage, and a fresh local clock report with
an append-only audit. It does not decrypt the signing key. TSA/CRL material is
retained as configuration but is not used or approved by this observation step.
`settings()`, `trustProfile()`, signing, query generation, timestamp submission,
receipt verification and export retain their existing READY-trust requirement.
Production/real-market capture with unavailable trust remains rejected.

After a separate capture execution approval, run from the verified new package
root using the existing verified synthetic configuration and handoff. Do not
initialize/replace a key or overwrite the old clock report:

```powershell
$ErrorActionPreference='Stop'
$config=(Resolve-Path '.\synthetic-witness.approved.json').Path
$handoff=(Resolve-Path '.\public-handoff.json').Path
if((Get-FileHash -LiteralPath $handoff -Algorithm SHA256).Hash -ne 'bb8aba57ccd3d339f1440acdc4c1f22ce7586db5cc25d7b34a73e097251806b9'){
    throw 'STOP: handoff mismatch'
}
$clockB=Join-Path $env:LOCALAPPDATA ('ZcashDarkPoolCommitmentWitness\clock-B-'+[Guid]::NewGuid().ToString('N'))
node tools/commitment-witness/clock-cli.mjs COMPUTER_B $clockB
if($LASTEXITCODE -ne 0){throw 'STOP: clock check failed'}
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/commitment-witness/witness.ps1 -Action capture -Config $config -Request $handoff -ClockB $clockB -CommonControlAcknowledged
if($LASTEXITCODE -ne 0){throw 'STOP: preserve original evidence for review'}
```

If the existing verified synthetic configuration has another filename, change
only `$config`. Keep its status UNAVAILABLE. The capture record hashes the full
unchanged configuration, preserves its original observation on identical retry,
and fails on conflicts or partial records. Changing status/configuration later
does not promote the observation into a signed receipt; that requires a separate
reviewed workflow. Stop after capture. Archive upload, signing and TSA submission
are not authorized by this capability. No financial authorization is granted.

## Read-only diagnosis of failed synthetic capture

The supported diagnostic Node policy is `>=24.21.0 <25.0.0`, stable releases
only. Both 24.21.0 and 24.22.0 pass; older Node 24 releases, other majors,
prereleases and malformed version strings fail RUNTIME. This replaces the old
exact 24.21.0 comparison. The actual capture CLI has no exact patch-version check;
it remains unchanged. Accepting a supported runtime does not skip any later
configuration, metadata, permissions, clock or trust check.

Use the new package in a fresh directory. Keep B's state/key, original clock
directory and operation markers unchanged. From the package root, with `$clockB`
pointing to the **original** failed operation's clock directory:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/commitment-witness/diagnose-capture.ps1 -Config .\synthetic-witness.approved.json -Request .\public-handoff.json -ClockB $clockB
```

Use the existing verified public configuration filename if different. This
command performs no capture and makes no network request, write or repair. It
emits exactly one JSON object containing only `stage` and `status` (`PASS` or
`FAIL`). Send only that result to A; do not send state files or key contents.
The launcher suppresses all child exceptions/stderr and validates its bounded
output against a fixed stage list. It resolves `node.exe` as an application and
excludes inherited Node preload options from the diagnostic child.

The first failed stage is one of `RUNTIME`, `PUBLIC_INPUT_PATHS`,
`CONFIGURATION_JSON`, `HANDOFF_JSON`, `SYNTHETIC_BINDINGS`,
`PUBLIC_WITNESS_IDENTITY`, `STORAGE_VALIDATION`, `OPERATION_LOCK`,
`KEY_FILE_METADATA`, `ARCHIVE_LAYOUT`, `CLOCK_INTEGRITY`, `CLOCK_FRESHNESS`,
`AUDIT_PATH` or `RECORD_ABSENT`. `BOOTSTRAP`/`DIAGNOSTIC_PROCESS` identify a
diagnostic startup/process/output problem. Full completion returns
`{"stage":"READ_ONLY_CHECKS","status":"PASS"}`.

`STORAGE_VALIDATION` invokes the unchanged helper's read-only `check` action:
non-elevated Windows identity, root/child ownership, protected root ACL, allowed
SIDs, current-user full control, no reparse points and bounded inventory. It
never invokes init/protect/unprotect. Key checks inspect file **metadata only**;
the private/encrypted key file is never opened, parsed, hashed or decrypted.
Config/request paths inside witness or publisher credential storage are refused.
Clock checks read only public report files. No audit or operation lock is created.

PASS is deliberately limited: it does not validate the key file's contents,
canonical JSON, matching stored SPKI, decryptability or signing capability. It
does not prove that a future lock/audit write will succeed (disk-full, filesystem
or race failures remain possible). `CLOCK_FRESHNESS: FAIL` on an old report means
it is unusable **now**, not that it was stale during the original failure. Clock
integrity is checked separately without changing the retained evidence. Do not
change the clock files or rerun capture to make the diagnostic pass. Production
trust remains UNAVAILABLE and financial authorization NOT_GRANTED.

## One-time setup on B only

Use a normal non-elevated Windows account. Keep the package out of the application
checkout and keep state outside OneDrive/synced/network folders. Copy the public
example, then initialize a dedicated key only when separately ready to do so:

```powershell
Copy-Item tools/commitment-witness/config.example.json witness-config.json
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/commitment-witness/witness.ps1 -Action init-key -Config witness-config.json -CommonControlAcknowledged
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/commitment-witness/witness.ps1 -Action public-key -Config witness-config.json -CommonControlAcknowledged
```

State is fixed to `%LOCALAPPDATA%\ZcashDarkPoolCommitmentWitness`. The helper
creates a restricted ACL root, permits only the current user/SYSTEM/local
Administrators, rejects elevated execution and reparse points, and rechecks the
inventory before access. The private Ed25519 key is encrypted standard PKCS8
(AES-256-CBC) with a random 32-byte password protected by CurrentUser DPAPI. Only
local anonymous pipes carry that password. Never copy `keys/`, the DPAPI capsule
or a full state-directory backup to A or the public archive. DPAPI recovery after
replacing B/user profile is **not proven**; losing it requires explicit key/trust
rotation, not regenerating an old acknowledgement. Public receipts remain
verifiable with the original public key. No portable private-key recovery tool
is supplied.

Pin the returned **public** SPKI/fingerprint out of band. Configure a static
HTTPS archive, e.g. a second-account GitHub Pages site. It must serve exact bytes
without redirects/compression; its account and local copy remain under common
human control. Configure the real hostname, public key, approved TSA CA/chain
and current CRLs, actual TSA policy OID, approved clock-skew/witness-lag values
and a `common_control_...` policy reference. Keep trust UNAVAILABLE until review;
no test key or synthetic policy is production trust. Setting B's local trust
READY does not approve or provision Computer A's financial publication policy.
Acceptance of common-control evidence for any financial authorization remains
a separate explicit security decision; the utility never changes that policy.

## Each on-demand run

A supplies only a public handoff JSON with exactly `commit`, `content_sha256`,
`envelope` (the approved five public fields). No private ticket, secret, stake,
blinding, payment mapping, address, credential or wallet file goes to B.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/commitment-witness/witness.ps1 -Action capture -Config witness-config.json -Request public-handoff.json -ClockB $clockB -CommonControlAcknowledged
```

Capture checks the pinned numeric repository ID, main branch HEAD before and
after retrieval, full commit, exact digest and canonical envelope. It prints a
64-hex `record` and an archive URL. Retain that record ID as `$record`. Manually
upload **only** its local `archive\$record\envelope.json` to the printed static
URL using B's archive account. No upload automation or archive token is included.
The command below refuses to sign until the actual public copy matches:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/commitment-witness/witness.ps1 -Action sign -Config witness-config.json -Record $record -ClockB $clockB -CommonControlAcknowledged
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/commitment-witness/witness.ps1 -Action query -Config witness-config.json -Record $record -ClockB $clockB -CommonControlAcknowledged
# The next command makes the one explicit FreeTSA POST; do not run without approval.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/commitment-witness/witness.ps1 -Action timestamp -Config witness-config.json -Record $record -ClockA $clockA -ClockB $clockB -CommonControlAcknowledged -SubmitTsaAcknowledged
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/commitment-witness/witness.ps1 -Action verify -Config witness-config.json -Record $record -ClockA $clockA -ClockB $clockB -CommonControlAcknowledged
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/commitment-witness/witness.ps1 -Action export -Config witness-config.json -Record $record -ClockA $clockA -ClockB $clockB -CommonControlAcknowledged
```

Only synthetic/mock runs were authorized during implementation. These future
real-key, archive-upload, witness-signing and FreeTSA commands were **not run**.
Retain original acknowledgement, nonce-bearing TSQ and TSR. An invalid token
cannot produce a verified bundle. No automatic re-sign, new nonce or second TSA
POST follows an ambiguous result. A crash lock, partial file, unavailable archive,
lost TSA reply or failed validation stops for manual evidence-backed review.
Do not delete state/attempt markers to retry. No automatic repair is supplied.

Copy **only** `exports\$record\` and the separately approved public configuration
to A, never `keys/`. The five-field `publication-evidence.json` is compatible with
the unchanged verifier. The signed archive URL binds the common-control label,
public-key fingerprint, repository ID, branch, market hash and content hash
without altering the frozen 12-field statement schema. Witness identity is the
verified SPKI fingerprint, not a claimed account display name. Both acknowledgement
and retained context disclose common control; do not describe them as independent.

On A, using its own expected public sealed envelope and independently pinned
public configuration, without B's private key:

```powershell
node tools/commitment-witness/verify-public.mjs approved-public-config.json publication-evidence.json expected-envelope.json $clockA $clockB new-public-audit-directory
```

This performs anonymous public retrieval and original Ed25519/RFC3161/chain/CRL
verification. A bundle-supplied key is never automatically trusted. Success means
cryptographic public-evidence verification only; it cannot insert a database
receipt or authorize resolution/claims/spending. The existing migration 0009 and
lifecycle guards are unchanged.

After retaining/transferring the public evidence, B can disconnect and shut down.
The static hosting provider serves the archive; future verifiers do not call B.
Keep local archives and original public trust evidence securely. GitHub and the
archive may become unavailable; TSA time proves receipt existence by genTime,
not exact first upload, operator honesty or third-party independence.
