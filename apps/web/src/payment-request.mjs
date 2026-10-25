// Private stateless Rust boundary. No participant DB, wallet or key configuration.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function parsePaymentRequest(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "receiving_ua,requested_amount_zat" ||
    typeof value.receiving_ua !== "string" ||
    value.receiving_ua.length > 1024 ||
    !/^utest1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(value.receiving_ua) ||
    typeof value.requested_amount_zat !== "string" ||
    !/^[1-9][0-9]{0,15}$/.test(value.requested_amount_zat) ||
    BigInt(value.requested_amount_zat) > 2100000000000000n
  )
    throw new Error("INVALID_REQUEST");
  return value;
}

export function formatPaymentRequest(value) {
  const input = parsePaymentRequest(value);
  const executable = fileURLToPath(
    new URL(
      `../../../target/debug/darkpool-zcash${process.platform === "win32" ? ".exe" : ""}`,
      import.meta.url,
    ),
  );
  const frame = Buffer.concat(
    [input.receiving_ua, input.requested_amount_zat].map((f) => {
      const bytes = Buffer.from(f, "utf8"),
        size = Buffer.alloc(4);
      size.writeUInt32BE(bytes.length);
      return Buffer.concat([size, bytes]);
    }),
  );
  return new Promise((resolve, reject) => {
    // Explicit environment allowlist: never inherit PG/wallet/viewing/signing authority.
    const env = { ZCASH_NETWORK: "testnet" };
    for (const key of [
      "SystemRoot",
      "SYSTEMROOT",
      "SystemDrive",
      "TEMP",
      "TMP",
    ])
      if (process.env[key]) env[key] = process.env[key];
    let child,
      timer,
      settled = false,
      output = Buffer.alloc(0);
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.kill();
      reject(new Error("PAYMENT_REQUEST_UNAVAILABLE"));
    };
    try {
      child = spawn(executable, ["format-payment-request"], {
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      timer = setTimeout(fail, 5000);
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.stdout.on("data", (data) => {
        output = Buffer.concat([output, data]);
        if (output.length > 1200) fail();
      });
      child.stderr.on("data", fail); // Never forward even unexpected diagnostics.
      child.on("close", (code) => {
        if (settled) return;
        try {
          if (
            code !== 0 ||
            output.length < 5 ||
            output.readUInt32BE(0) !== output.length - 4
          )
            throw new Error();
          const payment_uri = output.subarray(4).toString("utf8");
          if (
            !payment_uri.startsWith(`zcash:${input.receiving_ua}?amount=`) ||
            !/^zcash:utest1[023456789acdefghjklmnpqrstuvwxyz]+\?amount=(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(
              payment_uri,
            )
          )
            throw new Error();
          settled = true;
          clearTimeout(timer);
          resolve(
            Object.freeze({
              payment_request_profile_version: 1,
              network: "testnet",
              payment_uri,
            }),
          );
        } catch {
          fail();
        }
      });
      child.stdin.end(frame);
    } catch {
      fail();
    }
  });
}

export function participantPaymentResult(value) {
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      "network,payment_request_profile_version,payment_uri" ||
    value.network !== "testnet" ||
    value.payment_request_profile_version !== 1 ||
    typeof value.payment_uri !== "string" ||
    value.payment_uri.length > 1196 ||
    !/^zcash:utest1[023456789acdefghjklmnpqrstuvwxyz]+\?amount=(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(
      value.payment_uri,
    )
  )
    throw new Error("PAYMENT_REQUEST_UNAVAILABLE");
  return {
    payment_request_profile_version: 1,
    network: "testnet",
    payment_uri: value.payment_uri,
  };
}
