// Completion-v3: native causal journal. Legacy v2 remains unchanged in its own module.
const demand = (v, code) => {
  if (!v) throw Error(code);
};
const hash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const fields = (o, names) =>
  o &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  Object.keys(o).length === names.length &&
  names.every((n) => Object.hasOwn(o, n));
export const sameWindowsPath = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.replaceAll("\\", "/").toLowerCase() ===
    b.replaceAll("\\", "/").toLowerCase();
export function nativeTime(value) {
  const m =
    typeof value === "string" &&
    /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.(\d{1,7})Z$/.exec(value);
  demand(
    m &&
      Number.isFinite(Date.parse(value)) &&
      new Date(Date.parse(m[1] + ".000Z")).toISOString().slice(0, 19) === m[1],
    "E_NATIVE_TIME",
  );
  return (
    BigInt(Date.parse(m[1] + ".000Z")) * 10000n +
    116444736000000000n +
    BigInt(m[2].padEnd(7, "0"))
  );
}
function quote(value) {
  let out = '"',
    slashes = 0;
  for (const c of value) {
    if (c === "\\") {
      slashes++;
      continue;
    }
    out += "\\".repeat(c === '"' ? slashes * 2 + 1 : slashes) + c;
    slashes = 0;
  }
  return out + "\\".repeat(slashes * 2) + '"';
}
function commandBinding(p) {
  const l = p.launch,
    cmd = p.command,
    base = l.executable_path
      .replaceAll("\\", "/")
      .split("/")
      .at(-1)
      .toLowerCase();
  const equals = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let args,
    cmdShell = false;
  if (cmd[0] === "offline-fixture") {
    demand(
      l.policy === "offline-fixture-direct-child" && cmd.length === 2,
      "E_NATIVE_COMMAND_BINDING",
    );
    cmdShell = cmd[1] === "cmd-quoting";
    if (!cmdShell) {
      demand(
        base === "fixture.exe" && l.inputs.length === 0,
        "E_NATIVE_COMMAND_BINDING",
      );
      args = [cmd[1]];
    }
  } else {
    demand(
      l.policy === "approved-focused-v1-direct-child",
      "E_NATIVE_COMMAND_BINDING",
    );
    cmdShell = cmd[0] === "npm.cmd";
    if (!cmdShell) {
      demand(
        (cmd[0] === "node" && base === "node.exe") ||
          (cmd[0] === "cargo" && base === "cargo.exe"),
        "E_NATIVE_COMMAND_BINDING",
      );
      args = cmd.slice(1);
      if (cmd[0] === "cargo")
        demand(l.inputs.length === 0, "E_NATIVE_COMMAND_BINDING");
      else {
        const script = (cmd[1].startsWith("--") ? cmd.at(-1) : cmd[1])
          .replaceAll("\\", "/")
          .toLowerCase();
        demand(
          l.inputs.length === 1 &&
            l.inputs[0].path
              .replaceAll("\\", "/")
              .toLowerCase()
              .endsWith("/" + script),
          "E_NATIVE_SCRIPT_BINDING",
        );
      }
    } else
      demand(
        equals(cmd, ["npm.cmd", "run", "build:web"]),
        "E_NATIVE_COMMAND_BINDING",
      );
  }
  if (cmdShell) {
    demand(
      base === "cmd.exe" && l.inputs.length === 1,
      "E_NATIVE_COMMAND_BINDING",
    );
    const name = l.inputs[0].path
      .replaceAll("\\", "/")
      .split("/")
      .at(-1)
      .toLowerCase();
    demand(
      name === (cmd[0] === "offline-fixture" ? "fixed fixture.cmd" : "npm.cmd"),
      "E_NATIVE_SCRIPT_BINDING",
    );
    args = [
      "/d",
      "/s",
      "/c",
      '"' + quote(l.inputs[0].path) + ' run build:web"',
    ];
  }
  demand(
    equals(l.arguments, args) &&
      l.command_line ===
        (cmdShell
          ? quote(l.executable_path) + " /d /s /c " + args[3]
          : [l.executable_path, ...args].map(quote).join(" ")),
    "E_NATIVE_COMMAND_BINDING",
  );
}
export function validateCompletionProof(p) {
  demand(p?.contract_version === 3, "E_COMPLETION_CONTRACT_VERSION");
  demand(
    p.root_exit_observed === true &&
      Number.isInteger(p.root_exit_code) &&
      p.tree_completion_verified === true &&
      p.cleanup_succeeded === true &&
      p.termination_requested === false,
    "E_NATIVE_COMPLETION",
  );
  const c = p.containment;
  demand(
    fields(c, [
      "assigned_before_resume",
      "membership_verified",
      "job_flags",
      "same_job_handle",
      "non_inheritable",
      "job_handle_binding",
    ]),
    "E_NATIVE_CONTAINMENT_SCHEMA",
  );
  demand(
    c?.assigned_before_resume === true &&
      c.membership_verified === true &&
      c.job_flags === 0x2000 &&
      c.same_job_handle === true &&
      c.non_inheritable === true &&
      /^retained-job:0x[0-9a-f]+$/.test(c.job_handle_binding),
    "E_NATIVE_CONTAINMENT",
  );
  const l = p.launch;
  demand(
    fields(l, [
      "executable_path",
      "image_path",
      "executable_sha256",
      "arguments",
      "command_line",
      "policy",
      "inputs",
    ]),
    "E_NATIVE_LAUNCH_SCHEMA",
  );
  demand(
    l &&
      /^[a-z]:[\\/]/i.test(l.executable_path) &&
      sameWindowsPath(l.executable_path, l.image_path) &&
      hash(l.executable_sha256) &&
      Array.isArray(l.arguments) &&
      l.arguments.every((a) => typeof a === "string") &&
      typeof l.command_line === "string" &&
      l.command_line.length > 0 &&
      [
        "approved-focused-v1-direct-child",
        "offline-fixture-direct-child",
      ].includes(l.policy),
    "E_NATIVE_LAUNCH",
  );
  demand(
    Array.isArray(l.inputs) &&
      l.inputs.every(
        (f) =>
          fields(f, ["path", "sha256"]) &&
          typeof f.path === "string" &&
          hash(f.sha256),
      ) &&
      Array.isArray(p.command) &&
      p.command.length > 0 &&
      p.command.every((a) => typeof a === "string"),
    "E_NATIVE_COMMAND",
  );
  commandBinding(p);
  demand(
    p.query_succeeded === true && p.active_processes === 0,
    "E_NATIVE_ZERO",
  );
  const zero = nativeTime(p.zero_query_utc),
    exit = nativeTime(p.root_exit_utc);
  demand(
    zero > 0n &&
      exit > 0n &&
      Array.isArray(p.accounting) &&
      p.accounting.length > 0 &&
      p.accounting.every(
        (q) =>
          fields(q, [
            "observed_utc",
            "purpose",
            "event_sequence",
            "succeeded",
            "active_processes",
            "total_processes",
            "win32_error",
          ]) &&
          q.succeeded === true &&
          q.win32_error === null &&
          integer(q.active_processes) &&
          integer(q.total_processes) &&
          q.active_processes <= q.total_processes,
      ),
    "E_NATIVE_ACCOUNTING",
  );
  const h = p.historical;
  demand(
    fields(h, [
      "lifetime_process_count",
      "retained_process_identities",
      "missing_identity_count",
      "inventory_complete",
      "identities",
    ]),
    "E_NATIVE_HISTORY_SCHEMA",
  );
  demand(
    h &&
      integer(h.lifetime_process_count) &&
      integer(h.retained_process_identities) &&
      integer(h.missing_identity_count) &&
      h.lifetime_process_count > 0 &&
      h.retained_process_identities > 0 &&
      h.retained_process_identities <= h.lifetime_process_count &&
      h.missing_identity_count ===
        h.lifetime_process_count - h.retained_process_identities &&
      h.inventory_complete === (h.missing_identity_count === 0) &&
      Array.isArray(h.identities) &&
      h.identities.length === h.retained_process_identities,
    "E_NATIVE_HISTORY",
  );
  const seen = new Set();
  for (const i of h.identities) {
    demand(
      fields(i, [
        "pid",
        "binding_id",
        "creation_filetime",
        "creation_utc",
        "handle_binding",
        "observed_utc",
        "exit_utc",
        "membership_verified",
        "handle_closed",
        "exit_code",
      ]) &&
        Number.isInteger(i.pid) &&
        i.pid > 0 &&
        /^\d+$/.test(i.creation_filetime) &&
        i.membership_verified === true &&
        i.handle_closed === true &&
        /^GetProcessId\+GetProcessTimes\+IsProcessInJob:0x[0-9a-f]+$/.test(
          i.handle_binding,
        ) &&
        Number.isInteger(i.exit_code),
      "E_NATIVE_IDENTITY",
    );
    const key = i.pid + ":" + i.creation_filetime;
    demand(
      !seen.has(key) &&
        nativeTime(i.creation_utc) === BigInt(i.creation_filetime) &&
        nativeTime(i.exit_utc) > 0n &&
        nativeTime(i.observed_utc) > 0n,
      "E_NATIVE_IDENTITY_TIME",
    );
    seen.add(key);
  }
  const root = h.identities.filter(
    (i) =>
      i.pid === p.root_pid && i.creation_filetime === p.root_creation_filetime,
  );
  demand(
    root.length === 1 &&
      root[0].exit_code === p.root_exit_code &&
      root[0].exit_utc === p.root_exit_utc,
    "E_NATIVE_ROOT",
  );
  demand(
    p.accounting.some(
      (q) =>
        q.purpose === "completion" &&
        q.active_processes === 0 &&
        q.total_processes === h.lifetime_process_count &&
        q.observed_utc === p.zero_query_utc,
    ) && p.accounting.every((q) => nativeTime(q.observed_utc) > 0n),
    "E_NATIVE_ZERO_OBSERVATION",
  );
  validateJournal(p);
  return p;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const int64 = (v) => {
  demand(typeof v === "string" && /^(0|-?[1-9]\d*)$/.test(v), "E_QPC_INTEGER");
  const n = BigInt(v);
  demand(n >= -(1n << 63n) && n < 1n << 63n, "E_QPC_INTEGER");
  return n;
};
export function validateJournal(p) {
  const o = p.ordering;
  demand(
    fields(o, [
      "clock",
      "frequency",
      "session_id",
      "observer_creation_filetime",
      "stage_id",
      "observer_pid",
      "thread_id",
      "supervisor_pid",
      "supervisor_creation_filetime",
      "capacity",
      "record_count",
      "complete",
      "overflow",
      "events",
    ]),
    "E_JOURNAL_SCHEMA",
  );
  demand(
    o.clock === "QueryPerformanceCounter" &&
      int64(o.frequency) > 0n &&
      /^[a-f0-9]{32}$/.test(o.session_id) &&
      int64(o.observer_creation_filetime) > 0n &&
      Number.isSafeInteger(o.observer_pid) &&
      o.observer_pid > 0 &&
      Number.isSafeInteger(o.thread_id) &&
      o.thread_id > 0 &&
      typeof o.stage_id === "string" &&
      o.stage_id.length > 0 &&
      o.capacity === 32768 &&
      o.complete === true &&
      o.overflow === false &&
      Array.isArray(o.events) &&
      o.events.length <= o.capacity &&
      o.record_count === o.events.length,
    "E_JOURNAL_CONTEXT",
  );
  demand(
    (p.launch.policy === "offline-fixture-direct-child" &&
      o.supervisor_pid === 0 &&
      o.supervisor_creation_filetime === null) ||
      (Number.isSafeInteger(o.supervisor_pid) &&
        o.supervisor_pid > 0 &&
        int64(o.supervisor_creation_filetime) > 0n),
    "E_JOURNAL_SUPERVISOR",
  );
  let end = null;
  for (const [n, e] of o.events.entries()) {
    demand(
      fields(e, [
        "sequence",
        "kind",
        "subject",
        "qpc_begin",
        "qpc_end",
        "utc",
        "details",
        "thread_id",
        "session_id",
      ]) &&
        e.sequence === String(n + 1) &&
        typeof e.kind === "string" &&
        typeof e.subject === "string",
      "E_JOURNAL_EVENT",
    );
    demand(
      e.thread_id === o.thread_id && e.session_id === o.session_id,
      "E_JOURNAL_EVENT_CONTEXT",
    );
    const a = int64(e.qpc_begin),
      b = int64(e.qpc_end);
    nativeTime(e.utc);
    demand(a <= b && (end === null || end <= a), "E_QPC_ORDER");
    end = b;
  }
  const one = (kind, subject) => {
    const a = o.events.filter((e) => e.kind === kind && e.subject === subject);
    demand(a.length === 1, "E_JOURNAL_TRANSITION");
    return a[0];
  };
  const seq = (e) => BigInt(e.sequence);
  const before = (...events) =>
    demand(
      events.every((e, n) => n === 0 || seq(events[n - 1]) < seq(e)),
      "E_JOURNAL_ORDER",
    );
  const details = (e, names, expected) =>
    demand(
      fields(e.details, names) &&
        names.every((k) => same(e.details[k], expected[k])),
      "E_JOURNAL_BINDING",
    );
  const begin = one("stage_begin", "stage"),
    ready = one("job_ready", "job"),
    create = one("create", "root"),
    assign = one("assign", "root"),
    jobClose = one("job_release", "job"),
    cleanup = one("cleanup", "stage"),
    finish = one("stage_end", "stage");
  demand(
    begin === o.events[0] && finish === o.events.at(-1),
    "E_JOURNAL_TRANSITION",
  );
  demand(
    fields(begin.details, ["utc"]) && fields(finish.details, ["utc"]),
    "E_JOURNAL_BINDING",
  );
  nativeTime(begin.details.utc);
  nativeTime(finish.details.utc);
  details(ready, ["job_handle_binding", "flags", "non_inheritable"], {
    job_handle_binding: p.containment.job_handle_binding,
    flags: 8192,
    non_inheritable: true,
  });
  const root = p.historical.identities.find(
    (i) =>
      i.pid === p.root_pid && i.creation_filetime === p.root_creation_filetime,
  );
  demand(root, "E_NATIVE_ROOT");
  const handle = root.handle_binding.split(":").at(-1);
  details(create, ["pid", "handle", "suspended"], {
    pid: p.root_pid,
    handle,
    suspended: true,
  });
  details(assign, ["pid", "handle", "job_handle_binding", "assigned"], {
    pid: p.root_pid,
    handle,
    job_handle_binding: p.containment.job_handle_binding,
    assigned: true,
  });
  const launch = one("launch_verified", root.binding_id),
    resume = one("resume", root.binding_id);
  demand(same(launch.details, p.launch), "E_JOURNAL_LAUNCH");
  details(resume, ["pid", "previous_suspend_count"], {
    pid: p.root_pid,
    previous_suspend_count: 1,
  });
  const identities = new Set();
  let rootBind, rootExit;
  const exits = [];
  for (const i of p.historical.identities) {
    demand(
      typeof i.binding_id === "string" &&
        /^process-[1-9]\d*$/.test(i.binding_id) &&
        !identities.has(i.binding_id),
      "E_JOURNAL_IDENTITY",
    );
    identities.add(i.binding_id);
    const bind = one("bind", i.binding_id),
      exit = one("exit", i.binding_id),
      release = one("release", i.binding_id);
    details(
      bind,
      [
        "pid",
        "creation_filetime",
        "creation_utc",
        "handle_binding",
        "observed_utc",
        "membership_verified",
      ],
      i,
    );
    details(
      exit,
      [
        "pid",
        "creation_filetime",
        "handle_binding",
        "wait_result",
        "exit_utc",
        "exit_code",
      ],
      { ...i, wait_result: 0 },
    );
    details(release, ["closed"], { closed: true });
    before(assign, bind, exit, release, jobClose);
    exits.push(exit);
    if (i === root) {
      rootBind = bind;
      rootExit = exit;
    } else before(resume, bind);
  }
  const completions = p.accounting.filter((q) => q.purpose === "completion");
  demand(completions.length === 1, "E_JOURNAL_ZERO");
  const q = completions[0],
    zero = o.events.find((e) => e.sequence === q.event_sequence);
  demand(
    zero && q.active_processes === 0 && q.observed_utc === p.zero_query_utc,
    "E_JOURNAL_ZERO",
  );
  for (const a of p.accounting) {
    const e = o.events.find((e) => e.sequence === a.event_sequence);
    demand(
      e?.kind === "account" && e.subject === "job",
      "E_JOURNAL_ACCOUNTING",
    );
    details(
      e,
      [
        "observed_utc",
        "purpose",
        "succeeded",
        "active_processes",
        "total_processes",
        "win32_error",
      ],
      a,
    );
    nativeTime(a.observed_utc);
    before(resume, e, jobClose);
  }
  demand(
    new Set(p.accounting.map((a) => a.event_sequence)).size ===
      p.accounting.length,
    "E_JOURNAL_ACCOUNTING",
  );
  before(
    begin,
    ready,
    create,
    assign,
    rootBind,
    launch,
    resume,
    rootExit,
    zero,
    jobClose,
    cleanup,
    finish,
  );
  for (const e of exits) before(e, zero);
  for (const i of p.historical.identities)
    before(zero, one("release", i.binding_id));
  details(jobClose, ["closed"], { closed: true });
  details(cleanup, ["succeeded", "termination_requested"], {
    succeeded: true,
    termination_requested: false,
  });
  demand(
    o.events.length ===
      9 + 3 * p.historical.identities.length + p.accounting.length,
    "E_JOURNAL_EVENT_COUNT",
  );
  return o;
}
export function utcAnomalies(p) {
  const out = [],
    add = (kind, subject, from, to) => {
      if (nativeTime(to) < nativeTime(from))
        out.push({ kind, subject, from_utc: from, to_utc: to });
    };
  for (const i of p.historical.identities) {
    add(
      "observation_before_creation",
      i.binding_id,
      i.creation_utc,
      i.observed_utc,
    );
    add("exit_before_creation", i.binding_id, i.creation_utc, i.exit_utc);
    add(
      "observation_after_zero",
      i.binding_id,
      i.observed_utc,
      p.zero_query_utc,
    );
    add("exit_after_zero", i.binding_id, i.exit_utc, p.zero_query_utc);
  }
  const start = p.ordering.events[0].details.utc,
    end = p.ordering.events.at(-1).details.utc;
  add("stage_end_before_start", "stage", start, end);
  add(
    "root_creation_before_stage_start",
    "root",
    start,
    p.historical.identities.find(
      (i) =>
        i.pid === p.root_pid &&
        i.creation_filetime === p.root_creation_filetime,
    ).creation_utc,
  );
  add("zero_after_stage_end", "stage", p.zero_query_utc, end);
  for (let n = 1; n < p.accounting.length; n++)
    add(
      "accounting_utc_reversal",
      p.accounting[n].event_sequence,
      p.accounting[n - 1].observed_utc,
      p.accounting[n].observed_utc,
    );
  add("zero_before_root_exit", "root", p.root_exit_utc, p.zero_query_utc);
  for (let n = 1; n < p.ordering.events.length; n++)
    add(
      "audit_clock_reversal",
      p.ordering.events[n].sequence,
      p.ordering.events[n - 1].utc,
      p.ordering.events[n].utc,
    );
  return out;
}
