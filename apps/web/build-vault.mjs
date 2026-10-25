// Copy only approved local dependencies. No bundler, CDN, network or protocol changes.
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
const output = new URL("./dist/vault/", import.meta.url);
await mkdir(new URL("vendor/", output), { recursive: true });
for (const name of [
  "vault.html",
  "vault.css",
  "vault-ui.mjs",
  "local-vault.mjs",
  "issuance.html",
  "issuance-ui.mjs",
  "issuance-client.mjs",
  "payment-status-wire.mjs",
  "payment-ui.mjs",
  "ticket-backup.mjs",
  "backup-ui.mjs",
  "backup.html",
  "claim.html",
  "claim-ui.mjs",
  "claim-client.mjs",
  "claim-wire.mjs",
])
  await copyFile(
    new URL(`./src/${name}`, import.meta.url),
    new URL(name, output),
  );
await copyFile(
  new URL("../../packages/protocol/dist/money.js", import.meta.url),
  new URL("money.js", output),
);
await copyFile(
  new URL("../../packages/protocol/dist/secrets.js", import.meta.url),
  new URL("secrets.js", output),
);
const source = await readFile(
  new URL("../../packages/protocol/dist/claim-commitment.js", import.meta.url),
  "utf8",
);
const browser = source
  .replace('"@noble/hashes/blake2.js"', '"./vendor/blake2.js"')
  .replace('"@noble/hashes/utils.js"', '"./vendor/utils.js"');
if (browser === source || browser.includes("@noble/"))
  throw new Error("Vault dependency adaptation failed");
await writeFile(new URL("claim-commitment.js", output), browser);
for (const name of [
  "blake2.js",
  "_blake.js",
  "_md.js",
  "_u64.js",
  "utils.js",
  "LICENSE",
])
  await copyFile(
    new URL(`../../node_modules/@noble/hashes/${name}`, import.meta.url),
    new URL(`vendor/${name}`, output),
  );
