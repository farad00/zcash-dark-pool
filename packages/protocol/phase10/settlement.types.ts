import type { Ticket, Resolution } from "../src/domain.ts";
import { calculateSubsidizedSettlement } from "./settlement.ts";
import type { SettlementPolicy } from "./settlement.ts";

declare const accepted: readonly Pick<
  Ticket,
  "ticket_id" | "side" | "accepted_amount_zat"
>[];
declare const outcome: Resolution["outcome"];
declare const policy: SettlementPolicy;
const result = calculateSubsidizedSettlement(accepted, outcome, policy);
const amount: bigint = result.distributable_pool_zat;
void amount;
calculateSubsidizedSettlement(
  // @ts-expect-error No floating-point currency API.
  [{ ticket_id: accepted[0]!.ticket_id, side: "YES", accepted_amount_zat: 1 }],
  "YES",
  policy,
);
// @ts-expect-error There is no default financial policy.
calculateSubsidizedSettlement(accepted, "YES");
// @ts-expect-error Results must not be mutated by claim processing.
result.total_refund_zat = 1n;
