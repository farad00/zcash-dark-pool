// Plan only: no database connection, credential read or resource creation.
import { v2Plan } from "./v2-target.mjs";
import { unifiedMigrationFiles, migrationDigest } from "./v2-migrations.mjs";
try {
  if (process.argv.length !== 2) throw new Error();
  const plan = v2Plan(process.env),
    files = await unifiedMigrationFiles();
  process.stdout.write(
    JSON.stringify({
      ...plan,
      migrations: files.map((f) => f.name),
      migration_digest: migrationDigest(files),
      creates_cluster: false,
      creates_wallets: false,
      installs_external_trust: false,
    }) + "\n",
  );
} catch {
  process.stderr.write("V2 plan rejected\n");
  process.exitCode = 1;
}
