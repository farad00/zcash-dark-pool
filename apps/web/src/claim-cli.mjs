// Local-only startup; separate claim and public-reader credentials, no owner fallback.
import { createParticipantClaims } from "../../../services/claims/participant.mjs";
import { createPublicReader } from "../../../db/public-read.mjs";
import { createClaimServer } from "./claim-server.mjs";
try {
  const port = Number(process.env.CLAIM_PORT ?? 3001);
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !process.env.CLAIM_READER_USER ||
    !process.env.CLAIM_READER_PASSFILE
  )
    throw new Error();
  const claims = await createParticipantClaims({ env: process.env });
  const readerEnv = {
    ...process.env,
    PGUSER: process.env.CLAIM_READER_USER,
    PGPASSFILE: process.env.CLAIM_READER_PASSFILE,
  };
  delete readerEnv.PGPASSWORD;
  const readMarket = await createPublicReader(readerEnv);
  const server = createClaimServer({ claims, readMarket });
  server.listen(port, "127.0.0.1", () =>
    process.stdout.write(
      `Private claim interface on http://127.0.0.1:${port}/claim\n`,
    ),
  );
  server.on("error", () => {
    process.stderr.write("Claim interface unavailable\n");
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close());
} catch {
  process.stderr.write("Claim interface unavailable\n");
  process.exitCode = 1;
}
