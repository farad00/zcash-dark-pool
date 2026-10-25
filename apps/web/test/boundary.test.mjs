import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

test("SEC01/04/07 Phase 4: HTTP exposes health only; no admin or participant routes", async () => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../src/server.mjs", import.meta.url))],
    {
      env: { ...process.env, ZCASH_NETWORK: "testnet", PORT: "0" },
      windowsHide: true,
    },
  );
  const closed = new Promise((resolve) => child.once("close", resolve));
  let error = "";
  child.stderr.on("data", (chunk) => {
    error += chunk;
  });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("local health start timeout")),
        10000,
      );
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("health process unavailable"));
      });
      child.once("close", () => {
        clearTimeout(timer);
        reject(new Error("health process ended before ready"));
      });
      child.stdout.on("data", (chunk) => {
        const match = /127\.0\.0\.1:(\d+)/.exec(String(chunk));
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      service: "web",
      status: "scaffold",
      network: "testnet",
    });
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.ok(
      health.headers
        .get("content-security-policy")
        .includes("default-src 'none'"),
    );
    for (const path of [
      "/admin",
      "/admin/open",
      "/admin/pause",
      "/admin/resolve",
      "/market",
      "/predict",
      "/claim",
      "/tickets",
    ]) {
      for (const method of ["GET", "POST"]) {
        const response = await fetch(base + path, { method });
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: "Not found" });
      }
    }
    assert.equal(
      (await fetch(`${base}/health`, { method: "POST" })).status,
      404,
    );
    assert.equal(error, "");
  } finally {
    child.kill();
    await closed;
  }
});
