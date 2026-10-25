// Browser-only internal storage. This is neither an export format nor an API wire format.
import { generateClaimSecret } from "./secrets.js";
import { deriveClaimCommitment } from "./claim-commitment.js";
import {
  encodeTicketBackup,
  decodeTicketBackup,
  validateBackupIdentity,
} from "./ticket-backup.mjs";

const databaseName = "darkpool-local-ticket-vault";
const schemaVersion = 1;
const profile = "DARKPOOL_CLAIM_V1_ID_FRAME_1";
const safeCodes = new Set([
  "INVALID_LOCAL_RECORD",
  "UNSUPPORTED_VAULT_SCHEMA",
  "LOCAL_RECORD_NOT_FOUND",
  "LOCAL_RECORD_IMMUTABLE",
  "LOCAL_RECORD_CHANGED",
  "TICKET_NOT_EXPORTABLE",
  "TICKET_BACKUP_CONFLICT",
]);
const fail = (code) => {
  throw new Error(code);
};
const exactKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
function identifier(value) {
  // Storage resource limit only: no normalization, production ID grammar or entropy claim.
  if (
    typeof value !== "string" ||
    !value.length ||
    !value.isWellFormed() ||
    new TextEncoder().encode(value).length > 8192
  )
    fail("INVALID_LOCAL_RECORD");
}
function commitment(record) {
  return deriveClaimCommitment({
    version: record.version,
    market_id: record.market_id,
    ticket_id: record.ticket_id,
    claim_secret: record.claim_secret,
  });
}
function validate(record) {
  const keys = ["local_id", "state", "version", "network", "claim_secret"];
  if (record?.state === "FINALIZED")
    keys.push("market_id", "ticket_id", "claim_commitment");
  if (
    !exactKeys(record, keys) ||
    !Number.isSafeInteger(record.local_id) ||
    record.local_id < 1 ||
    !["DRAFT", "FINALIZED"].includes(record.state) ||
    record.version !== 1 ||
    record.network !== "testnet" ||
    !(record.claim_secret instanceof Uint8Array) ||
    record.claim_secret.length !== 32
  )
    fail("INVALID_LOCAL_RECORD");
  if (record.state === "FINALIZED") {
    identifier(record.market_id);
    identifier(record.ticket_id);
    if (record.claim_commitment !== commitment(record))
      fail("INVALID_LOCAL_RECORD");
  }
}
const summary = (record) =>
  Object.freeze({
    local_id: record.local_id,
    state: record.state,
    ...(record.state === "FINALIZED"
      ? { market_id: record.market_id, ticket_id: record.ticket_id }
      : {}),
  });
function same(left, right) {
  return (
    left.state === right.state &&
    left.market_id === right.market_id &&
    left.ticket_id === right.ticket_id &&
    left.claim_secret.every((byte, index) => byte === right.claim_secret[index])
  );
}

