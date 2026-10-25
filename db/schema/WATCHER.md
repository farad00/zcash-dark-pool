# Private Phase 9 watcher schema

`0005_phase9_watcher.sql` follows all four historical migrations in one
transaction using the existing checksum/advisory-lock migration runner. It adds
exactly two private tables. It creates no roles, market, wallet or live binding.
Do not use `product-db.ps1 migrate` for Phase 9: the existing
`darkpool_product_dev` is outside this implementation's authorized provisioning.

| Table              | Responsibility                                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watcher_state`    | One immutable market/profile/account/endpoint/pre-OPEN anchor/deadline binding, serialized revision, last successful complete reconciliation reference, sticky hold reference.    |
| `watcher_evidence` | Append-only profile, targeted observations, inclusion/reclassification decisions, acceptance proof, minimal MTP boundary window, reconciliation receipt and safety-stop evidence. |

The existing `payment_receipts` retains stable output identity, original issued
receiver, whole integer principal and current canonical inclusion. Existing
`accepted_payments`, `accepted_payment_receipts` and `tickets` represent one
accepted output and its exact stake. Existing `payment_liabilities` retains
non-qualifying principal with unresolved return policy; no entitlement or refund
claim is created. Under/over/late/additional classification never increases stake.
Pending/orphan states retain historical principal without asserting spendability.
If an unaccepted note is re-mined into a qualifying decision, any historical
liability row is retained with `phase9-accepted`; membership remains authoritative
and that row must not be counted as current exception principal.

## Runtime capability

The dedicated authenticated login receives schema USAGE and EXECUTE on exactly:

```sql
darkpool_watcher.context()
darkpool_watcher.reconcile(bigint,jsonb)
```

It receives no table access, helper execution, owner privileges, role memberships,
admin, issuance, public-reader or signing capabilities. The runtime checks these
conditions on every connection. `db/watcher-provision.mjs` is maintenance-only and
rolls back grants if this check fails. Trigger functions are private helpers,
not additional runtime capabilities. Both entrypoints use SECURITY DEFINER and
fixed `pg_catalog` search paths with qualified application relations.

## Reconciliation

`context()` fails closed unless there is exactly one market and a corresponding
binding. It returns private receipt identity/mapping and retained unmapped
observations, account UUID, frozen anchor and revision. It returns no UFVK, seed,
claim secret or side selection. This object never crosses a public endpoint.

`reconcile(expected_revision, request)` locks the market, then state. A 256-bit
request ID and SHA-256 of PostgreSQL's JSONB representation identify the durable
commit receipt. An identical retry returns its original result even with the old
revision or an expired snapshot; changed content with that ID fails. A new
request requires the current revision. Concurrent requests serialize; stale
ones fail instead of merging incomplete snapshots.

The version-1 private object contains network/context binding, request ID, mode,
outputs and, for snapshot mode, a chain proof. Unknown top-level, output and
chain fields reject. Bodies and IPC frames are limited to 4 MiB and 4,096 notes.
Times/heights/indices are checked integers; principal is decimal integer text.
`verified_at` is a fresh operational UTC time, distinct from block eligibility.
Rust's integer epoch freshness value is normalized by Node; it does not decide
economic eligibility. SQL also requires complete/verified booleans, identical
tip/scanned height and hash, anchor continuity, complete retained identities,
consistent containing-block timestamps/hashes and the preceding-11 MTP window.

- `observe_only`: retain only previously unretained observations before sync can
  de-mine/delete them. Mapped principal uses existing receipts; raw inclusion and
  mapping are retained in append-only observation evidence. Unmapped principal
  remains restricted observation evidence without guessing a ticket/receiver.
  This mode never accepts and never advances the complete-scan checkpoint.
- `snapshot`: validate all contradictions first, reclassify unaccepted receipts,
  retain exceptions, select the earliest exact output by height/transaction
  index/pool code/output index, and accept at containing height + 2. Group,
  singleton membership, CONFIRMED/exact amount/DB acceptance time, immutable
  evidence and TICKET_CONFIRMED audit commit together. PAUSED/frozen/held markets
  cannot create acceptance. Checkpoint advances only on a complete unheld scan.
- `safety_stop`: record one of CANONICAL_CONTRADICTION, MAPPING_CONFLICT,
  RESTORE_REVIEW or ANCHOR_CONFLICT. Hold clearing has no runtime capability.

On canonical contradiction after acceptance, historical ticket, accepted
membership, inclusion and acceptance proof remain unchanged. A hold blocks new
acceptance and market lock/resolution/settlement progression. These are storage
guards, not implementations of those later workflows. Profile/deadline changes,
accepted history rewrites and evidence mutation/delete/TRUNCATE reject.

MTP uses the median of the preceding 11 canonical timestamps. The anchor window
must precede the deadline. The first height B with MTP(B) >= C yields eventual
scan-completion bound B-1. The evidence stores B, B-1, preceding 11 timestamps
plus B, and verified tip/hash. It does not store the complete block chain or a
staged full snapshot. Containing-block raw time < C still decides each note;
equality is late. Phase 9 does not finalize close or freeze/publish a ledger.

The wallet, maintained scanner and configured endpoint are trusted private
inputs. SQL cannot independently prove note decryption or full-node consensus.
Neither the migration nor this profile asserts finality, production safety,
strong same-user isolation, operator privacy or network anonymity.

Operational and manual-evidence steps: [watcher guide](../../services/watcher/README.md).

## Forward migration 0006: bounded close proof V2

0006 leaves migrations 0001–0005 byte-identical and creates no tables or runtime
grants. Its private validate_close_v2 helper is not executable by the runtime
login. Reconcile accepts a closed V2 proof alongside the unchanged bounded V1
reference path. Mixing representations, unknown fields/versions/profiles,
missing predecessors and inconsistent headers reject atomically.

chain.close_proof contains version=2, profile=phase9-exact-chainclock-3-v1,
status FOUND/NO_CROSSING_BY_H, boundary_height (integer/null), anchor_window (11
headers), window (13 crossing headers, 12 terminal headers, or empty if H=anchor)
and target. Headers contain exactly height, hash, prev_hash and time. Separate
inclusion_blocks are ordered/deduplicated and bounded by the existing 4,096-output
limit. All evidence is bounded by original H.

SQL recomputes median(t[B-12..B-2]) < C <= median(t[B-11..B-1]), validates the
below-C anchor seed, time/MTP relations, linked windows, consistent overlaps,
target and no-crossing terminal proof. Firstness uses the established valid
canonical sequence under the existing trusted wallet/scanner/endpoint model;
SQL does not independently verify consensus. Per-output raw time < C and three
confirmations remain authoritative. Legacy V1 retains its 16,384-array limit.

BOUNDARY evidence retains the minimal crossing window. INCLUSION is independent;
reconciliation/acceptance/hold chain records omit redundant inclusion_blocks.
Canonical boundary contradiction after acceptance creates a sticky hold;
unaccepted boundaries can be recomputed. Existing economic guards remain in
force and historical evidence is never rewritten. The preserved manual database
has not been migrated by this offline task.
