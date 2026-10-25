import { prepareResolutionSettlement } from "./preparation.ts";
import type {
  LockedSnapshot,
  PreparationRequest,
  PreparationConfiguration,
  SettlementPreparation,
} from "./preparation.ts";
declare const snapshot: LockedSnapshot;
declare const request: PreparationRequest;
declare const config: PreparationConfiguration;
const result: SettlementPreparation = prepareResolutionSettlement(
  snapshot,
  request,
  config,
  null,
);
const amount: bigint = result.calculation.total_accepted_zat;
void amount;
// @ts-expect-error Preparation never authorizes lifecycle transitions.
const authorized: true = result.lifecycle_authorized;
void authorized;
// @ts-expect-error No floating-point revision API.
const badRevision: PreparationRequest = { ...request, expected_revision: 1 };
void badRevision;
prepareResolutionSettlement(
  snapshot,
  request,
  // @ts-expect-error No default oracle review or assumed oracle authority.
  {
    commitment: config.commitment,
    oracle_rule: config.oracle_rule,
    ledger_limits: config.ledger_limits,
    settlement_policy: config.settlement_policy,
  },
  null,
);
// @ts-expect-error No transaction authorization plan or implicit hash is defined.
void result.plan_hash;
// @ts-expect-error Private preparation output is immutable.
result.binding.resolution.outcome = "NO";
