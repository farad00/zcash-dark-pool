// Evidence reader only. Never imports application modules, launches suites, or opens databases/wallets.
import { readFile, lstat, realpath, open, mkdir } from "node:fs/promises";
import { resolve, relative, dirname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { validateCompletionProof } from "./phase9-focused-completion-v2.mjs";
import {
  validateCompletionProof as validateCompletionV3,
  utcAnomalies,
  nativeTime as nativeAuditTime,
} from "./phase9-focused-completion-v3.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MANIFEST = "scripts/validation/phase9-focused-v1.json";
export const REQUIREMENTS = Object.freeze([
  "target-isolation",
  "signer-watcher-separation",
  "fresh-orchard-issuance",
  "exact-zip321",
  "canonical-output-matching",
  "three-confirmations",
  "integer-stake",
  "replay-prevention",
  "reorg-safety-hold",
  "schema-privileges",
  "admin-public-isolation",
  "vault-bearer-backup",
]);
export const NODE_FILES = Object.freeze([
  "db/test/environment.test.mjs",
  "db/test/target-registry.test.mjs",
  "db/test/public-reader-runtime.test.mjs",
  "db/test/initializer.test.mjs",
  "db/test/server-start.test.mjs",
  "db/test/evidence-wrapper.test.mjs",
  "services/watcher/test/watcher.test.mjs",
  "db/test/watcher.test.mjs",
  "db/test/schema.test.mjs",
  "apps/web/test/admin.test.mjs",
  "apps/web/test/issuance.test.mjs",
  "apps/web/test/public-db.test.mjs",
  "apps/web/test/payment-request.test.mjs",
  "apps/web/test/public.test.mjs",
  "apps/web/test/boundary.test.mjs",
  "apps/web/test/vault.test.mjs",
  "apps/web/test/vault-browser.test.mjs",
  "apps/web/test/ticket-backup.test.mjs",
  "packages/protocol/test/claim-commitment.test.mjs",
  "packages/protocol/test/domain.test.mjs",
  "packages/protocol/test/money.test.mjs",
  "packages/protocol/test/secrets.test.mjs",
]);
const RUST_FILES = Object.freeze({
  "services/zcash/src/lib.rs": "tests",
  "services/zcash/src/issuance.rs": "issuance::tests",
  "services/zcash/src/payment_request.rs": "payment_request::tests",
  "services/zcash/src/live_target.rs": "live_target::tests",
  "services/zcash/src/watcher.rs": "watcher::tests",
  "services/zcash/src/watcher_close.rs": "watcher::close::tests",
  "services/zcash/src/watcher_progress.rs": "watcher::progress::tests",
  "services/zcash/src/watcher_sync_tests.rs": "watcher::sync_tests",
  "services/zcash/src/watcher_connect_tests.rs": "watcher::connect::tests",
});
export const EXCLUDED_RUST = Object.freeze(
  [
    "cli_requires_no_context_and_ignores_fake_wallet_and_pg_inputs",
    "missing_or_extra_arguments_are_closed_without_environment",
    "typed_errors_preserve_only_closed_class_and_genuine_grpc_code",
    "unavailable_local_endpoint_naturally_fails_with_closed_output",
    "wrapper_deadline_kills_stalled_tls_without_inventing_rpc_timeout",
    "wrapper_natural_failure_is_distinct_from_outer_timeout",
  ].map((n) => "watcher::connect::tests::" + n),
);
const HASH = /^[a-f0-9]{64}$/;
const error = (code) => {
  throw new Error(code);
};
const requireValue = (v, code) => {
  if (!v) error(code);
};
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
const same = (a, b) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const unique = (a) => Array.isArray(a) && new Set(a).size === a.length;
const sameSet = (a, b) =>
  unique(a) &&
  unique(b) &&
  a.length === b.length &&
  a.every((n) => b.includes(n));
function keys(o, required, optional = []) {
  requireValue(
    o &&
      typeof o === "object" &&
      !Array.isArray(o) &&
      required.every((k) => Object.hasOwn(o, k)) &&
      Object.keys(o).every((k) => [...required, ...optional].includes(k)),
    "E_SCHEMA",
  );
}
function safeRelative(p) {
  requireValue(
    typeof p === "string" &&
      /^[a-zA-Z0-9_./-]+$/.test(p) &&
      !isAbsolute(p) &&
      !p.includes("\\") &&
      !p.split("/").some((s) => !s || s === "." || s === ".."),
    "E_PATH",
  );
  return p;
}
async function ordinary(root, p) {
  const base = await realpath(root),
    target = resolve(base, safeRelative(p));
  requireValue(
    relative(base, target) && !relative(base, target).startsWith(".."),
    "E_PATH",
  );
  for (let cursor = target; cursor !== base; cursor = dirname(cursor)) {
    const s = await lstat(cursor);
    requireValue(!s.isSymbolicLink(), "E_REDIRECT");
    requireValue(
      (await realpath(cursor)).toLowerCase() === cursor.toLowerCase(),
      "E_REDIRECT",
    );
  }
  requireValue((await lstat(target)).isFile(), "E_FILE");
  return target;
}
async function boundedRead(root, p, max = 16777216) {
  const file = await ordinary(root, p);
  requireValue((await lstat(file)).size <= max, "E_SIZE");
  return readFile(file);
}

// Static registration inventory: parse syntax only; never import/evaluate a test body.
export function nodeInventory(text) {
  const source = ts.createSourceFile(
    "inventory.mjs",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  requireValue(source.parseDiagnostics.length === 0, "E_TEST_SYNTAX");
  const names = [];
  function value(n, env) {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
      return n.text;
    if (ts.isNumericLiteral(n)) return Number(n.text);
    if (ts.isIdentifier(n) && Object.hasOwn(env, n.text)) return env[n.text];
    if (ts.isTemplateExpression(n))
      return (
        n.head.text +
        n.templateSpans
          .map((s) => String(value(s.expression, env)) + s.literal.text)
          .join("")
      );
    error("E_DYNAMIC_TEST_NAME");
  }
  function visit(n, env = {}) {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "test"
    ) {
      const name = value(n.arguments[0], env);
      requireValue(
        typeof name === "string" && name.length > 0 && !/[\r\n\0]/.test(name),
        "E_TEST_NAME",
      );
      names.push(name);
      return; // Tests inside callbacks cannot masquerade as top-level coverage.
    }
    if (ts.isFunctionLike(n)) return;
    if (ts.isForOfStatement(n)) {
      const registered = n.statement.getText(source).includes("test(");
      if (!registered) return;
      requireValue(
        ts.isArrayLiteralExpression(n.expression),
        "E_DYNAMIC_TEST_LOOP",
      );
      const binding = n.initializer.declarations?.[0]?.name;
      for (const item of n.expression.elements) {
        const first = ts.isArrayBindingPattern(binding)
          ? binding.elements[0]?.name
          : binding;
        requireValue(first && ts.isIdentifier(first), "E_DYNAMIC_TEST_LOOP");
        const element = ts.isArrayBindingPattern(binding)
          ? item.elements?.[0]
          : item;
        visit(n.statement, { ...env, [first.text]: value(element, env) });
      }
      return;
    }
    ts.forEachChild(n, (child) => visit(child, env));
  }
  visit(source);
  requireValue(names.length && unique(names), "E_TEST_INVENTORY");
  return names;
}
export async function rustInventory(root = ROOT) {
  const names = [];
  for (const [file, prefix] of Object.entries(RUST_FILES)) {
    const source = (await boundedRead(root, file)).toString("utf8");
    for (const match of source.matchAll(
      /#\[(?:tokio::)?test(?:\([^\]]*\))?\]\s*(?:#\[[^\]]+\]\s*)*(?:async\s+)?fn\s+([a-zA-Z0-9_]+)/g,
    ))
      names.push(prefix + "::" + match[1]);
    if (prefix === "watcher::sync_tests")
      for (const match of source.matchAll(
        /snapshot_guard_test!\(\s*([a-zA-Z0-9_]+),/g,
      ))
        names.push(prefix + "::" + match[1]);
  }
  requireValue(unique(names) && names.length === 72, "E_RUST_INVENTORY");
  return names.sort();
}
export async function captureSource(root = ROOT) {
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      maxBuffer: 16777216,
    });
  const files = [
    ...new Set(
      git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  const inventory = {};
  for (const p of files) inventory[p] = sha256(await boundedRead(root, p));
  return {
    revision: git(["rev-parse", "HEAD"]).trim(),
    dirty_worktree_sha256: sha256(
      JSON.stringify({
        status: git(["status", "--porcelain=v1", "-z"]),
        staged: sha256(git(["diff", "--cached", "--binary"])),
        inventory,
      }),
    ),
  };
}

export async function validateManifest(m, root = ROOT) {
  keys(m, [
    "version",
    "id",
    "requirements",
    "stages",
    "excluded_rust",
    "source_pins",
    "environment_policy",
    "preservation_groups",
    "outside_scope",
  ]);
  requireValue(
    m.version === 1 &&
      m.id === "phase9-focused-v1" &&
      sameSet(m.requirements, REQUIREMENTS) &&
      sameSet(
        m.excluded_rust.map((e) => e.identity),
        EXCLUDED_RUST,
      ),
    "E_MANIFEST_ID",
  );
  requireValue(
    m.excluded_rust.every(
      (e) => typeof e.reason === "string" && e.reason.length > 20,
    ),
    "E_EXCLUSION",
  );
  requireValue(
    m.environment_policy.test_only === true &&
      m.environment_policy.live_authorization === false &&
      m.environment_policy.test.system_identifier === "7697541254856017064" &&
      m.environment_policy.test.cluster_id ===
        "8a0bf1f9-e2e5-4af4-b449-90ab32d950af" &&
      m.environment_policy.old_live.system_identifier ===
        "7697706083887339692" &&
      m.environment_policy.old_live.cluster_id ===
        "0c39a4b7-f37f-4fde-b81d-502d61724e52",
    "E_ENV_POLICY",
  );
  requireValue(
    m.stages.length > 20 && unique(m.stages.map((s) => s.id)),
    "E_STAGES",
  );
  const prior = [],
    nodeFiles = [],
    rustNames = [],
    tags = new Set();
  const rustAll = await rustInventory(root);
  const prep = {
    "build-rust": [
      "cargo",
      "build",
      "--workspace",
      "--bins",
      "--examples",
      "--locked",
      "--offline",
    ],
    "build-web": ["npm.cmd", "run", "build:web"],
    "protocol-types": [
      "node",
      "node_modules/typescript/bin/tsc",
      "-p",
      "packages/protocol/tsconfig.types.json",
    ],
  };
  for (const s of m.stages) {
    keys(s, [
      "id",
      "kind",
      "command",
      "depends_on",
      "expected_tests",
      "requirements",
      "expected_assertions",
      "reason",
      "environment",
      "source_file",
    ]);
    requireValue(
      /^[a-z][a-z0-9-]+$/.test(s.id) &&
        Array.isArray(s.command) &&
        s.command.every((x) => typeof x === "string") &&
        unique(s.expected_tests) &&
        unique(s.depends_on) &&
        s.depends_on.every((id) => prior.includes(id)) &&
        s.expected_assertions.length > 0 &&
        s.reason.length > 20 &&
        s.requirements.every((t) => REQUIREMENTS.includes(t)) &&
        s.environment === "TEST_ONLY",
      "E_STAGE_SCHEMA",
    );
    for (const t of s.requirements) tags.add(t);
    if (s.kind === "node-tap") {
      requireValue(
        NODE_FILES.includes(s.source_file) &&
          same(s.command, [
            "node",
            "--test",
            "--test-concurrency=1",
            "--test-reporter=tap",
            s.source_file,
          ]),
        "E_COMMAND",
      );
      const actual = nodeInventory(
        (await boundedRead(root, s.source_file)).toString("utf8"),
      );
      requireValue(sameSet(s.expected_tests, actual), "E_NODE_COVERAGE");
      nodeFiles.push(s.source_file);
    } else if (s.kind === "rust-libtest") {
      const filter = s.source_file;
      const exact = !filter.endsWith("::");
      const command = [
        "cargo",
        "test",
        "-p",
        "darkpool-zcash",
        "--lib",
        "--locked",
        "--offline",
        filter,
        "--",
        ...(exact ? ["--exact"] : []),
        "--test-threads=1",
        "--format=pretty",
        "--color=never",
      ];
      requireValue(same(s.command, command), "E_COMMAND");
      const selected = rustAll.filter((n) =>
        exact ? n === filter : n.includes(filter),
      );
      requireValue(
        selected.length && sameSet(selected, s.expected_tests),
        "E_RUST_COVERAGE",
      );
      rustNames.push(...s.expected_tests);
    } else {
      requireValue(
        s.kind === "build" &&
          Object.hasOwn(prep, s.id) &&
          same(s.command, prep[s.id]) &&
          s.expected_tests.length === 0,
        "E_COMMAND",
      );
    }
    if (prior.length)
      requireValue(s.depends_on.includes(prior.at(-1)), "E_ORDER");
    prior.push(s.id);
  }
  requireValue(
    Object.keys(prep).every((id) => prior.includes(id)),
    "E_BUILD_COVERAGE",
  );
  requireValue(
    sameSet(nodeFiles, NODE_FILES) &&
      sameSet(
        rustNames,
        rustAll.filter((n) => !EXCLUDED_RUST.includes(n)),
      ) &&
      sameSet([...tags], REQUIREMENTS),
    "E_COVERAGE",
  );
  const pins = Object.entries(m.source_pins);
  requireValue(
    pins.length >= 175 &&
      NODE_FILES.every((p) => Object.hasOwn(m.source_pins, p)) &&
      Object.keys(RUST_FILES).every((p) => Object.hasOwn(m.source_pins, p)) &&
      ["Cargo.lock", "package-lock.json", "db/target-identities.json"].every(
        (p) => Object.hasOwn(m.source_pins, p),
      ),
    "E_PINS",
  );
  for (const [p, digest] of pins)
    requireValue(
      HASH.test(digest) && sha256(await boundedRead(root, p)) === digest,
      "E_SOURCE_PIN",
    );
  requireValue(
    same(m.preservation_groups, {
      historical_database: 431,
      historical_artifacts: 241,
      old_live_wallet_evidence: 49,
      protected_pg: 13,
      private_snapshots: 22,
      bearer_backup: 1,
      test_profile_marker: 2,
      audit_support: 1342,
    }),
    "E_PRESERVATION_POLICY",
  );
  return {
    stages: m.stages.length,
    tests: m.stages.reduce((n, s) => n + s.expected_tests.length, 0),
    rust_tests: rustNames.length,
    node_files: nodeFiles.length,
  };
}

// Strict top-level TAP: aggregate PASS alone never supplies identities.
export function parseTap(text, expected) {
  requireValue(typeof text === "string" && text.length <= 16777216, "E_LOG");
  const cases = [],
    summaries = {},
    subtests = [];
  let version = 0,
    plan,
    yaml = false;
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    if (!line.trim()) continue;
    if (line === "TAP version 13") {
      requireValue(++version === 1, "E_TAP_VERSION");
      continue;
    }
    if (line === "  ---") {
      requireValue(!yaml, "E_TAP_YAML");
      yaml = true;
      continue;
    }
    if (yaml) {
      if (line === "  ...") yaml = false;
      continue;
    }
    let x;
    if ((x = /^# Subtest: (.+)$/.exec(line))) {
      subtests.push(x[1].replaceAll("\\#", "#"));
      continue;
    }
    if ((x = /^(not ok|ok) ([0-9]+) - (.+)$/.exec(line))) {
      const skipped = / # (?:SKIP|TODO)\b/i.test(x[3]);
      const name = x[3]
        .replace(/ # (?:SKIP|TODO)\b.*$/i, "")
        .replaceAll("\\#", "#");
      requireValue(
        Number(x[2]) === cases.length + 1 &&
          expected.includes(name) &&
          !cases.some((c) => c.name === name),
        "E_TAP_IDENTITY",
      );
      cases.push({
        name,
        status: skipped ? "NOT RUN" : x[1] === "ok" ? "PASS" : "FAIL",
      });
      continue;
    }
    if ((x = /^1\.\.([0-9]+)$/.exec(line))) {
      requireValue(plan === undefined, "E_TAP_PLAN");
      plan = Number(x[1]);
      continue;
    }
    if (
      (x = /^# (tests|suites|pass|fail|cancelled|skipped|todo) ([0-9]+)$/.exec(
        line,
      ))
    ) {
      requireValue(!Object.hasOwn(summaries, x[1]), "E_TAP_SUMMARY");
      summaries[x[1]] = Number(x[2]);
      continue;
    }
    requireValue(
      line.startsWith("# ") &&
        !/^# (?:tests|suites|pass|fail|cancelled|skipped|todo)\b/.test(line),
      "E_TAP_GRAMMAR",
    );
  }
  requireValue(
    !yaml &&
      version === 1 &&
      plan === expected.length &&
      cases.length === plan &&
      sameSet(
        cases.map((c) => c.name),
        expected,
      ) &&
      sameSet(subtests, expected) &&
      ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"].every(
        (k) => Number.isSafeInteger(summaries[k]),
      ) &&
      summaries.tests === plan &&
      summaries.suites === 0 &&
      summaries.pass +
        summaries.fail +
        summaries.cancelled +
        summaries.skipped +
        summaries.todo ===
        plan &&
      summaries.pass === cases.filter((c) => c.status === "PASS").length,
    "E_TAP_ACCOUNTING",
  );
  return {
    cases,
    pass:
      cases.every((c) => c.status === "PASS") &&
      summaries.fail === 0 &&
      summaries.cancelled === 0 &&
      summaries.skipped === 0 &&
      summaries.todo === 0,
  };
}
export function parseRust(text, expected) {
  requireValue(typeof text === "string" && text.length <= 16777216, "E_LOG");
  const cases = [];
  let running = false,
    ended = false,
    declared,
    summary,
    failureSection = false;
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    if (!line.trim()) continue;
    let x;
    if ((x = /^running ([0-9]+) tests?$/.exec(line))) {
      requireValue(!running && !ended, "E_RUST_RUNNING");
      running = true;
      declared = Number(x[1]);
      continue;
    }
    if (
      (x =
        /^test ([A-Za-z_][A-Za-z0-9_:]*) has been running for over [0-9]+ seconds$/.exec(
          line,
        ))
    ) {
      requireValue(
        running &&
          expected.includes(x[1]) &&
          !cases.some((c) => c.name === x[1]),
        "E_RUST_NOTICE",
      );
      continue;
    }
    if (
      (x =
        /^test ([A-Za-z_][A-Za-z0-9_:]*) (?:- should panic )?\.\.\. (ok|FAILED|ignored)$/.exec(
          line,
        ))
    ) {
      requireValue(
        running &&
          expected.includes(x[1]) &&
          !cases.some((c) => c.name === x[1]),
        "E_RUST_IDENTITY",
      );
      cases.push({
        name: x[1],
        status:
          x[2] === "ok" ? "PASS" : x[2] === "ignored" ? "NOT RUN" : "FAIL",
      });
      continue;
    }
    if (
      (x =
        /^test result: (ok|FAILED)\. ([0-9]+) passed; ([0-9]+) failed; ([0-9]+) ignored; ([0-9]+) measured; ([0-9]+) filtered out; finished in [0-9.]+s$/.exec(
          line,
        ))
    ) {
      requireValue(running && !ended, "E_RUST_SUMMARY");
      summary = x;
      running = false;
      ended = true;
      continue;
    }
    if (line === "failures:") failureSection = true;
    requireValue(failureSection && !ended, "E_RUST_GRAMMAR");
  }
  requireValue(
    ended &&
      !running &&
      summary &&
      declared === expected.length &&
      sameSet(
        cases.map((c) => c.name),
        expected,
      ) &&
      Number(summary[2]) === cases.filter((c) => c.status === "PASS").length &&
      Number(summary[3]) === cases.filter((c) => c.status === "FAIL").length &&
      Number(summary[4]) ===
        cases.filter((c) => c.status === "NOT RUN").length &&
      Number(summary[5]) === 0 &&
      Number(summary[6]) === 72 - expected.length &&
      (!failureSection || cases.some((c) => c.status === "FAIL")),
    "E_RUST_ACCOUNTING",
  );
  return {
    cases,
    pass:
      !failureSection &&
      summary[1] === "ok" &&
      cases.every((c) => c.status === "PASS"),
  };
}

