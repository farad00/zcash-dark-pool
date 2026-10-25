// Pure evidence validation. Does not launch processes or import application code.
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
  demand(m && Number.isFinite(Date.parse(value)), "E_NATIVE_TIME");
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
  demand(p?.contract_version === 2, "E_COMPLETION_CONTRACT_VERSION");
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
    zero >= exit &&
      Array.isArray(p.accounting) &&
      p.accounting.length > 0 &&
      p.accounting.every(
        (q) =>
          fields(q, [
            "observed_utc",
            "purpose",
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
        nativeTime(i.exit_utc) >= BigInt(i.creation_filetime) &&
        nativeTime(i.observed_utc) >= BigInt(i.creation_filetime) &&
        nativeTime(i.observed_utc) <= zero &&
        nativeTime(i.exit_utc) <= zero,
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
    ) && p.accounting.every((q) => nativeTime(q.observed_utc) <= zero),
    "E_NATIVE_ZERO_OBSERVATION",
  );
  return p;
}
