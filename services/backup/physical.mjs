// Standalone disposable physical TEST harness. No registered target selectors,
// retained credentials, product lifecycle RPCs, or wallet imports.
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  lstat,
  readdir,
  readFile,
  writeFile,
  mkdir,
  open,
  rm,
} from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  assertSynthetic,
  privateProcess,
  syntheticKeyPair,
  digest,
} from "./crypto.mjs";
import { runBounded, boundedExit } from "../../scripts/dev/run-bounded.mjs";

export const fail = () => {
  throw new Error("PHYSICAL_REHEARSAL_REJECTED");
};
const exe = (name) =>
  fileURLToPath(new URL(`../../.tools/pgsql/bin/${name}.exe`, import.meta.url));
const ageExe = fileURLToPath(
  new URL(
    "../../.tools/backup-target/debug/darkpool-backup-age.exe",
    import.meta.url,
  ),
);
const script = (name) =>
  fileURLToPath(new URL(`../../scripts/dev/${name}`, import.meta.url));
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
const json = (v) =>
  `convert_from(decode('${Buffer.from(JSON.stringify(v)).toString("hex")}','hex'),'UTF8')::jsonb`;
const compressedLimit = 32 * 1024 * 1024,
  expandedLimit = 160 * 1024 * 1024;
const osEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k]) =>
      /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(
        k,
      ),
    ),
  );
export function physicalOnly() {
  assertSynthetic();
  if (
    process.env.DARKPOOL_PHYSICAL_REHEARSAL !== "1" ||
    Object.keys(process.env).some((k) => /^PG/i.test(k)) ||
    process.env.DATABASE_URL ||
    process.env.DARKPOOL_PG_PROFILE
  )
    fail();
}
export function safeRelative(path) {
  if (
    typeof path !== "string" ||
    path.length > 240 ||
    !path.length ||
    path
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /[^a-zA-Z0-9_.-]/.test(p) ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p),
      )
  )
    fail();
  return path;
}
const inRoot = (root, path) => {
  const full = resolve(path),
    rel = relative(resolve(root), full);
  if (!rel || rel.startsWith("..") || resolve(root) === full) fail();
  return full;
};
async function identity(path) {
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink()) fail();
  return { dev: String(s.dev), ino: String(s.ino) };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const scopes = new WeakMap();
const scope = (f) =>
  JSON.stringify({
    nonce: f.nonce,
    root: f.root,
    source: f.source,
    restored: f.restored,
    port: f.port,
    database: f.database,
    roles: f.roles,
  });
async function durableWrite(path, bytes) {
  const file = await open(path, "wx");
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function freePort(port = 0) {
  if (
    port !== 0 &&
    (!Number.isInteger(port) ||
      port < 49152 ||
      port > 65535 ||
      [55432, 55433, 55434, 55435].includes(port))
  )
    fail();
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error("PHYSICAL_PORT_UNAVAILABLE")));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      const selected = server.address().port;
      server.close((e) => (e ? reject(e) : resolvePort(selected)));
    });
  });
}
async function ps(name, args, input = Buffer.alloc(0)) {
  return privateProcess(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script(name),
      ...args,
    ],
    input,
    4096,
    {
      ...osEnv(),
      DARKPOOL_BACKUP_TEST_ONLY: "1",
      DARKPOOL_PHYSICAL_REHEARSAL: "1",
    },
  );
}
export async function storage(action, root) {
  return ps("physical-backup-storage.ps1", [
    "-Action",
    action,
    "-Directory",
    root,
  ]);
}
export async function scanTree(root) {
  const directories = [],
    files = [];
  async function visit(at) {
    const s = await lstat(at);
    if (s.isSymbolicLink() || !s.isDirectory()) fail();
    for (const entry of (await readdir(at)).sort()) {
      const full = inRoot(root, join(at, entry)),
        p = safeRelative(relative(root, full).replaceAll("\\", "/"));
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) fail();
      if (stat.isDirectory()) {
        directories.push(p);
        await visit(full);
      } else {
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024)
          fail();
        const bytes = await readFile(full);
        files.push({
          path: p,
          sha256: digest(bytes),
          bytes: bytes.toString("base64"),
        });
      }
    }
  }
  await visit(root);
  return {
    directories: directories.sort(),
    files: files.sort((a, b) => a.path.localeCompare(b.path, "en")),
  };
}
export const inventory = (tree) =>
  digest(
    Buffer.from(
      JSON.stringify({
        directories: tree.directories,
        files: tree.files.map(({ path, sha256 }) => ({ path, sha256 })),
      }),
    ),
  );
