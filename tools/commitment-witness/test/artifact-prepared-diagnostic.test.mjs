import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  stat,
  rm,
} from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  inspectPrepared,
  PINS,
  STAGES,
} from "../diagnose-artifact-prepared.mjs";
import { canonical, sha256 } from "../../../services/publication/profile.mjs";
import { noLinks } from "../operational.mjs";
import { ARTIFACT_LABELS as labels } from "../artifact-rfc3161.mjs";

globalThis.fetch = async () => {
  throw Error("NETWORK_FORBIDDEN");
};
const run = promisify(execFile);
const diagnostic = fileURLToPath(
  new URL("../diagnose-artifact-prepared.mjs", import.meta.url),
);
// Literal public query independently reconstructed from the reported DER fields.
const QUERY = Buffer.from(
  "304a0201013031300d060960864801650304020105000420cdcd869f517a516761607abe6000d72a54b406ca9915741a94bad84a70526c0a06042a030401020900bb9eb82f53b354700101ff",
  "hex",
);
const NOW = Date.parse("2026-10-24T10:00:00.000Z");

async function inventory(dir) {
  const records = {};
  async function visit(p) {
    const s = await stat(p);
    if (s.isDirectory()) {
      records[p] = "directory";
      for (const n of await readdir(p)) await visit(join(p, n));
    } else records[p] = [sha256(await readFile(p)), s.mtimeMs];
  }
  await visit(dir);
  return records;
}
async function fixture(work) {
  const dir = await mkdtemp(
    join(tmpdir(), "darkpool-artifact-diagnostic-test-"),
  );
  try {
    const root = join(dir, "state"),
      directory = join(root, "artifact-timestamps");
    await mkdir(directory, { recursive: true });
    const configFile = join(dir, "public-config.json"),
      trustFile = join(dir, "public-trust.json");
    for (const p of [configFile, trustFile])
      await writeFile(p, "SYNTHETIC_PUBLIC_FIXTURE");
    await writeFile(join(directory, "request.tsq"), QUERY);
    for (const n of ["acknowledgement.bin", "preparation.json"])
      await writeFile(join(directory, n), "SYNTHETIC_ENGINE_DOUBLE");
    const marker = {
      profile: "DARKPOOL_SYNTHETIC_ARTIFACT_TSA_V1",
      labels,
      acknowledgement_sha256: PINS.ack,
    };
    await writeFile(
      join(directory, "request-generation-attempt.json"),
      canonical(marker),
    );
    const binding = {
      query_sha256: PINS.query,
      nonce_hex: PINS.nonce,
      acknowledgement_sha256: PINS.ack,
      policy_oid: "1.2.3.4.1",
    };
    const trust = {
      status: "ARTIFACT_ONLY_APPROVED",
      financial_authorization: "NOT_GRANTED",
      tsa_verification: {
        crl_fetch_records: [{ retrieved_at: "2026-10-24T09:19:15.127Z" }],
        max_crl_fetch_age_seconds: 86400,
      },
    };
    let originalCalls = 0;
    const engine = {
      root,
      directory,
      configFile,
      trustFile,
      async original() {
        originalCalls++;
        return { marker: "SYNTHETIC_VERIFIED_ORIGINAL" };
      },
      async trust() {
        return trust;
      },
      async prepared() {
        return { binding };
      },
      async unchanged() {},
      async prepare() {
        assert.fail("mutation forbidden");
      },
      async submit() {
        assert.fail("submission forbidden");
      },
      async locked() {
        assert.fail("lock creation forbidden");
      },
    };
    const stages = [];
    const check = () =>
      inspectPrepared({
        engine,
        canonical,
        labels,
        noLinks,
        now: NOW,
        stage: (s) => stages.push(s),
      });
    await work({
      dir,
      engine,
      marker,
      binding,
      trust,
      check,
      stages,
      originalCalls: () => originalCalls,
    });
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert(basename(dir).startsWith("darkpool-artifact-diagnostic-test-"));
    await rm(dir, { recursive: true, force: true });
  }
}

test("literal 76-byte query matches the retained request pin", () => {
  assert.equal(QUERY.length, 76);
  assert.equal(sha256(QUERY), PINS.query);
});
test("complete read-only inspection preserves bytes, mtimes and directory inventory", () =>
  fixture(async (f) => {
    const before = await inventory(f.dir);
    assert.deepEqual(await f.check(), {
      stage: "READ_ONLY_PREPARED_REQUEST",
      status: "PASS",
    });
    assert.deepEqual(await inventory(f.dir), before);
    assert.equal(f.originalCalls(), 1);
    assert(f.stages.every((s) => STAGES.includes(s)));
  }));
for (const field of [
  "query_sha256",
  "nonce_hex",
  "acknowledgement_sha256",
  "policy_oid",
])
  test("reject mismatched " + field, () =>
    fixture(async (f) => {
      f.binding[field] = "WRONG";
      await assert.rejects(f.check());
      assert.equal(f.stages.at(-1), "PREPARED_REQUEST");
    }),
  );
