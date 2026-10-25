import { isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { reject } from "./profile.mjs";
const execute = promisify(execFile);
export async function opensslDetailed(path, args) {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new Error("PUBLICATION_UNAVAILABLE");
  try {
    const result = await execute(path, args, {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      env: {
        SystemRoot: process.env.SystemRoot,
        PATH: process.env.PATH,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        LC_ALL: "C",
        LANG: "C",
      },
    });
    return result;
  } catch (error) {
    if (["ENOENT", "EACCES"].includes(error.code))
      throw new Error("PUBLICATION_UNAVAILABLE");
    reject();
  }
}
export async function openssl(path, args) {
  return (await opensslDetailed(path, args)).stdout;
}
