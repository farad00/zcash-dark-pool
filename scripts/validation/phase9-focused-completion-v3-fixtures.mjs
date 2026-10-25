// Explicitly SYNTHETIC offline scaffolding. No native call or application is executed.
import { randomUUID } from "node:crypto";
import { syntheticProof as legacyScaffold } from "./phase9-focused-completion-v2-fixtures.mjs";
import { approvedManifest } from "./phase9-focused-executor-v1.mjs";
export async function syntheticProof(args) {
  const p = await legacyScaffold(args),
    i = p.historical.identities[0];
  p.contract_version = 3;
  i.binding_id = "process-1";
  const m = await approvedManifest();
  const o = (p.ordering = {
    clock: "QueryPerformanceCounter",
    frequency: "10000000",
    session_id: randomUUID().replaceAll("-", ""),
    observer_pid: args.pid + 100000,
    observer_creation_filetime: i.creation_filetime,
    thread_id: 1,
    supervisor_pid: 9999,
    supervisor_creation_filetime: "1",
    stage_id: m.stages.find(
      (s) => JSON.stringify(s.command) === JSON.stringify(args.command),
    ).id,
    capacity: 32768,
    record_count: 0,
    complete: true,
    overflow: false,
    events: [],
  });
  const event = (kind, subject, details) => {
    const n = o.events.length + 1;
    o.events.push({
      sequence: String(n),
      kind,
      subject,
      qpc_begin: String(n),
      qpc_end: String(n),
      utc: args.start,
      thread_id: o.thread_id,
      session_id: o.session_id,
      details,
    });
    return String(n);
  };
  event("stage_begin", "stage", { utc: args.start });
  event("job_ready", "job", {
    job_handle_binding: p.containment.job_handle_binding,
    flags: 8192,
    non_inheritable: true,
  });
  event("create", "root", { pid: i.pid, handle: "0x1", suspended: true });
  event("assign", "root", {
    pid: i.pid,
    handle: "0x1",
    job_handle_binding: p.containment.job_handle_binding,
    assigned: true,
  });
  event(
    "bind",
    i.binding_id,
    Object.fromEntries(
      [
        "pid",
        "creation_filetime",
        "creation_utc",
        "handle_binding",
        "observed_utc",
        "membership_verified",
      ].map((k) => [k, i[k]]),
    ),
  );
  event("launch_verified", i.binding_id, structuredClone(p.launch));
  event("resume", i.binding_id, { pid: i.pid, previous_suspend_count: 1 });
  event("exit", i.binding_id, {
    pid: i.pid,
    creation_filetime: i.creation_filetime,
    handle_binding: i.handle_binding,
    wait_result: 0,
    exit_utc: i.exit_utc,
    exit_code: i.exit_code,
  });
  const q = p.accounting[0];
  q.event_sequence = event("account", "job", structuredClone(q));
  event("release", i.binding_id, { closed: true });
  event("job_release", "job", { closed: true });
  event("cleanup", "stage", { succeeded: true, termination_requested: false });
  event("stage_end", "stage", { utc: args.end ?? args.zero });
  o.record_count = o.events.length;
  return p;
}
