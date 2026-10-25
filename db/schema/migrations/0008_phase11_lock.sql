-- Approved Phase 11, additive. No roles, target provisioning, chain work or publication.
CREATE SCHEMA darkpool_lock;
REVOKE ALL ON SCHEMA darkpool_lock FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA darkpool_lock REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
INSERT INTO darkpool_private.policy_refs VALUES
 ('DARKPOOL_LEDGER_V1_BIN1_B2B256','PINNED',NULL,'user-approved-phase11-phase10-profile')
 ON CONFLICT(id) DO NOTHING;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM darkpool_private.policy_refs WHERE id='DARKPOOL_LEDGER_V1_BIN1_B2B256'
  AND status='PINNED' AND reviewed_profile_ref='user-approved-phase11-phase10-profile') THEN
  RAISE EXCEPTION USING ERRCODE='P1101',MESSAGE='lock profile conflict'; END IF;
END $$;

CREATE TABLE darkpool_private.lock_requests (
 request_key text COLLATE "C" PRIMARY KEY,
 market_id darkpool_private.opaque_ref NOT NULL UNIQUE REFERENCES darkpool_private.markets,
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 context jsonb NOT NULL CHECK(jsonb_typeof(context)='object'),
 checkpoint_ref darkpool_private.opaque_ref NOT NULL,
 watcher_revision bigint NOT NULL,
 response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'),
 FOREIGN KEY(market_id,checkpoint_ref) REFERENCES darkpool_private.watcher_evidence(market_id,id)
);
CREATE TABLE darkpool_private.ledger_publication_outbox (
 market_id darkpool_private.opaque_ref PRIMARY KEY REFERENCES darkpool_private.ledger_commitments,
 request_key text NOT NULL UNIQUE REFERENCES darkpool_private.lock_requests,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 created_at timestamptz NOT NULL
);
CREATE TABLE darkpool_private.ledger_publication_receipts (
 market_id darkpool_private.opaque_ref PRIMARY KEY REFERENCES darkpool_private.ledger_publication_outbox,
 merkle_root bytea NOT NULL CHECK(octet_length(merkle_root)=32),
 verification_profile text NOT NULL,
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
 recorded_at timestamptz NOT NULL
);
REVOKE ALL ON darkpool_private.lock_requests,darkpool_private.ledger_publication_outbox,darkpool_private.ledger_publication_receipts FROM PUBLIC;
CREATE TRIGGER lock_requests_immutable BEFORE UPDATE OR DELETE ON darkpool_private.lock_requests
 FOR EACH ROW EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER lock_requests_no_truncate BEFORE TRUNCATE ON darkpool_private.lock_requests
 FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER lock_outbox_immutable BEFORE UPDATE OR DELETE ON darkpool_private.ledger_publication_outbox
 FOR EACH ROW EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER lock_outbox_no_truncate BEFORE TRUNCATE ON darkpool_private.ledger_publication_outbox
 FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER lock_receipts_immutable BEFORE UPDATE OR DELETE ON darkpool_private.ledger_publication_receipts
 FOR EACH ROW EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE TRIGGER lock_receipts_no_truncate BEFORE TRUNCATE ON darkpool_private.ledger_publication_receipts
 FOR EACH STATEMENT EXECUTE FUNCTION darkpool_private.reject_mutation();
CREATE UNIQUE INDEX lock_blindings_unique ON darkpool_private.ledger_records(market_id,record_blinding)
 WHERE blinding_policy_ref='DARKPOOL_LEDGER_V1_BIN1_B2B256';

CREATE FUNCTION darkpool_lock.authorize() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('role')<>'none'
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND
  (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=session_user))
 OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN ('darkpool_private','darkpool_public','darkpool_admin','darkpool_watcher','darkpool_lock','darkpool_migrations')
  AND pg_has_role(session_user,nspowner,'MEMBER'))
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN ('darkpool_private','darkpool_migrations') AND c.relkind IN ('r','v','p')
   AND has_table_privilege(session_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) THEN
  RAISE EXCEPTION USING ERRCODE='P1104',MESSAGE='restricted finalizer login required'; END IF;
