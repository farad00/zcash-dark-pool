// Real headless browser fixture, isolated temporary profile; no participant data.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";

export async function launchBrowser() {
  let executable;
  for (const candidate of [
    process.env.BROWSER_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ]) {
    if (!candidate) continue;
    try {
      await access(candidate);
      executable = candidate;
      break;
    } catch {
      /* next */
    }
  }
  if (!executable)
    throw new Error("A Chromium browser is required; set BROWSER_PATH");
  const directory = await mkdtemp(join(tmpdir(), "darkpool-phase6-browser-"));
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-default-apps",
      "--metrics-recording-only",
      "--no-proxy-server",
      "--remote-debugging-port=0",
      `--user-data-dir=${directory}`,
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  const closed = new Promise((done) => child.once("close", done));
  let failed = false;
  child.once("error", () => {
    failed = true;
  });
  let socket;
  const stop = async () => {
    socket?.close();
    child.kill();
    await closed;
    // Recursive cleanup is restricted to the exact newly created temporary profile.
    if (
      resolve(directory).startsWith(resolve(tmpdir()) + "/") ||
      resolve(directory).startsWith(resolve(tmpdir()) + "\\")
    ) {
      if (!basename(directory).startsWith("darkpool-phase6-browser-"))
        throw new Error("Unsafe test cleanup");
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    } else throw new Error("Unsafe test cleanup");
  };
  try {
    let port;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (failed || child.exitCode !== null)
        throw new Error("Browser could not start");
      try {
        port = (
          await readFile(join(directory, "DevToolsActivePort"), "utf8")
        ).split("\n")[0];
        break;
      } catch {
        await new Promise((done) => setTimeout(done, 50));
      }
    }
    if (!port) throw new Error("Browser startup timed out");
    const targets = await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
    socket = new WebSocket(
      targets.find((target) => target.type === "page").webSocketDebuggerUrl,
    );
    await new Promise((done, reject) => {
      socket.onopen = done;
      socket.onerror = () => reject(new Error("Browser connection failed"));
    });
    let nextId = 0;
    const pending = new Map(),
      events = [];
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error("Browser command failed"));
        else request.done(message.result);
      } else events.push(message);
    };
    const call = (method, params = {}) =>
      new Promise((done, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Browser command timed out: " + method));
        }, 10000);
        pending.set(id, { done, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    await call("Runtime.enable");
    await call("Network.enable");
    await call("Page.enable");
    const evaluate = async (expression) => {
      const result = await call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        // Browser test assertions use fixed messages, never raw private values.
        const description =
          result.exceptionDetails.exception?.description ??
          "Browser assertion failed";
        throw new Error(description.split("\n")[0]);
      }
      return result.result.value;
    };
    const navigate = async (url) => {
      await call("Page.navigate", { url });
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          if (
            await evaluate(
              `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`,
            )
          )
            return;
        } catch {
          /* navigation context replaced */
        }
        await new Promise((done) => setTimeout(done, 20));
      }
      throw new Error("Browser navigation timed out");
    };
    return { call, evaluate, navigate, events, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
