import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { resolve } from "node:path";
import { privateProcess } from "../../services/backup/crypto.mjs";
import {
  withSyntheticLifecycle,
  assertSyntheticLifecycle,
  resources,
} from "./lifecycle-fixtures.mjs";
import {
  authority,
  executable,
  syntheticRetrieval,
} from "../../services/publication/test/fixtures.mjs";
import { finalizeLock } from "../../services/lock/finalize.mts";
import { persistPublication } from "../../services/publication/persist.mjs";
import { approveResolution } from "../../services/resolution/approve.mjs";
import { finalizeResolution } from "../../services/resolution/prepare.mjs";
import { createParticipantClaims } from "../../services/claims/participant.mjs";
import {
  createClaimServer,
  NOT_CONFIRMED,
} from "../../apps/web/src/claim-server.mjs";
import { createPublicReader } from "../public-read.mjs";
let publisher, addresses;
before(async () => {
  assertSyntheticLifecycle();
  publisher = await authority();
  addresses = JSON.parse(
    (
      await privateProcess(
        resolve("target/debug/examples/phase14-claim-fixture.exe"),
        [],
        Buffer.alloc(0),
        16384,
        { DARKPOOL_SYNTHETIC_TEST: "1" },
      )
    ).toString(),
  );
});
after(async () => {
  await publisher?.close();
});
const wait = async (ms) => {
  if (ms > Date.now()) await new Promise((r) => setTimeout(r, ms - Date.now()));
};
for (const outcome of ["YES", "VOID", "NO"])
  test(
    `private HTTP durable claims: ${outcome === "NO" ? "no-winner refund" : outcome}`,
    { timeout: 150000 },
    async (t) => {
      await withSyntheticLifecycle(publisher, addresses, async (f) => {
        let server, base, packet, claims, locked;
        const send = async (p = packet, route = "/api/claim") => {
          const r = await fetch(base + route, {
            method: "POST",
            headers: { Origin: base, "Content-Type": "application/json" },
            body: JSON.stringify(p),
          });
          return { code: r.status, body: await r.json() };
        };
        const count = () =>
          f.sql("SELECT count(*) FROM darkpool_private.claim_reservations;");
        try {
          await t.test(
            "restricted sessions reject incorrect role and development-only V2 before connection",
            async () => {
              await assert.rejects(
                createParticipantClaims({
                  env: { ...f.env("claim"), PGPORT: "55435" },
                }),
              );
              await assert.rejects(
                createParticipantClaims({
                  env: f.env("other"),
                  syntheticTest: true,
                }),
              );
              await assert.rejects(
                createParticipantClaims({
                  env: f.env("admin"),
                  syntheticTest: true,
                }),
              );
              await assert.rejects(
                f.roleQuery(
                  "read",
                  "SELECT to_jsonb(c) FROM darkpool_private.claim_reservations c;",
                ),
              );
            },
          );
          await f.admin("create", {
            request_key: "create",
            expected_revision: null,
            configuration: f.configuration,
          });
          await f.register();
          await f.admin("open", {
            request_key: "open",
            expected_revision: "1",
          });
          for (const side of ["YES", outcome === "NO" ? "YES" : "NO", "YES"])
            await f.createTicket(side, "2");
          claims = await createParticipantClaims({
            env: f.env("claim"),
            syntheticTest: true,
          });
          const readMarket = await createPublicReader(f.env("read"));
          server = createClaimServer({ claims, readMarket });
          await new Promise((r) => server.listen(0, "127.0.0.1", r));
          base = `http://127.0.0.1:${server.address().port}`;
          const ticket = f.tickets[0];
          packet = {
            market_id: f.mid,
            ticket_id: ticket.id,
            claim_secret: Buffer.from(ticket.secret).toString("hex"),
            payout_ua: addresses[3],
            idempotency_key: `participant_v1_${ticket.id}`,
          };
          await t.test(
            "OPEN and pending publication cannot reserve",
            async () => {
              assert.deepEqual((await send()).body, NOT_CONFIRMED);
              assert.equal(await count(), "0");
              await wait(f.close * 1000 + 10);
              await f.watcher.reconcile(0, f.payment());
              locked = await finalizeLock(
                f.lockRequest,
                resources,
                f.env("lock"),
              );
              assert.deepEqual((await send()).body, NOT_CONFIRMED);
              assert.equal(await count(), "0");
            },
          );
          await wait(Date.parse(locked.commitment.locked_at) + 1100);
          const proof = await publisher.evidence(locked.commitment);
          await persistPublication(
            f.mid,
            proof,
            publisher.trust,
            executable,
            f.env("publication"),
            syntheticRetrieval(proof),
          );
          await t.test(
            "verified receipt without durable resolution remains unavailable",
            async () => {
              assert.deepEqual((await send()).body, NOT_CONFIRMED);
              assert.equal(await count(), "0");
            },
          );
          const q = {
            request_key: "participant_resolution",
            market_id: f.mid,
            expected_revision: locked.revision,
            expected_root: locked.commitment.merkle_root,
            resolution_id: "participant_resolution_v1",
            outcome,
            evidence: ["synthetic-source:objective-observation"],
            rule_version: f.rule.rule_version,
            review: {
              decision: outcome === "VOID" ? "AMBIGUOUS" : "DEFENSIBLE",
              source_ref: "synthetic-source",
              observation_at: f.observation,
              rationale: "Synthetic declared objective review",
            },
            authorize_entitlements: true,
          };
          await approveResolution(q, f.env("oracle"));
          await finalizeResolution(q.request_key, f.env("coordinator"));
          await t.test(
            "default external policy rejects synthetically verified publication",
            async () => {
              const external = await createParticipantClaims({
                env: f.env("claim"),
              });
              await assert.rejects(external.reserve(packet));
              assert.equal(await count(), "0");
            },
          );
          await t.test(
            "wrong bearer, unknown ticket and malformed/transparent destinations redact identically",
            async () => {
              for (const p of [
                { ...packet, claim_secret: "00".repeat(32) },
                {
                  ...packet,
                  ticket_id: "ff".repeat(32),
                  idempotency_key: `participant_v1_${"ff".repeat(32)}`,
                },
                { ...packet, payout_ua: "tmTransparent" },
                { ...packet, payout_ua: "utest1qqqqqq" },
              ]) {
                const r = await send(p);
                assert.equal(r.code, 409);
                assert.deepEqual(r.body, NOT_CONFIRMED);
              }
              assert.equal(await count(), "0");
            },
          );
          await t.test(
            "eligible winning/refund claim is atomic; concurrent retries create one obligation",
            async () => {
              const attempts = await Promise.all([send(), send(), send()]);
              assert(attempts.some((r) => r.code === 200));
              for (const r of attempts) assert([200, 409].includes(r.code));
              assert.equal(await count(), "1");
              const retry = await send();
              assert.equal(retry.code, 200);
              assert.deepEqual(retry.body, {
                status: "RESERVED",
                payment: "NOT_SENT",
                environment: "SYNTHETIC_TEST_ONLY",
              });
              const original = await f.sql(
                "SELECT jsonb_agg(to_jsonb(c)) FROM darkpool_private.claim_reservations c;",
              );
              assert.deepEqual((await send()).body, retry.body);
              assert.equal(
                await f.sql(
                  "SELECT jsonb_agg(to_jsonb(c)) FROM darkpool_private.claim_reservations c;",
                ),
                original,
              );
              assert.deepEqual(
                (await send({ ...packet, payout_ua: addresses[4] })).body,
                NOT_CONFIRMED,
              );
              assert.equal(
                await f.sql(
                  "SELECT jsonb_agg(to_jsonb(c)) FROM darkpool_private.claim_reservations c;",
                ),
                original,
              );
              const amount = JSON.parse(
                await f.sql(
                  "SELECT jsonb_build_object('claim',(SELECT record#>>'{binding,amount_zat}' FROM darkpool_private.claim_reservations),'entitlement',(SELECT amount_zat::text FROM darkpool_private.entitlements WHERE ticket_id='" +
                    ticket.id +
                    "'));",
                ),
              );
              assert.equal(amount.claim, amount.entitlement);
            },
          );
          await t.test(
            "loser rejection or full refunds; public status contains no ticket/credential/destination",
            async () => {
              const other = f.tickets[1];
              const p = {
                ...packet,
                ticket_id: other.id,
                claim_secret: Buffer.from(other.secret).toString("hex"),
                idempotency_key: `participant_v1_${other.id}`,
                payout_ua: addresses[4],
              };
              const r = await send(p);
              if (outcome === "YES") {
                assert.equal(r.code, 409);
                assert.deepEqual(r.body, NOT_CONFIRMED);
              } else {
                assert.equal(r.code, 200);
                assert.equal(r.body.status, "RESERVED");
              }
              const status = await (
                await fetch(base + "/api/claim-market")
              ).json();
              assert.deepEqual(Object.keys(status.market).sort(), [
                "market_id",
                "question",
                "state",
              ]);
              const text = JSON.stringify(status);
              for (const secret of [
                packet.ticket_id,
                packet.claim_secret,
                packet.payout_ua,
                "amount_zat",
                "blindings",
              ])
                assert(!text.includes(secret));
              assert.equal(
                status.market.state,
                outcome === "VOID" ? "REFUNDING" : "PAYING",
              );
              assert.equal(
                await f.sql(
                  "SELECT count(*) FROM darkpool_private.claim_instruction_outbox;",
                ),
                "0",
              );
            },
          );
        } finally {
          if (server) await new Promise((r) => server.close(r));
        }
      });
    },
  );
