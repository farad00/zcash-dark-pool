import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { privateProcess } from "../../../backup/crypto.mjs";
const script = fileURLToPath(
  new URL(
    "../../../../scripts/dev/observation-native-windows.ps1",
    import.meta.url,
  ),
);
const invoke = async (args) =>
  JSON.parse(
    (
      await privateProcess(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          ...args,
        ],
        Buffer.alloc(0),
        16384,
      )
    ).toString(),
  );
test("native adapter inspection does not imply elevated account or service-user proof", async () => {
  const r = await invoke(["-Action", "Inspect"]);
  assert.equal(r.status, "NATIVE_BACKEND_INSPECTION");
  assert.equal(r.persistent_creation, "DISABLED");
});
test("persistent creation and unapproved/missing-source-binding rehearsal reject before resources", async () => {
  await assert.rejects(
    invoke(["-Action", "CreatePersistent", "-DisposableAccountsAcknowledged"]),
  );
  await assert.rejects(invoke(["-Action", "Rehearse"]));
  await assert.rejects(
    invoke(["-Action", "Rehearse", "-DisposableAccountsAcknowledged"]),
  );
});
test("expired or excessive UAC approval windows fail closed and a short read-only window validates", async () => {
  const utc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  for (const end of [Date.now() - 10000, Date.now() + 3600000])
    await assert.rejects(
      invoke(["-Action", "Inspect", "-ApprovalExpiresUtc", utc(end)]),
    );
  assert.equal(
    (
      await invoke([
        "-Action",
        "Inspect",
        "-ApprovalExpiresUtc",
        utc(Date.now() + 300000),
      ])
    ).window_checked,
    true,
  );
});
test("native SCM/LSA/host code compiles; unbound mutations and persistent names reject; fixture cleanup succeeds", async () => {
  const r = await invoke(["-Action", "CompileTest"]);
  assert.equal(r.status, "PASS");
  assert.equal(r.accounts_created, 0);
  assert.equal(r.cleanup_confirmed, true);
  assert.ok(r.checks.includes("UNBOUND_SID_AND_ACCOUNT_MUTATIONS_REFUSED"));
  assert.equal(r.host_results.length, 0); // Never relabel compile checks as real logon proof.
});

for (const scenario of [
  "durable",
  "reparse",
  "acl",
  "owner",
  "ancestor-acl",
  "collision",
  "interrupted",
  "result",
  "result-failure",
  "result-acl-failure",
  "ordering",
]) {
  test(`native evidence disposable storage: ${scenario}`, async () => {
    const fixture = fileURLToPath(
      new URL("./native-evidence-fixture.ps1", import.meta.url),
    );
    const output = await privateProcess(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fixture,
        "-Case",
        scenario,
      ],
      Buffer.alloc(0),
      16384,
    );
    const r = JSON.parse(output.toString());
    assert.equal(r.status, "PASS");
    assert.equal(r.cleanup_confirmed, true);
    assert.equal(r.accounts_created, 0);
    assert.equal(r.persistent_creation, "DISABLED");
  });
}
