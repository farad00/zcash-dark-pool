// Wallet-free doubles of the EXISTING TCP/IPC contracts, never a wallet implementation.
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { framedWalletProcess } from "../../watcher/main.mjs";
export async function allocatorFixture({ market, vault, addresses }) {
  if (!process.env.NODE_TEST_CONTEXT) throw Error("TEST_ONLY");
  const auth = randomBytes(32).toString("hex"),
    journal = new Map(),
    sockets = new Set();
  const controls = { collision: false, loseReply: false };
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(1000, () => socket.destroy());
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 42000) socket.destroy();
    });
    socket.on("end", () => {
      try {
        let offset = 0;
        const fields = [];
        while (offset < bytes.length) {
          const n = bytes.readUInt32BE(offset);
          offset += 4;
          if (!n || n > 8192 || offset + n > bytes.length) throw Error();
          fields.push(
            new TextDecoder("utf-8", { fatal: true }).decode(
              bytes.subarray(offset, offset + n),
            ),
          );
          offset += n;
        }
        const [token, m, v, ticket, commitment] = fields;
        if (
          fields.length !== 5 ||
          token.length !== auth.length ||
          !timingSafeEqual(Buffer.from(token), Buffer.from(auth)) ||
          m !== market ||
          v !== vault ||
          ![ticket, commitment].every((v) => /^[0-9a-f]{64}$/.test(v))
        )
          throw Error();
        let entry = journal.get(ticket);
        if (entry && entry.commitment !== commitment) throw Error();
        if (!entry) {
          const index = controls.collision ? 0 : journal.size;
          if (!addresses[index]) throw Error();
          entry = {
            commitment,
            ua: addresses[index],
            diversifier: (index + 1).toString(16).padStart(22, "0"),
          };
          journal.set(ticket, entry);
        }
        if (controls.loseReply) {
          controls.loseReply = false;
          socket.destroy();
          return;
        }
        const result = Buffer.concat(
          [entry.ua, entry.diversifier].map((value) => {
            const b = Buffer.from(value),
              h = Buffer.alloc(4);
            h.writeUInt32BE(b.length);
            return Buffer.concat([h, b]);
          }),
        );
        socket.end(result);
      } catch {
        socket.end(Buffer.alloc(4));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    auth,
    port: String(server.address().port),
    journal,
    controls,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}
export function scannerChild({
  observed = [],
  snapshot,
  mode = "normal",
} = {}) {
  if (!process.env.NODE_TEST_CONTEXT) throw Error("TEST_ONLY");
  const env = {
    DARKPOOL_SYNTHETIC_OBSERVATION_WORKER: "1",
    DARKPOOL_SYNTHETIC_INPUT: JSON.stringify({ observed, snapshot, mode }),
  };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"])
    if (process.env[key]) env[key] = process.env[key];
  return spawn(
    process.execPath,
    [fileURLToPath(new URL("./scanner-worker.mjs", import.meta.url))],
    { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
}
export const scannerFixture = (input) =>
  framedWalletProcess(scannerChild(input));
