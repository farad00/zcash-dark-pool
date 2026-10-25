// Explicit TEST-only loader for the user-requested nested migration location.
import { readFile } from "node:fs/promises";
import { migrationFiles, migrationScript, psql } from "./test-fixtures.mjs";
export async function migratePhase11(database) {
  const extra = {
    name: "0008_phase11_lock.sql",
    sql: await readFile(
      new URL("./schema/migrations/0008_phase11_lock.sql", import.meta.url),
      "utf8",
    ),
  };
  return psql(migrationScript([...(await migrationFiles()), extra]), {
    database,
  });
}
