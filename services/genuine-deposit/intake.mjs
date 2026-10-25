// SQL builders only. All execution must pass the fixed-target supervisor.
import { readFile, readdir } from "node:fs/promises";
import { migrationScript } from "../../db/migrate.mjs";
import { provisionIssuanceScript } from "../../db/issuance-provision.mjs";
import { provisionPublicScript } from "../../db/public-provision.mjs";
import { provisionScript } from "../../db/admin-provision.mjs";
import { participantStatusScript } from "../../db/participant-status-provision.mjs";
import { markerText } from "../../db/environment-identity.mjs";
import { sha256, scope } from "./unfunded.mjs";
export const roles = Object.freeze(
  Object.fromEntries(
    ["maintenance", "owner", "admin", "issue", "status", "read", "watch"].map(
      (k) => [k, "darkpool_obs_v1_" + k],
    ),
  ),
);
const fail = () => {
  throw Error("UNFUNDED_INTAKE_REJECTED");
};
export const lit = (v) => "'" + String(v).replaceAll("'", "''") + "'";
export const jsonSql = (v) =>
  `convert_from(decode('${Buffer.from(JSON.stringify(v)).toString("hex")}','hex'),'UTF8')::jsonb`;
export async function intakeFiles() {
  const directory = new URL("../../db/migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((n) => /^\d{4}_.*\.sql$/.test(n))
    .sort();
  if (names.length !== 7 || names.some((n, i) => +n.slice(0, 4) !== i + 1))
    fail();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(new URL(name, directory), "utf8"),
    })),
  );
}
export function migrationDigest(files) {
  if (
    files.length !== 7 ||
    files.some(
      (f, i) => !new RegExp(`^000${i + 1}_[a-z0-9_]+\\.sql$`).test(f.name),
    )
  )
    fail();
  return sha256(
    JSON.stringify(files.map((f) => ({ name: f.name, sha256: sha256(f.sql) }))),
  );
}
export function roleSql(passwords) {
  if (
    Object.keys(passwords).sort().join() !==
      ["maintenance", "admin", "issue", "status", "read"].sort().join() ||
    !Object.values(passwords).every((p) => /^[a-f0-9]{64}$/.test(p)) ||
    new Set(Object.values(passwords)).size !== 5
  )
    fail();
  return `BEGIN;
DO $b$ BEGIN
 IF current_database()<>'postgres' OR current_user<>'${roles.maintenance}' OR
  EXISTS(SELECT 1 FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')) OR
  EXISTS(SELECT 1 FROM pg_roles WHERE rolname LIKE 'darkpool%' AND rolname<>'${roles.maintenance}') THEN
  RAISE EXCEPTION 'fresh isolated cluster required'; END IF;
END $b$;
${Object.entries(roles)
  .filter(([k]) => k !== "maintenance")
  .map(
    ([k, name]) =>
      `CREATE ROLE "${name}" ${["owner", "watch"].includes(k) ? "NOLOGIN" : `LOGIN PASSWORD '${passwords[k]}'`} NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
  )
  .join("\n")}
REVOKE CONNECT,TEMPORARY ON DATABASE postgres,template1 FROM PUBLIC;
COMMIT;`;
}
export function hba() {
  return (
    `host postgres ${roles.maintenance} 127.0.0.1/32 scram-sha-256\n` +
    ["maintenance", "admin", "issue", "status", "read"]
      .map(
        (k) =>
          `host darkpool_testnet_observation_v1 ${roles[k]} 127.0.0.1/32 scram-sha-256`,
      )
      .join("\n") +
    "\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n"
  );
}
// Additive unfunded-only restrictions; existing product rules remain unchanged.
export function boundarySql(binding) {
  return `CREATE SCHEMA darkpool_unfunded;
REVOKE ALL ON SCHEMA darkpool_unfunded FROM PUBLIC;
CREATE TABLE darkpool_unfunded.binding(singleton boolean PRIMARY KEY CHECK(singleton), value jsonb NOT NULL);
INSERT INTO darkpool_unfunded.binding VALUES(true,${jsonSql(binding)});
CREATE TRIGGER no_binding_change BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON darkpool_unfunded.binding
 FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE FUNCTION darkpool_unfunded.refuse_funding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='unfunded rehearsal only'; END $$;
REVOKE ALL ON FUNCTION darkpool_unfunded.refuse_funding() FROM PUBLIC;
CREATE TRIGGER no_receipts BEFORE INSERT OR UPDATE ON darkpool_private.payment_receipts
 FOR EACH ROW EXECUTE FUNCTION darkpool_unfunded.refuse_funding();
