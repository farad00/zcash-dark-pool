// Synthetic cryptographic authority only. Generated keys are ephemeral TEST
// material, unrelated to any wallet, account, external witness or real TSA.
import {
  generateKeyPairSync,
  sign,
  createHash,
  X509Certificate,
} from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROFILE,
  DOMAIN,
  canonical,
  sha256,
  envelopeBytes,
} from "../profile.mjs";
import { openssl } from "../verify.mjs";

export const executable =
  process.env.DARKPOOL_PUBLICATION_OPENSSL ||
  "C:\\Program Files\\Git\\usr\\bin\\openssl.exe";
export const copy = (value) => JSON.parse(JSON.stringify(value));
// Simulation exists only in TEST fixtures. Never exported by a runtime module.
export function syntheticRetrieval(evidence) {
  if (evidence.statement.evidence_class !== "SYNTHETIC_TEST")
    throw new Error("NOT_SYNTHETIC");
  return async (binding) => ({
    ...binding,
    repository_bytes: evidence.envelope,
    archive_bytes: evidence.envelope,
  });
}
export async function authority({ policyOid = "1.3.6.1.4.1.57264.11.1" } = {}) {
  if (!/^[0-9.]+$/.test(policyOid)) throw new Error("SYNTHETIC_POLICY_ONLY");
  const directory = await mkdtemp(join(tmpdir(), "darkpool-synthetic-tsa-"));
  const path = (name) => join(directory, name);
  const quoted = (name) => '"' + path(name).replaceAll("\\", "/") + '"';
  const ca = `[ca]
default_ca=issuer
[issuer]
database=${quoted("index")}
new_certs_dir=${quoted("certs")}
certificate=${quoted("root.cert")}
private_key=${quoted("root.key")}
serial=${quoted("serial")}
crlnumber=${quoted("crlnumber")}
default_md=sha256
default_days=7
default_crl_days=7
policy=names
unique_subject=no
[names]
commonName=supplied
[req]
distinguished_name=dn
[dn]
[root]
basicConstraints=critical,CA:true
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
[timestamp]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,timeStamping
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
[server]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,serverAuth
[tsa]
default_tsa=tsa_profile
[tsa_profile]
serial=${quoted("tsserial")}
signer_cert=${quoted("tsa.cert")}
signer_key=${quoted("tsa.key")}
signer_digest=sha256
default_policy=${policyOid}
other_policies=${policyOid}
digests=sha256
accuracy=secs:1
ordering=yes
tsa_name=yes
ess_cert_id_chain=no
ess_cert_id_alg=sha256
`;
  try {
    await mkdir(path("certs"));
    await Promise.all([
      writeFile(path("config"), ca),
      writeFile(path("index"), ""),
      ...["serial", "crlnumber", "tsserial"].map((name) =>
        writeFile(path(name), "01\n"),
      ),
    ]);
    await openssl(executable, [
      "req",
      "-new",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "7",
      "-sha256",
      "-config",
      path("config"),
      "-extensions",
      "root",
      "-subj",
      "/CN=Synthetic Publication Root",
      "-keyout",
      path("root.key"),
      "-out",
      path("root.cert"),
    ]);
    await openssl(executable, [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-config",
      path("config"),
      "-subj",
      "/CN=Synthetic Publication TSA",
      "-keyout",
      path("tsa.key"),
      "-out",
      path("tsa.csr"),
    ]);
    await openssl(executable, [
      "ca",
      "-batch",
      "-notext",
      "-config",
      path("config"),
      "-extensions",
      "timestamp",
      "-in",
      path("tsa.csr"),
      "-out",
      path("tsa.cert"),
    ]);
    await openssl(executable, [
      "ca",
      "-gencrl",
      "-config",
      path("config"),
      "-out",
      path("crl"),
    ]);
    const keys = generateKeyPairSync("ed25519");
    const root = new X509Certificate(await readFile(path("root.cert"))),
      signer = new X509Certificate(await readFile(path("tsa.cert")));
    const crlRecords = async () => [
      {
        sha256: sha256(
          Buffer.from(
            (await readFile(path("crl"), "utf8")).replace(
              /-----[^\r\n]+-----|\s/g,
              "",
            ),
            "base64",
          ),
        ),
        retrieved_at: new Date().toISOString(),
        source: "https://synthetic-tsa.invalid/root.crl",
      },
    ];
    const trust = {
      status: "READY",
      policy_ref: "phase11_publication_synthetic_v1",
      evidence_class: "SYNTHETIC_TEST",
      repository: "https://github.com/synthetic-fixture/ledger",
      path: "testnet/ledger-v1.json",
      archive_origin: "https://synthetic-witness.invalid",
      witness_spki: keys.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64"),
      ca_bundle:
        (await readFile(path("root.cert"), "utf8")) +
        (await readFile(path("crl"), "utf8")),
      tsa_policy_oid: policyOid,
      tsa_verification: {
        version: 1,
        signer_certificate: signer.raw.toString("base64"),
        signer_certificate_sha256: sha256(signer.raw),
        signer_spki_sha256: sha256(
          signer.publicKey.export({ type: "spki", format: "der" }),
        ),
        anchor_certificate_sha256: [sha256(root.raw)],
        crl_fetch_records: await crlRecords(),
        max_crl_fetch_age_seconds: 86400,
        min_crl_remaining_seconds: 86400,
      },
      max_clock_skew_seconds: 2,
      max_witness_lag_seconds: 300,
    };
    return {
      trust,
      async refreshCrl(hours = 1) {
        if (
          !process.env.NODE_TEST_CONTEXT ||
          !Number.isSafeInteger(hours) ||
          hours < 1 ||
          hours > 168
        )
          throw new Error("SYNTHETIC_ONLY");
        await openssl(executable, [
          "ca",
          "-gencrl",
          "-config",
          path("config"),
          "-crlhours",
          String(hours),
          "-out",
          path("crl"),
        ]);
        return {
          ...trust,
          ca_bundle:
            (await readFile(path("root.cert"), "utf8")) +
            (await readFile(path("crl"), "utf8")),
          tsa_verification: {
            ...trust.tsa_verification,
            crl_fetch_records: await crlRecords(),
          },
        };
      },
      async rotate({ reuseKey = false, extension = "timestamp" } = {}) {
        if (
          !process.env.NODE_TEST_CONTEXT ||
          !["timestamp", "server"].includes(extension)
        )
          throw new Error("SYNTHETIC_ONLY");
        const args = [
          "req",
          "-new",
          "-nodes",
          "-config",
          path("config"),
          "-subj",
          "/CN=Synthetic Rotated TSA",
          "-out",
          path("tsa.csr"),
        ];
        if (reuseKey) args.push("-key", path("tsa.key"));
        else args.push("-newkey", "rsa:2048", "-keyout", path("tsa.key"));
        await openssl(executable, args);
        await openssl(executable, [
          "ca",
          "-batch",
          "-notext",
          "-config",
          path("config"),
          "-extensions",
          extension,
          "-in",
          path("tsa.csr"),
          "-out",
          path("tsa.cert"),
        ]);
        const c = new X509Certificate(await readFile(path("tsa.cert")));
        return {
          ...trust,
          tsa_verification: {
            ...trust.tsa_verification,
            signer_certificate: c.raw.toString("base64"),
            signer_certificate_sha256: sha256(c.raw),
            signer_spki_sha256: sha256(
              c.publicKey.export({ type: "spki", format: "der" }),
            ),
          },
        };
      },
      async timestampQuery(query) {
        if (
          !process.env.NODE_TEST_CONTEXT ||
          !Buffer.isBuffer(query) ||
          !query.length ||
          query.length > 65536
        )
          throw new Error("SYNTHETIC_TIMESTAMP_ONLY");
        await writeFile(path("witness-query"), query);
        await openssl(executable, [
          "ts",
          "-reply",
          "-config",
          path("config"),
          "-queryfile",
          path("witness-query"),
          "-out",
          path("witness-reply"),
        ]);
        return readFile(path("witness-reply"));
      },
      async evidence(envelope, change = () => {}) {
        const bytes = envelopeBytes(envelope);
        const statement = {
          profile: PROFILE,
          network: "testnet",
          market_id: envelope.market_id,
          repository: trust.repository,
          path: trust.path,
          commit: "12".repeat(20),
          git_blob_sha1: createHash("sha1")
            .update(Buffer.from(`blob ${bytes.length}\0`))
            .update(bytes)
            .digest("hex"),
          content_sha256: sha256(bytes),
          archive_url: trust.archive_origin + "/" + sha256(bytes),
          observed_at: new Date().toISOString(),
          retention: "RETAINED_PUBLIC_AND_OFFLINE",
          evidence_class: "SYNTHETIC_TEST",
        };
        change(statement);
        const signature = sign(
          null,
          Buffer.concat([DOMAIN, Buffer.from(canonical(statement))]),
          keys.privateKey,
        ).toString("base64");
        await writeFile(path("data"), canonical({ statement, signature }));
        await openssl(executable, [
          "ts",
          "-query",
          "-data",
          path("data"),
          "-sha256",
          "-cert",
          "-tspolicy",
          trust.tsa_policy_oid,
          "-out",
          path("query"),
        ]);
        await openssl(executable, [
          "ts",
          "-reply",
          "-config",
          path("config"),
          "-queryfile",
          path("query"),
          "-out",
          path("reply"),
        ]);
        return {
          envelope: bytes.toString("base64"),
          statement,
          signature,
          tsq: (await readFile(path("query"))).toString("base64"),
          tsr: (await readFile(path("reply"))).toString("base64"),
        };
      },
      async revoke() {
        await openssl(executable, [
          "ca",
          "-config",
          path("config"),
          "-revoke",
          path("tsa.cert"),
        ]);
        await openssl(executable, [
          "ca",
          "-gencrl",
          "-config",
          path("config"),
          "-out",
          path("crl"),
        ]);
        return {
          ...trust,
          ca_bundle:
            (await readFile(path("root.cert"), "utf8")) +
            (await readFile(path("crl"), "utf8")),
          tsa_verification: {
            ...trust.tsa_verification,
            crl_fetch_records: await crlRecords(),
          },
        };
      },
      async close() {
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function envelope() {
  return {
    market_id: "synthetic-publication",
    ledger_version: 1,
    accepted_ticket_count: "2",
    merkle_root: "ab".repeat(32),
    locked_at: new Date(Date.now() - 60000).toISOString(),
  };
}