const CATEGORIES = [
  "historical_database",
  "historical_artifacts",
  "old_live_wallet_evidence",
  "protected_pg",
  "private_snapshots",
  "bearer_backup",
  "test_profile_marker",
  "audit_support",
];
function checkPreservation(p, m) {
  keys(p, ["before", "after"]);
  for (const phase of ["before", "after"]) keys(p[phase], CATEGORIES);
  for (const name of CATEGORIES) {
    for (const phase of ["before", "after"]) {
      const values = p[phase][name];
      requireValue(
        values &&
          typeof values === "object" &&
          !Array.isArray(values) &&
          Object.keys(values).length === m.preservation_groups[name] &&
          Object.entries(values).every(
            ([k, v]) => /^[a-z0-9-]{1,120}$/.test(k) && HASH.test(v),
          ),
        "E_PRESERVATION_INVENTORY",
      );
    }
    requireValue(
      same(
        Object.entries(p.before[name]).sort(),
        Object.entries(p.after[name]).sort(),
      ),
      "E_PRESERVATION_CHANGED",
    );
  }
  return Object.fromEntries(
    CATEGORIES.map((name) => [
      name,
      { status: "PASS", files: Object.keys(p.before[name]).length },
    ]),
  );
}
function checkEnvironments(e, m) {
  keys(e, ["before", "after"]);
  for (const phase of ["before", "after"]) {
    keys(e[phase], ["test", "old_live", "historical", "v2"]);
    for (const [name, port, pid] of [
      ["test", 55433, 24984],
      ["old_live", 55434, 22968],
    ]) {
      const v = e[phase][name];
      keys(v, [
        "system_identifier",
        "cluster_id",
        "port",
        "pid",
        "process_start_utc",
        "path_sha256",
        "executable_sha256",
        "profile_sha256",
        "marker_sha256",
        "evidence_class",
      ]);
      const policy = m.environment_policy[name];
      requireValue(
        v.system_identifier === policy.system_identifier &&
          v.cluster_id === policy.cluster_id &&
          v.port === port &&
          v.pid === pid &&
          Number.isFinite(Date.parse(v.process_start_utc)) &&
          [
            "path_sha256",
            "executable_sha256",
            "profile_sha256",
            "marker_sha256",
          ].every((k) => HASH.test(v[k])) &&
          v.evidence_class === "native-file-observation",
        "E_ENV_IDENTITY",
      );
    }
    keys(e[phase].historical, ["sql_connections", "lifecycle_actions"]);
    keys(e[phase].v2, ["exists", "listener", "created"]);
    requireValue(
      e[phase].historical.sql_connections === 0 &&
        e[phase].historical.lifecycle_actions === 0 &&
        same(e[phase].v2, { exists: false, listener: false, created: false }),
      "E_ENV_BOUNDARY",
    );
  }
  requireValue(same(e.before, e.after), "E_ENV_CHANGED");
  return e.after;
}
function checkOwnership(o) {
  keys(o, [
    "contract_version",
    "root_pid",
    "root_creation_filetime",
    "root_exit_observed",
    "root_exit_utc",
    "root_exit_code",
    "query_succeeded",
    "active_processes",
    "zero_query_utc",
    "tree_completion_verified",
    "cleanup_succeeded",
    "termination_requested",
    "launch",
    "containment",
    "command",
    "accounting",
    "historical",
    "evidence_path",
    "evidence_sha256",
    ...(o?.contract_version === 3 ? ["ordering"] : []),
  ]);
  if (o.contract_version === 3) validateCompletionV3(o);
  else validateCompletionProof(o);
  requireValue(HASH.test(o.evidence_sha256), "E_PROCESS_COMPLETION");
}
export async function reportEvidence(
  m,
  evidence,
  { root = ROOT, evidenceRoot = root, currentSource } = {},
) {
  const result = {
    version: 1,
    manifest_id: m.id,
    evidence_class: "unverified",
    status: "NOT RUN",
    complete_gate: "BLOCKED_UNCHANGED",
    live_authorized: false,
    v2_authorized: false,
    source: null,
    environments: null,
    preservation: { status: "NOT RUN" },
    expected: {
      stages: m.stages.length,
      tests: m.stages.reduce((n, s) => n + s.expected_tests.length, 0),
    },
    actual: {
      stages_executed: 0,
      tests_executed: 0,
      tests_execution_known: true,
      pass: 0,
      fail: 0,
      not_run: 0,
    },
    first_failure: null,
    stages: m.stages.map((s) => ({
      id: s.id,
      status: "NOT RUN",
      expected_tests: s.expected_tests.length,
      cases: s.expected_tests.map((name) => ({ name, status: "NOT RUN" })),
    })),
  };
  let activeRow = null;
  const fail = (code, stage = null) => {
    result.first_failure ??= { code, stage };
    result.status = "FAIL";
  };
  try {
    await validateManifest(m, root);
    keys(evidence, [
      "version",
      "evidence_class",
      "manifest_sha256",
      "source_before",
      "source_after",
      "execution_environment",
      "environments",
      "preservation",
      "stages",
      ...(evidence?.version === 2 ? ["completion_contract"] : []),
    ]);
    requireValue(
      (evidence.version === 1 ||
        (evidence.version === 2 && evidence.completion_contract === 3)) &&
        ["application-evidence", "offline-fixture", "plan-only"].includes(
          evidence.evidence_class,
        ),
      "E_EVIDENCE_CLASS",
    );
    result.evidence_class = evidence.evidence_class;
    requireValue(
      evidence.manifest_sha256 === sha256(await boundedRead(root, MANIFEST)),
      "E_MANIFEST_HASH",
    );
    for (const s of [evidence.source_before, evidence.source_after]) {
      keys(s, ["revision", "dirty_worktree_sha256"]);
      requireValue(
        /^[a-f0-9]{40}$/.test(s.revision) && HASH.test(s.dirty_worktree_sha256),
        "E_SOURCE_SCHEMA",
      );
    }
    requireValue(
      currentSource === undefined ||
        evidence.evidence_class !== "application-evidence",
      "E_SOURCE_OVERRIDE",
    );
    const actualSource = currentSource ?? (await captureSource(root));
    requireValue(
      same(evidence.source_before, evidence.source_after) &&
        same(actualSource, evidence.source_after),
      "E_SOURCE_CHANGED",
    );
    result.source = actualSource;
    requireValue(
      Array.isArray(evidence.stages) &&
        evidence.stages.length <= m.stages.length,
      "E_STAGE_RECORDS",
    );
    if (evidence.evidence_class === "plan-only") {
      requireValue(
        evidence.stages.length === 0 &&
          evidence.environments === null &&
          evidence.preservation === null &&
          evidence.execution_environment === null,
        "E_PLAN_EXECUTION",
      );
    } else {
      requireValue(
        same(evidence.execution_environment, {
          DARKPOOL_PG_ENV: "TEST",
          DARKPOOL_TEST_ONLY: "TEST_ONLY",
          DARKPOOL_LIVE_INSTANCE: null,
          ZCASH_NETWORK: "testnet",
          PGHOST: "127.0.0.1",
          PGPORT: "55433",
          PGUSER: "darkpool_test_maintenance",
          PGDATABASE: "postgres",
          libpq_overrides: [],
        }),
        "E_TEST_EXECUTION_ENVIRONMENT",
      );
      result.execution_environment = evidence.execution_environment;
      result.environments = checkEnvironments(evidence.environments, m);
      result.preservation = {
        status: "PASS",
        evidence_origin:
          "externally supplied hash inventories; not independent native attestation",
        groups: checkPreservation(evidence.preservation, m),
      };
      let lastEnd = -Infinity;
      for (let index = 0; index < evidence.stages.length; index++) {
        requireValue(result.first_failure === null, "E_AFTER_FAILURE");
        const record = evidence.stages[index],
          spec = m.stages[index],
          row = result.stages[index];
        activeRow = row;
        keys(record, [
          "id",
          "command",
          "started_utc",
          "ended_utc",
          "exit_code",
          "stdout",
          "stderr",
          "ownership",
          ...(evidence.version === 2 ? ["handoff"] : []),
        ]);
        requireValue(
          record.id === spec.id && same(record.command, spec.command),
          "E_STAGE_ORDER_COMMAND",
        );
        const start = Date.parse(record.started_utc),
          end = Date.parse(record.ended_utc);
        requireValue(
          Number.isFinite(start) &&
            Number.isFinite(end) &&
            (evidence.version === 2 || (start >= lastEnd && end >= start)) &&
            Number.isInteger(record.exit_code),
          "E_STAGE_TIMING",
        );
        result.actual.stages_executed++;
        const own = record.ownership;
        checkOwnership(own);
        if (evidence.version === 2) {
          requireValue(own.contract_version === 3, "E_COMPLETION_V3_REQUIRED");
          requireValue(
            record.started_utc === own.ordering.events[0].details.utc &&
              record.ended_utc === own.ordering.events.at(-1).details.utc,
            "E_STAGE_JOURNAL_TIMING",
          );
          requireValue(
            own.ordering.stage_id === spec.id ||
              (evidence.evidence_class === "offline-fixture" &&
                own.ordering.stage_id === "offline:" + own.command[1]),
            "E_STAGE_JOURNAL_BINDING",
          );
          const h = record.handoff;
          keys(h, [
            "index",
            "stage_id",
            "previous",
            "request_path",
            "request_sha256",
            "worker",
            "observer_session_id",
            "proof_sha256",
          ]);
          keys(h.worker, ["pid", "exit_code", "signal"]);
          requireValue(
            h.index === index &&
              h.stage_id === spec.id &&
              h.worker.pid === own.ordering.observer_pid &&
              h.worker.exit_code === own.root_exit_code &&
              h.worker.signal === null &&
              h.observer_session_id === own.ordering.session_id &&
              h.proof_sha256 === own.evidence_sha256,
            "E_STAGE_HANDOFF",
          );
          requireValue(
            h.request_path === "request-" + (index + 1) + ".json" &&
              HASH.test(h.request_sha256),
            "E_STAGE_REQUEST",
          );
          const requestBytes = await boundedRead(evidenceRoot, h.request_path),
            request = JSON.parse(requestBytes);
          keys(request, [
            "index",
            "stage_id",
            "command",
            "previous",
            "controller",
          ]);
          keys(request.controller, ["pid", "creation_filetime"]);
          requireValue(
            sha256(requestBytes) === h.request_sha256 &&
              request.index === index &&
              request.stage_id === spec.id &&
              same(request.command, spec.command) &&
              same(request.previous, h.previous) &&
              request.controller.pid === own.ordering.supervisor_pid &&
              request.controller.creation_filetime ===
                own.ordering.supervisor_creation_filetime,
            "E_STAGE_REQUEST",
          );
          requireValue(
            !result.stages
              .slice(0, index)
              .some(
                (s) =>
                  s.ownership?.ordering?.session_id === own.ordering.session_id,
              ),
            "E_STAGE_SESSION_REUSE",
          );
          if (index === 0) requireValue(h.previous === null, "E_STAGE_HANDOFF");
          else {
            const previous = evidence.stages[index - 1],
              link = h.previous;
            keys(link, [
              "stage_id",
              "ownership_sha256",
              "session_id",
              "prefix_path",
              "prefix_sha256",
            ]);
            requireValue(
              link.stage_id === previous.id &&
                link.ownership_sha256 === previous.ownership.evidence_sha256 &&
                link.session_id === previous.ownership.ordering.session_id &&
                link.prefix_path === `prefix-${index}.json` &&
                HASH.test(link.prefix_sha256),
              "E_STAGE_HANDOFF",
            );
            const bytes = await boundedRead(evidenceRoot, link.prefix_path),
              prefix = JSON.parse(bytes);
            requireValue(
              sha256(bytes) === link.prefix_sha256 &&
                prefix.first_failure === null &&
                prefix.manifest_id === m.id &&
                same(prefix.source, result.source) &&
                prefix.actual.stages_executed === index &&
                prefix.preservation.status === "PASS" &&
                same(prefix.environments, result.environments) &&
                prefix.actual.tests_execution_known === true &&
                prefix.actual.tests_executed ===
                  m.stages
                    .slice(0, index)
                    .reduce((n, s) => n + s.expected_tests.length, 0) &&
                prefix.actual.fail === 0 &&
                prefix.stages
                  .slice(0, index)
                  .every((s) => s.status === "PASS") &&
                prefix.stages[index - 1].ownership.evidence_sha256 ===
                  previous.ownership.evidence_sha256,
              "E_STAGE_PREDECESSOR_ACCEPTANCE",
            );
          }
          row.utc_anomalies = utcAnomalies(own);
          if (
            index > 0 &&
            nativeAuditTime(record.started_utc) <
              nativeAuditTime(evidence.stages[index - 1].ended_utc)
          )
            row.utc_anomalies.push({
              kind: "cross_stage_utc_reversal",
              from_utc: evidence.stages[index - 1].ended_utc,
              to_utc: record.started_utc,
            });
        } else
          requireValue(
            own.contract_version === 2,
            "E_COMPLETION_ENVELOPE_VERSION",
          );
        requireValue(
          (same(own.command, spec.command) ||
            (evidence.evidence_class === "offline-fixture" &&
              own.command[0] === "offline-fixture" &&
              own.launch.policy === "offline-fixture-direct-child")) &&
            own.root_exit_code === record.exit_code &&
            (evidence.evidence_class !== "application-evidence" ||
              own.launch.policy === "approved-focused-v1-direct-child"),
          "E_PROCESS_COMMAND_EXIT",
        );
        requireValue(
          evidence.version === 2 ||
            (Date.parse(own.root_exit_utc) >= start &&
              Date.parse(own.zero_query_utc) >= Date.parse(own.root_exit_utc) &&
              Date.parse(own.zero_query_utc) <= end),
          "E_PROCESS_TIMING",
        );
        const nativeBytes = await boundedRead(evidenceRoot, own.evidence_path);
        requireValue(
          sha256(nativeBytes) === own.evidence_sha256,
          "E_PROCESS_ARTIFACT",
        );
        const nativeFields = Object.fromEntries(
          Object.entries(own).filter(
            ([k]) => !["evidence_path", "evidence_sha256"].includes(k),
          ),
        );
        const native = JSON.parse(nativeBytes.toString("utf8"));
        requireValue(same(native, nativeFields), "E_PROCESS_ARTIFACT");
        const logs = {};
        for (const stream of ["stdout", "stderr"]) {
          keys(record[stream], ["path", "sha256"]);
          const bytes = await boundedRead(evidenceRoot, record[stream].path);
          requireValue(
            HASH.test(record[stream].sha256) &&
              sha256(bytes) === record[stream].sha256,
            "E_LOG_HASH",
          );
          logs[stream] = new TextDecoder("utf-8", { fatal: true }).decode(
            bytes,
          );
        }
        row.exit_code = record.exit_code;
        row.ownership = {
          evidence_origin:
            "external native observations; reporter does not supervise",
          ...own,
        };
        if (spec.kind === "build")
          row.status = record.exit_code === 0 ? "PASS" : "FAIL";
        else {
          const parsed =
            spec.kind === "node-tap"
              ? parseTap(logs.stdout, spec.expected_tests)
              : parseRust(logs.stdout, spec.expected_tests);
          row.cases = parsed.cases;
          row.status = parsed.pass && record.exit_code === 0 ? "PASS" : "FAIL";
        }
        lastEnd = end;
        if (row.status !== "PASS") fail("E_STAGE_FAILED", spec.id);
        activeRow = null;
      }
    }
    if (!result.first_failure)
      result.status = result.stages.every((s) => s.status === "PASS")
        ? "PASS"
        : "NOT RUN";
  } catch (e) {
    const code = /^E_[A-Z_]+$/.test(e.message)
      ? e.message
      : "E_INPUT_UNAVAILABLE";
    fail(code, activeRow?.id ?? null);
    if (activeRow) {
      activeRow.status = "FAIL";
      if (activeRow.expected_tests) result.actual.tests_execution_known = false;
    }
  }
  const cases = result.stages.flatMap((s) => s.cases);
  result.actual.pass = cases.filter((c) => c.status === "PASS").length;
  result.actual.fail = cases.filter((c) => c.status === "FAIL").length;
  result.actual.not_run = cases.filter((c) => c.status === "NOT RUN").length;
  result.actual.tests_executed = result.actual.tests_execution_known
    ? result.actual.pass + result.actual.fail
    : null;
  result.coverage_complete =
    result.actual.not_run === 0 &&
    !result.first_failure &&
    result.status === "PASS";
  result.application_validation_pass =
    result.coverage_complete &&
    result.evidence_class === "application-evidence";
  return result;
}