END $$;

CREATE FUNCTION darkpool_lock.validate_request(q jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF q IS NULL OR jsonb_typeof(q)<>'object' OR octet_length(q::text)>8192
 OR (SELECT count(*) FROM jsonb_object_keys(q))<>6
 OR NOT(q ?& ARRAY['request_key','market_id','expected_revision','expected_watcher_revision','checkpoint_ref','profile'])
 OR EXISTS(SELECT 1 FROM jsonb_each(q) kv WHERE jsonb_typeof(kv.value)<>'string')
 OR NOT coalesce(q->>'request_key' ~ '^[A-Za-z0-9_-]{1,128}$',false)
 OR NOT coalesce(q->>'expected_revision' ~ '^[1-9][0-9]{0,18}$',false)
 OR NOT coalesce(q->>'expected_watcher_revision' ~ '^(0|[1-9][0-9]{0,18})$',false)
 OR length(q->>'market_id')=0 OR length(q->>'checkpoint_ref')=0
 OR q->>'profile'<>'DARKPOOL_LEDGER_V1_BIN1_B2B256' THEN
  RAISE EXCEPTION USING ERRCODE='P1101',MESSAGE='invalid lock request'; END IF;
END $$;

CREATE FUNCTION darkpool_lock.ticket_rows(mid text) RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('version',t.version,'network','testnet','market_id',t.market_id,
  'ticket_id',t.id,'side',t.side,'accepted_amount_zat',t.accepted_amount_zat::text,
  'accepted_payment_ref',t.accepted_payment_ref,'receiver_ref',t.receiver_ref) ORDER BY t.id COLLATE "C"),'[]'::jsonb)
 FROM darkpool_private.tickets t WHERE t.market_id=mid AND t.accepted_amount_zat>0;
$$;

CREATE FUNCTION darkpool_lock.evidence(mid text,rev bigint,cp text) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE m darkpool_private.markets; s darkpool_private.watcher_state; e darkpool_private.watcher_evidence;
 c jsonb; b bigint; h bigint; bad boolean;
