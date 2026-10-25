// Read-only diagnosis of the exact original public config + existing capture.
// No clock capture, network, key decryption, lock/audit writes or signing calls.
import { readFile, lstat } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { noLinks } from "./operational.mjs";
import { WitnessStore } from "./store.mjs";
import { settings } from "./core.mjs";
import { canonical, sha256 } from "../../services/publication/profile.mjs";
import {
  requireSyntheticSigningFile,
  syntheticSigningSettings,
  syntheticSigningCaptureValid,
  SIGNING_CONFIGURATION_SHA256,
} from "./synthetic-signing.mjs";
import { syntheticRecord } from "./synthetic.mjs";

export async function checkSigningConfiguration(configPath, root) {
  let stage = "CONFIGURATION_PATH";
  try {
    configPath = resolve(configPath);
    root = resolve(root);
    const p = configPath.toLowerCase(),
      r = root.toLowerCase();
    if (
      extname(p) !== ".json" ||
      p === r ||
      p.startsWith(r + "/") ||
      p.startsWith(r + "\\")
    )
      throw Error();
    await noLinks(configPath);
    const info = await lstat(configPath);
    if (!info.isFile() || info.size < 1 || info.size > 1048576) throw Error();
    const bytes = await readFile(configPath);
    if (bytes.length > 1048576) throw Error();
    stage = "CONFIGURATION_FILE_HASH";
    requireSyntheticSigningFile(bytes);
    stage = "CONFIGURATION_JSON";
    const config = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    stage = "NORMALIZED_CONFIGURATION_HASH";
    if (
      sha256(Buffer.from(canonical(settings(config, false)))) !==
      SIGNING_CONFIGURATION_SHA256
    )
      throw Error();
    stage = "SYNTHETIC_BINDINGS";
    const record = syntheticRecord();
    syntheticSigningSettings(config, record);
    stage = "EXISTING_CAPTURE";
    const store = new WitnessStore(root, config);
    const loaded = await store.loadCapture(record);
    stage = "SIGNING_CAPTURE_BINDING";
    syntheticSigningCaptureValid(config, loaded.key, loaded.capture, record);
    stage = "EXISTING_OPERATION";
    for (const path of [
      join(root, "operation.lock"),
      join(root, "synthetic-sign-" + record + ".attempt.json"),
      join(loaded.path, "acknowledgement.json"),
    ])
      if (await store.exists(path)) throw Error();
    return { stage: "READ_ONLY_CONFIG_AND_CAPTURE", status: "PASS" };
  } catch {
    return { stage, status: "FAIL" };
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let result = { stage: "RUNTIME", status: "FAIL" };
  if (
    process.platform === "win32" &&
    process.argv.length === 3 &&
    process.env.LOCALAPPDATA
  )
    result = await checkSigningConfiguration(
      process.argv[2],
      join(process.env.LOCALAPPDATA, "ZcashDarkPoolCommitmentWitness"),
    );
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = result.status === "PASS" ? 0 : 1;
}
