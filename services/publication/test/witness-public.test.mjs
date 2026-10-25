// Public-key/configuration checks only: no key generation, signing, HTTP or DB.
import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { decode64, sha256, trustProfile } from "../profile.mjs";
import { verifyPublication } from "../verify.mjs";
import { verifyGitHubPublication } from "../github-receipt.mjs";
import {
  archiveUrl,
  settings,
} from "../../../tools/commitment-witness/core.mjs";

globalThis.fetch = async () => {
  throw new Error("TEST_NETWORK_DISABLED");
};
const config = JSON.parse(
  await readFile(new URL("../witness-public.json", import.meta.url), "utf8"),
);
const fingerprint =
  "4c2823572181e400eff4bfb70548a06f9d578e00d2d2175f1306564d5587558a";

test("pinned public SPKI is canonical Ed25519 and matches operator fingerprint", () => {
  const der = decode64(config.trust.witness_spki);
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  assert.equal(key.asymmetricKeyType, "ed25519");
  assert.deepEqual(key.export({ format: "der", type: "spki" }), der);
  assert.equal(sha256(der), fingerprint);
});

test("public witness settings preserve destination, archive and unavailable trust", async () => {
  const destination = JSON.parse(
    await readFile(
      new URL("../github-destination.json", import.meta.url),
      "utf8",
    ),
  );
  const c = settings(config, false);
  assert.deepEqual(c.destination, destination);
  assert.equal(c.archive_origin, "https://0xfarad.github.io");
  assert.equal(c.archive_base_path, "commitment-witness");
  assert.equal(c.trust.archive_origin, c.archive_origin);
  assert.equal(c.trust.repository, destination.repository);
  assert.equal(c.trust.path, destination.path);
  assert.equal(c.mode, "COMMON_CONTROL_TECHNICAL_SEPARATION");
  assert.equal(c.trust.status, "UNAVAILABLE");
  assert.equal(c.trust.policy_ref, "common_control_REQUIRES_APPROVAL");
  assert.throws(() => settings(config), /PUBLICATION_UNAVAILABLE/);
});

test("changing status alone cannot activate missing TSA trust and timing", () => {
  const changed = structuredClone(config.trust);
  changed.status = "READY";
  assert.throws(() => trustProfile(changed));
  assert.equal(
    config.trust.ca_bundle,
    "REQUIRES_APPROVED_CERTIFICATE_CHAIN_AND_CURRENT_CRLS",
  );
  for (const key of [
    "tsa_policy_oid",
    "max_clock_skew_seconds",
    "max_witness_lag_seconds",
  ])
    assert.equal(config.trust[key], "REQUIRES_APPROVAL");
});

test("unavailable public pins cannot authorize a receipt or invoke retrieval", async () => {
  let calls = 0;
  await assert.rejects(
    verifyPublication({}, {}, config.trust, config.openssl, async () => {
      calls++;
      throw new Error("MUST_NOT_RETRIEVE");
    }),
    /PUBLICATION_UNAVAILABLE/,
  );
  assert.equal(calls, 0);
});

test("GitHub verification refuses unavailable trust before public networking", async () => {
  let calls = 0;
  await assert.rejects(
    verifyGitHubPublication(
      {},
      {},
      {
        configuration: config.destination,
        trust: config.trust,
        executable: config.openssl,
        fetch: async () => {
          calls++;
          throw new Error("MUST_NOT_FETCH");
        },
      },
    ),
    /PUBLICATION_UNAVAILABLE/,
  );
  assert.equal(calls, 0);
});

test("existing archive convention binds public key, destination, market and digest", () => {
  const c = settings(config, false);
  const request = {
    content_sha256: "ab".repeat(32),
    envelope: { market_id: "synthetic-public-pin-check" },
  };
  const market = sha256(Buffer.from(request.envelope.market_id));
  const url = archiveUrl(c, fingerprint, request);
  assert.equal(
    url,
    `https://0xfarad.github.io/commitment-witness/common-control/${fingerprint}/1427973036/main/${market}/${request.content_sha256}/envelope.json`,
  );
  assert.notEqual(archiveUrl(c, "00".repeat(32), request), url);
  assert.notEqual(
    archiveUrl(c, fingerprint, { ...request, content_sha256: "cd".repeat(32) }),
    url,
  );
});
