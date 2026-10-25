import { verifyClaim, preparePayout, reserveClaim } from "./claim.mts";
import type {
  ClaimRequest,
  ClaimContext,
  ClaimChecks,
  ClaimReservation,
} from "./claim.mts";
declare const request: ClaimRequest;
declare const context: ClaimContext;
declare const checks: ClaimChecks;
declare const reserved: ClaimReservation;
const proposed = await verifyClaim(request, context, checks);
const amount: bigint = preparePayout(reserveClaim(proposed, null).next).next
  .binding.amount_zat;
void amount;
// @ts-expect-error Bare ticket ID or hex string is not the original byte credential.
const wrong: ClaimRequest = { ...request, claim_secret: "00" };
void wrong;
// @ts-expect-error No default authority, destination or freshness policy.
await verifyClaim(request, context, {});
// @ts-expect-error Payout instruction cannot authorize spending.
const spend: true =
  preparePayout(reserved).next.instruction!.spending_authorized;
void spend;
// @ts-expect-error No mutation of the bound payout destination.
proposed.binding.payout_ua = "changed";