export function validateArchive(value, receipt) {
  if (
    !value ||
    value.profile !== "DISPOSABLE_COLD_CLUSTER_AGE_V1" ||
    value.nonce !== receipt.nonce ||
    value.system_identifier !== receipt.system_identifier ||
    value.state !== "shut down" ||
    !value.tree ||
    !Array.isArray(value.tree.files) ||
    !Array.isArray(value.tree.directories) ||
    !Array.isArray(value.credentials)
  )
    fail();
  const paths = new Set(),
    dirs = new Set();
  let size = 0;
  for (const d of value.tree.directories) {
    safeRelative(d);
    if (paths.has(d.toLowerCase())) fail();
    paths.add(d.toLowerCase());
    dirs.add(d);
  }
  for (const f of value.tree.files) {
    safeRelative(f.path);
    if (paths.has(f.path.toLowerCase()) || typeof f.bytes !== "string") fail();
    paths.add(f.path.toLowerCase());
    const b = Buffer.from(f.bytes, "base64");
    size += b.length;
    if (
      b.length > 32 * 1024 * 1024 ||
      size > 100 * 1024 * 1024 ||
      b.toString("base64") !== f.bytes ||
      digest(b) !== f.sha256
    )
      fail();
    const parent = f.path.includes("/")
      ? f.path.slice(0, f.path.lastIndexOf("/"))
      : null;
    if (parent && !dirs.has(parent)) fail();
  }
  if (inventory(value.tree) !== receipt.inventory_sha256) fail();
  for (const p of [
    "PG_VERSION",
    "global/pg_control",
    "postgresql.conf",
    "pg_hba.conf",
  ]) {
    if (!value.tree.files.some((f) => f.path === p)) fail();
  }
  for (const d of [
    "base",
    "global",
    "pg_wal",
    "pg_xact",
    "pg_multixact",
    "pg_tblspc",
  ]) {
    if (!dirs.has(d)) fail();
  }
  if (
    value.tree.files.some(
      (f) => f.path === "postmaster.pid" || f.path.startsWith("pg_tblspc/"),
    ) ||
    value.tree.directories.some((d) => d.startsWith("pg_tblspc/"))
  )
    fail();
  return value;
}
export async function encryptPhysical(value, recipient, receipt) {
  physicalOnly();
  validateArchive(value, receipt);
  const plain = Buffer.from(JSON.stringify(value));
  if (plain.length > expandedLimit) fail();
  const zipped = gzipSync(plain);
  if (zipped.length > compressedLimit) fail();
  const ciphertext = await privateProcess(
    ageExe,
    ["encrypt", recipient],
    zipped,
    compressedLimit,
    { DARKPOOL_BACKUP_SYNTHETIC: "1" },
  );
  return {
    ciphertext,
    receipt: { ...receipt, ciphertext_sha256: digest(ciphertext) },
  };
}
export async function decryptPhysical(ciphertext, key, receipt) {
  physicalOnly();
  if (
    ciphertext.length > compressedLimit ||
    digest(ciphertext) !== receipt.ciphertext_sha256 ||
    typeof key !== "string" ||
    key.length < 1 ||
    key.length > 128
  )
    fail();
  const encoded = Buffer.from(key),
    n = Buffer.alloc(4);
  n.writeUInt32BE(encoded.length);
  const bytes = await privateProcess(
    ageExe,
    ["decrypt"],
    Buffer.concat([n, encoded, ciphertext]),
    compressedLimit,
    { DARKPOOL_BACKUP_SYNTHETIC: "1" },
  );
  let value;
  try {
    value = JSON.parse(
      gunzipSync(bytes, { maxOutputLength: expandedLimit }).toString("utf8"),
    );
  } catch {
    fail();
  }
  return validateArchive(value, receipt);
}
export class PhysicalFixture {
  constructor() {
    physicalOnly();
    this.nonce = randomBytes(16).toString("hex");
    this.roots = [];
    this.created = [];
    this.running = null;
    this.initialized = false;
    this.restoreStarted = false;
  }
  async create() {
    for (let i = 0; i < 3; i++) {
      const root = join(
        tmpdir(),
        "darkpool-backup-fixture-" + randomBytes(16).toString("hex"),
      );
      await ps("backup-fixture-storage.ps1", [
        "-Action",
        "create",
        "-Directory",
        root,
      ]);
      this.created.push({ root, identity: await identity(root) });
      this.roots.push(root);
      await writeFile(join(root, "owner-nonce"), this.nonce, { flag: "wx" });
    }
    this.root = this.roots[0];
    this.source = join(this.root, "source", "data");
    this.restored = join(this.root, "restored", "data");
    this.lease = await open(join(this.root, "controller.lock"), "wx");
    this.port = await freePort();
    this.database = "darkpool_physical_" + this.nonce.slice(0, 16);
    this.roles = Object.fromEntries(
      ["admin", "owner", "read"].map((p) => [
        p,
        `darkpool_physical_${p}_${this.nonce.slice(0, 16)}`,
      ]),
    );
    this.credentials = Object.keys(this.roles).map((p) => ({
      purpose: p,
      login: this.roles[p],
      password: randomBytes(32).toString("hex"),
    }));
    this.currentCredentials = this.credentials;
    scopes.set(this, scope(this));
    await mkdir(dirname(this.source));
    const pw = join(this.root, "bootstrap.password");
    await writeFile(pw, this.password("admin") + "\n", { flag: "wx" });
    try {
      await this.native("initdb", [
        "-D",
        this.source,
        "-U",
        this.roles.admin,
        "--pwfile=" + pw,
        "--auth-host=scram-sha-256",
        "--auth-local=scram-sha-256",
        "--encoding=UTF8",
        "--locale=C",
        "--wal-segsize=1",
      ]);
    } finally {
      await rm(pw, { force: true });
    }
    this.systemId = (await readFile(join(this.source, "global", "pg_control")))
      .readBigUInt64LE()
      .toString();
    this.initialized = true;
    this.config = `listen_addresses='127.0.0.1'\nport=${this.port}\nmax_connections=12\nshared_buffers='16MB'\nwal_level=minimal\nmax_wal_senders=0\nmin_wal_size='2MB'\nmax_wal_size='16MB'\nfsync=on\nsynchronous_commit=on\nfull_page_writes=on\ntimezone='UTC'\npassword_encryption='scram-sha-256'\nlog_statement='none'\nlog_min_error_statement='panic'\nlog_error_verbosity='terse'\nlog_connections=''\nlog_disconnections=off\n`;
    await writeFile(join(this.source, "postgresql.conf"), this.config);
    await writeFile(
      join(this.source, "pg_hba.conf"),
      "host all all 127.0.0.1/32 scram-sha-256\n",
    );
    this.marker = JSON.stringify({
      profile: "DISPOSABLE_PHYSICAL_TEST",
      nonce: this.nonce,
      system_identifier: this.systemId,
      port: this.port,
      database: this.database,
    });
    this.sourceDirectoryIdentity = await identity(this.source);
    await this.start("source");
    await this.sql(
      "source",
      `COMMENT ON DATABASE postgres IS ${quote(this.marker)};`,
      "admin",
      "postgres",
      true,
    );
    this.markerWritten = true;
    return this;
  }
  password(p) {
    const c = this.currentCredentials?.find((c) => c.purpose === p);
    if (!c || c.login !== this.roles[p] || !/^[a-f0-9]{64}$/.test(c.password))
      fail();
    return c.password;
  }
  async owned() {
    physicalOnly();
    if (!this.lease || scopes.get(this) !== scope(this)) fail();
    for (const record of this.created) {
      if (
        dirname(resolve(record.root)).toLowerCase() !==
          resolve(tmpdir()).toLowerCase() ||
        !/^darkpool-backup-fixture-[a-f0-9]{32}$/.test(basename(record.root)) ||
        !same(await identity(record.root), record.identity) ||
        (await readFile(join(record.root, "owner-nonce"), "utf8")) !==
          this.nonce
      )
        fail();
    }
  }
  async native(name, args, input = Buffer.alloc(0), extra = {}) {
    await this.owned();
    if (
      !["initdb", "psql", "pg_ctl", "pg_controldata", "pg_checksums"].includes(
        name,
      )
    )
      fail();
    if (name === "psql") {
      if (
        extra.PGHOST !== "127.0.0.1" ||
        extra.PGPORT !== String(this.port) ||
        !["postgres", this.database].includes(extra.PGDATABASE) ||
        !Object.values(this.roles).includes(extra.PGUSER)
      )
        fail();
    } else {
      const at = args.indexOf("-D");
      if (at < 0 || ![this.source, this.restored].includes(args[at + 1]))
        fail();
      if (name === "initdb" && args[at + 1] !== this.source) fail();
      if (
        name === "pg_ctl" &&
        !args.some((a) => ["status", "stop"].includes(a))
      )
        fail();
      if (name === "pg_checksums" && args[0] !== "--check") fail();
    }
    return privateProcess(exe(name), args, input, 1024 * 1024, {
      ...extra,
      LC_ALL: "C",
    });
  }
  async control(which) {
    await this.owned();
    const data = this[which];
    if (![this.source, this.restored].includes(data)) fail();
    if (
      (await readFile(join(data, "global", "pg_control")))
        .readBigUInt64LE()
        .toString() !== this.systemId
    )
      fail();
    const text = (await this.native("pg_controldata", ["-D", data])).toString();
    const state = /Database cluster state:\s*([^\r\n]+)/
      .exec(text)?.[1]
      ?.trim();
    if (!state) fail();
    return { state, text };
  }
  async status(which) {
    await this.control(which);
    try {
      await this.native("pg_ctl", ["-D", this[which], "status"]);
      return true;
    } catch (e) {
      if (e.exitCode === 3) return false;
      throw e;
    }
  }
  async sql(
    which,
    sql,
    purpose = "admin",
    database = this.database,
    bootstrap = false,
  ) {
    await this.owned();
    await this.control(which);
    if (
      !["source", "restored"].includes(which) ||
      ![this.database, "postgres"].includes(database) ||
      this.running !== which
    )
      fail();
    const ack = "physical_ack_" + randomBytes(24).toString("hex");
    const guard = `DO $guard$ BEGIN IF current_database()<>${quote(database)} OR session_user<>${quote(this.roles[purpose])} OR current_user<>session_user OR inet_server_port()<>${this.port}${purpose === "admin" ? ` OR current_setting('data_directory')<>${quote(this[which].replaceAll("\\", "/"))} OR (SELECT system_identifier::text FROM pg_control_system())<>${quote(this.systemId)}` : ""}${bootstrap ? "" : ` OR shobj_description((SELECT oid FROM pg_database WHERE datname='postgres'),'pg_database') IS DISTINCT FROM ${quote(this.marker)}`} THEN RAISE EXCEPTION 'physical identity mismatch'; END IF; END $guard$;`;
    const out = await this.native(
      "psql",
      [
        "--no-psqlrc",
        "--no-password",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        "VERBOSITY=sqlstate",
        "--dbname",
        database,
      ],
      Buffer.from(
        `SET statement_timeout='15s'; SET synchronous_commit=on; SET TIME ZONE 'UTC';\n${guard}\n${sql}\n;SELECT '${ack}';`,
      ),
      {
        PGHOST: "127.0.0.1",
        PGPORT: String(this.port),
        PGDATABASE: database,
        PGUSER: this.roles[purpose],
        PGPASSWORD: this.password(purpose),
        PGCONNECT_TIMEOUT: "3",
        PGCLIENTENCODING: "UTF8",
      },
    );
    const lines = out.toString().trim().split(/\r?\n/);
    if (lines.pop() !== ack) fail();
    return lines.join("\n");
  }
  async start(which) {
    await this.owned();
    if (!["source", "restored"].includes(which) || this.running) fail();
    await storage("check", this.root);
    if (
      (await this.control(which)).state !== "shut down" ||
      (await this.status(which))
    )
      fail();
    const other = which === "source" ? "restored" : "source";
    try {
      if (await this.status(other)) fail();
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (
      (await readFile(join(this[which], "postgresql.conf"), "utf8")) !==
      this.config
    )
      fail();
    await freePort(this.port);
    const result = await runBounded(
      exe("pg_ctl"),
      [
        "-D",
        this[which],
        "-l",
        join(this.root, which + ".log"),
        "-t",
        "20",
        "-w",
        "start",
      ],
      { timeoutMs: 30000, allowInheritedOutputAfterExit: true, env: osEnv() },
    );
    // An unknown start is never automatically retried or reported successful.
    if (boundedExit(result) !== 0) fail();
    this.running = which;
  }
  async stop(which) {
    await this.owned();
    if (this.running !== which) fail();
    await this.sql(
      which,
      "SELECT 1;",
      "admin",
      "postgres",
      !this.markerWritten,
    );
    await this.native("pg_ctl", [
      "-D",
      this[which],
      "-m",
      "fast",
      "-t",
      "20",
      "-w",
      "stop",
    ]);
    if (
      (await this.status(which)) ||
      (await this.control(which)).state !== "shut down"
    )
      fail();
    this.running = null;
    await freePort(this.port);
  }
  async seed(commitment) {
    // SCRAM verifiers are generated by PostgreSQL; SQL/passwords remain private pipes.
    await this.sql(
      "source",
      ["owner", "read"]
        .map(
          (p) =>
            `CREATE ROLE "${this.roles[p]}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quote(this.password(p))};`,
        )
        .join("\n"),
      "admin",
      "postgres",
    );
    await this.sql(
      "source",
      `CREATE DATABASE "${this.database}" OWNER "${this.roles.owner}" TEMPLATE template0 ENCODING 'UTF8';`,
      "admin",
      "postgres",
    );
    await this.sql(
      "source",
      `REVOKE ALL ON DATABASE "${this.database}" FROM PUBLIC;GRANT CONNECT ON DATABASE "${this.database}" TO "${this.roles.owner}","${this.roles.read}";CREATE SCHEMA recovery_probe AUTHORIZATION "${this.roles.owner}";REVOKE ALL ON SCHEMA public FROM PUBLIC;`,
    );
    const oid = await this.sql(
      "source",
      "SELECT oid FROM pg_database WHERE datname=current_database();",
    );
    const bound = {
      profile: "NONFINANCIAL_PHYSICAL_FIXTURE",
      nonce: this.nonce,
      system_identifier: this.systemId,
      database_oid: oid,
      source_directory: this.source,
      source_directory_identity: this.sourceDirectoryIdentity,
      commitment,
    };
    await this.sql(
      "source",
      `CREATE TABLE recovery_probe.private_state(value jsonb NOT NULL);INSERT INTO recovery_probe.private_state VALUES(${json(bound)});REVOKE ALL ON SCHEMA recovery_probe FROM PUBLIC;REVOKE ALL ON recovery_probe.private_state FROM PUBLIC;CREATE VIEW recovery_probe.safe_summary AS SELECT value->'commitment'->'public' AS commitment FROM recovery_probe.private_state;GRANT USAGE ON SCHEMA recovery_probe TO "${this.roles.read}";GRANT SELECT ON recovery_probe.safe_summary TO "${this.roles.read}";`,
      "owner",
    );
    this.expected = await this.summary("source");
    return bound;
  }
  async summary(which) {
    return JSON.parse(
      await this.sql(
        which,
        `SELECT jsonb_build_object('system_identifier',(SELECT system_identifier::text FROM pg_control_system()),'database_oid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'database_acl',(SELECT datacl::text FROM pg_database WHERE datname=current_database()),'roles',(SELECT jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolcreaterole,rolcreatedb,rolinherit,rolbypassrls,rolpassword) ORDER BY rolname) FROM pg_authid WHERE rolname IN (${Object.values(this.roles).map(quote).join(",")})),'schema',(SELECT jsonb_agg(jsonb_build_array(oid,nspname,nspowner,nspacl::text) ORDER BY nspname) FROM pg_namespace WHERE nspname IN ('public','recovery_probe')),'relations',(SELECT jsonb_agg(jsonb_build_array(c.oid,c.relname,c.relowner,c.relacl::text) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='recovery_probe'),'data',(SELECT value FROM recovery_probe.private_state));`,
      ),
    );
  }
  async backup() {
    await this.owned();
    if (
      this.running ||
      (await this.status("source")) ||
      (await this.control("source")).state !== "shut down"
    )
      fail();
    await storage("check", this.root);
    const tree = await scanTree(this.source);
    if (
      (await this.status("source")) ||
      (await this.control("source")).state !== "shut down"
    )
      fail();
    const receipt = {
      nonce: this.nonce,
      system_identifier: this.systemId,
      inventory_sha256: inventory(tree),
    };
    const value = {
      profile: "DISPOSABLE_COLD_CLUSTER_AGE_V1",
      nonce: this.nonce,
      system_identifier: this.systemId,
      state: "shut down",
      credentials: this.currentCredentials,
      expected: this.expected,
      tree,
    };
    const key = await syntheticKeyPair();
    const encrypted = await encryptPhysical(value, key.recipient, receipt);
    await durableWrite(
      join(this.roots[1], "cluster.age"),
      encrypted.ciphertext,
    );
    await durableWrite(join(this.roots[2], "recovery.identity"), key.identity);
    this.receipt = encrypted.receipt;
    this.credentials = null;
    return encrypted;
  }
  async restore() {
    await this.owned();
    if (this.running || (await this.status("source"))) fail();
    const value = await decryptPhysical(
      await readFile(join(this.roots[1], "cluster.age")),
      await readFile(join(this.roots[2], "recovery.identity"), "utf8"),
      this.receipt,
    );
    this.currentCredentials = value.credentials;
    await mkdir(dirname(this.restored));
    await mkdir(this.restored);
    for (const d of [...value.tree.directories].sort(
      (a, b) => a.split("/").length - b.split("/").length,
    ))
      await mkdir(inRoot(this.restored, join(this.restored, ...d.split("/"))));
    for (const f of value.tree.files) {
      const path = inRoot(
        this.restored,
        join(this.restored, ...f.path.split("/")),
      );
      const file = await open(path, "wx");
      try {
        await file.writeFile(Buffer.from(f.bytes, "base64"));
        await file.sync();
      } finally {
        await file.close();
      }
    }
    await storage("check", this.root);
    if (
      inventory(await scanTree(this.restored)) !== this.receipt.inventory_sha256
    )
      fail();
    if ((await this.control("restored")).state !== "shut down") fail();
    return value;
  }
  async cleanup() {
    if (!this.created.length) return { cleaned: true };
    try {
      await this.owned();
      for (const which of ["source", "restored"]) {
        try {
          if (await this.status(which)) {
            this.running = which;
            await this.stop(which);
          }
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
      }
      for (const record of this.created) await storage("check", record.root);
      await this.lease.close();
      this.lease = null;
      for (const record of this.created) {
        if (!same(await identity(record.root), record.identity)) fail();
        // Native filesystem removal only, with exact owned absolute roots checked.
        await rm(record.root, { recursive: true, force: false });
      }
      return { cleaned: true };
    } catch {
      return {
        cleaned: false,
        roots: this.created.map((r) => r.root),
        system_identifier: this.systemId ?? "UNKNOWN",
        port: this.port ?? null,
      };
    }
  }
}
