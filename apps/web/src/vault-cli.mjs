import { createVaultServer } from "./vault-server.mjs";
if (process.env.ZCASH_NETWORK !== "testnet") {
  process.stderr.write("Local vault requires explicit testnet configuration\n");
  process.exit(1);
}
const port = Number(process.env.VAULT_PORT ?? "3001");
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write("Invalid local vault port\n");
  process.exit(1);
}
try {
  const server = createVaultServer();
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(
      `Local vault listening on 127.0.0.1:${server.address().port}\n`,
    );
  });
  server.on("error", () => {
    process.stderr.write("Local vault could not start\n");
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close());
} catch {
  process.stderr.write("Build the local vault before starting\n");
  process.exitCode = 1;
}
