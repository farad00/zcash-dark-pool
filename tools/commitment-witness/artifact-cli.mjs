// Dedicated entry point; never dispatches to witness signing/publication actions.
import { join } from "node:path";
import {
  ArtifactTimestamp,
  ARTIFACT_SUBMISSION_APPROVAL,
} from "./artifact-timestamp.mjs";
try {
  if (
    process.platform !== "win32" ||
    process.argv.length !== 9 ||
    !process.env.LOCALAPPDATA
  )
    throw Error();
  if (
    [
      "NODE_OPTIONS",
      "NODE_EXTRA_CA_CERTS",
      "NODE_PATH",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "NODE_TEST_CONTEXT",
      "DARKPOOL_SYNTHETIC_CAPTURE_TEST",
    ].some((k) => process.env[k])
  )
    throw Error();
  const [action, config, trustFile, trustHash, clockA, clockB, approval] =
    process.argv.slice(2);
  if (!["check", "prepare", "submit", "verify"].includes(action)) throw Error();
  if (action !== "submit" && approval !== "NO_SUBMISSION_APPROVAL")
    throw Error();
  if (action === "submit" && approval !== ARTIFACT_SUBMISSION_APPROVAL)
    throw Error();
  const engine = new ArtifactTimestamp(
    join(process.env.LOCALAPPDATA, "ZcashDarkPoolCommitmentWitness"),
    config,
    { trustFile, trustHash, clockA, clockB },
  );
  const result =
    action === "submit"
      ? await engine.submit(approval)
      : await engine[action]();
  process.stdout.write(JSON.stringify(result) + "\n");
} catch {
  process.stderr.write(
    "Artifact operation not confirmed; preserve all evidence and STOP. No automatic retry.\n",
  );
  process.exitCode = 1;
}
