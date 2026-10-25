import assert from "node:assert/strict";
import test from "node:test";
import {
  supportedNodeVersion,
  SUPPORTED_NODE_POLICY,
  diagnoseCapture,
} from "../diagnose-capture.mjs";

for (const version of [
  "24.21.0",
  "24.21.1",
  "24.21.99",
  "24.22.0",
  "24.22.1",
  "24.99.123",
])
  test("supported stable Node version: " + version, () =>
    assert.equal(supportedNodeVersion(version), true),
  );
for (const version of [
  "24.20.99",
  "24.0.0",
  "22.22.0",
  "23.99.0",
  "25.0.0",
  "26.0.0",
  "124.22.0",
  "24.22.0-rc.1",
  "24.22.0+build",
  "v24.22.0",
  "24.22",
  "24.22.0\n",
  " 24.22.0",
  "024.22.0",
  "24.022.0",
  "24.22.00",
  "24.22.9007199254740992",
  "24.9999999999999999.0",
  "",
  null,
  24.22,
  undefined,
])
  test("unsupported/malformed Node version: " + String(version), () =>
    assert.equal(supportedNodeVersion(version), false),
  );
test("explicit policy preserves repository lower bound and excludes Node 25", () => {
  assert.equal(
    SUPPORTED_NODE_POLICY,
    ">=24.21.0 <25.0.0 (stable releases only)",
  );
});
test(
  "diagnostic advances past RUNTIME under simulated 24.22.0 and rejects 25",
  { skip: process.platform !== "win32" },
  async () => {
    const original = Object.getOwnPropertyDescriptor(process.versions, "node");
    try {
      const options = {
        configFile: "-",
        requestFile: "-",
        clockDirectory: "-",
        local: "unused-synthetic-root",
        systemRoot: "unused-synthetic-root",
      };
      // No filesystem access: '-' fails the public input check immediately.
      Object.defineProperty(process.versions, "node", {
        ...original,
        value: "24.22.0",
      });
      assert.deepEqual(await diagnoseCapture(options), {
        stage: "PUBLIC_INPUT_PATHS",
        status: "FAIL",
      });
      Object.defineProperty(process.versions, "node", {
        ...original,
        value: "25.0.0",
      });
      assert.deepEqual(await diagnoseCapture(options), {
        stage: "RUNTIME",
        status: "FAIL",
      });
    } finally {
      Object.defineProperty(process.versions, "node", original);
    }
  },
);
