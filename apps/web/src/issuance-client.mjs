// Browser-only pending attempts. Separate from Phase 6 credentials; not a backup format.
import { deriveClaimCommitment } from "./claim-commitment.js";
import {
  paymentStatusPacket,
  paymentStatusResult,
} from "./payment-status-wire.mjs";
const name = "darkpool-pending-issuance";
const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const validHex = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const fail = () => {
  throw new Error("ISSUANCE_NOT_FINALIZED");
};
function validate(r) {
  if (
    !r ||
    Object.keys(r).sort().join(",") !==
      "issuance_token,local_id,market_id,requested_amount_zat,secret_tag,side,ticket_id,version" ||
    r.version !== 1 ||
    !Number.isSafeInteger(r.local_id) ||
    r.local_id < 1 ||
    !validHex(r.issuance_token) ||
    !validHex(r.secret_tag) ||
    typeof r.market_id !== "string" ||
    !r.market_id.length ||
    !r.market_id.isWellFormed() ||
    r.market_id.includes("\0") ||
    new TextEncoder().encode(r.market_id).length > 8192 ||
    !["YES", "NO"].includes(r.side) ||
    typeof r.requested_amount_zat !== "string" ||
    r.requested_amount_zat.length > 1024 ||
    !/^[1-9][0-9]*$/.test(r.requested_amount_zat) ||
    (r.ticket_id !== null && !validHex(r.ticket_id))
  )
    fail();
}
async function open() {
  if (!globalThis.isSecureContext || !globalThis.indexedDB) fail();
  return new Promise((done, reject) => {
    const request = globalThis.indexedDB.open(name, 1);
    let abandoned = false;
    const timer = setTimeout(() => {
      abandoned = true;
      reject(new Error("ISSUANCE_NOT_FINALIZED"));
    }, 3000);
    request.onupgradeneeded = (event) => {
      if (event.oldVersion !== 0) {
        request.transaction.abort();
        return;
      }
      request.result
        .createObjectStore("attempts", { keyPath: "local_id" })
        .createIndex("token", "issuance_token", { unique: true });
    };
    request.onerror = request.onblocked = () => {
      clearTimeout(timer);
      abandoned = true;
      reject(new Error("ISSUANCE_NOT_FINALIZED"));
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (abandoned) request.result.close();
      else done(request.result);
    };
  });
}
export async function openIssuanceClient(vault) {
  const db = await open();
  db.onversionchange = () => db.close();
  const transact = (action) =>
    new Promise((done, reject) => {
      let tx;
      try {
        if (
          db.version !== 1 ||
          [...db.objectStoreNames].join(",") !== "attempts"
        )
          fail();
        tx = db.transaction("attempts", "readwrite");
        const store = tx.objectStore("attempts");
        if (
          store.keyPath !== "local_id" ||
          store.autoIncrement ||
          [...store.indexNames].join(",") !== "token" ||
          !store.index("token").unique ||
          store.index("token").keyPath !== "issuance_token" ||
          store.index("token").multiEntry
        )
          fail();
        let result;
        tx.oncomplete = () => done(result);
        tx.onabort = () => reject(new Error("ISSUANCE_NOT_FINALIZED"));
        tx.onerror = () => {};
        const all = store.getAll();
        all.onsuccess = () => {
          try {
            all.result.forEach(validate);
            result = action(store, all.result);
          } catch {
            tx.abort();
          }
        };
      } catch {
        try {
          tx?.abort();
        } catch {
          /* ended */
        }
        reject(new Error("ISSUANCE_NOT_FINALIZED"));
      }
    });
  await transact(() => undefined);
  const request = async (input) => {
    let response;
    try {
      response = await fetch("/api/issuance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        body: JSON.stringify(input),
      });
    } catch {
      fail();
    }
    if (!response.ok) {
      let code;
      try {
        code = (await response.json()).error;
      } catch {
        fail();
      }
      throw new Error(
        code === "ISSUANCE_CONFLICT"
          ? "ISSUANCE_CONFLICT"
          : "ISSUANCE_NOT_FINALIZED",
      );
    }
    try {
      return await response.json();
    } catch {
      fail();
    }
  };
  function context(response, attempt, status) {
    const keys = [
      "issuance_profile_version",
      "network",
      "market_id",
      "ticket_id",
      "status",
      "closes_at",
    ];
    if (status === "ISSUED") keys.push("receiving_ua");
    if (
      !response ||
      Object.keys(response).sort().join(",") !== keys.sort().join(",") ||
      response.issuance_profile_version !== 1 ||
      response.network !== "testnet" ||
      response.market_id !== attempt.market_id ||
      response.status !== status ||
      !validHex(response.ticket_id) ||
      (attempt.ticket_id !== null &&
        response.ticket_id !== attempt.ticket_id) ||
      typeof response.closes_at !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(response.closes_at) ||
      !Number.isFinite(Date.parse(response.closes_at)) ||
      (status === "ISSUED" &&
        (typeof response.receiving_ua !== "string" ||
          response.receiving_ua.length > 1024 ||
          !/^utest1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(
            response.receiving_ua,
          )))
    )
      fail();
  }
  return Object.freeze({
    close: () => db.close(),
    // Browser-local context only. Never expose the issuance capability or secret tag.
    async savedSelection(local_id) {
      return transact((store, all) => {
        const r = all.find((r) => r.local_id === local_id);
        return r ? Object.freeze({ market_id: r.market_id }) : null;
      });
    },
    async paymentStatus(local_id) {
      const credential = await vault.readCredential(local_id);
      try {
        const secret_tag = hex(
          new Uint8Array(
            await globalThis.crypto.subtle.digest(
              "SHA-256",
              credential.claim_secret,
            ),
          ),
        );
        const attempt = await transact((store, all) =>
          all.find((r) => r.local_id === local_id),
        );
        if (
          !attempt ||
          attempt.secret_tag !== secret_tag ||
          !credential.ticket_id ||
          attempt.ticket_id !== credential.ticket_id ||
          attempt.market_id !== credential.market_id
        )
          fail();
        const input = paymentStatusPacket({
          market_id: attempt.market_id,
          ticket_id: attempt.ticket_id,
          issuance_token: attempt.issuance_token,
        });
        const response = await fetch("/api/payment-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "omit",
          cache: "no-store",
          referrerPolicy: "no-referrer",
          body: JSON.stringify(input),
        });
        if (!response.ok) fail();
        return paymentStatusResult(await response.json());
      } catch {
        throw new Error("PAYMENT_STATUS_UNAVAILABLE");
      } finally {
        credential.claim_secret.fill(0);
      }
    },
    async issue(local_id, selection) {
      const credential = await vault.readCredential(local_id);
      try {
        const secret_tag = hex(
          new Uint8Array(
            await globalThis.crypto.subtle.digest(
              "SHA-256",
              credential.claim_secret,
            ),
          ),
        );
        let attempt = await transact((store, all) => {
          const previous = all.find((r) => r.local_id === local_id);
          if (previous) {
            if (
              previous.secret_tag !== secret_tag ||
              (selection &&
                (previous.market_id !== selection.market_id ||
                  previous.side !== selection.side ||
                  previous.requested_amount_zat !==
                    selection.requested_amount_zat))
            )
              throw new Error();
            return previous;
          }
          if (
            credential.ticket_id ||
            !selection ||
            Object.keys(selection).sort().join(",") !==
              "market_id,requested_amount_zat,side"
          )
            throw new Error();
          const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
          const issuance_token = hex(bytes);
          bytes.fill(0);
          const created = {
            version: 1,
            local_id,
            secret_tag,
            issuance_token,
            ...selection,
            ticket_id: null,
          };
          validate(created);
          store.add(created);
          return created;
        });
        // Revalidate the saved immutable selection on EVERY recovery. Completion
        // does not echo amount/side; reserve rejects changed saved selections.
        {
          const reserved = await request({
            operation: "reserve",
            issuance_token: attempt.issuance_token,
            market_id: attempt.market_id,
            side: attempt.side,
            requested_amount_zat: attempt.requested_amount_zat,
          });
          context(reserved, attempt, "RESERVED");
          if (attempt.ticket_id === null)
            attempt = await transact((store, all) => {
              const r = all.find((r) => r.local_id === local_id);
              if (
                !r ||
                r.issuance_token !== attempt.issuance_token ||
                r.secret_tag !== attempt.secret_tag ||
                r.market_id !== attempt.market_id ||
                r.side !== attempt.side ||
                r.requested_amount_zat !== attempt.requested_amount_zat ||
                (r.ticket_id !== null && r.ticket_id !== reserved.ticket_id)
              )
                throw new Error();
              const updated = { ...r, ticket_id: reserved.ticket_id };
              store.put(updated);
              return updated;
            });
        }
        if (
          credential.ticket_id &&
          (credential.ticket_id !== attempt.ticket_id ||
            credential.market_id !== attempt.market_id)
        )
          fail();
        const claim_commitment = deriveClaimCommitment({
          version: 1,
          market_id: attempt.market_id,
          ticket_id: attempt.ticket_id,
          claim_secret: credential.claim_secret,
        });
        const issued = await request({
          operation: "complete",
          issuance_token: attempt.issuance_token,
          ticket_id: attempt.ticket_id,
          claim_commitment,
          claim_commitment_profile: "DARKPOOL_CLAIM_V1_ID_FRAME_1",
        });
        context(issued, attempt, "ISSUED");
        // finalize is atomic/idempotent and keeps the original Phase 6 secret.
        const saved = await vault.finalize(local_id, {
          version: 1,
          network: "testnet",
          market_id: issued.market_id,
          ticket_id: issued.ticket_id,
        });
        if (saved !== claim_commitment) fail();
        await vault.recordIssued(local_id, {
          version: 1,
          network: "testnet",
          market_id: issued.market_id,
          ticket_id: issued.ticket_id,
        });
        // Retain pending capability for same-attempt retries; it is never exported.
        return Object.freeze({
          status: "ISSUED",
          market_id: issued.market_id,
          ticket_id: issued.ticket_id,
          payment: Object.freeze({
            receiving_ua: issued.receiving_ua,
            requested_amount_zat: attempt.requested_amount_zat,
            closes_at: issued.closes_at,
          }),
        });
      } catch (error) {
        throw new Error(
          error.message === "ISSUANCE_CONFLICT"
            ? "ISSUANCE_CONFLICT"
            : "ISSUANCE_NOT_FINALIZED",
        );
      } finally {
        credential.claim_secret.fill(0);
      }
    },
  });
}
