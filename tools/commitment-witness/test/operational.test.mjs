import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  mkdir,
  rm,
} from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import {
  captureClock,
  loadClock,
  clockPair,
  clockSamples,
  durableAudit,
  operationalEvidence,
} from "../operational.mjs";
import {
  syntheticEnvelope,
  syntheticDestination,
  syntheticPlan,
  syntheticDigest,
  requireSyntheticEnvelope,
  operationalDestination,
  SYNTHETIC_POLICY,
  SYNTHETIC_SCOPE,
} from "../synthetic.mjs";
import {
  canonical,
  envelopeBytes,
} from "../../../services/publication/profile.mjs";
import { settings } from "../core.mjs";
import { WitnessStore } from "../store.mjs";
import {
  recomputeLedgerCommitment,
  LEDGER_PROFILE,
} from "../../../packages/protocol/phase10/ledger-commitment.ts";

globalThis.fetch = async () => {
  throw new Error("TEST_NETWORK_DISABLED");
};
const report =
  "Tracking time.cloudflare.com\n12:00:00, -00.4220000s\n12:00:01, -00.4050000s\n12:00:02, -00.4100000s\n";
const measure = async () => ({ stdout: report, stderr: "" });
async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), "darkpool-clock-unit-"));
  try {
    await work(root);
  } finally {
    if (
      !resolve(root).startsWith(
        resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"),
      ) ||
      !basename(root).startsWith("darkpool-clock-unit-")
    )
      throw new Error("UNSAFE_CLEANUP");
    await rm(root, { recursive: true, force: true });
  }
}
test("synthetic five-field envelope recomputes with frozen empty-ledger algorithm", () => {
  const actual = recomputeLedgerCommitment(
    {
      profile: LEDGER_PROFILE,
      version: 1,
      network: "testnet",
      market_id: syntheticEnvelope.market_id,
      locked_at: syntheticEnvelope.locked_at,
    },
    [],
    {
      stake_bounds: { min: 1n, max: (1n << 256n) - 1n },
      max_tickets: 100n,
      max_text_bytes: 4096,
      max_amount_bytes: 32,
      max_ledger_bytes: 2000000,
    },
  );
  assert.deepEqual(actual, syntheticEnvelope);
  assert.equal(Object.keys(actual).length, 5);
  assert.equal(
    syntheticDigest(),
    "657516b70067fa75c284359428acb75d92fb300a7b136133c3865a3d56843a2c",
  );
  assert.deepEqual(
    readFileSync(new URL("../synthetic/envelope.json", import.meta.url)),
    envelopeBytes(actual),
  );
});
test("approved synthetic destination never reserves the real create-only path", () => {
  assert.equal(syntheticDestination.repository_id, "1427973036");
  assert.equal(syntheticDestination.branch, "main");
  assert.equal(
    syntheticPlan().destination.path,
    "testnet/synthetic/roundtrip-2026-10-21.json",
  );
  assert.notEqual(syntheticDestination.path, "testnet/ledger-v1.json");
  const config = {
    destination: syntheticDestination,
    trust: { policy_ref: SYNTHETIC_POLICY },
  };
  assert.equal(operationalDestination(config), SYNTHETIC_SCOPE);
  for (const delta of [
    { repository_id: "1" },
    { branch: "other" },
    { path: "testnet/synthetic/other.json" },
  ])
    assert.throws(() =>
      operationalDestination({
        ...config,
        destination: { ...syntheticDestination, ...delta },
      }),
    );
  assert.throws(() =>
    operationalDestination({ ...config, trust: { policy_ref: "real_policy" } }),
  );
});
test("synthetic path refuses changed roots, markets, amounts/counts and private fields", () => {
  requireSyntheticEnvelope(syntheticEnvelope);
  for (const delta of [
    { merkle_root: "00".repeat(32) },
    { market_id: "real-market" },
    { accepted_ticket_count: "1" },
    { claim_secret: "synthetic-private" },
  ])
    assert.throws(() =>
      requireSyntheticEnvelope({ ...syntheticEnvelope, ...delta }),
    );
});
test("candidate and production trust remain unavailable; no automatic activation", () => {
  for (const path of [
    "../synthetic/witness-config.proposed.json",
    "../../../services/publication/witness-public.json",
  ]) {
    const config = JSON.parse(
      readFileSync(new URL(path, import.meta.url), "utf8"),
    );
    assert.equal(config.trust.status, "UNAVAILABLE");
    assert.throws(() => settings(config), /PUBLICATION_UNAVAILABLE/);
  }
});
test("clock captures observed source, worst offset, raw hash and immutable files", () =>
  fixture(async (root) => {
    const dir = join(root, "b"),
      record = await captureClock("COMPUTER_B", dir, { measure });
    assert.equal(record.offset_milliseconds, -422);
    assert.deepEqual(await loadClock(dir, "COMPUTER_B"), record);
    assert.equal((await readdir(dir)).length, 3);
    await assert.rejects(captureClock("COMPUTER_B", dir, { measure }));
  }));
