# Public submission readiness — 25 October 2026

Status: **CLEAN SOURCE EXPORT APPROVED; PUBLICATION NOT AUTHORIZED.** The submission claim is
a working synthetic lifecycle, ending at an unsent payout intent. Genuine
integrated Zcash testnet deposits/payouts remain UNVERIFIED. Production trust is
UNAVAILABLE; financial authorization is NOT_GRANTED.

## Release scope and audit

The initial read-only Git inventory contained **132 tracked** and **372 untracked**
candidate files. Essential newer product source is untracked: publishing only the
current committed tree would omit much of the MVP. The audit read approximately
6.8 MB of candidate source, examined **188 blobs across 8 reachable commits**, and
inventoried **89,080 ignored artifact paths** without reading their private
contents. Protected external databases, wallets, credentials and backups were
not opened. No Git index, refs, configuration, remotes or history was changed.

The scan checked private-key headers, age identities, GitHub/AWS token shapes,
Zcash key encodings, credential-bearing database URLs, DPAPI payload shapes and
secret-like assignments. Flagged working-source assignments were reviewed in
their test/validation context. They are synthetic rejection fixtures, mock
credentials or format checks, not identified live credentials. This bounded
pattern/context review is not proof that every possible secret format is absent.

One actual private-key-shaped file is intentionally public test data:
`services/zcash/testdata/connect-only/end.key.txt`. Its adjacent README documents
the unchanged upstream tokio-rustls 0.26.4 TLS fixture and licenses; it is used
only by loopback TLS tests. Never use it as a wallet, witness or deployment key.
The reviewed public FreeTSA test response/certificate fixtures are also test
inputs, not authorization receipts for this project.

**Historical credential finding: REVIEWED PLACEHOLDER, not an exposed issued
credential.** The historical `.env.example` URI contains angle-bracket username
and password placeholders in an explicitly labelled template. Across 188
reachable historical blobs, the password placeholder occurred only in that
template; it is absent from the curated working files. No issued credential or
revocation target was established, and no rotation is indicated by this finding.
Active authentication/reuse was not probed; no protected credentials were opened
or changed. No credential value is reproduced here. The public release will use
a fresh root commit; existing private Git history is deliberately excluded and
preserved rather than rewritten or pushed.

The private audit report is retained locally under
`.tools/submission-audit/4eddcf0b2b1a4b129665831f8da6e627/`. It contains only
paths, rule names, locations and counts; it is excluded from the public release.
Ignored directories can contain real secrets and recovery material and must never
be copied into a submission archive. Their contents were deliberately not read.

## Exact public file inventory

Use [PUBLIC_RELEASE_MANIFEST.json](../submission/PUBLIC_RELEASE_MANIFEST.json)
as an **explicit allowlist**. Each entry binds a relative path, byte length and
SHA-256 of the working file. The manifest does not hash itself. Regenerate/review
it after any included-file edit; do not distribute files whose hashes differ.
It prepares a source-only export, not a Git history export or upload approval.

Included: application/protocol/native source, test code and documented synthetic
fixtures, migrations and guards, dependency manifests/lockfiles, baseline product
documents, this guide, recording instructions and reviewed public screenshots.
Existing protected target identifiers in source guards are nonsecret safety
bindings and remain unchanged; they are not credentials or permission to connect.

Excluded: `.git`, `.tools`, dependencies/build output, runtime evidence, populated
environment files, credentials/DPAPI containers, databases, wallet/key material,
bearer backups, recovery archives, and historical operational/result documents
outside the manifest. Historical wallet/Phase 9 evidence is preserved locally;
it is not required to demonstrate the synthetic product. Some legacy source
READMEs refer to omitted operational notes; the root README and public recording
guide are the supported submission entry points.

The operator explicitly excluded `scripts/dev/zcash-devtool-ironwood-sign.patch`
from the public inventory. Its original bytes remain privately preserved. It is
historical spike material and is not required by the supported synthetic demo.

`.gitignore` adds credential/recovery/export patterns and an explicit exception
for the reviewed public timestamp test fixture. It does not untrack files or
purge history. Do not use `git add .`, upload the whole folder, copy the existing
`.git`, or include a browser profile. The operator approved the **MIT License**
for original project code, with copyright **2026 Jimoh Abdulsamad**; the root
[LICENSE](../LICENSE) is included in the release inventory. Third-party code and
public fixtures retain their existing licenses. Preserve their notices and
see the completed, source-only [third-party notice review](THIRD_PARTY_NOTICES.md).
This review does not approve redistribution of compiled dependencies or tools.

## Verified commands and evidence

The README's launch/Test/Regression action names, localhost URL, fixed suite
lists, ten-minute predeclared close, 30-minute session and Stop/cleanup behavior
were checked against current source. The dependency-install instructions match
the pinned manifests; a clean-machine download/build has **not** been executed.
The full demo is Windows-specific and requires its approved TEST/55433 setup.

Retained evidence was revalidated without rerunning tests or database actions:

| Command                                              | Retained result | Verification                                                                                   |
| ---------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------- |
| `scripts/dev/submission-demo.ps1 -Action Test`       | 46/46 PASS      | Exit 0; no skips/cancellations; TAP digest and every recorded source hash match current files. |
| `scripts/dev/submission-demo.ps1 -Action Regression` | 113/113 PASS    | Exit 0; no skips/cancellations; TAP digest and every recorded source hash match current files. |

Local receipt IDs: `63ccf4eabbda487d9258dbfd9243e395` and
`513bd46c239840018eba5b76a7664722`. Both declare wallet initialization false,
financial authorization NOT_GRANTED and production trust UNAVAILABLE. Raw logs
are intentionally excluded. These 159 checks are previous executed evidence,
not 159 additional tests run during packaging. Earlier failures and the original
preservation-violating lifecycle execution retain their original classifications.

## Screenshots and recording

Two real browser screenshots exist:

- [Current operator dashboard](screenshots/synthetic-product-finish-2026-10-25.png):
  reviewed synthetic market, commitment and operator status fields.
- [Earlier operator dashboard](screenshots/synthetic-lifecycle.png): retained
  historical synthetic screenshot, not a second participant flow.

Both show the operator view. Still capture, using only a new synthetic fixture:

1. Public market/participation page with visible SYNTHETIC TEST label.
2. Current-market ticket with private CONFIRMED status; hide secret/export UI.
3. Claim PREPARED screen with explicit NOT SENT/NOT CONFIRMED wording.

Do not show bearer backup contents, network POST payloads, local storage, private
credentials, viewer keys or unrelated machine windows. Retain synthetic warnings
around payment addresses/QRs; never fund them. Existing screenshots are authentic
UI evidence, not generated mockups. A final video has not been recorded or uploaded.
Use the exact [four-minute sequence](SUBMISSION_DEMO.md#four-minute-final-edit),
including a labelled waiting cut rather than an altered market deadline.

## Submission text and outstanding materials

Approved public title: **Zcash Dark Pool**.

Approved source repository name: **`zcash-dark-pool`**. The destination account
and exact public project-source URL are not yet specified or created.

Approved author credit: **Jimoh Abdulsamad — individual developer**.
License: **MIT**. No additional team members or contributors are claimed.

Suggested short description: **Accountless private YES/NO prediction tickets,
with deterministic parimutuel settlement, shielded-payment integration modules
and a working synthetic end-to-end demonstration.**

Suggested technical disclosure: **The recorded product uses synthetic chain and
publication evidence in isolated PostgreSQL TEST resources. It demonstrates
issuance, private status, immutable locking, resolution, claims and an unsent
payout intent. Genuine integrated testnet deposits and payouts are unverified;
spending remains disabled. The operator can see the private book.**

The [official ZECATHON site](https://thezecathon.com/) publicly lists a submission
deadline of **28 October 2026, 23:59 UTC** (29 October 00:59 in Lagos). Its project
submission form and track details require sign-in; one account per project may
use GitHub, Google or email. The exact mandatory form fields and upload limits
were **not** independently inspected behind sign-in. Confirm them in the actual
form; do not assume the checklist below is an official field specification.

Operator checklist for the form and materials:

- [ ] Confirm official deadline, eligibility, track and build-period requirements.
- [x] Approve project name, repository name, MIT license and individual author credit.
- [ ] Choose public project source account/URL; the commitment repository is a
      separate purpose-bound publication destination, not the project source repo.
- [x] Complete third-party license/notice review for the source-only distribution.
- [x] Review the historical credential finding as a placeholder, not an issued secret.
- [x] Approve a clean source export and a new root commit; preserve private history.
- [x] Supply an exact public or GitHub noreply commit email; never inherit a private email.
- [ ] Verify the created export and its single root commit before publication.
- [ ] Record the four-minute video; supply a judge-accessible video URL.
- [ ] Capture the three missing participant/claim screenshots and review privacy.
- [ ] Supply source URL, project title/pitch, architecture and honest limitations.
- [ ] Complete any private contact/team fields directly in the official form.
- [ ] Check submitted links anonymously and retain submission confirmation.

Project name, repository name, MIT license and individual author credit have been
supplied and recorded. The public project-source URL and final video link remain
missing. A logo/cover image can be supplied if the actual form asks for one; it
is not a reason to delay the functional recording.

## Exact next actions

1. Specify the public source destination account/URL. The operator has supplied
   an exact GitHub noreply commit email. License, author credit and the local clean-history export are approved;
   GitHub repository creation and publication are not yet authorized. The
   historical credential finding is resolved as a placeholder.
2. On the already configured machine, run the README's Demo command, record the
   four-minute sequence, capture missing shots, Stop, and verify cleanup.
3. Verify every manifest hash after any final edit. Review the source-only export
   and its third-party notices; keep all excluded material local.
4. After separate publication approval, publish the reviewed source snapshot and
   video, verify anonymous links, then submit the official form before deadline.

No accounts, keys, wallets, databases, services, financial authorization, witness
evidence or closed TSA records are changed by this packaging work. Git
initialization, staging and one initial commit are authorized only inside the
fresh export. The original repository's Git history/index/configuration remain
unchanged. No remote, push or external publication is authorized by this task.
