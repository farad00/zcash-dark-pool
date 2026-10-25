import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { psql } from "../test-fixtures.mjs";
import { migrateClaims } from "../claims-migrations.mjs";
import { provisionLockScript } from "../lock-provision.mjs";
import { provisionPublicationScript } from "../publication-provision.mjs";
import {
  provisionResolutionScript,
  registerOracleScript,
} from "../resolution-provision.mjs";
import { provisionClaimsScript } from "../claims-provision.mjs";
import { fixture, resources, json, id } from "./lock-fixtures.mjs";
import { deriveClaimCommitment } from "../../packages/protocol/src/claim-commitment.ts";
import { finalizeLock } from "../../services/lock/finalize.mts";
import { approveResolution } from "../../services/resolution/approve.mjs";
import { finalizeResolution } from "../../services/resolution/prepare.mjs";
import { persistPublication } from "../../services/publication/persist.mjs";
import {
  executable,
  syntheticRetrieval,
} from "../../services/publication/test/fixtures.mjs";
import {
  reserveDurableClaim,
  prepareDurablePayout,
} from "../../services/claims/reserve.mjs";
import { openLockSession } from "../../services/lock/db-session.mjs";

export const secret = () => new Uint8Array(32).fill(7); // Synthetic only.
const frozen = `SELECT jsonb_build_object('ledger',(SELECT jsonb_agg(to_jsonb(l) ORDER BY ticket_id) FROM darkpool_private.ledger_records l),
 'roots',(SELECT jsonb_agg(to_jsonb(c)) FROM darkpool_private.ledger_commitments c),
 'results',(SELECT jsonb_agg(to_jsonb(r)) FROM darkpool_private.resolution_results r),
 'entitlements',(SELECT jsonb_agg(to_jsonb(e) ORDER BY ticket_id) FROM darkpool_private.entitlements e),
 'receipts',(SELECT jsonb_agg(to_jsonb(p)) FROM darkpool_private.ledger_publication_receipts p),
 'market',(SELECT to_jsonb(m) FROM darkpool_private.markets m));`;

