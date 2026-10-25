# Synthetic acknowledgement artifact timestamp — staged workflow

This path is **SYNTHETIC_ARTIFACT_TIMESTAMP_ONLY**. Its only assertion is
**ARTIFACT_EXISTENCE_ONLY**: the unchanged acknowledgement bytes existed by the
TSA's signed time. Every result is **NOT_TIMELY_PUBLICATION**,
**NOT_FINANCIALLY_AUTHORIZED**, **COMMON_HUMAN_CONTROL**, financial authorization
NOT_GRANTED and third-party independence NO (false). The original 900-second
capture-to-timestamp window is expired. It stays expired: no observation, clock,
configuration, receipt or financial rule is rewritten or reinterpreted.

## Separate implementation and fixed inputs

The standalone entry point is artifact-timestamp.ps1 -> artifact-cli.mjs, not
the existing witness query/timestamp/verify/export commands. It never signs,
decrypts a key, initializes a key, publishes, uploads, touches SQL, or creates a
production receipt. No background process or always-on Computer B is required.

It accepts only record
`d36d8cbf3534280b0a01b56f1dd553fd318635a81f5a3d035c2db214f6dfeb75`
and acknowledgement SHA-256
`cdcd869f517a516761607abe6000d72a54b406ca9915741a94bad84a70526c0a`.
The original config must remain at
`C:\ZcashWitness\80781d289a434100a100f5b24005c4e6\synthetic-witness.approved.json`,
raw SHA-256 `df3047845f92ecbee3c3ce031229cf34363a01bc64e604c7f863fa465111cf72`,
normalized SHA-256 `ce055bbd67ba4fa20bfba2a34e3f2de55cdafb70551283b6ce3e4341fed91a73`.
The actual file is retained on B, not reconstructed or bundled on A. The proposed
template is not interchangeable with it. Existing loader, canonical capture,
public key identity and synthetic signature verification remain mandatory.
Reading the encrypted key record is for public identity metadata only; no DPAPI
unprotect/sign function is supplied or called by this workflow.

The original four record files, config and known original capture/sign markers
are hashed and rechecked through each operation. Their timestamps/contents are
not updated. The utility never writes keys, original markers, original clock
reports or the original archive. Filesystem owners can still edit local files;
this tool does not make local storage tamperproof. Exact acknowledgement pinning
and signature binding reject changed observations and substituted signatures.

## Stage 0 — source verification and read-only B check (next action)

Extract the new source package side-by-side. Verify its manifest SHA-256 from A
through a trusted channel, then every listed source/public file. Retain all old
packages, configs, state and markers. Never copy a package over LOCALAPPDATA state.
Use stable Node >=24.21.0 <25.0.0 and B's existing reviewed OpenSSL installation
from its unchanged config (B reports 3.5.9). Do not reinstall/downgrade OpenSSL or
alter production trust for this task. OpenSSL compatibility beyond existing
synthetic native tests remains unverified on B until later approved stages.

From the NEW verified package root, in B's existing non-elevated account:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/commitment-witness/artifact-timestamp.ps1 -Action check -Config 'C:\ZcashWitness\80781d289a434100a100f5b24005c4e6\synthetic-witness.approved.json'
if ($LASTEXITCODE -ne 0) { throw 'Read-only artifact check failed; STOP' }
```

Expected stage READ_ONLY_ARTIFACT_INPUTS / status PASS, with the artifact-only
labels above. This checks the already-signed acknowledgement and existing record.
It needs no TSA trust file, new clock, network or output directory. Storage checks
are read-only. Return that result before preparation. It does not establish TSA
readiness, approval to submit, or current public hosting availability.

## Stage 1 — separately reviewed public TSA trust sidecar

artifact-trust.example.json is deliberately UNAVAILABLE, with no certificates.
It cannot prepare or submit. Create a separate **public** artifact-trust sidecar
outside the capture config and retain its independently reviewed SHA-256.
Do not merely hash an unreviewed file and treat that as approval. Required fields:

- version 1, scope SYNTHETIC_ARTIFACT_TIMESTAMP_ONLY, status ARTIFACT_ONLY_APPROVED,
  financial_authorization NOT_GRANTED (never production READY);
- fixed endpoint https://freetsa.org/tsr, numeric signed policy OID 1.2.3.4.1,
  clock_skew_seconds 120;
- reviewed ca_bundle and tsa_verification in the unchanged TSA profile format:
  exact signer DER/certificate and SPKI pins, independently authenticated root
  certificate pins, timestamping-only EKU, current signed CRLs and fetch records.

Recheck official public material, validity, pin matches, root provenance and CRL
freshness before future operations. Missing/expired material, revoked signers,
unexpected rotations and unapproved sidecars fail closed. Existing old public
trust material is not represented as current. No trust material was fetched here.
Trust rotation requires explicit review; token-supplied certificates never become
anchors. Keep the capture-bound file immutable. The sidecar hash is frozen into
the preparation/attempt; changing it after preparation stops for manual review.

## Stage 2 — fresh A/B clocks and offline preparation

After separate review of preparation prerequisites, obtain NEW clock reports on
both computers using clock-cli.mjs, never overwriting old reports. Transfer only
A's public clock-check.json and clock-raw.txt together in a separate directory.
B retains its own new report. Reports must be within five minutes, offsets within
30 seconds, source time.cloudflare.com, matching raw report hashes, correct and
distinct A/B device identities. They are operator-recorded, unauthenticated clock
observations, not proof of first publication. This utility does not obtain or
reset clocks. Both reports are checked before preparation/submission/verification.

Set `$artifactTrust`, `$artifactTrustHash`, `$clockA`, `$clockB` only to the reviewed
local public sidecar, its independently approved digest and NEW report directories.
The following future command is documented, not executed or authorized here:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/commitment-witness/artifact-timestamp.ps1 -Action prepare -Config 'C:\ZcashWitness\80781d289a434100a100f5b24005c4e6\synthetic-witness.approved.json' -Trust $artifactTrust -TrustSha256 $artifactTrustHash -ClockA $clockA -ClockB $clockB
```

