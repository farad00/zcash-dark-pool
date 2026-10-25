// Supervised local commands. Secrets enter stdin, never argv or diagnostics.
import { readFile, stat, open, lstat } from "node:fs/promises";
import { win32 } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { runBounded, boundedExit } from "../../scripts/dev/run-bounded.mjs";
import { rejectRedirects } from "../../db/target-registry.mjs";
import {
  readClusterProfile,
  validateIdentityProfile,
  markerText,
  guardSql,
  guardedSql,
} from "../../db/environment-identity.mjs";
import {
  roles,
  intakeFiles,
  migrationDigest,
  roleSql,
  hba,
  installSql,
  marketSql,
  lit,
} from "./intake.mjs";
import {
  layout,
  scope,
  validateApproval,
  assertUnfundedLaunch,
  readJson,
  durableNew,
  sha256,
} from "./unfunded.mjs";
import { proposedTarget, nativeEnvironment } from "./target.mjs";
import { createMirror, resolveUnfundedTool } from "./unfunded-tools.mjs";
import { openUnfundedIssuer } from "./unfunded-runtime.mjs";

const osEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k]) =>
      /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(k),
    ),
  );
const fail = () => {
  throw Error("UNFUNDED_OPERATION_NOT_CONFIRMED");
};
async function currentSid() {
  const r = await runBounded(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ],
    { env: osEnv(), timeoutMs: 10000, maxBytes: 256 },
  );
  if (boundedExit(r) !== 0) fail();
  return r.stdout.trim();
}
async function profile() {
  const p = layout();
  return readClusterProfile(p, (v) => {
    validateIdentityProfile(
      v,
      {
        ...p,
        reserved_system_identifiers: [
          "7698884242696928048",
          "7697706083887339692",
          "7697541254856017064",
        ],
      },
      "TESTNET_OBSERVATION",
    );
    if (
      v.database !== p.database ||
      v.instance !== p.instance ||
      v.maintenance_user !== roles.maintenance ||
      v.financial_authorization !== "NOT_GRANTED"
    )
      fail();
  });
}
async function query(sql, database, password, p, initial = false) {
  await profile(); // Recheck local physical identity immediately before each operation.
  const tool = await resolveUnfundedTool("context");
  const prefix = initial
    ? `SELECT current_user='${roles.maintenance}' AND current_database()='postgres'
 AND inet_server_addr()='127.0.0.1'::inet AND inet_server_port()=55436
 AND lower(replace(current_setting('data_directory'),chr(92),'/'))=lower(replace(${lit(p.data_directory)},chr(92),'/'))
 AND (SELECT system_identifier::text FROM pg_control_system())=${lit(p.system_identifier)}
 AND shobj_description((SELECT oid FROM pg_database WHERE datname='postgres'),'pg_database') IS NULL
 AS darkpool_target_ok \\gset\n\\if :darkpool_target_ok\n`
    : guardSql(p, database);
  const r = await runBounded(
    tool.executable,
    [
      "--no-psqlrc",
      "--no-password",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "VERBOSITY=sqlstate",
      "-d",
      database,
    ],
    {
      env: {
        ...osEnv(),
        PGHOST: "127.0.0.1",
        PGPORT: "55436",
        PGDATABASE: database,
        PGUSER: roles.maintenance,
        PGPASSWORD: password,
        PGCONNECT_TIMEOUT: "3",
        PGCLIENTENCODING: "UTF8",
      },
      input: guardedSql({ prefix }, sql),
      timeoutMs: 90000,
      maxBytes: 131072,
    },
  );
  if (boundedExit(r) !== 0 || r.timedOut || r.overflow || r.spawnFailed) fail();
  return r.stdout.trim();
}
async function main(action, input) {
  if (action === "plan")
    return {
      scope,
      target: proposedTarget(),
      roles,
      migrations_sha256: migrationDigest(await intakeFiles()),
      hba: hba(),
      persistent_creation: "SEPARATE_APPROVAL_REQUIRED",
      financial_authorization: "NOT_GRANTED",
    };
  const sid = await currentSid();
  const a =
    action === "validate" ? input.approval : await readJson(layout().approval);
  validateApproval(a);
  if (
    ["validate", "mirror", "profile", "install", "open"].includes(action) &&
    sid !== a.operator_sid
  )
    fail();
  if (action === "validate") {
    if (a.migrations_sha256 !== migrationDigest(await intakeFiles())) fail();
    return { status: "APPROVAL_VALIDATED" };
  }
  if (action === "mirror") {
    await createMirror();
    return { status: "PRIVATE_TOOL_COPY_VERIFIED" };
  }
  if (action === "profile") {
    const p = layout();
    await rejectRedirects(p.root);
    await rejectRedirects(p.data);
    const control = await open(win32.join(p.data, "global", "pg_control"), "r");
    const b = Buffer.alloc(8);
    try {
      if ((await control.read(b, 0, 8, 0)).bytesRead !== 8) fail();
    } finally {
      await control.close();
    }
    const s = await stat(p.data);
    const identity = {
      version: 1,
      kind: "TESTNET_OBSERVATION",
      instance: p.instance,
      cluster_id: randomUUID(),
      system_identifier: b.readBigUInt64LE().toString(),
      host: p.host,
      port: p.port,
      data_directory: p.data,
      directory_identity: { dev: String(s.dev), ino: String(s.ino) },
      database: p.database,
      maintenance_user: roles.maintenance,
      financial_authorization: "NOT_GRANTED",
    };
    validateIdentityProfile(
      identity,
      {
        ...p,
        reserved_system_identifiers: [
          "7698884242696928048",
          "7697706083887339692",
          "7697541254856017064",
        ],
      },
      "TESTNET_OBSERVATION",
    );
    await durableNew(p.profile, JSON.stringify(identity));
    await durableNew(p.marker, markerText(identity));
    return {
      status: "FRESH_IDENTITY_BOUND",
      system_identifier: identity.system_identifier,
    };
  }
  const p = await profile();
  if (action === "install") {
    await durableNew(
      win32.join(layout().root, "install-attempt.json"),
      JSON.stringify({ scope, marker: markerText(p) }),
    );
    const passwords = input.passwords;
    const bootstrap = roleSql(passwords);
    await query(
      bootstrap + `\nCOMMENT ON DATABASE postgres IS ${lit(markerText(p))};`,
      "postgres",
      passwords.maintenance,
      p,
      true,
    );
    await query(
      `CREATE DATABASE "${p.database}" OWNER "${roles.owner}" TEMPLATE template0 ENCODING 'UTF8';`,
      "postgres",
      passwords.maintenance,
      p,
    );
    await query(
      `REVOKE ALL ON DATABASE "${p.database}" FROM PUBLIC;
GRANT CONNECT ON DATABASE "${p.database}" TO ${["maintenance", "admin", "issue", "read", "status"].map((k) => '"' + roles[k] + '"').join(",")};
REVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
      p.database,
      passwords.maintenance,
      p,
    );
    await query(await installSql(p, a), p.database, passwords.maintenance, p);
    const check = await query(
      `SELECT (SELECT count(*) FROM darkpool_migrations.applied)=7
 AND NOT EXISTS(SELECT 1 FROM darkpool_private.markets)
 AND NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname='${roles.owner}')
 AND NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname='${roles.watch}')
 AND NOT has_function_privilege('${roles.issue}','darkpool_watcher.reconcile(bigint,jsonb)','EXECUTE');`,
      p.database,
      passwords.maintenance,
      p,
    );
    if (check !== "t") fail();
    const receipt = {
      scope,
      status: "INTAKE_INSTALLED_NO_MARKET",
      marker: markerText(p),
      approval_sha256: sha256(JSON.stringify(a)),
      migrations_sha256: a.migrations_sha256,
    };
    await durableNew(layout().receipt, JSON.stringify(receipt));
    return {
      status: receipt.status,
      system_identifier: p.system_identifier,
      financial_authorization: "NOT_GRANTED",
    };
  }
  if (action === "open") {
    const completion = await readJson(
      win32.join(layout().root, "bootstrap-completed.json"),
    );
    const receipt = await readJson(layout().receipt);
    if (
      completion.status !== "PHYSICAL_BOOTSTRAP_COMPLETED" ||
      completion.scope !== scope ||
      completion.receipt_sha256 !== sha256(JSON.stringify(receipt))
    )
      fail();
    const bytes = await readFile(win32.join(layout().root, "market-plan.json"));
    if (sha256(bytes) !== input.approved_market_sha256) fail();
    const plan = JSON.parse(bytes.toString().replace(/^\uFEFF/, ""));
    if (
      Object.keys(plan).sort().join() !==
      ["configuration", "watcher"].sort().join()
    )
      fail();
    const sql = marketSql(plan.configuration, plan.watcher);
    await durableNew(
      win32.join(layout().root, "market-attempt.json"),
      JSON.stringify({
        scope,
        market_plan_sha256: sha256(bytes),
        marker: markerText(p),
      }),
    );
    await query(sql, p.database, input.maintenance, p);
    const opened = {
      scope,
      marker: markerText(p),
      approval_sha256: sha256(JSON.stringify(a)),
      market_plan_sha256: sha256(bytes),
      market_id: plan.configuration.id,
      vault_context_ref: plan.configuration.vault_context_ref,
      account_ref: plan.watcher.account_ref,
      anchor_height: plan.watcher.anchor_height,
      closes_at: plan.configuration.closes_at,
    };
    await durableNew(
      win32.join(layout().root, "market-opened.json"),
      JSON.stringify(opened),
    );
    return {
      status: "PRIVATE_UNFUNDED_MARKET_OPENED",
      financial_authorization: "NOT_GRANTED",
    };
  }
  const receipt = await readJson(layout().receipt);
  const completion = await readJson(
    win32.join(layout().root, "bootstrap-completed.json"),
  );
  const purpose =
    action === "serve" ? "issuer" : action === "allocator" ? "allocator" : null;
  assertUnfundedLaunch({
    approval: a,
    profile: p,
    receipt,
    completion,
    actorSid: sid,
    purpose,
  });
  const opened = await readJson(
    win32.join(layout().root, "market-opened.json"),
  );
  if (
    opened.marker !== markerText(p) ||
    opened.approval_sha256 !== receipt.approval_sha256
  )
    fail();
  if (
    input.allocator?.ALLOCATION_MARKET_ID !== opened.market_id ||
    input.allocator?.ALLOCATION_VAULT_CONTEXT !== opened.vault_context_ref
  )
    fail();
  if (action === "serve") {
    const runtime = await openUnfundedIssuer({
      connections: input.connections,
      allocator: input.allocator,
      actorSid: sid,
    });
    await new Promise((r, j) => {
      runtime.server.once("error", j);
      runtime.server.listen(3003, "127.0.0.1", r);
    });
    console.log(
      JSON.stringify({
        status: "UNFUNDED_ISSUER_READY",
        url: "http://127.0.0.1:3003/market",
        financial_authorization: "NOT_GRANTED",
        acceptance_enabled: false,
      }),
    );
    const stop = async () => {
      await runtime.close();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    setTimeout(stop, Math.min(1800000, Date.parse(a.expires_at) - Date.now()));
    return null;
  }
  if (action === "allocator") {
    const binary = win32.join(layout().root, "bin", "darkpool-zcash.exe");
    await rejectRedirects(binary);
    await rejectRedirects(layout().wallet_path);
    if (
      !(await lstat(layout().wallet_path)).isFile() ||
      sha256(await readFile(binary)) !== a.native_sha256
    )
      fail();
    const native = nativeEnvironment(
      proposedTarget(),
      "allocation",
      input.allocator,
    );
    const preflight = await runBounded(binary, ["check-unfunded-viewer"], {
      env: { ...osEnv(), ...native },
      input: JSON.stringify({
        market_id: opened.market_id,
        vault_context_ref: opened.vault_context_ref,
        account_ref: opened.account_ref,
        anchor_height: opened.anchor_height,
      }),
      timeoutMs: 10000,
      maxBytes: 256,
    });
    if (
      boundedExit(preflight) !== 0 ||
      preflight.stdout.trim() !== "UNFUNDED_VIEWER_READY"
    )
      fail();
    const child = spawn(binary, ["serve-allocation"], {
      env: { ...osEnv(), ...native },
      stdio: "ignore",
      windowsHide: true,
    });
    const stop = () => child.kill();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const timer = setTimeout(
      stop,
      Math.min(1800000, Date.parse(a.expires_at) - Date.now()),
    );
    child.once("error", () => {
      clearTimeout(timer);
      console.log(
        JSON.stringify({
          status: "UNFUNDED_OPERATION_NOT_CONFIRMED",
          action: "allocator",
        }),
      );
      process.exitCode = 1;
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      process.exitCode = code === 0 ? 0 : 1;
    });
    console.log(
      JSON.stringify({
        status: "UNFUNDED_ALLOCATOR_PROCESS_STARTED_NOT_YET_PROVEN",
      }),
    );
    return null;
  }
  fail();
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    let input = "";
    for await (const b of process.stdin) {
      input += b;
      if (Buffer.byteLength(input) > 65536) fail();
    }
    const r = await main(process.argv[2], input ? JSON.parse(input) : {});
    if (r) console.log(JSON.stringify(r));
  } catch {
    console.log(
      JSON.stringify({
        status: "UNFUNDED_OPERATION_NOT_CONFIRMED",
        action: [
          "plan",
          "validate",
          "mirror",
          "profile",
          "install",
          "open",
          "serve",
          "allocator",
        ].includes(process.argv[2])
          ? process.argv[2]
          : "INVALID",
      }),
    );
    process.exitCode = 1;
  }
}
