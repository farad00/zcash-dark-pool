import { readFile, lstat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WitnessStore } from "./store.mjs";
import { MODE, fail, settings, captureSettings } from "./core.mjs";
import { operationalEvidence } from "./operational.mjs";
import {
  syntheticSigningSettings,
  requireSyntheticSigningFile,
} from "./synthetic-signing.mjs";
import {
  operationalDestination,
  requireSyntheticEnvelope,
  SYNTHETIC_SCOPE,
} from "./synthetic.mjs";
async function storage(action, input = Buffer.alloc(0)) {
  const executable = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  return new Promise((done, reject) => {
    const child = spawn(
      executable,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(new URL("./storage.ps1", import.meta.url)),
        "-Action",
        action,
      ],
      {
        windowsHide: true,
        env: {
          SystemRoot: process.env.SystemRoot,
          LOCALAPPDATA: process.env.LOCALAPPDATA,
          PATH: process.env.PATH,
        },
      },
    );
    let output = "",
      bad = false;
    const timer = setTimeout(() => {
      bad = true;
      child.kill();
    }, 10000);
    child.stdout.on("data", (b) => {
      output += b.toString();
      if (output.length > 16384) {
        bad = true;
        child.kill();
      }
    });
    child.stderr.on("data", () => {
      bad = true;
    });
    child.on("error", () => {
      bad = true;
    });
    child.stdin.on("error", () => {
      bad = true;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (bad || code !== 0) reject(new Error("WITNESS_STORAGE_REJECTED"));
      else done(output.trim());
    });
    child.stdin.end(input.length ? input.toString("base64") : "");
  });
}
async function json(path, signing = false) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576) fail();
  const bytes = await readFile(path);
  if (bytes.length > 1048576) fail();
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (signing && value?.trust?.status === "UNAVAILABLE")
    requireSyntheticSigningFile(bytes);
  return value;
}
try {
  if (
    process.platform !== "win32" ||
    !process.env.LOCALAPPDATA ||
    process.argv.length !== 9
  )
    fail();
  const [action, configFile, requestFile, record, ack, clockA, clockB] =
    process.argv.slice(2);
  if (
    ack !==
    (action === "timestamp"
      ? "COMMON_CONTROL_AND_TSA_SUBMISSION_ACKNOWLEDGED"
      : "COMMON_CONTROL_ACKNOWLEDGED")
  )
    fail();
  const configuration = await json(resolve(configFile), action === "sign");
  settings(configuration, false);
  const request =
    action === "capture" ? await json(resolve(requestFile)) : undefined;
  if (action === "capture") captureSettings(configuration, request);
  else if (action === "sign" && configuration.trust.status === "UNAVAILABLE")
    syntheticSigningSettings(configuration, record);
  else if (!["init-key", "public-key"].includes(action))
    settings(configuration);
  const destinationMode = operationalDestination(configuration);
  if (configuration.trust.evidence_class !== "EXTERNAL") fail();
  await storage(action === "init-key" ? "init" : "check");
  const store = new WitnessStore(
    join(process.env.LOCALAPPDATA, "ZcashDarkPoolCommitmentWitness"),
    configuration,
    {
      protect: async (bytes) =>
        Buffer.from(await storage("protect", bytes), "base64"),
      unprotect: async (bytes) =>
        Buffer.from(await storage("unprotect", bytes), "base64"),
      operational: operationalEvidence(
        resolve(clockA),
        resolve(clockB),
        join(
          process.env.LOCALAPPDATA,
          "ZcashDarkPoolCommitmentWitness",
          "audit",
        ),
      ),
    },
  );
  if (destinationMode === SYNTHETIC_SCOPE) {
    // This path cannot initialize/replace B's key or process a real ledger.
    if (["init-key", "public-key"].includes(action)) fail();
    requireSyntheticEnvelope(
      action === "capture"
        ? request?.envelope
        : (
            await (action === "sign" &&
            configuration.trust.status === "UNAVAILABLE"
              ? store.loadCapture(record)
              : store.load(record))
          ).capture.request.envelope,
    );
  }
  let result;
  if (action === "init-key") result = await store.initKey();
  else if (action === "public-key") result = await store.publicIdentity();
  else if (action === "capture") result = await store.capture(request);
  else if (action === "sign") result = await store.sign(record);
  else if (action === "query") result = await store.query(record);
  else if (action === "timestamp") result = await store.timestamp(record, true);
  else if (action === "verify") result = await store.verify(record);
  else if (action === "export") result = await store.export(record);
  else fail();
  process.stdout.write(
    JSON.stringify({
      ...result,
      scope: destinationMode,
      mode: MODE,
      third_party_independence: false,
      financial_authorization: false,
    }) + "\n",
  );
} catch {
  process.stderr.write(
    "Witness operation not confirmed; retain original files and reconcile.\n",
  );
  process.exitCode = 1;
}
