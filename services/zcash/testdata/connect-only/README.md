# Public local TLS fixture

`root.pem.txt`, `chain.pem.txt` and `end.key.txt` contain unchanged bytes from
the upstream `root.pem`, `chain.pem` and `end.key` in the cached
`tokio-rustls` 0.26.4 crate, `tests/certs/` (MIT OR Apache-2.0),
<https://github.com/rustls/tokio-rustls/tree/v/0.26.4/tests/certs>.
The upstream generator and tests use the server name `foobar.com`.
The `.txt` suffix makes these public fixtures reviewable without changing the
repository's ignore rules for private certificates/keys. License notices are included.

This is a publicly distributed, non-secret test key, never wallet/signing material
and never suitable for production. Fixtures bind only to loopback ephemeral ports.
Only test code adds this CA and uses its certified hostname. Rustls still verifies
the certificate chain, validity and hostname. Production WebPKI roots, TLS policy
and endpoint timeouts remain unchanged. No system trust store is modified.