BEGIN
 SELECT * INTO STRICT m FROM darkpool_private.markets WHERE id=mid;
 SELECT * INTO STRICT s FROM darkpool_private.watcher_state WHERE market_id=mid;
 IF s.revision<>rev OR s.checkpoint_ref IS DISTINCT FROM cp OR s.hold_ref IS NOT NULL
 OR m.network<>'testnet' OR m.version<>1 OR m.deposit_confirmations IS DISTINCT FROM 3
 OR m.close_policy_ref<>'phase9-exact-chainclock-3-v1' OR m.payment_policy_ref<>m.close_policy_ref
 OR s.profile_ref<>m.payment_policy_ref OR s.bound_closes_at<>m.closes_at
 OR s.endpoint_ref<>'https://testnet.zec.rocks:443'
 OR m.fee_policy_ref<>'phase9-zero-platform-fee-v1' OR m.payout_confirmations IS NOT NULL
 OR (SELECT count(*) FROM darkpool_private.market_policy_refs WHERE market_id=mid)<>3
 OR NOT EXISTS(SELECT 1 FROM darkpool_private.market_policy_refs WHERE market_id=mid AND purpose='receiving' AND policy_ref='phase9-orchard-receiving-v1')
 OR NOT EXISTS(SELECT 1 FROM darkpool_private.market_policy_refs WHERE market_id=mid AND purpose='close-proof' AND policy_ref='phase9-bounded-close-proof-v2')
 OR NOT EXISTS(SELECT 1 FROM darkpool_private.market_policy_refs WHERE market_id=mid AND purpose='payout' AND policy_ref='phase9-payout-deferred-v1')
 OR NOT EXISTS(SELECT 1 FROM darkpool_private.policy_refs WHERE id=m.close_policy_ref AND status='PINNED' AND reviewed_profile_ref='docs/PHASE9_IMPLEMENTATION.md#approved-2026-10-07')
 OR (SELECT count(*) FROM darkpool_private.policy_refs WHERE id IN ('phase9-zero-platform-fee-v1','phase9-payout-deferred-v1','phase9-orchard-receiving-v1','phase9-bounded-close-proof-v2')
  AND status='PINNED' AND reviewed_profile_ref='user-approved-phase9-intake-open-2026-10-16')<>4
 OR NOT EXISTS(SELECT 1 FROM darkpool_private.watcher_evidence WHERE id='profile:'||mid AND market_id=mid AND kind='PROFILE'
  AND details->>'account'=s.account_ref AND details->>'endpoint'=s.endpoint_ref
  AND details->>'anchor_hash'=encode(s.anchor_hash,'hex') AND (details->>'anchor_height')::bigint=s.anchor_height) THEN
  RAISE EXCEPTION USING ERRCODE='P1103',MESSAGE='lock evidence unavailable'; END IF;
 SELECT * INTO e FROM darkpool_private.watcher_evidence WHERE id=cp AND market_id=mid AND kind='RECONCILIATION';
 c:=e.details->'chain';
 IF NOT FOUND OR e.details->>'mode' IS DISTINCT FROM 'snapshot' OR e.details#>>'{result,result}' IS DISTINCT FROM 'RECONCILED'
 OR e.details#>>'{result,revision}' IS DISTINCT FROM rev::text
 OR c->'complete' IS DISTINCT FROM 'true'::jsonb OR c->'verified' IS DISTINCT FROM 'true'::jsonb
 OR c->>'tip_height' IS DISTINCT FROM c->>'scanned_height' OR c->>'tip_hash' IS DISTINCT FROM c->>'scanned_hash'
 OR c->>'anchor_hash' IS DISTINCT FROM encode(s.anchor_hash,'hex') OR c#>>'{close_proof,status}' IS DISTINCT FROM 'FOUND'
 OR c->>'verified_at' IS NULL OR (c->>'verified_at')::timestamptz<clock_timestamp()-interval '30 seconds'
 OR (c->>'verified_at')::timestamptz>clock_timestamp()+interval '5 seconds' THEN
  RAISE EXCEPTION USING ERRCODE='P1103',MESSAGE='complete fresh close evidence required'; END IF;
 -- Reuse the frozen checker for its closed crossing window. Retained per-output
 -- inclusion is checked separately below; never invent predecessor hashes.
 b:=darkpool_watcher.validate_close_v2(c||jsonb_build_object('inclusion_blocks','[]'::jsonb),s.anchor_height,encode(s.anchor_hash,'hex'),m.closes_at);
 h:=(c->>'tip_height')::bigint;
 IF b IS NULL OR h<b+1 OR NOT EXISTS(SELECT 1 FROM darkpool_private.watcher_evidence
  WHERE id='boundary:'||e.request_id AND market_id=mid AND kind='BOUNDARY'
   AND (details->>'height')::bigint=b AND (details->>'close_height')::bigint=b-1
   AND details->'window'=c#>'{close_proof,window}' AND details->>'tip_hash'=c->>'tip_hash') THEN
  RAISE EXCEPTION USING ERRCODE='P1103',MESSAGE='mature close boundary required'; END IF;
 SELECT EXISTS(SELECT 1 FROM darkpool_private.tickets t WHERE t.market_id=mid AND
  (t.accepted_amount_zat>0 OR t.payment_state='CONFIRMED') AND
  (t.payment_state<>'CONFIRMED' OR t.accepted_amount_zat<>t.requested_amount_zat OR t.accepted_amount_zat<=0
   OR t.accepted_amount_zat<m.min_stake_zat OR t.accepted_amount_zat>m.max_stake_zat OR t.id!~'^[0-9a-f]{64}$'
   OR (SELECT count(*) FROM darkpool_private.accepted_payments g WHERE g.market_id=mid AND g.ticket_id=t.id)<>1
   OR NOT EXISTS(SELECT 1 FROM darkpool_private.accepted_payments g
    JOIN darkpool_private.accepted_payment_receipts ar ON ar.accepted_payment_id=g.id
    JOIN darkpool_private.payment_receipts r ON r.id=ar.receipt_id
    JOIN darkpool_private.watcher_evidence i ON i.id=r.chain_evidence_ref
    JOIN darkpool_private.watcher_evidence a ON a.id='acceptance:'||t.id
    JOIN darkpool_private.watcher_evidence original ON original.id='reconcile:'||(a.details->>'request_id')
    JOIN darkpool_private.issuance_attempts issue ON issue.ticket_id=t.id
    WHERE g.id=t.accepted_payment_ref AND g.market_id=mid AND g.ticket_id=t.id
     AND g.acceptance_policy_ref=m.payment_policy_ref
     AND (SELECT count(*) FROM darkpool_private.accepted_payment_receipts WHERE accepted_payment_id=g.id)=1
     AND ar.market_id=mid AND ar.ticket_id=t.id AND r.market_id=mid AND r.ticket_id=t.id
     AND r.network='testnet' AND r.vault_context_ref=m.vault_context_ref AND t.vault_context_ref=m.vault_context_ref
     AND r.value_pool IN ('ORCHARD','IRONWOOD') AND r.receiver_ref=t.receiver_ref AND r.amount_zat=t.accepted_amount_zat
     AND r.block_height<=b-1 AND h>=r.block_height+2 AND r.block_height>=s.anchor_height
     AND i.market_id=mid AND i.kind='INCLUSION' AND i.receipt_id=r.id
     AND i.details->>'classification'='candidate' AND (i.details->>'height')::bigint=r.block_height
     AND i.details->>'hash'=encode(r.block_hash,'hex') AND (i.details->>'time')::numeric*1000000<extract(epoch FROM m.closes_at)*1000000
     AND a.market_id=mid AND a.kind='ACCEPTANCE' AND a.receipt_id=r.id AND a.details->>'group_id'=g.id
     AND a.details->>'profile'=m.payment_policy_ref AND a.details->'containing'=i.details
     AND original.market_id=mid AND original.kind='RECONCILIATION' AND original.details->>'mode'='snapshot'
     AND original.details#>>'{result,result}'='RECONCILED'
     AND (a.details#>>'{chain,tip_height}')::bigint>=r.block_height+2
     AND issue.state='ISSUED' AND issue.market_id=mid AND issue.vault_context_ref=m.vault_context_ref
     AND issue.commitment=t.claim_commitment AND issue.side=t.side AND issue.requested_amount_zat=t.requested_amount_zat))) INTO bad;
 IF bad OR EXISTS(SELECT 1 FROM darkpool_private.accepted_payments g LEFT JOIN darkpool_private.tickets t ON t.id=g.ticket_id
  WHERE g.market_id=mid AND (t.payment_state IS DISTINCT FROM 'CONFIRMED' OR t.accepted_payment_ref IS DISTINCT FROM g.id)) THEN
  RAISE EXCEPTION USING ERRCODE='P1103',MESSAGE='accepted evidence mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM darkpool_private.payment_receipts r JOIN darkpool_private.tickets t ON t.id=r.ticket_id
  JOIN darkpool_private.watcher_evidence i ON i.id=r.chain_evidence_ref
  WHERE r.market_id=mid AND r.status_policy_ref='phase9-candidate' AND r.amount_zat=t.requested_amount_zat
   AND r.block_height<=b-1 AND h>=r.block_height+2 AND (i.details->>'time')::numeric*1000000<extract(epoch FROM m.closes_at)*1000000
   AND (t.accepted_amount_zat=0 OR EXISTS(SELECT 1 FROM darkpool_private.accepted_payment_receipts ar
    JOIN darkpool_private.payment_receipts chosen ON chosen.id=ar.receipt_id
    JOIN darkpool_private.watcher_evidence ci ON ci.id=chosen.chain_evidence_ref
    WHERE ar.accepted_payment_id=t.accepted_payment_ref AND
    ROW(r.block_height,(i.details->>'tx_index')::bigint,CASE r.value_pool WHEN 'SAPLING' THEN 2 WHEN 'ORCHARD' THEN 3 ELSE 4 END,r.output_index)
    <ROW(chosen.block_height,(ci.details->>'tx_index')::bigint,CASE chosen.value_pool WHEN 'SAPLING' THEN 2 WHEN 'ORCHARD' THEN 3 ELSE 4 END,chosen.output_index)))) THEN
  RAISE EXCEPTION USING ERRCODE='P1103',MESSAGE='unreconciled canonical candidate'; END IF;
 RETURN darkpool_lock.ticket_rows(mid);
END $$;

CREATE FUNCTION darkpool_lock.snapshot(mid text) RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('result','SEALED','context',q.context,'response',q.response,
  'min_stake_zat',m.min_stake_zat::text,'max_stake_zat',m.max_stake_zat::text,
  'records',coalesce((SELECT jsonb_agg(jsonb_build_object('version',r.version,'network','testnet','market_id',r.market_id,
   'ticket_id',r.ticket_id,'side',r.side,'accepted_amount_zat',r.accepted_amount_zat::text,
   'accepted_payment_ref',r.accepted_payment_ref,'receiver_ref',r.receiver_ref,'record_blinding',encode(r.record_blinding,'hex')) ORDER BY r.ticket_id COLLATE "C")
   FROM darkpool_private.ledger_records r WHERE r.market_id=mid),'[]'::jsonb))
 FROM darkpool_private.lock_requests q JOIN darkpool_private.markets m ON m.id=q.market_id WHERE q.market_id=mid;
$$;

CREATE FUNCTION darkpool_lock.begin_lock(q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE m darkpool_private.markets; s darkpool_private.watcher_state; rev bigint; saved darkpool_private.lock_requests; rows jsonb; ctx jsonb;
BEGIN
 PERFORM darkpool_lock.authorize(); PERFORM darkpool_lock.validate_request(q);
 IF current_setting('transaction_isolation')<>'serializable' OR current_setting('synchronous_commit')<>'on' THEN
  RAISE EXCEPTION USING ERRCODE='P1101',MESSAGE='serializable durable transaction required'; END IF;
 PERFORM pg_advisory_xact_lock(1146110284,4);
 IF (SELECT count(*) FROM darkpool_private.markets)<>1 THEN RAISE EXCEPTION USING ERRCODE='P1103',MESSAGE='single market required'; END IF;
 SELECT * INTO STRICT m FROM darkpool_private.markets WHERE id=q->>'market_id' FOR UPDATE;
 SELECT revision INTO STRICT rev FROM darkpool_private.admin_revisions WHERE market_id=m.id FOR UPDATE;
 SELECT * INTO STRICT s FROM darkpool_private.watcher_state WHERE market_id=m.id FOR UPDATE;
 SELECT * INTO saved FROM darkpool_private.lock_requests WHERE request_key=q->>'request_key';
 IF FOUND THEN
  IF saved.request IS DISTINCT FROM q THEN RAISE EXCEPTION USING ERRCODE='P1102',MESSAGE='lock retry conflict'; END IF;
  RETURN darkpool_lock.snapshot(m.id); END IF;
 IF EXISTS(SELECT 1 FROM darkpool_private.ledger_sets WHERE market_id=m.id) OR m.status<>'OPEN'
  OR m.closes_at>clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P1103',MESSAGE='market not lockable'; END IF;
 IF rev::text IS DISTINCT FROM q->>'expected_revision' OR s.revision::text IS DISTINCT FROM q->>'expected_watcher_revision'
  OR s.checkpoint_ref IS DISTINCT FROM q->>'checkpoint_ref' THEN RAISE EXCEPTION USING ERRCODE='P1102',MESSAGE='lock revision conflict'; END IF;
 rows:=darkpool_lock.evidence(m.id,s.revision,s.checkpoint_ref);
 ctx:=jsonb_build_object('profile',q->>'profile','version',1,'network','testnet','market_id',m.id,
  'locked_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 PERFORM set_config('darkpool_lock.begin',jsonb_build_object('request',q,'context',ctx,'xid',pg_current_xact_id()::text)::text,true);
 RETURN jsonb_build_object('result','READY','context',ctx,'records',rows,'min_stake_zat',m.min_stake_zat::text,'max_stake_zat',m.max_stake_zat::text);
END $$;

CREATE FUNCTION darkpool_lock.finish_lock(q jsonb,records jsonb,payload jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE started jsonb; rows jsonb; bare jsonb; ctx jsonb; stamp timestamptz; mid text; rev bigint;
BEGIN
 PERFORM darkpool_lock.authorize(); PERFORM darkpool_lock.validate_request(q);
 started:=nullif(current_setting('darkpool_lock.begin',true),'')::jsonb; ctx:=started->'context';mid:=q->>'market_id';
 IF started IS NULL OR started->'request' IS DISTINCT FROM q OR started->>'xid' IS DISTINCT FROM pg_current_xact_id()::text
  OR current_setting('transaction_isolation')<>'serializable' OR current_setting('synchronous_commit')<>'on' THEN
  RAISE EXCEPTION USING ERRCODE='P1101',MESSAGE='same lock transaction required'; END IF;
 rows:=darkpool_lock.evidence(mid,(q->>'expected_watcher_revision')::bigint,q->>'checkpoint_ref');
 IF jsonb_typeof(records) IS DISTINCT FROM 'array' OR octet_length(records::text)>4194304
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(records) r WHERE jsonb_typeof(r)<>'object'
  OR (SELECT count(*) FROM jsonb_object_keys(r))<>9 OR NOT (r ?& ARRAY['version','network','market_id','ticket_id','side','accepted_amount_zat','accepted_payment_ref','receiver_ref','record_blinding'])
  OR jsonb_typeof(r->'record_blinding') IS DISTINCT FROM 'string' OR NOT coalesce(r->>'record_blinding' ~ '^[0-9a-f]{64}$',false)) THEN
  RAISE EXCEPTION USING ERRCODE='P1101',MESSAGE='invalid private lock material'; END IF;
 SELECT coalesce(jsonb_agg(r-'record_blinding' ORDER BY r->>'ticket_id' COLLATE "C"),'[]'::jsonb) INTO bare FROM jsonb_array_elements(records) r;
 IF bare IS DISTINCT FROM rows OR (SELECT count(DISTINCT r->>'record_blinding') FROM jsonb_array_elements(records) r)<>jsonb_array_length(records)
 OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(payload))<>5
 OR NOT(payload ?& ARRAY['market_id','ledger_version','accepted_ticket_count','merkle_root','locked_at'])
 OR payload->>'market_id' IS DISTINCT FROM mid OR payload->'ledger_version' IS DISTINCT FROM '1'::jsonb
 OR payload->>'accepted_ticket_count' IS DISTINCT FROM jsonb_array_length(records)::text
 OR jsonb_typeof(payload->'accepted_ticket_count') IS DISTINCT FROM 'string'
 OR payload->>'locked_at' IS DISTINCT FROM ctx->>'locked_at'
 OR jsonb_typeof(payload->'merkle_root') IS DISTINCT FROM 'string' OR NOT coalesce(payload->>'merkle_root' ~ '^[0-9a-f]{64}$',false) THEN
  RAISE EXCEPTION USING ERRCODE='P1101',MESSAGE='lock material binding mismatch'; END IF;
 stamp:=(ctx->>'locked_at')::timestamptz;
 INSERT INTO darkpool_private.ledger_sets VALUES(mid,q->>'profile',NULL);
 INSERT INTO darkpool_private.ledger_records SELECT mid,r->>'ticket_id',1,r->>'side',(r->>'accepted_amount_zat')::numeric,
  r->>'accepted_payment_ref',r->>'receiver_ref',decode(r->>'record_blinding','hex'),q->>'profile' FROM jsonb_array_elements(records) r;
 UPDATE darkpool_private.ledger_sets SET frozen_at=stamp WHERE market_id=mid;
 INSERT INTO darkpool_private.ledger_commitments VALUES(mid,1,jsonb_array_length(records),decode(payload->>'merkle_root','hex'),q->>'profile',stamp);
 UPDATE darkpool_private.admin_revisions SET revision=revision+1 WHERE market_id=mid AND revision=(q->>'expected_revision')::bigint RETURNING revision INTO rev;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P1102',MESSAGE='lock revision conflict'; END IF;
 INSERT INTO darkpool_private.lock_requests VALUES(q->>'request_key',mid,q,ctx,q->>'checkpoint_ref',(q->>'expected_watcher_revision')::bigint,
  jsonb_build_object('result','LOCKED','commitment',payload,'publication','PENDING','revision',rev::text));
 INSERT INTO darkpool_private.ledger_publication_outbox VALUES(mid,q->>'request_key',payload,stamp);
 INSERT INTO darkpool_private.audit_events SELECT 'phase11:'||(q->>'request_key')||':'||ev,1,mid,ev,stamp,session_user,q->>'request_key',
  CASE WHEN ev='MARKET_LOCKED' THEN 'OPEN' ELSE NULL END,CASE WHEN ev='MARKET_LOCKED' THEN 'LOCKED' ELSE NULL END,q->>'checkpoint_ref'
  FROM unnest(ARRAY['MARKET_LOCK_FINALIZATION_STARTED','LEDGER_COMMITTED','MARKET_LOCKED']) ev;
 UPDATE darkpool_private.markets SET status='LOCKED',updated_at=stamp WHERE id=mid AND status='OPEN';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P1103',MESSAGE='market state conflict'; END IF;
 PERFORM set_config('darkpool_lock.begin','',true);
 RETURN darkpool_lock.snapshot(mid);
END $$;

CREATE FUNCTION darkpool_lock.check_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE mid text; q darkpool_private.lock_requests; c darkpool_private.ledger_commitments; l darkpool_private.ledger_sets; p jsonb; bare jsonb;
BEGIN
 IF TG_TABLE_NAME='markets' THEN mid:=NEW.id; ELSE mid:=NEW.market_id; END IF;
 SELECT * INTO l FROM darkpool_private.ledger_sets WHERE market_id=mid;
 IF l.encoding_policy_ref IS DISTINCT FROM 'DARKPOOL_LEDGER_V1_BIN1_B2B256' THEN RETURN NULL; END IF;
 SELECT * INTO q FROM darkpool_private.lock_requests WHERE market_id=mid;
 SELECT * INTO c FROM darkpool_private.ledger_commitments WHERE market_id=mid;
 SELECT payload INTO p FROM darkpool_private.ledger_publication_outbox WHERE market_id=mid AND request_key=q.request_key;
 SELECT coalesce(jsonb_agg(jsonb_build_object('version',r.version,'network','testnet','market_id',r.market_id,'ticket_id',r.ticket_id,
  'side',r.side,'accepted_amount_zat',r.accepted_amount_zat::text,'accepted_payment_ref',r.accepted_payment_ref,'receiver_ref',r.receiver_ref) ORDER BY r.ticket_id COLLATE "C"),'[]'::jsonb)
  INTO bare FROM darkpool_private.ledger_records r WHERE market_id=mid;
 IF q.request_key IS NULL OR l.frozen_at IS NULL OR c.market_id IS NULL OR p IS NULL
 OR c.commitment_policy_ref<>l.encoding_policy_ref OR c.locked_at<>l.frozen_at
 OR q.context->>'locked_at' IS DISTINCT FROM to_char(c.locked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
 OR octet_length(c.merkle_root)<>32 OR c.accepted_ticket_count<>jsonb_array_length(bare) OR c.accepted_ticket_count>18446744073709551615
 OR p IS DISTINCT FROM q.response->'commitment' OR p->>'merkle_root' IS DISTINCT FROM encode(c.merkle_root,'hex')
 OR p->>'accepted_ticket_count' IS DISTINCT FROM c.accepted_ticket_count::text
 OR bare IS DISTINCT FROM darkpool_lock.evidence(mid,q.watcher_revision,q.checkpoint_ref)
 OR (SELECT status FROM darkpool_private.markets WHERE id=mid) NOT IN ('LOCKED','RESOLVED','PAYING','VOID','REFUNDING','CLOSED')
 OR EXISTS(SELECT 1 FROM darkpool_private.ledger_records WHERE market_id=mid AND
  (record_blinding IS NULL OR octet_length(record_blinding)<>32 OR blinding_policy_ref<>l.encoding_policy_ref)) THEN
  RAISE EXCEPTION USING ERRCODE='P1103',MESSAGE='incomplete atomic lock seal'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER phase11_set_complete AFTER INSERT OR UPDATE ON darkpool_private.ledger_sets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION darkpool_lock.check_seal();
CREATE CONSTRAINT TRIGGER phase11_commitment_complete AFTER INSERT ON darkpool_private.ledger_commitments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION darkpool_lock.check_seal();
CREATE CONSTRAINT TRIGGER phase11_request_complete AFTER INSERT ON darkpool_private.lock_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION darkpool_lock.check_seal();
CREATE CONSTRAINT TRIGGER phase11_outbox_complete AFTER INSERT ON darkpool_private.ledger_publication_outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION darkpool_lock.check_seal();
-- Revalidate only an actual OPEN->LOCKED transition, not unrelated future metadata updates.
CREATE CONSTRAINT TRIGGER phase11_market_complete AFTER UPDATE ON darkpool_private.markets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.status='LOCKED' AND OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION darkpool_lock.check_seal();

CREATE FUNCTION darkpool_lock.reject_unverified_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 -- No independently verifiable publication channel/receipt profile has been approved.
 -- A future additive verifier migration is required; URLs and booleans cannot unlock publication.
 RAISE EXCEPTION USING ERRCODE='P1105',MESSAGE='publication receipt verifier not configured';
END $$;
CREATE TRIGGER phase11_receipt_verifier BEFORE INSERT ON darkpool_private.ledger_publication_receipts FOR EACH ROW EXECUTE FUNCTION darkpool_lock.reject_unverified_receipt();
CREATE FUNCTION darkpool_lock.publication_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM darkpool_private.lock_requests WHERE market_id=NEW.market_id)
 AND NOT EXISTS(SELECT 1 FROM darkpool_private.ledger_publication_receipts WHERE market_id=NEW.market_id) THEN
  RAISE EXCEPTION USING ERRCODE='P1105',MESSAGE='independent publication receipt required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER phase11_resolution_publication BEFORE INSERT OR UPDATE ON darkpool_private.resolutions FOR EACH ROW EXECUTE FUNCTION darkpool_lock.publication_gate();
CREATE TRIGGER phase11_settlement_publication BEFORE INSERT OR UPDATE ON darkpool_private.settlements FOR EACH ROW EXECUTE FUNCTION darkpool_lock.publication_gate();
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA darkpool_lock FROM PUBLIC;
