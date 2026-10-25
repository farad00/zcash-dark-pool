// Every automated PostgreSQL fixture uses this boundary, including teardown.
import { psql as query, migrationScript, migrationFiles } from "./migrate.mjs";
export { migrationFiles, migrationScript } from "./migrate.mjs";
export const psql = (sql, options = {}) =>
  query(sql, { ...options, requireKind: "TEST" });
export async function migrate(options) {
  return psql(migrationScript(await migrationFiles()), options);
}
