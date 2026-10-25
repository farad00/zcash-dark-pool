// SYNTHETIC OFFLINE SCAFFOLDING ONLY. No application process is launched.
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolveApprovedLaunch } from "./phase9-focused-executor-v1.mjs";
import { nativeTime } from "./phase9-focused-completion-v2.mjs";
const sha = (b) => createHash("sha256").update(b).digest("hex");
export async function syntheticProof({
  command,
  pid,
  start,
  exit,
  zero,
  code = 0,
}) {
  const l = await resolveApprovedLaunch(command);
  const identity = {
    pid,
    creation_filetime: nativeTime(start).toString(),
    creation_utc: start,
    handle_binding: "GetProcessId+GetProcessTimes+IsProcessInJob:0x1",
    observed_utc: start,
    exit_utc: exit,
    membership_verified: true,
    handle_closed: true,
    exit_code: code,
  };
  return {
    contract_version: 2,
    root_pid: pid,
    root_creation_filetime: identity.creation_filetime,
    root_exit_observed: true,
    root_exit_utc: exit,
    root_exit_code: code,
    query_succeeded: true,
    active_processes: 0,
    zero_query_utc: zero,
    tree_completion_verified: true,
    cleanup_succeeded: true,
    termination_requested: false,
    launch: {
      executable_path: l.executable,
      image_path: l.executable,
      executable_sha256: sha(await fs.readFile(l.executable)),
      arguments: l.args,
      command_line: l.command_line,
      policy: "approved-focused-v1-direct-child",
      inputs: await Promise.all(
        l.inputs.map(async (path) => ({
          path,
          sha256: sha(await fs.readFile(path)),
        })),
      ),
    },
    containment: {
      assigned_before_resume: true,
      membership_verified: true,
      job_flags: 8192,
      same_job_handle: true,
      non_inheritable: true,
      job_handle_binding: "retained-job:0x1",
    },
    command,
    accounting: [
      {
        observed_utc: zero,
        purpose: "completion",
        succeeded: true,
        active_processes: 0,
        total_processes: 1,
        win32_error: null,
      },
    ],
    historical: {
      lifetime_process_count: 1,
      retained_process_identities: 1,
      missing_identity_count: 0,
      inventory_complete: true,
      identities: [identity],
    },
  };
}