test("decimal-comma Windows reports parse; fractional offsets round conservatively", () => {
  assert.equal(
    clockSamples("00:00:01, +0,0000001s\n00:00:02, -0,0000002s\n").offset,
    -1,
  );
});
test("clock fails on timeout, stderr and insufficient samples; no success record", () =>
  fixture(async (root) => {
    for (const [name, measure] of [
      [
        "timeout",
        async () => {
          throw new Error("timeout");
        },
      ],
      ["stderr", async () => ({ stdout: report, stderr: "failed" })],
      ["partial", async () => ({ stdout: "+0.4s\n", stderr: "" })],
    ]) {
      const dir = join(root, name);
      await assert.rejects(captureClock("COMPUTER_A", dir, { measure }));
      await assert.rejects(loadClock(dir, "COMPUTER_A"));
    }
  }));
test("out-of-bound, missing, excessive and arbitrary local clock data fail closed", () => {
  for (const raw of [
    "",
    "2026-10-21T12:00:00Z",
    "+30.000001s\n+0.0s",
    "+0.0s\n".repeat(4),
    "x".repeat(16385),
  ])
    assert.throws(() => clockSamples(raw));
});
test("stale, future, wrong-device and tampered raw clock evidence is rejected", () =>
  fixture(async (root) => {
    const dir = join(root, "a"),
      record = await captureClock("COMPUTER_A", dir, { measure });
    await assert.rejects(loadClock(dir, "COMPUTER_B"));
    await assert.rejects(
      loadClock(dir, "COMPUTER_A", Date.parse(record.checked_at) + 300001),
    );
    await assert.rejects(
      loadClock(dir, "COMPUTER_A", Date.parse(record.checked_at) - 1),
    );
    await writeFile(
      join(dir, "clock-raw.txt"),
      report.replace("4220000", "1000000"),
    );
    await assert.rejects(loadClock(dir, "COMPUTER_A"));
  }));
test("two-device evidence requires separate reports; cannot relabel one as both", () =>
  fixture(async (root) => {
    const a = join(root, "a"),
      b = join(root, "b");
    await captureClock("COMPUTER_A", a, { measure });
    await captureClock("COMPUTER_B", b, { measure });
    assert.equal((await clockPair(a, b)).length, 2);
    await assert.rejects(clockPair(a, a));
    await assert.rejects(clockPair(b, a));
  }));
test("audit files are content-bound, idempotent and exclusively created", () =>
  fixture(async (root) => {
    const dir = join(root, "audit"),
      event = {
        scope: "SYNTHETIC_TEST_ONLY",
        status: "PREPARED",
        financial_authorization: "NOT_GRANTED",
      };
    const id = await durableAudit(dir, event);
    assert.equal(await durableAudit(dir, event), id);
    assert.equal(
      await readFile(join(dir, id + ".json"), "utf8"),
      canonical(event),
    );
    await writeFile(join(dir, id + ".json"), "altered");
    await assert.rejects(durableAudit(dir, event));
  }));
test("missing clock and unwritable/invalid audit sink block the operational gate", () =>
  fixture(async (root) => {
    const a = join(root, "a"),
      b = join(root, "b"),
      bad = join(root, "not-a-directory");
    await captureClock("COMPUTER_A", a, { measure });
    await captureClock("COMPUTER_B", b, { measure });
    await writeFile(bad, "synthetic");
    await assert.rejects(
      operationalEvidence(a, b, bad).before(
        "SIGN",
        "00".repeat(32),
        "11".repeat(32),
      ),
    );
    await assert.rejects(
      operationalEvidence(a, join(root, "missing"), join(root, "audit")).before(
        "SIGN",
        "00".repeat(32),
        "11".repeat(32),
      ),
    );
  }));
test("invalid record identifiers cannot put arbitrary credential-like text into an audit", () =>
  fixture(async (root) => {
    let audits = 0;
    const store = new WitnessStore(
      root,
      { trust: { evidence_class: "EXTERNAL" } },
      {
        operational: {
          before: async () => {
            audits++;
          },
          verification: async () => ({}),
        },
      },
    );
    await assert.rejects(
      store.before("VERIFY", "SYNTHETIC_CREDENTIAL_MUST_NOT_BE_RETAINED"),
    );
    assert.equal(audits, 0);
    assert.deepEqual(await readdir(root), []);
  }));

test("source-only package includes complete static dependency closure and no credentials", async () => {
  const script = readFileSync(
    new URL(
      "../../../scripts/dev/export-commitment-witness.ps1",
      import.meta.url,
    ),
    "utf8",
  );
  const files = [...script.matchAll(/'((?:tools|services)\/[^']+)'/g)].map(
    (m) => m[1],
  );
  assert.equal(files.length, new Set(files).size);
  const base = new URL("../../../", import.meta.url);
  for (const file of files.filter((p) => p.endsWith(".mjs"))) {
    const text = readFileSync(new URL(file, base), "utf8");
    for (const m of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const target = new URL(m[1], new URL(file, base)).href.slice(
        base.href.length,
      );
      assert(files.includes(target), "Missing package dependency: " + target);
    }
  }
  assert(
    files.every(
      (p) => !/witness-key|wallet|\.env|protected_password|\.ts$/.test(p),
    ),
  );
  assert(files.includes("services/publication/rfc3161.mjs"));
});
