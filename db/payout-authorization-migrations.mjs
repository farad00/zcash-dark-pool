import { readFile } from "node:fs/promises";
import { migrationFiles, migrationScript, psql } from "./test-fixtures.mjs";
export async function migratePayoutAuthorization(database) {
  const extras = await Promise.all(
    [
      "0008_phase11_lock.sql",
      "0009_phase11_publication.sql",
      "0010_phase12_resolution.sql",
      "0011_phase13_claims.sql",
      "0012_payout_planning.sql",
      "0013_payout_authorization_review.sql",
    ].map(async (name) => ({
      name,
      sql: await readFile(
        new URL("./schema/migrations/" + name, import.meta.url),
        "utf8",
      ),
    })),
  );
  return psql(migrationScript([...(await migrationFiles()), ...extras]), {
    database,
  });
}
