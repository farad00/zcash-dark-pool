// Stateless process double. No filesystem, networking, wallet or database imports.
if (
  process.env.DARKPOOL_OBSERVATION_CHILD !== "SYNTHETIC_ONLY" ||
  !["allocation", "scan", "observation"].includes(process.argv[2]) ||
  !["ok", "failure"].includes(process.argv[3]) ||
  process.argv.length !== 4
)
  process.exit(1);
let data = "";
for await (const b of process.stdin) {
  data += b;
  if (data.length > 4096) process.exit(1);
}
try {
  const request = JSON.parse(data);
  if (
    !/^[a-f0-9]{32}$/.test(request.nonce) ||
    request.purpose !== process.argv[2] ||
    request.scope !== "DISPOSABLE_TEST_ONLY" ||
    process.argv[3] === "failure"
  )
    process.exit(1);
  if (
    Object.keys(process.env).some((k) =>
      /^(PG|WALLET|ALLOCATION|CHAIN_ENDPOINT|DARKPOOL_GITHUB|DATABASE_URL)/i.test(
        k,
      ),
    )
  )
    process.exit(1);
  process.stdout.write(
    JSON.stringify({
      scope: "DISPOSABLE_TEST_ONLY",
      purpose: request.purpose,
      nonce: request.nonce,
      pid: process.pid,
      observations: [],
      financial_authorization: "NOT_GRANTED",
    }),
  );
} catch {
  process.exit(1);
}
