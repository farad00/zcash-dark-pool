import { createIssuanceServer } from "./issuance-server.mjs";
import { issuanceEnvironment } from "../../../db/issuance-runtime.mjs";
try {
  issuanceEnvironment(process.env);
  const port = Number(process.env.VAULT_PORT ?? 3001);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error();
  const server = createIssuanceServer();
  server.listen(port, "127.0.0.1", () =>
    process.stdout.write(
      `Ticket issuance listening on 127.0.0.1:${server.address().port}\n`,
    ),
  );
  server.on("error", () => {
    process.stderr.write("Issuance server unavailable\n");
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close());
} catch {
  process.stderr.write("Issuance server unavailable\n");
  process.exitCode = 1;
}
