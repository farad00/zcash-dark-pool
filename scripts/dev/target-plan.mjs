// Pure allowlisted initialization plan. Never creates directories or credentials.
import { initializerPlan, rejectRedirects } from "../../db/target-registry.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
export async function planTarget(kind, instance, env = process.env) {
  const plan = initializerPlan(kind, env.LOCALAPPDATA, instance);
  await rejectRedirects(plan.root);
  return plan;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [kind, instance, ...extra] = process.argv.slice(2);
    if (extra.length) throw Error();
    process.stdout.write(
      JSON.stringify(await planTarget(kind, instance)) + "\n",
    );
  } catch {
    process.stderr.write("POSTGRES_TARGET_REJECTED\n");
    process.exitCode = 1;
  }
}
