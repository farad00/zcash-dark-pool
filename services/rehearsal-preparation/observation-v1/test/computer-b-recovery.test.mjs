import assert from "node:assert/strict";
import { test, after } from "node:test";
import { readFile, writeFile, readdir, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { syntheticKeyPair } from "../../../backup/crypto.mjs";
import {
  encryptPhysical,
  inventory,
  storage,
} from "../../../backup/physical.mjs";
import { proposal, proposalDigest } from "../../plan.mjs";
import { sha256 } from "../bootstrap-plan.mjs";
import { copiedComputerBReview } from "./computer-b-copy-fixture.mjs";
import { recoveryTransferManifest } from "../bootstrap-recovery.mjs";
import {
  createComputerBRehearsal,
  receiveComputerBFixture,
  reviewComputerBFixture,
  disposeComputerBRehearsal,
  offlineCustodyPlan,
} from "../computer-b-recovery.mjs";
const caps = [];
const fresh = async () => {
  const cap = await createComputerBRehearsal();
  caps.push(cap);
  return cap;
};
after(async () => {
  for (const cap of caps.reverse()) {
    assert.deepEqual(await disposeComputerBRehearsal(cap), { cleaned: true });
    await assert.rejects(lstat(cap.root));
    console.log(
      "COMPUTER_B_FIXTURE_CLEANUP " +
        JSON.stringify({ root: cap.root, cleaned: true }),
    );
  }
});
let bundle;
async function syntheticBundle() {
  if (bundle) return bundle;
  const key = await syntheticKeyPair();
  const nonce = randomBytes(16).toString("hex");
  const journalBytes = Buffer.from(
    "SYNTHETIC_ONLY_NOT_A_REAL_BOOTSTRAP_JOURNAL",
  );
  const value = {
    profile: "DISPOSABLE_COLD_CLUSTER_AGE_V1",
    nonce,
    system_identifier: "7700000000000000001",
    state: "shut down",
    tree: {
      directories: [
        "base",
        "global",
        "pg_wal",
        "pg_xact",
        "pg_multixact",
        "pg_tblspc",
      ],
      files: [
        "PG_VERSION",
        "global/pg_control",
        "postgresql.conf",
        "pg_hba.conf",
        "observation-bootstrap-journal.json",
      ].map((path) => {
        const b =
          path === "observation-bootstrap-journal.json"
            ? journalBytes
            : Buffer.from("SYNTHETIC_NOT_A_USABLE_DATABASE");
        return { path, bytes: b.toString("base64"), sha256: sha256(b) };
      }),
    },
    credentials: ["admin", "owner", "read"].map((purpose) => ({
      purpose,
      login: `darkpool_physical_${purpose}_${nonce.slice(0, 16)}`,
      password: randomBytes(32).toString("hex"),
    })),
    expected: {
      descriptor_sha256: proposalDigest(proposal()),
      journal_sha256: sha256(journalBytes),
    },
  };
  const sealed = await encryptPhysical(value, key.recipient, {
    nonce,
    system_identifier: value.system_identifier,
    inventory_sha256: inventory(value.tree),
    scope: "DISPOSABLE_BOOTSTRAP_ONLY",
    ...value.expected,
    financial_authorization: "NOT_GRANTED",
  });
  const manifest = recoveryTransferManifest(sealed.receipt);
  bundle = {
    manifest,
    hash: sha256(Buffer.from(JSON.stringify(manifest))),
    ciphertext: sealed.ciphertext,
    key: key.identity,
  };
  return bundle;
}
async function received() {
  const b = await syntheticBundle(),
    cap = await fresh();
  await receiveComputerBFixture(cap, b.manifest, b.ciphertext, b.hash);
  return { cap, b };
}
test("offline custody excludes the key from both A/B and never equates a path with proven custody", () => {
  const p = offlineCustodyPlan();
  assert.equal(p.custody_verified, false);
  assert.match(p.offline_key, /NOT_ON_A_OR_B/);
  assert.equal(p.actual_computer_b_retention, "NOT_PROVEN");
});
test("Computer B read-only review separates public integrity from private decryption and never claims operational restore", async () => {
  const b = await syntheticBundle();
  const input = {
    manifest: b.manifest,
    ciphertext: b.ciphertext,
    manifestSha256: b.hash,
  };
  assert.equal(
    (await copiedComputerBReview({ ...input, shellCheck: true })).decryption,
    "NOT_PROVEN",
  );
  const result = await copiedComputerBReview({ ...input, key: b.key });
  assert.equal(result.decryption, "VERIFIED_IN_MEMORY");
  assert.equal(result.operational_restore, "NOT_PROVEN");
  assert.equal(result.financial_authorization, "NOT_GRANTED");
  assert.equal(JSON.stringify(result).includes(b.key), false);
});
test("Computer B read-only review rejects wrong manifest/tool pins and noncanonical manifest bytes before recovery input", async () => {
  const b = await syntheticBundle();
  const input = {
    manifest: b.manifest,
    ciphertext: b.ciphertext,
    manifestSha256: b.hash,
    ageSha256: "0".repeat(64),
  };
  await assert.rejects(copiedComputerBReview(input));
  await assert.rejects(
    copiedComputerBReview({ ...input, manifestSha256: "0".repeat(64) }),
  );
  const modified = Buffer.from(JSON.stringify(b.manifest, null, 2));
  await assert.rejects(
    copiedComputerBReview({
      ...input,
      rawManifest: modified,
      manifestSha256: sha256(modified),
    }),
  );
});
test("Computer B read-only review rejects wrong offline key without writing plaintext or revealing the key", async () => {
  const b = await syntheticBundle(),
    wrong = await syntheticKeyPair();
  await assert.rejects(
    copiedComputerBReview({
      manifest: b.manifest,
      ciphertext: b.ciphertext,
      manifestSha256: b.hash,
      key: wrong.identity,
    }),
  );
});
test("real age ciphertext transfer, authenticated decryption and quarantine materialization use synthetic data only", async () => {
  const { cap, b } = await received();
  const r = await reviewComputerBFixture(cap, b.key, { sourceFenced: true });
  assert.equal(r.status, "SYNTHETIC_DECRYPTION_AND_MATERIALIZATION_VERIFIED");
  assert.equal(r.authorization, "QUARANTINED_NO_LAUNCH");
  assert.equal(r.actual_computer_b_retention, "NOT_PROVEN");
  assert.equal(r.financial_authorization, "NOT_GRANTED");
  assert.equal(
    await readFile(join(cap.root, "restore-quarantine", "PG_VERSION"), "utf8"),
    "SYNTHETIC_NOT_A_USABLE_DATABASE",
  );
  assert.equal(
    (await readdir(cap.root)).some((n) => /identity|private|key/.test(n)),
    false,
  );
  await assert.rejects(
    reviewComputerBFixture(cap, b.key, { sourceFenced: true }),
  );
});
test("transfer rejects a manifest not matching the independently retained digest", async () => {
  const b = await syntheticBundle(),
    cap = await fresh();
  await assert.rejects(
    receiveComputerBFixture(cap, b.manifest, b.ciphertext, "0".repeat(64)),
  );
  assert.deepEqual(await readdir(cap.root), ["scope.json"]);
});
test("wrong recovery key and modified ciphertext fail authenticated decryption without authorizing a restore", async () => {
  const { cap, b } = await received();
  const wrongKey = await syntheticKeyPair();
  await assert.rejects(
    reviewComputerBFixture(cap, wrongKey.identity, { sourceFenced: true }),
  );
  const path = join(cap.root, "cluster.age");
  const changed = Buffer.from(b.ciphertext);
  changed[changed.length - 1] ^= 1;
  await writeFile(path, changed);
  await assert.rejects(
    reviewComputerBFixture(cap, b.key, { sourceFenced: true }),
  );
  assert.equal(
    (await readdir(cap.root)).includes("restore-attempt.json"),
    false,
  );
});
test("manifest/identity substitution is rejected even when a ciphertext is unchanged", async () => {
  const { cap, b } = await received();
  await writeFile(
    join(cap.root, "manifest.json"),
    JSON.stringify({ ...b.manifest, system_identifier: "7700000000000000002" }),
  );
  await assert.rejects(
    reviewComputerBFixture(cap, b.key, { sourceFenced: true }),
  );
});
test("unsafe NTFS permissions reject before decryption; only the disposable probe ACL is repaired for cleanup", async () => {
  const { cap, b } = await received();
  await mkdir(join(cap.root, "unsafe-probe"));
  await storage("check", cap.root);
  await storage("unsafe", cap.root);
  try {
    await assert.rejects(
      reviewComputerBFixture(cap, b.key, { sourceFenced: true }),
      /BACKUP_REJECTED/,
    );
  } finally {
    await storage("repair", cap.root);
  }
});
test("source fencing prerequisite, capability cloning and duplicate transfer fail closed", async () => {
  const { cap, b } = await received();
  await assert.rejects(
    reviewComputerBFixture(cap, b.key, { sourceFenced: false }),
  );
  await assert.rejects(
    reviewComputerBFixture({ ...cap }, b.key, { sourceFenced: true }),
  );
  const prior = await readFile(join(cap.root, "receive-attempt.json"));
  await assert.rejects(
    receiveComputerBFixture(cap, b.manifest, b.ciphertext, b.hash),
  );
  assert.deepEqual(
    await readFile(join(cap.root, "receive-attempt.json")),
    prior,
  );
});
test("concurrent delivery creates exactly one obligation/attempt", async () => {
  const b = await syntheticBundle(),
    cap = await fresh();
  const results = await Promise.allSettled([
    receiveComputerBFixture(cap, b.manifest, b.ciphertext, b.hash),
    receiveComputerBFixture(cap, b.manifest, b.ciphertext, b.hash),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});
for (const fault of ["after_attempt", "after_ciphertext"])
  test(`interrupted receive ${fault} stays quarantined; no automatic resume`, async () => {
    const b = await syntheticBundle(),
      cap = await fresh();
    await assert.rejects(
      receiveComputerBFixture(cap, b.manifest, b.ciphertext, b.hash, { fault }),
    );
    const original = await readFile(join(cap.root, "receive-attempt.json"));
    await assert.rejects(
      receiveComputerBFixture(cap, b.manifest, b.ciphertext, b.hash),
    );
    assert.deepEqual(
      await readFile(join(cap.root, "receive-attempt.json")),
      original,
    );
  });
for (const fault of ["after_attempt", "during_restore"])
  test(`interrupted restore ${fault} cannot launch or overwrite the partial copy`, async () => {
    const { cap, b } = await received();
    await assert.rejects(
      reviewComputerBFixture(cap, b.key, { sourceFenced: true, fault }),
    );
    const original = await readFile(join(cap.root, "restore-attempt.json"));
    await assert.rejects(
      reviewComputerBFixture(cap, b.key, { sourceFenced: true }),
    );
    assert.deepEqual(
      await readFile(join(cap.root, "restore-attempt.json")),
      original,
    );
    assert.equal(
      (await readdir(cap.root)).includes("restore-readiness.json"),
      false,
    );
  });
