# Third-party source notices

This review covers the curated **source-only** Zcash Dark Pool submission.
Original project code is MIT licensed, copyright 2026 Jimoh Abdulsamad.
Third-party components retain their own licenses; the root license does not
relicense them. No dependency caches, native executables, PostgreSQL distribution
or compiled application bundle are included in this source export.

## Public local TLS fixtures

`services/zcash/testdata/connect-only/root.pem.txt`, `chain.pem.txt` and
`end.key.txt` are unchanged public test fixtures from **tokio-rustls 0.26.4**,
`tests/certs/`. The included fixture files and license texts were compared
byte-for-byte with the cached upstream crate and matched.

- Upstream: <https://github.com/rustls/tokio-rustls/tree/v/0.26.4/tests/certs>
- License: MIT OR Apache-2.0, with the upstream notices retained:
  [MIT](../services/zcash/testdata/connect-only/LICENSE-MIT) and
  [Apache-2.0](../services/zcash/testdata/connect-only/LICENSE-APACHE).
- MIT attribution: Copyright (c) 2017 quininer kel.

The public test key is never suitable for wallet, witness or deployment use.
Its fixture README and upstream attribution remain included.

## Browser cryptographic dependency

**@noble/hashes 2.4.0** is an external dependency under MIT, copyright (c) 2022
Paul Miller. Its source is downloaded through the pinned npm lockfile rather
than bundled in this source export. `apps/web/build-vault.mjs` explicitly copies
the upstream `LICENSE` beside the dependency files in generated browser assets.
Keep that license with any subsequently distributed browser bundle.

Upstream license:
<https://github.com/paulmillr/noble-hashes/blob/2.4.0/LICENSE>.
The npm lockfile's external package entries declare their license expressions;
workspace links are project code. The other npm/Cargo dependencies are declared
and locked but their downloaded source and compiled libraries are excluded.
Redistributing binaries or dependency trees requires a separate review of the
actual bundled licenses and notices.

## Public FreeTSA verification data

`services/publication/test/public-freetsa/` retains public certificate, CRL and
timestamp-token test data with source URLs and hashes in `provenance.json`.
The token was extracted from a public sample; the third-party audit-export
report itself is not included. `sample-tstinfo.der` is the protocol information
extracted from that token. These files remain public verification fixtures and
are not project publication receipts or evidence authorizing financial activity.

FreeTSA's published usage policy permits projects to incorporate its timestamps
without a separate commercial licence; attribution is appreciated:
<https://www.freetsa.org/freetsa.html>.
Official public certificate/CRL sources: <https://www.freetsa.org/>.
Retain the provenance file and do not present these third-party artifacts as
original project code, timely project publication or independent attestation.

## Deliberately omitted historical patch

`scripts/dev/zcash-devtool-ironwood-sign.patch` is excluded from the public
inventory by operator decision. The original is preserved in private storage;
the supported synthetic demonstration does not depend on it. This source
release does not distribute the upstream devtool checkout or its binaries.