CREATE TRIGGER no_acceptance BEFORE INSERT OR UPDATE ON darkpool_private.accepted_payment_receipts
 FOR EACH ROW EXECUTE FUNCTION darkpool_unfunded.refuse_funding();
CREATE FUNCTION darkpool_unfunded.one_attempt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(1146110284,55436);
 IF EXISTS(SELECT 1 FROM darkpool_private.issuance_attempts) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='one unfunded reservation only'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION darkpool_unfunded.one_attempt() FROM PUBLIC;
CREATE TRIGGER one_unfunded_attempt BEFORE INSERT ON darkpool_private.issuance_attempts
 FOR EACH ROW EXECUTE FUNCTION darkpool_unfunded.one_attempt();
CREATE FUNCTION darkpool_unfunded.no_finance() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_TABLE_NAME='markets' THEN
  IF NEW.status NOT IN ('DRAFT','OPEN','PAUSED') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='unfunded lifecycle only'; END IF;
 ELSE
  IF NEW.accepted_amount_zat<>0 OR NEW.payment_state<>'AWAITING_PAYMENT' OR NEW.accepted_payment_ref IS NOT NULL THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='unfunded ticket only'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION darkpool_unfunded.no_finance() FROM PUBLIC;
CREATE TRIGGER no_financial_market BEFORE INSERT OR UPDATE ON darkpool_private.markets
 FOR EACH ROW EXECUTE FUNCTION darkpool_unfunded.no_finance();
CREATE TRIGGER no_funded_ticket BEFORE INSERT OR UPDATE ON darkpool_private.tickets
 FOR EACH ROW EXECUTE FUNCTION darkpool_unfunded.no_finance();`;
}
export async function installSql(profile, approval) {
  const files = await intakeFiles();
  if (migrationDigest(files) !== approval.migrations_sha256) fail();
  const binding = {
    scope,
    marker: markerText(profile),
    approval_sha256: sha256(JSON.stringify(approval)),
    acceptance_enabled: false,
  };
  const status = participantStatusScript({
    database: profile.database,
    role: roles.status,
    environment: "TESTNET_OBSERVATION",
  });
  const [statusCreate, statusCheck] = status.split(
    `SET LOCAL ROLE "${roles.status}";`,
  );
  return `SET ROLE "${roles.owner}";
${migrationScript(files)}
BEGIN;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM darkpool_private.markets) THEN RAISE EXCEPTION 'fresh intake required'; END IF; END $$;
${boundarySql(binding)}
${statusCreate.replace(/^BEGIN;/, "")}
COMMIT;
RESET ROLE;
BEGIN; SET LOCAL ROLE "${roles.status}";
${statusCheck}
${provisionScript(roles.admin)}
${provisionIssuanceScript(roles.issue)}
${provisionPublicScript(roles.read)}`;
}
export function marketSql(configuration, watcher) {
  if (
    !configuration ||
    !watcher ||
    Object.keys(watcher).sort().join() !==
      ["account_ref", "anchor_height", "anchor_hash"].sort().join() ||
    !/^[a-f0-9-]{36}$/.test(watcher.account_ref) ||
    !/^[a-f0-9]{64}$/.test(watcher.anchor_hash) ||
    !Number.isSafeInteger(watcher.anchor_height) ||
    watcher.anchor_height < 11 ||
    watcher.anchor_height > 4294967295
  )
    fail();
  // Existing admin validator freezes every economic field. No INSERT of a market,
  // OPEN UPDATE, fake scan/acceptance, or change to close semantics here.
  return `BEGIN;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM darkpool_private.markets) THEN RAISE EXCEPTION 'new rehearsal market only'; END IF; END $$;
SET LOCAL ROLE "${roles.admin}";
SELECT darkpool_admin.command('create',${jsonSql({ request_key: "unfunded_create_v1", expected_revision: null, configuration })});
RESET ROLE;
INSERT INTO darkpool_private.watcher_state
 VALUES(${lit(configuration.id)},'phase9-exact-chainclock-3-v1',${lit(watcher.account_ref)},'https://testnet.zec.rocks:443',
 ${watcher.anchor_height},decode('${watcher.anchor_hash}','hex'),${lit(configuration.closes_at)}::timestamptz,0,NULL,NULL,clock_timestamp());
SET LOCAL ROLE "${roles.admin}";
SELECT darkpool_admin.command('open',${jsonSql({ request_key: "unfunded_open_v1", expected_revision: "1" })});
COMMIT;`;
}
