// Explicit child fixture. Does not import wallet, SQL, network or filesystem tools.
if (
  process.env.DARKPOOL_SYNTHETIC_OBSERVATION_WORKER !== "1" ||
  Object.keys(process.env).some(
    (k) => /^PG/.test(k) || /WALLET|SEED|SPENDING|ALLOCATION_AUTH/.test(k),
  )
)
  process.exit(1);
const fixture = JSON.parse(process.env.DARKPOOL_SYNTHETIC_INPUT);
let pending = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const n = pending.readUInt32BE();
    if (!n || n > 4194304) process.exit(2);
    if (pending.length < 4 + n) return;
    const request = JSON.parse(pending.subarray(4, 4 + n));
    pending = pending.subarray(4 + n);
    if (
      (fixture.mode === "exit-sync" && request.operation === "sync") ||
      (fixture.mode === "exit-observe" && request.operation === "observe")
    )
      process.exit(3);
    let value;
    if (request.operation === "observe") value = { outputs: fixture.observed };
    else if (request.operation === "sync" && fixture.snapshot) {
      value = structuredClone(fixture.snapshot);
      if (value.chain) value.chain.verified_at = new Date().toISOString();
    } else process.exit(4);
    const b =
      fixture.mode === "malformed"
        ? Buffer.from("{")
        : Buffer.from(JSON.stringify(value));
    const h = Buffer.alloc(4);
    h.writeUInt32BE(b.length);
    process.stdout.write(Buffer.concat([h, b]));
  }
});
