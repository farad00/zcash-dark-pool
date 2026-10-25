// Read-only NTP observations; writes only a NEW local public diagnostic directory.
import { captureClock } from "./operational.mjs";
import { resolve } from "node:path";
try {
  if (process.argv.length !== 4) throw new Error();
  const record = await captureClock(process.argv[2], resolve(process.argv[3]));
  process.stdout.write(
    JSON.stringify({
      ...record,
      assurance: "OPERATOR_RECORDED_NOT_AUTHENTICATED_TIME",
      financial_authorization: false,
    }) + "\n",
  );
} catch {
  process.stderr.write(
    "Clock evidence unavailable; retain files and stop. No clock configuration was changed.\n",
  );
  process.exitCode = 1;
}