export async function writeExclusive(root, destination, data) {
  safeRelative(destination);
  requireValue(
    /^\.tools\/phase9-focused\/run-[a-f0-9]{32}\/report\.json$/.test(
      destination,
    ),
    "E_OUTPUT_NAMESPACE",
  );
  const parent = dirname(resolve(root, destination));
  // Reserve a completely new run, never an existing historical output directory.
  const base = await realpath(root);
  for (
    let cursor = dirname(dirname(parent));
    cursor !== base;
    cursor = dirname(cursor)
  ) {
    requireValue(
      !(await lstat(cursor)).isSymbolicLink() &&
        (await realpath(cursor)).toLowerCase() === cursor.toLowerCase(),
      "E_REDIRECT",
    );
  }
  try {
    await mkdir(dirname(parent));
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  requireValue(
    !(await lstat(dirname(parent))).isSymbolicLink() &&
      (await realpath(dirname(parent))).toLowerCase() ===
        dirname(parent).toLowerCase(),
    "E_REDIRECT",
  );
  await mkdir(parent); // EEXIST is deliberately fatal, including empty old runs.
  const f = await open(resolve(root, destination), "wx", 0o600);
  try {
    await f.writeFile(JSON.stringify(data, null, 2) + "\n");
    await f.sync();
  } finally {
    await f.close();
  }
}
async function main(args) {
  const m = JSON.parse((await boundedRead(ROOT, MANIFEST)).toString("utf8"));
  if (args.length === 1 && args[0] === "check") {
    console.log(
      JSON.stringify({
        manifest: MANIFEST,
        ...(await validateManifest(m)),
        application_suites_executed: 0,
        launches_commands: false,
      }),
    );
    return;
  }
  if (args.length === 2 && args[0] === "plan") {
    await validateManifest(m);
    const source = await captureSource();
    const evidence = {
      version: 1,
      evidence_class: "plan-only",
      manifest_sha256: sha256(await boundedRead(ROOT, MANIFEST)),
      source_before: source,
      source_after: source,
      execution_environment: null,
      environments: null,
      preservation: null,
      stages: [],
    };
    const report = await reportEvidence(m, evidence);
    await writeExclusive(ROOT, args[1], report);
    console.log(
      JSON.stringify({
        status: report.status,
        expected: report.expected,
        actual: report.actual,
      }),
    );
    process.exitCode = report.status === "NOT RUN" ? 2 : 1;
    return;
  }
  if (args.length === 3 && args[0] === "report") {
    let evidence;
    try {
      evidence = JSON.parse(
        (await boundedRead(ROOT, args[1])).toString("utf8"),
      );
    } catch {
      evidence = null;
    } // Invalid input still produces a fail-closed report.
    const report = await reportEvidence(m, evidence, {
      evidenceRoot: dirname(resolve(ROOT, args[1])),
    });
    await writeExclusive(ROOT, args[2], report);
    console.log(
      JSON.stringify({
        status: report.status,
        first_failure: report.first_failure,
        actual: report.actual,
      }),
    );
    process.exitCode = report.application_validation_pass
      ? 0
      : report.status === "NOT RUN"
        ? 2
        : 1;
    return;
  }
  error("E_ARGUMENTS");
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main(process.argv.slice(2)).catch(() => {
    console.error("Focused evidence unavailable");
    process.exitCode = 1;
  });
}
