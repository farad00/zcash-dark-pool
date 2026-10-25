// No HTTP endpoint, wallet import, configuration plugin or external publisher.
import { TextDecoder } from "node:util";
import {
  commands,
  MAX_COMMAND_BYTES,
  createOperationsAdapter,
  lockResourcesFromEnvironment,
} from "./commands.mjs";

try {
  if (process.argv.length !== 3 || !Object.hasOwn(commands, process.argv[2]))
    throw new Error();
  const purpose = process.argv[2];
  const adapter = await createOperationsAdapter({
    purpose,
    env: process.env,
    lockResources:
      purpose === "lock"
        ? lockResourcesFromEnvironment(process.env)
        : undefined,
  });
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > MAX_COMMAND_BYTES) throw new Error();
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    let result;
    try {
      result = await adapter(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } finally {
      bytes.fill(0);
    }
    process.stdout.write(JSON.stringify(result) + "\n");
    if (["REJECTED", "BLOCKED", "UNCONFIRMED"].includes(result.result))
      process.exitCode = 1;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
} catch {
  process.stdout.write(
    JSON.stringify({ result: "REJECTED", code: "OPERATIONS_UNAVAILABLE" }) +
      "\n",
  );
  process.exitCode = 1;
}