Preparation performs offline root/leaf/EKU/chain/CRL checks using the reviewed
OpenSSL. It copies only the unchanged public acknowledgement into the new artifact
directory, durably reserves a request-generation marker, asks OpenSSL for a fresh
CSPRNG nonce-bearing SHA-256 TSQ, then writes it once with exclusive create/fsync.
Strict DER inspection binds policy, SHA-256 imprint, nonce and exact TSQ hash.
No certificate/private key is generated. A complete identical preparation retry
returns the same TSQ/nonce; a partial directory/query/plan stops. It never creates
a replacement nonce after an interrupted generation, even if no TSQ was retained.

The artifact verifier has no capture/publication observation or lag parameter.
Original observed_at is retained only as original metadata, not supplied as a new
event to the production verifier. There is no substitute preparation-to-TSA lag
claim: a later valid token proves existence by its signed time only. Current
certificate/revocation checks and the 120-second future-clock bound still apply.

## Stage 3 — separate explicit approval for ONE live submission

No live submission is authorized in this implementation increment. Only after
reviewing the retained TSQ binding, trust freshness and fresh A/B clocks, obtain
separate approval for one POST. The submit action requires the explicit
SubmitSyntheticArtifactTsaOnce switch. It durably creates submission-attempt.json
with endpoint/query/nonce/ack/trust/clock bindings before the only HTTPS POST.

The TSQ sends only an acknowledgement digest, nonce, policy and certificate-request
metadata. It does not send the acknowledgement itself, keys, participants, tickets,
addresses, stakes or wallet data. FreeTSA/network operators can observe source IP,
timing and request metadata; the digest can be correlated with later public bytes.
There are no credentials, redirects or retries. The existing bounded transport
requires HTTP 200, application/timestamp-reply, identity encoding and a bounded
response. Response retention means UNVERIFIED, never publication authorization.

An existing attempt or response blocks every second submit, including after a
timeout or crash. Never delete a marker, regenerate a nonce, overwrite a response,
or run a second request automatically. If a reply was lost after the POST, the
outcome remains quarantined for manual review. A retained TSR can be verified
without another network request. Trust expiry after preparation also requires
manual review; this increment supplies no recovery/resubmission bypass.

## Stage 4 — offline artifact-only verification

Use the verify action with the same config, pinned trust sidecar and fresh A/B
reports. It rechecks original hashes/signature and retained TSQ/nonce/digest,
verifies exact TSA signer/root pins, CMS signature, chain, timestamping EKU,
certificate validity, current CRL signatures/freshness/revocation, signed numeric
OID, exact nonce and SHA-256 imprint against both query and acknowledgement.
The token's time must be valid for its signer and no more than 120 seconds into
the future. No expired-publication-window exception exists in production code.

Success creates artifact-evidence.json once, with all four explicit semantic
labels. It cannot be a production receipt: different schema/profile, synthetic
signature domain, no publication receipt output or DB path, original financial
trust unchanged. Reverification with identical inputs retains the same evidence;
different evidence/clock context does not overwrite it. Partial or conflicting
evidence is retained for review. No upload/export automation is supplied.

## New local layout and preservation

```text
%LOCALAPPDATA%\ZcashDarkPoolCommitmentWitness\
  artifact-timestamp.lock                 # only our active lock; crash => STOP
  artifact-timestamps\<record>\<ack-sha256>\
    acknowledgement.bin                  # exact public bytes, not a new signature
    request-generation-attempt.json
    request.tsq
    preparation.json
    submission-attempt.json
    response.tsr
    artifact-evidence.json
```

Only these NEW artifact paths are writable. Their restricted ACLs inherit from
the existing checked user-only witness root. Normal completion removes only its
own token-checked artifact lock; crash locks and all attempt markers are retained.
Original witness operation locks are never removed and block artifact mutations.
All original capture, acknowledgement, keys, old reports, markers and production
financial environments remain untouched. Once evidence is retained, B can shut
down. No always-running server or connection is needed.