for (const name of [
  "submission-attempt.json",
  "response.tsr",
  "artifact-evidence.json",
])
  test("existing " + name + " fails without changing or deleting it", () =>
    fixture(async (f) => {
      await writeFile(join(f.engine.directory, name), "RETAIN_ME");
      const before = await inventory(f.dir);
      await assert.rejects(f.check());
      assert.equal(f.stages.at(-1), "OPERATION_STATE");
      assert.deepEqual(await inventory(f.dir), before);
    }),
  );
for (const name of ["operation.lock", "artifact-timestamp.lock"])
  test("existing " + name + " is preserved", () =>
    fixture(async (f) => {
      await writeFile(join(f.engine.root, name), "RETAIN_ME");
      const before = await inventory(f.dir);
      await assert.rejects(f.check());
      assert.deepEqual(await inventory(f.dir), before);
    }),
  );
for (const name of [
  "request.tsq",
  "acknowledgement.bin",
  "preparation.json",
  "request-generation-attempt.json",
])
  test("missing " + name + " is never recreated", () =>
    fixture(async (f) => {
      await rm(join(f.engine.directory, name));
      const before = await inventory(f.dir);
      await assert.rejects(f.check());
      assert.deepEqual(await inventory(f.dir), before);
    }),
  );
for (const status of ["READY", "UNAVAILABLE"])
  test("reject trust status " + status, () =>
    fixture(async (f) => {
      f.trust.status = status;
      await assert.rejects(f.check());
      assert.equal(f.stages.at(-1), "ARTIFACT_TRUST");
    }),
  );
test("reject financial authorization", () =>
  fixture(async (f) => {
    f.trust.financial_authorization = "GRANTED";
    await assert.rejects(f.check());
  }));
for (const time of [
  "2026-10-22T09:19:15.127Z",
  "2026-10-25T09:19:15.127Z",
  "INVALID",
])
  test("reject stale, future or invalid CRL retrieval " + time, () =>
    fixture(async (f) => {
      f.trust.tsa_verification.crl_fetch_records[0].retrieved_at = time;
      await assert.rejects(f.check());
      assert.equal(f.stages.at(-1), "ARTIFACT_TRUST");
    }),
  );
for (const value of [
  "{}",
  "PARTIAL",
  "\ufffd",
  canonical({ profile: "WRONG" }),
])
  test("reject incomplete or conflicting generation marker " + value, () =>
    fixture(async (f) => {
      await writeFile(
        join(f.engine.directory, "request-generation-attempt.json"),
        value,
      );
      await assert.rejects(f.check());
      assert.equal(f.stages.at(-1), "GENERATION_MARKER");
    }),
  );
test("reject changed query bytes even if engine double returns the expected binding", () =>
  fixture(async (f) => {
    await writeFile(join(f.engine.directory, "request.tsq"), Buffer.alloc(76));
    await assert.rejects(f.check());
  }));
test("original verification failures remain failures", () =>
  fixture(async (f) => {
    f.engine.original = async () => {
      throw Error("SENSITIVE_ERROR_MUST_NOT_BE_PRINTED");
    };
    await assert.rejects(f.check());
    assert.equal(f.stages.at(-1), "ORIGINAL_EVIDENCE");
  }));
test("frozen prepared-plan verification failures remain failures", () =>
  fixture(async (f) => {
    f.engine.prepared = async () => {
      throw Error("INVALID_PLAN");
    };
    await assert.rejects(f.check());
    assert.equal(f.stages.at(-1), "PREPARED_REQUEST");
  }));
test("immutable snapshot detects alteration during inspection", () =>
  fixture(async (f) => {
    f.engine.unchanged = async () => {
      await writeFile(f.engine.trustFile, "ALTERED");
    };
    await assert.rejects(f.check());
    assert.equal(f.stages.at(-1), "PRESERVATION");
  }));
test("original-evidence recheck rejection fails closed", () =>
  fixture(async (f) => {
    f.engine.unchanged = async () => {
      throw Error("ORIGINAL_CHANGED");
    };
    await assert.rejects(f.check());
  }));
test("a submission marker appearing during inspection prevents PASS", () =>
  fixture(async (f) => {
    f.engine.unchanged = async () => {
      await writeFile(
        join(f.engine.directory, "submission-attempt.json"),
        "RETAIN",
      );
    };
    await assert.rejects(f.check());
  }));
test("CLI uses a file, ignores stdin and returns only fixed JSON on invalid arguments", async () => {
  await assert.rejects(
    run(process.execPath, [diagnostic], { timeout: 5000 }),
    (e) => {
      assert.deepEqual(JSON.parse(e.stdout), {
        stage: "RUNTIME",
        status: "FAIL",
      });
      assert.equal(e.stderr, "");
      return true;
    },
  );
});
test("CLI refuses an unpinned package before storage inspection", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "darkpool-artifact-diagnostic-package-"),
  );
  try {
    await assert.rejects(
      run(process.execPath, [diagnostic, dir], {
        timeout: 5000,
        env: { ...process.env, NODE_TEST_CONTEXT: "" },
      }),
      (e) => {
        assert.deepEqual(JSON.parse(e.stdout), {
          stage: process.platform === "win32" ? "PACKAGE_INTEGRITY" : "RUNTIME",
          status: "FAIL",
        });
        assert.equal(e.stderr, "");
        return true;
      },
    );
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert(basename(dir).startsWith("darkpool-artifact-diagnostic-package-"));
    await rm(dir, { recursive: true, force: true });
  }
});
