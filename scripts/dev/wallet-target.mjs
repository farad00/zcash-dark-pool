// Fixed path/argument planning for the reviewed external wallet tools. No execution.
import { configuredTarget, liveWalletPath } from "../../db/target-registry.mjs";
import { join } from "node:path";
export function walletPreparationPlan(env) {
  const target = configuredTarget(env);
  const signerDb = liveWalletPath(env, "signer");
  const watcherDb = liveWalletPath(env, "watcher");
  if (env.WALLET_DB_PATH && env.WALLET_DB_PATH !== signerDb)
    throw Error("POSTGRES_TARGET_REJECTED");
  return Object.freeze({
    instance: target.instance,
    signer_directory: target.signer,
    watcher_directory: target.watcher,
    signer_db: signerDb,
    watcher_db: watcherDb,
    evidence_directory: target.evidence,
    age_identity: join(target.signer, "identity.txt"),
    account_arguments: Object.freeze([
      "wallet",
      "--wallet-dir",
      target.signer,
      "init",
      "--name",
      "phase9-live-payment-v2",
      "--identity",
      join(target.signer, "identity.txt"),
      "-n",
      "test",
      "-s",
      "zecrocks",
      "--connection",
      "direct",
    ]),
    view_import_arguments: Object.freeze([signerDb, target.watcher]),
    resource_creation: false,
  });
}
