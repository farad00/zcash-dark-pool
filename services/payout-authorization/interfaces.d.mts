/** Trusted internal interfaces still requiring implementation. These DTOs and
 * reference strings alone are NOT verification capabilities or authority. */
export interface PayoutBinding {
  readonly intent_id: string;
  readonly review_id: string;
  readonly network: "testnet";
  readonly execution_class: "EXTERNAL" | "SYNTHETIC_TEST";
  readonly approved_plan_digest: string;
  readonly entitlement_total_zat: bigint;
  readonly fee_ceiling_zat: bigint;
}
export type Unavailable = Readonly<{ status: "UNAVAILABLE"; reason: string }>;
export interface FeeReserveVerifier {
  verify(
    binding: PayoutBinding,
    actualFeeZat: bigint,
  ): Promise<
    | Unavailable
    | Readonly<{
        status: "VERIFIED";
        binding: PayoutBinding;
        actual_fee_zat: bigint;
        verified_external_reserve_zat: bigint;
        external_allocation_ref: string;
        unique_input_reservation_ref: string;
        canonical_wallet_snapshot_ref: string;
        preserved_liabilities_zat: bigint;
      }>
  >;
}
export interface SignedArtifactVerifier {
  verify(
    binding: PayoutBinding,
    exactBytes: Uint8Array,
  ): Promise<
    | Unavailable
    | Readonly<{
        status: "VERIFIED";
        binding: PayoutBinding;
        native_zcash_txid: string;
        bytes_sha256: string;
        signer_authority_ref: string;
        exclusive_control_ref: string;
        actual_fee_zat: bigint;
        reviewed_outputs_and_change_ref: string;
      }>
  >;
}
export interface SignedArtifactRepository {
  /** Must write exact bytes and wallet/intent association durably, then return
   * only after verified readback AND acknowledged commit. Never broadcast. */
  retain(
    binding: PayoutBinding,
    exactBytes: Uint8Array,
    nativeTxid: string,
  ): Promise<
    | Unavailable
    | Readonly<{
        status: "COMMITTED";
        binding: PayoutBinding;
        native_zcash_txid: string;
        bytes_sha256: string;
        wallet_association_ref: string;
        durable_receipt_ref: string;
      }>
  >;
}
export interface CanonicalChainVerifier {
  verify(
    binding: PayoutBinding,
    nativeTxid: string,
  ): Promise<
    | Unavailable
    | Readonly<{
        status: "CANONICAL" | "UNMINED" | "REORG" | "SPEND_CONFLICT";
        binding: PayoutBinding;
        native_zcash_txid: string;
        tip_height: bigint;
        tip_hash: string;
        inclusion_height: bigint | null;
        inclusion_hash: string | null;
        synchronized_wallet_ref: string;
        canonical_evidence_ref: string;
      }>
  >;
}
/** Intentionally no signer/broadcaster implementation or interface returning
 * spending_authorized:true in this increment. No default mock or demo adapter. */