export async function openLocalVault() {
  if (!globalThis.isSecureContext || !globalThis.indexedDB)
    fail("LOCAL_STORAGE_UNAVAILABLE");
  const db = await new Promise((resolve, reject) => {
    let abandoned = false;
    let request;
    try {
      request = globalThis.indexedDB.open(databaseName, schemaVersion);
    } catch {
      reject(new Error("LOCAL_STORAGE_UNAVAILABLE"));
      return;
    }
    const timer = globalThis.setTimeout(() => {
      abandoned = true;
      reject(new Error("LOCAL_STORAGE_BLOCKED"));
    }, 3000);
    request.onupgradeneeded = (event) => {
      if (event.oldVersion !== 0) {
        request.transaction.abort();
        return;
      }
      const records = request.result.createObjectStore("records", {
        keyPath: "local_id",
        autoIncrement: true,
      });
      records.createIndex("credential", "claim_secret", { unique: true });
      records.createIndex("identity", ["market_id", "ticket_id"], {
        unique: true,
      });
      request.result
        .createObjectStore("metadata")
        .add({ schema_version: schemaVersion }, "schema");
    };
    request.onblocked = () => {
      globalThis.clearTimeout(timer);
      abandoned = true;
      reject(new Error("LOCAL_STORAGE_BLOCKED"));
    };
    request.onerror = () => {
      globalThis.clearTimeout(timer);
      reject(
        new Error(
          request.error?.name === "VersionError"
            ? "UNSUPPORTED_VAULT_VERSION"
            : "LOCAL_STORAGE_UNAVAILABLE",
        ),
      );
    };
    request.onsuccess = () => {
      globalThis.clearTimeout(timer);
      if (abandoned) request.result.close();
      else resolve(request.result);
    };
  });
  let closed = false;
  const close = () => {
    closed = true;
    db.close();
  };
  db.onversionchange = close;
  function schema() {
    if (closed) fail("LOCAL_STORAGE_UNAVAILABLE");
    if (
      db.version !== 1 ||
      [...db.objectStoreNames].join(",") !== "metadata,records"
    )
      fail("UNSUPPORTED_VAULT_SCHEMA");
  }
  function transaction(mode, action) {
    return new Promise((resolve, reject) => {
      let tx, result, failure;
      const abort = (error) => {
        failure = error;
        try {
          tx.abort();
        } catch {
          /* already aborted */
        }
      };
      try {
        schema();
        tx = db.transaction(["metadata", "records"], mode);
        tx.oncomplete = () => resolve(result);
        tx.onabort = () =>
          reject(
            new Error(
              safeCodes.has(failure?.message)
                ? failure.message
                : tx.error?.name === "ConstraintError"
                  ? "DUPLICATE_LOCAL_RECORD"
                  : "LOCAL_STORAGE_FAILED",
            ),
          );
        tx.onerror = () => {}; // Never forward storage diagnostics or records.
        const store = tx.objectStore("records");
        if (
          store.keyPath !== "local_id" ||
          !store.autoIncrement ||
          [...store.indexNames].join(",") !== "credential,identity" ||
          store.index("credential").keyPath !== "claim_secret" ||
          !store.index("credential").unique ||
          store.index("credential").multiEntry ||
          JSON.stringify(store.index("identity").keyPath) !==
            '["market_id","ticket_id"]' ||
          !store.index("identity").unique ||
          store.index("identity").multiEntry ||
          tx.objectStore("metadata").keyPath !== null ||
          tx.objectStore("metadata").autoIncrement
        )
          fail("UNSUPPORTED_VAULT_SCHEMA");
        const metaKeys = tx.objectStore("metadata").getAllKeys();
        const meta = tx.objectStore("metadata").getAll();
        const records = store.getAll();
        records.onsuccess = () => {
          try {
            records.result.forEach(validate);
            const receipts = new Set();
            const schemaIndex = metaKeys.result.indexOf("schema");
            if (
              schemaIndex < 0 ||
              !exactKeys(meta.result[schemaIndex], ["schema_version"]) ||
              meta.result[schemaIndex].schema_version !== schemaVersion
            )
              fail("UNSUPPORTED_VAULT_SCHEMA");
            for (let i = 0; i < metaKeys.result.length; i++) {
              const key = metaKeys.result[i];
              if (key === "schema") continue;
              const receipt = meta.result[i];
              const record = records.result.find(
                (r) => key === `backup:${r.local_id}`,
              );
              if (
                !record ||
                record.state !== "FINALIZED" ||
                !exactKeys(receipt, [
                  "backup_version",
                  "market_id",
                  "ticket_id",
                  "claim_commitment",
                ]) ||
                receipt.backup_version !== 1 ||
                receipt.market_id !== record.market_id ||
                receipt.ticket_id !== record.ticket_id ||
                receipt.claim_commitment !== record.claim_commitment
              )
                fail("UNSUPPORTED_VAULT_SCHEMA");
              try {
                validateBackupIdentity(record);
              } catch {
                fail("UNSUPPORTED_VAULT_SCHEMA");
              }
              receipts.add(record.local_id);
            }
            result = action(
              store,
              records.result,
              tx.objectStore("metadata"),
              receipts,
            );
            if (result && typeof result.onsuccess !== "undefined") {
              const write = result;
              write.onsuccess = () => {
                result = write.result;
              };
            }
          } catch (error) {
            abort(error);
          }
        };
      } catch {
        if (tx) abort(new Error("UNSUPPORTED_VAULT_SCHEMA"));
        else
          reject(
            new Error(
              closed ? "LOCAL_STORAGE_UNAVAILABLE" : "UNSUPPORTED_VAULT_SCHEMA",
            ),
          );
      }
    });
  }
  const find = (records, id) => {
    if (!Number.isSafeInteger(id) || id < 1) fail("INVALID_LOCAL_RECORD");
    const record = records.find((value) => value.local_id === id);
    if (!record) fail("LOCAL_RECORD_NOT_FOUND");
    return record;
  };
  const saveReceipt = (metadata, record) =>
    metadata.put(
      {
        backup_version: 1,
        market_id: record.market_id,
        ticket_id: record.ticket_id,
        claim_commitment: record.claim_commitment,
      },
      `backup:${record.local_id}`,
    );
  try {
    await transaction("readonly", () => undefined);
  } catch (error) {
    close();
    throw error;
  }
  return Object.freeze({
    close,
    async list() {
      return transaction("readonly", (_store, records) => records.map(summary));
    },
    async createDraft() {
      let secret;
      try {
        secret = generateClaimSecret();
        return await transaction("readwrite", (store) =>
          store.add({
            state: "DRAFT",
            version: 1,
            network: "testnet",
            claim_secret: secret,
          }),
        );
      } catch {
        // RNG/storage errors can contain external diagnostics; surface fixed text only.
        fail("LOCAL_DRAFT_NOT_SAVED");
      } finally {
        secret?.fill(0);
      }
    },
    // Future trusted caller supplies already-issued final IDs. No issuance/handshake here.
    async finalize(localId, context) {
      if (
        !exactKeys(context, ["version", "network", "market_id", "ticket_id"]) ||
        context.version !== 1 ||
        context.network !== "testnet"
      )
        fail("INVALID_LOCAL_RECORD");
      identifier(context.market_id);
      identifier(context.ticket_id);
      const market_id = context.market_id,
        ticket_id = context.ticket_id;
      return transaction("readwrite", (store, records) => {
        const record = find(records, localId);
        if (record.state === "FINALIZED") {
          if (record.market_id !== market_id || record.ticket_id !== ticket_id)
            fail("LOCAL_RECORD_IMMUTABLE");
          return record.claim_commitment;
        }
        const finalized = {
          ...record,
          state: "FINALIZED",
          market_id,
          ticket_id,
        };
        finalized.claim_commitment = commitment(finalized);
        store.put(finalized);
        return finalized.claim_commitment;
      });
    },
    // Raw in-memory credential for future local claim integration, never a portable encoding.
    async readCredential(localId) {
      return transaction("readonly", (_store, records) => {
        const record = find(records, localId);
        return {
          version: record.version,
          network: record.network,
          claim_secret: record.claim_secret.slice(),
          ...(record.state === "FINALIZED"
            ? {
                market_id: record.market_id,
                ticket_id: record.ticket_id,
              }
            : {}),
        };
      });
    },
    // Trusted issuance caller only: invoked AFTER validated ISSUED and finalize.
    // This local marker is not a server signature, funding or eligibility proof.
    async recordIssued(localId, context) {
      if (!exactKeys(context, ["version", "network", "market_id", "ticket_id"]))
        fail("INVALID_LOCAL_RECORD");
      validateBackupIdentity(context);
      return transaction("readwrite", (_store, records, metadata) => {
        const record = find(records, localId);
        if (
          record.state !== "FINALIZED" ||
          record.market_id !== context.market_id ||
          record.ticket_id !== context.ticket_id
        )
          fail("TICKET_NOT_EXPORTABLE");
        saveReceipt(metadata, record);
      });
    },
    async canExport(localId) {
      return transaction("readonly", (_store, records, _metadata, receipts) => {
        find(records, localId);
        return receipts.has(localId);
      });
    },
    async exportBackup(localId) {
      return transaction("readonly", (_store, records, _metadata, receipts) => {
        const record = find(records, localId);
        if (!receipts.has(localId)) fail("TICKET_NOT_EXPORTABLE");
        return encodeTicketBackup(record);
      });
    },
    async importBackup(bytes) {
      const credential = decodeTicketBackup(bytes);
      try {
        return await transaction("readwrite", (store, records, metadata) => {
          const identity = records.find(
            (r) =>
              r.market_id === credential.market_id &&
              r.ticket_id === credential.ticket_id,
          );
          const matchingSecret = records.find((r) =>
            r.claim_secret.every((b, i) => b === credential.claim_secret[i]),
          );
          if (identity) {
            if (identity !== matchingSecret) fail("TICKET_BACKUP_CONFLICT");
            return "ALREADY_STORED";
          }
          if (matchingSecret) fail("TICKET_BACKUP_CONFLICT");
          const record = {
            state: "FINALIZED",
            ...credential,
            claim_commitment: commitment(credential),
          };
          const added = store.add(record);
          added.onsuccess = () => {
            try {
              saveReceipt(metadata, { ...record, local_id: added.result });
            } catch {
              store.transaction.abort();
            }
          };
          return "RESTORED";
        });
      } finally {
        credential.claim_secret.fill(0);
      }
    },
    async remove(localId, confirmRemoval) {
      if (typeof confirmRemoval !== "function")
        fail("LOCAL_CONFIRMATION_REQUIRED");
      const record = await transaction("readonly", (_store, records) =>
        find(records, localId),
      );
      try {
        let confirmed;
        try {
          confirmed = await confirmRemoval(summary(record));
        } catch {
          fail("LOCAL_CONFIRMATION_FAILED");
        }
        if (confirmed !== true) return false;
        return await transaction("readwrite", (store, records, metadata) => {
          if (!same(record, find(records, localId)))
            fail("LOCAL_RECORD_CHANGED");
          store.delete(localId);
          metadata.delete(`backup:${localId}`);
          return true;
        });
      } finally {
        record.claim_secret.fill(0);
      }
    },
    commitmentProfile: profile,
  });
}