export async function claimFixture(
  { roles, password, issuer, addresses },
  work,
  options = {},
) {
  const database = "darkpool_phase9_" + randomBytes(8).toString("hex");
  const sql = (q) => psql(q, { database });
  let created = false;
  try {
    await psql(
      `CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8';`,
      { database: "postgres" },
    );
    created = true;
    await migrateClaims(database);
    await sql(provisionLockScript(roles.lock));
    await sql(
      provisionPublicationScript(roles.publication, database, issuer.trust),
    );
    await sql(provisionResolutionScript(roles.oracle, roles.coordinator));
    const f = fixture(Math.floor(Date.now() / 1000) + 5, options.count ?? 3);
    const observation = new Date(f.close * 1000)
      .toISOString()
      .replace(/(\.\d{3})Z$/, "$1000Z");
    const rule = {
      question: "Synthetic Phase 11 question",
      yes_definition: "Yes",
      no_definition: "No",
      resolution_rule: `Observe synthetic-source at ${observation}; YES if gauge >= 10; NO otherwise; VOID when ambiguous.`,
      resolution_sources: ["synthetic-source"],
      void_conditions: ["void"],
      rule_version: "synthetic-rule-v1",
    };
    const registration = {
      market_id: f.mid,
      oracle_login: roles.oracle,
      coordinator_login: roles.coordinator,
      actor_ref: "synthetic_operator",
      execution_class: "SYNTHETIC_TEST",
      rule,
      observation_at: observation,
      resources: {
        ...resources,
        max_tickets: resources.max_tickets.toString(),
        max_total_zat: ((1n << 128n) - 1n).toString(),
        max_numerator_zat_squared: ((1n << 256n) - 1n).toString(),
      },
    };
    const stake = options.stake ?? "1";
    for (const [index, o] of f.request.outputs.entries()) {
      o.amount_zat = stake;
      o.receiver_ref = addresses[index];
      o.journal_commitment = deriveClaimCommitment({
        version: 1,
        market_id: f.mid,
        ticket_id: id(index + 1),
        claim_secret: secret(),
      });
    }
    let setup =
      f.setup.slice(0, f.setup.indexOf("SELECT darkpool_watcher.reconcile")) +
      `SELECT darkpool_watcher.reconcile(0,${json(f.request)}); COMMIT;`;
    setup = setup
      .replace(
        "'Rule',ARRAY['synthetic-source']",
        `'${rule.resolution_rule}',ARRAY['synthetic-source']`,
      )
      .replaceAll(",1000,0,", `,${stake},0,`)
      .replaceAll(",1000,decode", `,${stake},decode`)
      .replace(",1,100000000,", ",1,100000000000000000,");
    for (let i = 0; i < (options.count ?? 3); i++) {
      const ticket = id(i + 1),
        commitment = deriveClaimCommitment({
          version: 1,
          market_id: f.mid,
          ticket_id: ticket,
          claim_secret: secret(),
        });
      setup = setup.replaceAll(`synthetic-receiver-${i + 1}`, addresses[i]);
      setup = setup
        .split(/\r?\n/)
        .map((line) =>
          line.startsWith(`INSERT INTO tickets VALUES('${ticket}'`) ||
          line.startsWith(
            `INSERT INTO issuance_attempts VALUES(decode('${ticket}'`,
          )
            ? line.replace(
                "decode(repeat('ab',32),'hex')",
                `decode('${commitment}','hex')`,
              )
            : line,
        )
        .join("\n");
    }
    setup = setup.replace(
      "UPDATE markets SET status='OPEN';",
      registerOracleScript(registration) +
        "\nUPDATE markets SET status='OPEN';",
    );
    await sql(setup);
    await sql(
      provisionClaimsScript(
        roles.claim,
        f.mid,
        options.claimClass ?? "SYNTHETIC_TEST",
      ),
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, f.close * 1000 - Date.now() + 10)),
    );
    const env = (kind) => ({
      ...process.env,
      PGDATABASE: database,
      PGUSER: roles[kind],
      PGPASSWORD: password,
      APP_ENV: "development",
      ZCASH_NETWORK: "testnet",
      DARKPOOL_LOCK_INTERNAL: "1",
    });
    const locked = await finalizeLock(f.lockRequest, resources, env("lock"));
    if (!options.pending) {
      await new Promise((resolve) => setTimeout(resolve, 1010));
      const proof = await issuer.evidence(locked.commitment);
      await persistPublication(
        f.mid,
        proof,
        issuer.trust,
        executable,
        env("publication"),
        syntheticRetrieval(proof),
      );
    }
    if (!options.pending && !options.missingResolution) {
      await approveResolution(
        {
          request_key: "synthetic_resolution_request",
          market_id: f.mid,
          expected_revision: "2",
          expected_root: locked.commitment.merkle_root,
          resolution_id: "synthetic_resolution",
          outcome: options.outcome ?? "YES",
          evidence: ["synthetic-source:observation"],
          rule_version: rule.rule_version,
          review: {
            decision: options.outcome === "VOID" ? "AMBIGUOUS" : "DEFENSIBLE",
            source_ref: "synthetic-source",
            observation_at: observation,
            rationale: "Synthetic objective review",
          },
          authorize_entitlements: true,
        },
        env("oracle"),
      );
      await finalizeResolution(
        "synthetic_resolution_request",
        env("coordinator"),
      );
    }
    const request = {
      market_id: f.mid,
      ticket_id: id(1),
      claim_secret: secret(),
      payout_ua: addresses[4],
      idempotency_key: "synthetic_claim_1",
    };
    const baseline = JSON.parse(await sql(frozen));
    await work({
      ...f,
      database,
      sql,
      env,
      locked,
      request,
      addresses,
      reserve: (q = request, kind = "claim") =>
        reserveDurableClaim(q, env(kind)),
      prepare: (q = request) => prepareDurablePayout(q, env("claim")),
      query: async (statement, kind = "claim") => {
        const s = await openLockSession(env(kind));
        try {
          return await s.query(statement);
        } finally {
          await s.close();
        }
      },
    });
    if (!options.corrupt)
      assert.deepEqual(
        JSON.parse(await sql(frozen)),
        baseline,
        "claims must not rewrite source evidence or entitlements",
      );
  } finally {
    if (created) {
      assert.match(database, /^darkpool_phase9_[a-f0-9]{16}$/);
      await psql(`DROP DATABASE "${database}";`, { database: "postgres" });
    }
  }
}
