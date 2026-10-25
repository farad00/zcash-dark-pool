import { createPublicServer } from "./public-server.mjs";
import { createPublicReader } from "../../../db/public-read.mjs";

if (process.env.ZCASH_NETWORK !== "testnet") {
  process.stderr.write("Web requires explicit testnet configuration\n");
  process.exit(1);
}

const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write("Invalid local web port\n");
  process.exit(1);
}

let readMarket;
try {
  readMarket = await createPublicReader();
} catch {
  // Health/routes remain available; failed startup binding cannot be retargeted.
  readMarket = async () => {
    throw new Error("Market unavailable");
  };
}
const server = createPublicServer({ readMarket });

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `Public web listening on 127.0.0.1:${server.address().port}\n`,
  );
});
server.on("error", () => {
  process.stderr.write("Public web could not start\n");
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close());
}
