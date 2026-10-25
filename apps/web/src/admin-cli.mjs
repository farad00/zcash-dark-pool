import {
  requireInternalEnvironment,
  parseCommand,
  executeCommand,
} from "./admin.mjs";

try {
  requireInternalEnvironment(process.env);
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 65536) throw new Error("INVALID_REQUEST");
    chunks.push(chunk);
  }
  const command = parseCommand(Buffer.concat(chunks).toString("utf8"));
  const result = await executeCommand(command);
  process.stdout.write(JSON.stringify(result) + "\n");
  if (result.result === "REJECTED" || result.result === "BLOCKED")
    process.exitCode = 1;
} catch (error) {
  const code =
    error.message === "INTERNAL_DEVELOPMENT_ONLY"
      ? "INTERNAL_DEVELOPMENT_ONLY"
      : "INVALID_REQUEST";
  process.stdout.write(JSON.stringify({ result: "REJECTED", code }) + "\n");
  process.exitCode = 1;
}
