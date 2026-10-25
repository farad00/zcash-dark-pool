import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  loadEnvironmentGuard,
  guardedSql,
  assertFixtureSql,
} from "../../db/environment.mjs";

/** TEST-only, one real psql connection. Never imports LIVE component provisioning. */
export async function openLockSession(env) {
  if (
    env.APP_ENV !== "development" ||
    env.ZCASH_NETWORK !== "testnet" ||
    env.DARKPOOL_LOCK_INTERNAL !== "1"
  )
    throw new Error("LOCK_TEST_ONLY");
  const target = await loadEnvironmentGuard(env, {
    database: env.PGDATABASE,
    requireKind: "TEST",
  });
  const child = spawn(
    env.PSQL_PATH || "psql",
    [
      "--no-psqlrc",
      "--no-password",
      "--quiet",
      "--no-align",
      "--tuples-only",
      "--set=ON_ERROR_STOP=1",
      "--set=VERBOSITY=sqlstate",
      "--dbname",
      env.PGDATABASE,
    ],
    {
      env: {
        ...env,
        PGAPPNAME: "darkpool-phase11-lock",
        PGCLIENTENCODING: "UTF8",
      },
      windowsHide: true,
    },
  );
  let pending,
    buffer = "",
    diagnostics = "",
    closed = false,
    closing = false;
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  function fail(code = "LOCK_DATABASE_FAILURE") {
    if (pending) {
      const reject = pending.reject;
      pending = undefined;
      const error = new Error(code);
      error.sqlstate = /ERROR:\s+([0-9A-Z]{5})\b/.exec(diagnostics)?.[1];
      reject(error);
    }
  }
  const deadline = setTimeout(() => {
    fail("LOCK_SESSION_DEADLINE");
    child.kill();
  }, 15000);
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) {
      fail("LOCK_OUTPUT_LIMIT");
      child.kill();
      return;
    }
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (!pending) {
        if (line.trim()) {
          fail();
          child.kill();
        }
        continue;
      }
      if (line === pending.marker) {
        const current = pending;
        pending = undefined;
        try {
          if (current.lines.length !== 1) throw new Error();
          current.resolve(JSON.parse(current.lines[0]));
        } catch {
          current.reject(new Error("LOCK_DATABASE_PROTOCOL"));
          child.kill();
        }
      } else if (line.trim()) {
        pending.lines.push(line);
        pending.size += line.length;
        if (pending.size > 8 * 1024 * 1024) {
          fail("LOCK_OUTPUT_LIMIT");
          child.kill();
        }
      }
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-16384);
  });
  child.on("error", () => {
    closed = true;
    clearTimeout(deadline);
    fail();
    resolveExit();
  });
  child.on("close", () => {
    closed = true;
    clearTimeout(deadline);
    fail();
    resolveExit();
  });
  child.stdin.on("error", () => fail());
  return {
    query(sql) {
      if (closed || closing || pending)
        return Promise.reject(new Error("LOCK_SESSION_UNAVAILABLE"));
      if (typeof sql !== "string" || Buffer.byteLength(sql) > 5 * 1024 * 1024)
        return Promise.reject(new Error("LOCK_INPUT_LIMIT"));
      assertFixtureSql(sql);
      const marker = "phase11_" + randomBytes(24).toString("hex");
      return new Promise((resolve, reject) => {
        pending = { marker, lines: [], size: 0, resolve, reject };
        child.stdin.write(
          guardedSql(target, sql + "\n\\echo " + marker + "\n"),
        );
      });
    },
    async close() {
      if (!closed && !closing) {
        closing = true;
        child.stdin.end("\\q\n");
      }
      await exited;
    },
  };
}
