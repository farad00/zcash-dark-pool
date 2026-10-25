// Read-only local descriptor check, no target access or launcher.
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { proposal, reviewIsolation, planPurpose } from "./plan.mjs";
export function offlineReview(context) {
  const p = proposal();
  return {
    scope: "OFFLINE_PROPOSAL_ONLY",
    target: {
      instance: p.instance,
      port: p.port,
      database: p.database,
      root: p.root,
    },
    review: reviewIsolation(p, context),
    purposes: ["allocation", "scan", "observation"].map((purpose) =>
      planPurpose(p, purpose, context),
    ),
  };
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    if (process.argv.length !== 2) throw Error();
    const context = {
      localAppData: process.env.LOCALAPPDATA,
      workspace: fileURLToPath(new URL("../../", import.meta.url)).replace(
        /[\\/]$/,
        "",
      ),
    };
    process.stdout.write(JSON.stringify(offlineReview(context)) + "\n");
  } catch {
    process.stderr.write("UNFUNDED_PLAN_REJECTED\n");
    process.exitCode = 1;
  }
}
