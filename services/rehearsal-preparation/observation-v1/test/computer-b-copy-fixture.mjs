// TEST helper: exercise the same standalone-copy layout required on Computer B.
import { copyFile, mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateProcess } from "../../../backup/crypto.mjs";
import {
  createComputerBRehearsal,
  disposeComputerBRehearsal,
} from "../computer-b-recovery.mjs";
import { sha256 } from "../bootstrap-plan.mjs";
export const recoveryPackageFiles = Object.freeze([
  "scripts/dev/observation-computer-b-review.ps1",
  "scripts/dev/v2-security.ps1",
  "scripts/dev/run-bounded.mjs",
  "services/backup/physical.mjs",
  "services/backup/crypto.mjs",
  "services/rehearsal-preparation/plan.mjs",
  "services/rehearsal-preparation/target.proposed.json",
  "services/rehearsal-preparation/observation-v1/bootstrap-plan.mjs",
  "services/rehearsal-preparation/observation-v1/bootstrap-recovery.mjs",
  "services/rehearsal-preparation/observation-v1/computer-b-review.mjs",
  "services/rehearsal-preparation/observation-v1/computer-b-review-cli.mjs",
  ".tools/backup-target/debug/darkpool-backup-age.exe",
]);
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
export async function copiedComputerBReview({
  manifest,
  ciphertext,
  manifestSha256,
  key,
  ageSha256,
  rawManifest,
  shellCheck = false,
}) {
  const cap = await createComputerBRehearsal();
  try {
    for (const name of recoveryPackageFiles) {
      const target = join(cap.root, name);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(repo, name), target, constants.COPYFILE_EXCL);
      if ((await lstat(target)).nlink !== 1) throw Error("COPY_NOT_STANDALONE");
    }
    const manifestBytes = rawManifest ?? Buffer.from(JSON.stringify(manifest));
    await writeFile(join(cap.root, "manifest.json"), manifestBytes, {
      flag: "wx",
    });
    await writeFile(join(cap.root, "cluster.age"), ciphertext, { flag: "wx" });
    const pin =
      ageSha256 ??
      sha256(
        await readFile(
          join(cap.root, ".tools/backup-target/debug/darkpool-backup-age.exe"),
        ),
      );
    const hash = manifestSha256 ?? sha256(manifestBytes);
    let bytes;
    if (shellCheck) {
      const nodeCopy = join(cap.root, "node.exe");
      await copyFile(process.execPath, nodeCopy, constants.COPYFILE_EXCL);
      if (
        sha256(await readFile(nodeCopy)) !==
        sha256(await readFile(process.execPath))
      )
        throw Error("NODE_COPY_MISMATCH");
      bytes = await privateProcess(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(cap.root, "scripts/dev/observation-computer-b-review.ps1"),
          "-Action",
          "Check",
          "-BundleDirectory",
          cap.root,
          "-NodePath",
          nodeCopy,
          "-ManifestSha256",
          hash,
          "-AgeSha256",
          pin,
        ],
        Buffer.alloc(0),
        4096,
      );
    } else
      bytes = await privateProcess(
        process.execPath,
        [
          join(
            cap.root,
            "services/rehearsal-preparation/observation-v1/computer-b-review-cli.mjs",
          ),
          key === undefined ? "check" : "verify",
          cap.root,
          hash,
          pin,
        ],
        key === undefined ? Buffer.alloc(0) : Buffer.from(key + "\n"),
        4096,
      );
    return JSON.parse(bytes);
  } finally {
    const result = await disposeComputerBRehearsal(cap);
    if (!result.cleaned) throw Error("COPY_FIXTURE_CLEANUP_UNCONFIRMED");
    console.log(
      "COMPUTER_B_COPY_FIXTURE_CLEANUP " +
        JSON.stringify({ root: cap.root, cleaned: true }),
    );
  }
}
