// Approved, isolated public diagnostic destination. No policy activation or receipt.
import destination from "./synthetic/github-destination.json" with { type: "json" };
import envelope from "./synthetic/envelope.json" with { type: "json" };
import proposed from "./synthetic/witness-config.proposed.json" with { type: "json" };
import realDestination from "../../services/publication/github-destination.json" with { type: "json" };
import {
  canonical,
  exact,
  envelopeBytes,
  sha256,
} from "../../services/publication/profile.mjs";
import { prepareGitHubPublication } from "../../services/publication/github.mjs";

export const SYNTHETIC_SCOPE = "SYNTHETIC_TEST_ONLY";
export const SYNTHETIC_POLICY = "common_control_synthetic_roundtrip_20261021";
export const syntheticEnvelope = Object.freeze(envelope);
export const syntheticDestination = Object.freeze(destination);
export function operationalDestination(config) {
  if (canonical(config.destination) === canonical(realDestination))
    return "REAL_PATH";
  if (
    canonical(config.destination) !== canonical(destination) ||
    config.trust.policy_ref !== SYNTHETIC_POLICY
  )
    throw new Error("WITNESS_DESTINATION_REJECTED");
  return SYNTHETIC_SCOPE;
}
export function requireSyntheticEnvelope(input) {
  if (canonical(input) !== canonical(envelope))
    throw new Error("SYNTHETIC_ENVELOPE_MISMATCH");
}
// Public observation capability only. Never returns or constructs READY trust.
// TSA material is not used to observe GitHub; receipt verification still validates it.
export function requireSyntheticCaptureConfiguration(config) {
  exact(config.trust, Object.keys(proposed.trust));
  if (
    operationalDestination(config) !== SYNTHETIC_SCOPE ||
    config.trust.status !== "UNAVAILABLE" ||
    config.trust.evidence_class !== "EXTERNAL" ||
    config.archive_origin !== proposed.archive_origin ||
    config.archive_base_path !== proposed.archive_base_path ||
    config.trust.archive_origin !== config.archive_origin ||
    config.trust.repository !== destination.repository ||
    config.trust.path !== destination.path ||
    config.trust.witness_spki !== proposed.trust.witness_spki
  )
    throw new Error("SYNTHETIC_CAPTURE_CONFIGURATION_REJECTED");
}
export function syntheticPlan() {
  if (
    destination.path === realDestination.path ||
    !envelope.market_id.startsWith(SYNTHETIC_SCOPE + ":") ||
    envelope.accepted_ticket_count !== "0"
  )
    throw new Error("SYNTHETIC_ISOLATION_REJECTED");
  return prepareGitHubPublication(envelope, destination);
}
export const syntheticRecord = () => sha256(Buffer.from(envelope.market_id));
export const syntheticDigest = () => sha256(envelopeBytes(envelope));
