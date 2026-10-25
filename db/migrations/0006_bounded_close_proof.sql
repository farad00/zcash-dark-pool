-- Bounded private proof V2. Existing economics, immutable migrations and runtime grants unchanged.
-- Private proof checker, invoked only by the existing restricted reconciliation capability.
CREATE FUNCTION darkpool_watcher.validate_close_v2(c jsonb,a bigint,ah text,closing timestamptz)
 RETURNS bigint LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p jsonb; w jsonb; b jsonb; prior jsonb; all_headers jsonb:='[]'::jsonb;
 target jsonb; status text; boundary bigint; tip bigint; start_h bigint; count_h integer; n integer; i integer;
 times bigint[]; previous_mtp bigint; current_mtp bigint;
BEGIN
 p:=c->'close_proof'; target:=p->'target'; tip:=(c->>'tip_height')::bigint;status:=p->>'status';
 IF c ? 'mtp_blocks' OR jsonb_typeof(p) IS DISTINCT FROM 'object'
  OR p->'version' IS DISTINCT FROM '2'::jsonb OR p->>'profile' IS DISTINCT FROM 'phase9-exact-chainclock-3-v1'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('version','profile','status','boundary_height','anchor_window','window','target'))
  OR NOT (p ?& ARRAY['version','profile','status','boundary_height','anchor_window','window','target'])
  OR status IS NULL OR status NOT IN ('FOUND','NO_CROSSING_BY_H')
  OR jsonb_typeof(c->'inclusion_blocks') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'inclusion_blocks')>4096
  OR jsonb_typeof(target) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='invalid close proof'; END IF;
 IF status='FOUND' THEN
  IF jsonb_typeof(p->'boundary_height') IS DISTINCT FROM 'number' OR NOT coalesce(p->>'boundary_height' ~ '^[0-9]{1,10}$',false) THEN RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='invalid boundary'; END IF;
  boundary:=(p->>'boundary_height')::bigint;
  IF boundary<a+2 OR boundary>tip THEN RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='invalid boundary'; END IF;
 ELSIF p->'boundary_height' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='future boundary'; END IF;
 FOR i IN 0..3 LOOP
  IF i=0 THEN w:=p->'anchor_window';start_h:=a-10;count_h:=11;
  ELSIF i=1 THEN w:=p->'window';start_h:=CASE WHEN boundary IS NOT NULL THEN boundary-12 ELSE tip-11 END;count_h:=CASE WHEN boundary IS NOT NULL THEN 13 WHEN tip=a THEN 0 ELSE 12 END;
  ELSIF i=2 THEN w:=jsonb_build_array(target);start_h:=tip;count_h:=1;
  ELSE w:=c->'inclusion_blocks';start_h:=NULL;count_h:=jsonb_array_length(w);END IF;
  IF jsonb_typeof(w) IS DISTINCT FROM 'array' OR jsonb_array_length(w)<>count_h THEN RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='missing close predecessors';END IF;
  prior:=NULL;n:=0;
  FOR b IN SELECT value FROM jsonb_array_elements(w) LOOP
   IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR NOT (b ?& ARRAY['height','hash','prev_hash','time'])
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(b) k WHERE k NOT IN ('height','hash','prev_hash','time'))
    OR jsonb_typeof(b->'height') IS DISTINCT FROM 'number' OR jsonb_typeof(b->'time') IS DISTINCT FROM 'number'
    OR NOT coalesce(b->>'height' ~ '^[0-9]{1,10}$',false) OR (b->>'height')::bigint>tip
    OR NOT coalesce(b->>'time' ~ '^[0-9]{1,10}$',false) OR (b->>'time')::bigint>4294967295
    OR NOT coalesce(b->>'hash' ~ '^[0-9a-f]{64}$',false) OR NOT coalesce(b->>'prev_hash' ~ '^[0-9a-f]{64}$',false)
    OR (start_h IS NOT NULL AND (b->>'height')::bigint<>start_h+n)
    OR (prior IS NOT NULL AND ((b->>'height')::bigint<=(prior->>'height')::bigint
     OR ((b->>'height')::bigint=(prior->>'height')::bigint+1 AND b->>'prev_hash'<>prior->>'hash'))) THEN
    RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='invalid close witness';END IF;
   prior:=b;n:=n+1;
  END LOOP;
  all_headers:=all_headers||w;
 END LOOP;
 IF p#>>'{anchor_window,10,hash}' IS DISTINCT FROM ah
  OR target->>'height' IS DISTINCT FROM c->>'tip_height' OR target->>'hash' IS DISTINCT FROM c->>'tip_hash'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(all_headers) x GROUP BY (x->>'height')::bigint HAVING count(DISTINCT x)>1)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(all_headers) x JOIN jsonb_array_elements(all_headers) y
    ON (x->>'height')::bigint=(y->>'height')::bigint+1 WHERE x->>'prev_hash'<>y->>'hash') THEN
  RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='conflicting close witnesses';END IF;
 SELECT array_agg((x->>'time')::bigint ORDER BY ord) INTO times FROM jsonb_array_elements(p->'anchor_window') WITH ORDINALITY q(x,ord);
 SELECT x INTO current_mtp FROM unnest(times) x ORDER BY x OFFSET 5 LIMIT 1;
 IF current_mtp::numeric*1000000>=extract(epoch FROM closing)*1000000 THEN RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='anchor must precede close boundary';END IF;
 IF boundary IS NOT NULL THEN
  SELECT array_agg((x->>'time')::bigint ORDER BY ord) INTO times FROM jsonb_array_elements(p->'window') WITH ORDINALITY q(x,ord);
  SELECT x INTO previous_mtp FROM unnest(times[1:11]) x ORDER BY x OFFSET 5 LIMIT 1;
  SELECT x INTO current_mtp FROM unnest(times[2:12]) x ORDER BY x OFFSET 5 LIMIT 1;
  IF previous_mtp::numeric*1000000>=extract(epoch FROM closing)*1000000
   OR current_mtp::numeric*1000000<extract(epoch FROM closing)*1000000
   OR times[12]<=previous_mtp OR times[13]<=current_mtp THEN RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='invalid first crossing';END IF;
 ELSIF tip>a THEN
  SELECT array_agg((x->>'time')::bigint ORDER BY ord) INTO times FROM jsonb_array_elements(p->'window') WITH ORDINALITY q(x,ord);
  SELECT x INTO current_mtp FROM unnest(times[1:11]) x ORDER BY x OFFSET 5 LIMIT 1;
  IF current_mtp::numeric*1000000>=extract(epoch FROM closing)*1000000 OR times[12]<=current_mtp THEN RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='invalid no-crossing proof';END IF;
 END IF;
 RETURN boundary;
END $$;
REVOKE ALL ON FUNCTION darkpool_watcher.validate_close_v2(jsonb,bigint,text,timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION darkpool_watcher.reconcile(expected_revision bigint,request jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s darkpool_private.watcher_state; m darkpool_private.markets; o jsonb; c jsonb; b jsonb;
 r darkpool_private.payment_receipts; t darkpool_private.tickets; saved darkpool_private.watcher_evidence;
 digest bytea; rid text; eid text; group_id text; mode text; reason text; classification text;
 tip bigint; h bigint; idx bigint; tm bigint; previous_h bigint; median_time bigint; boundary bigint;
 times bigint[]:=ARRAY[]::bigint[];
 row_id text; mapped boolean; accepted boolean; evidence_id text; result jsonb;
 note_reason text; conflicts jsonb:='[]'::jsonb;
BEGIN
 IF request IS NULL OR jsonb_typeof(request)<>'object' OR octet_length(request::text)>4194304
  OR request->'version' IS DISTINCT FROM '1'::jsonb OR request->>'network' IS DISTINCT FROM 'testnet'
  OR NOT coalesce(request->>'request_id' ~ '^[0-9a-f]{64}$',false) THEN
  RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='invalid watcher request'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(request) k WHERE k NOT IN
  ('version','request_id','mode','network','market_id','vault_context_ref','account_ref','endpoint_ref','outputs','chain','reason')) THEN
  RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='unknown watcher field'; END IF;
 IF (SELECT count(*) FROM darkpool_private.markets)<>1 THEN
  RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='watcher unavailable'; END IF;
 SELECT * INTO STRICT m FROM darkpool_private.markets FOR UPDATE;
 SELECT * INTO STRICT s FROM darkpool_private.watcher_state WHERE market_id=m.id FOR UPDATE;
 rid:=request->>'request_id'; eid:='reconcile:'||rid; digest:=sha256(convert_to(request::text,'UTF8'));
 SELECT * INTO saved FROM darkpool_private.watcher_evidence WHERE market_id=m.id AND request_id=rid;
 IF FOUND THEN
  IF saved.request_digest<>digest THEN RAISE EXCEPTION USING ERRCODE='P4902',MESSAGE='watcher retry conflict'; END IF;
  RETURN saved.details->'result';
 END IF;
 IF expected_revision IS DISTINCT FROM s.revision THEN
  RAISE EXCEPTION USING ERRCODE='P4902',MESSAGE='watcher revision conflict'; END IF;
 IF request->>'market_id' IS DISTINCT FROM m.id OR request->>'vault_context_ref' IS DISTINCT FROM m.vault_context_ref
  OR request->>'account_ref' IS DISTINCT FROM s.account_ref OR request->>'endpoint_ref' IS DISTINCT FROM s.endpoint_ref
  OR m.closes_at<>s.bound_closes_at OR m.deposit_confirmations IS DISTINCT FROM 3
  OR m.payment_policy_ref<>s.profile_ref OR m.close_policy_ref<>s.profile_ref THEN
  RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='watcher context mismatch'; END IF;
 mode:=request->>'mode';
 IF mode NOT IN ('observe_only','snapshot','safety_stop') OR mode IS NULL THEN
  RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='invalid watcher mode'; END IF;
 IF mode='safety_stop' THEN
  IF NOT coalesce(request->>'reason' IN ('CANONICAL_CONTRADICTION','MAPPING_CONFLICT','RESTORE_REVIEW','ANCHOR_CONFLICT'),false) THEN
   RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='invalid safety reason'; END IF;
  reason:=request->>'reason';
 ELSE
  IF jsonb_typeof(request->'outputs') IS DISTINCT FROM 'array' OR jsonb_array_length(request->'outputs')>4096 THEN
   RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='invalid watcher outputs'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(request->'outputs') q GROUP BY q->>'txid',q->>'pool',q->>'output_index' HAVING count(*)>1) THEN
   RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='duplicate request output'; END IF;
  IF mode='snapshot' THEN
   c:=request->'chain';
   IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(c) k WHERE k NOT IN
    ('complete','verified','tip_height','tip_hash','scanned_height','scanned_hash','anchor_hash','verified_at','verified_at_epoch','mtp_blocks','close_proof','inclusion_blocks')) THEN
    RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='invalid chain fields'; END IF;
   IF c->'complete' IS DISTINCT FROM 'true'::jsonb OR c->'verified' IS DISTINCT FROM 'true'::jsonb
    OR c->>'anchor_hash' IS DISTINCT FROM encode(s.anchor_hash,'hex')
    OR NOT coalesce(c->>'tip_height' ~ '^[0-9]{1,10}$',false) OR NOT coalesce(c->>'tip_hash' ~ '^[0-9a-f]{64}$',false)
    OR c->>'scanned_height' IS DISTINCT FROM c->>'tip_height' OR c->>'scanned_hash' IS DISTINCT FROM c->>'tip_hash'
    OR c->>'verified_at' IS NULL OR (c->>'verified_at')::timestamptz>clock_timestamp()+interval '5 seconds'
    OR (c->>'verified_at')::timestamptz<clock_timestamp()-interval '30 seconds' THEN
    RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='unverified watcher snapshot'; END IF;
   tip:=(c->>'tip_height')::bigint;
   IF tip<s.anchor_height OR tip>4294967295 THEN RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='invalid chain coverage'; END IF;
   IF EXISTS(SELECT 1 FROM darkpool_private.payment_receipts p WHERE p.market_id=m.id AND NOT EXISTS
    (SELECT 1 FROM jsonb_array_elements(request->'outputs') q WHERE q->>'txid'=encode(p.txid,'hex')
     AND q->>'pool'=p.value_pool AND (q->>'output_index')::bigint=p.output_index)) THEN
    RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='incomplete reconciliation'; END IF;
   IF c ? 'close_proof' THEN
    boundary:=darkpool_watcher.validate_close_v2(c,s.anchor_height,encode(s.anchor_hash,'hex'),m.closes_at);
   ELSE
    IF c ? 'inclusion_blocks' THEN RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='invalid close proof';END IF;
   IF jsonb_typeof(c->'mtp_blocks') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'mtp_blocks')>16384 THEN
    RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='missing close evidence'; END IF;
   previous_h:=s.anchor_height-11;
   FOR b IN SELECT value FROM jsonb_array_elements(c->'mtp_blocks') LOOP
    h:=(b->>'height')::bigint;
    IF h IS DISTINCT FROM previous_h+1 OR NOT coalesce(b->>'hash' ~ '^[0-9a-f]{64}$',false) OR NOT coalesce(b->>'time' ~ '^[0-9]{1,10}$',false) THEN
     RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='invalid close evidence'; END IF;
    previous_h:=h;
    IF h=s.anchor_height AND b->>'hash'<>encode(s.anchor_hash,'hex') THEN reason:='ANCHOR_CONFLICT'; END IF;
    IF h>s.anchor_height THEN
     SELECT x INTO median_time FROM unnest(times) x ORDER BY x OFFSET 5 LIMIT 1;
     IF median_time IS NULL OR (b->>'time')::bigint<=median_time THEN
      RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='invalid median-time evidence'; END IF;
     IF boundary IS NULL AND median_time::numeric*1000000>=extract(epoch FROM m.closes_at)*1000000 THEN boundary:=h; END IF;
    END IF;
    tm:=(b->>'time')::bigint;
    IF tm>4294967295 THEN RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='invalid block timestamp'; END IF;
    times:=CASE WHEN cardinality(times)=11 THEN times[2:11]||tm ELSE times||tm END;
    IF h=s.anchor_height THEN
     SELECT x INTO median_time FROM unnest(times) x ORDER BY x OFFSET 5 LIMIT 1;
     IF median_time IS NULL OR median_time::numeric*1000000>=extract(epoch FROM m.closes_at)*1000000 THEN
      RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='anchor must precede close boundary'; END IF;
    END IF;
   END LOOP;
   IF previous_h<>tip OR b->>'hash' IS DISTINCT FROM c->>'tip_hash' THEN RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='incomplete close evidence'; END IF;
   END IF;
   -- A changed canonical boundary after acceptance is a contradiction, never a rewrite.
   IF EXISTS(SELECT 1 FROM darkpool_private.watcher_evidence accepted JOIN darkpool_private.watcher_evidence prior_boundary
      ON prior_boundary.id='boundary:'||(accepted.details->>'request_id')
     WHERE accepted.market_id=m.id AND accepted.kind='ACCEPTANCE'
      AND ((prior_boundary.details->>'height')::bigint IS DISTINCT FROM boundary
       OR EXISTS(SELECT 1 FROM jsonb_array_elements(prior_boundary.details->'window') old_header
          LEFT JOIN jsonb_array_elements(CASE WHEN c ? 'close_proof' THEN c#>'{close_proof,window}' ELSE c->'mtp_blocks' END) new_header
           ON (new_header->>'height')::bigint=(old_header->>'height')::bigint
          WHERE new_header IS NULL OR new_header->>'hash' IS DISTINCT FROM old_header->>'hash'
           OR (new_header->>'time')::bigint IS DISTINCT FROM (old_header->>'time')::bigint
           OR (old_header ? 'prev_hash' AND new_header->>'prev_hash' IS DISTINCT FROM old_header->>'prev_hash')))) THEN reason:='CANONICAL_CONTRADICTION';END IF;
  END IF;
  -- Validate every output and all immutable conflicts before new acceptance.
  FOR o IN SELECT value FROM jsonb_array_elements(request->'outputs') LOOP
   note_reason:=NULL;
   IF jsonb_typeof(o) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='invalid observed output'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(o) k WHERE k NOT IN ('txid','pool','output_index','amount_zat','is_change','key_scope','present',
    'receiver_verified','canonical','block_height','block_hash','block_time','tx_index','receiver_ref','diversifier_ref','ticket_id','journal_commitment','receipt_id','accepted')) THEN
    RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='unknown output field'; END IF;
   IF jsonb_typeof(o) IS DISTINCT FROM 'object' OR NOT coalesce(o->>'txid' ~ '^[0-9a-f]{64}$',false) OR NOT coalesce(o->>'pool' IN ('SAPLING','ORCHARD','IRONWOOD'),false)
    OR NOT coalesce(o->>'output_index' ~ '^[0-9]{1,10}$',false) OR (o->>'output_index')::numeric>4294967295
    OR NOT coalesce(o->>'amount_zat' ~ '^(0|[1-9][0-9]{0,15})$',false)
    OR NOT coalesce(o->'present' IN ('true'::jsonb,'false'::jsonb),false)
    OR NOT coalesce(o->'canonical' IN ('true'::jsonb,'false'::jsonb),false)
    OR NOT coalesce(o->'receiver_verified' IN ('true'::jsonb,'false'::jsonb),false)
    OR NOT coalesce(o->'is_change' IN ('true'::jsonb,'false'::jsonb),false) THEN
    RAISE EXCEPTION USING ERRCODE='P4901',MESSAGE='invalid observed identity'; END IF;
   SELECT * INTO r FROM darkpool_private.payment_receipts WHERE network='testnet' AND txid=decode(o->>'txid','hex')
    AND value_pool=o->>'pool' AND output_index=(o->>'output_index')::bigint;
   IF FOUND THEN
    IF r.market_id<>m.id OR r.amount_zat<>(o->>'amount_zat')::numeric
     OR o->>'receiver_ref' IS DISTINCT FROM r.receiver_ref OR o->>'ticket_id' IS DISTINCT FROM r.ticket_id
     OR o->>'receiver_verified' IS DISTINCT FROM 'true' OR o->>'key_scope' IS DISTINCT FROM '0' OR o->>'is_change' IS DISTINCT FROM 'false'
     OR NOT EXISTS(SELECT 1 FROM darkpool_private.tickets bound_ticket WHERE bound_ticket.id=r.ticket_id
       AND bound_ticket.diversifier_ref=o->>'diversifier_ref' AND encode(bound_ticket.claim_commitment,'hex')=o->>'journal_commitment')
     THEN note_reason:='MAPPING_CONFLICT'; END IF;
    IF mode='snapshot' AND EXISTS(SELECT 1 FROM darkpool_private.accepted_payment_receipts a WHERE a.receipt_id=r.id) THEN
     IF o->>'canonical' IS DISTINCT FROM 'true' OR o->>'present' IS DISTINCT FROM 'true'
      OR o->>'block_hash' IS DISTINCT FROM encode(r.block_hash,'hex')
      OR (o->>'block_height')::bigint IS DISTINCT FROM r.block_height
      OR tip<r.block_height+2 OR o->>'is_change' IS DISTINCT FROM 'false'
      OR o->>'receiver_verified' IS DISTINCT FROM 'true' OR o->>'key_scope' IS DISTINCT FROM '0'
      OR o->>'ticket_id' IS DISTINCT FROM r.ticket_id OR o->>'receiver_ref' IS DISTINCT FROM r.receiver_ref
      OR NOT EXISTS(SELECT 1 FROM darkpool_private.tickets v WHERE v.id=r.ticket_id
       AND v.diversifier_ref=o->>'diversifier_ref' AND encode(v.claim_commitment,'hex')=o->>'journal_commitment')
      OR NOT EXISTS(SELECT 1 FROM darkpool_private.watcher_evidence inclusion WHERE inclusion.id=r.chain_evidence_ref
       AND inclusion.details->>'time'=o->>'block_time' AND inclusion.details->>'tx_index'=o->>'tx_index')
      THEN note_reason:='CANONICAL_CONTRADICTION'; END IF;
    END IF;
   END IF;
   IF note_reason IS NOT NULL THEN reason:=note_reason; conflicts:=conflicts||jsonb_build_array(o); END IF;
  END LOOP;
 END IF;
 IF reason IS NOT NULL THEN
  evidence_id:='hold:'||rid;
  INSERT INTO darkpool_private.watcher_evidence VALUES(evidence_id,m.id,'HOLD',NULL,NULL,NULL,NULL,
   jsonb_build_object('reason',reason,'chain',(request->'chain')-'mtp_blocks'-'inclusion_blocks','conflicting_outputs',conflicts),clock_timestamp());
  result:=jsonb_build_object('result','HELD','revision',(s.revision+1)::text);
  INSERT INTO darkpool_private.watcher_evidence VALUES(eid,m.id,'RECONCILIATION',NULL,evidence_id,rid,digest,
   jsonb_build_object('result',result,'mode',mode),clock_timestamp());
  UPDATE darkpool_private.watcher_state SET hold_ref=coalesce(hold_ref,evidence_id),revision=revision+1 WHERE market_id=m.id;
  RETURN result;
 END IF;

 FOR o IN SELECT value FROM jsonb_array_elements(request->'outputs') LOOP
  row_id:='note:testnet:'||(o->>'txid')||':'||(o->>'pool')||':'||(o->>'output_index');
  SELECT * INTO r FROM darkpool_private.payment_receipts WHERE id=row_id;
  mapped:=false;
  SELECT * INTO t FROM darkpool_private.tickets WHERE market_id=m.id AND receiver_ref=o->>'receiver_ref'
   AND diversifier_ref=o->>'diversifier_ref' AND id=o->>'ticket_id'
   AND encode(claim_commitment,'hex')=o->>'journal_commitment'
   AND EXISTS(SELECT 1 FROM darkpool_private.issuance_attempts a WHERE a.ticket_id=tickets.id AND a.state='ISSUED'
    AND a.market_id=tickets.market_id AND a.vault_context_ref=tickets.vault_context_ref
    AND a.commitment=tickets.claim_commitment AND a.side=tickets.side AND a.requested_amount_zat=tickets.requested_amount_zat);
  mapped:=coalesce(FOUND AND o->>'receiver_verified'='true' AND o->>'key_scope'='0' AND o->>'is_change'='false'
   AND o->>'pool' IN ('ORCHARD','IRONWOOD'),false);
  IF NOT mapped THEN
   evidence_id:='unmapped:'||encode(sha256(convert_to(row_id||o::text,'UTF8')),'hex');
   INSERT INTO darkpool_private.watcher_evidence VALUES(evidence_id,m.id,'OBSERVATION',NULL,NULL,NULL,NULL,
    jsonb_build_object('classification','UNMAPPED','output',o),clock_timestamp()) ON CONFLICT(id) DO NOTHING;
   CONTINUE;
  END IF;
  IF r.id IS NOT NULL AND r.ticket_id IS NOT NULL AND r.ticket_id<>t.id THEN
   RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='retained mapping conflict'; END IF;
  IF r.id IS NULL THEN
   INSERT INTO darkpool_private.payment_receipts VALUES(row_id,m.id,m.vault_context_ref,'testnet',row_id,
    decode(o->>'txid','hex'),o->>'pool',(o->>'output_index')::bigint,t.id,t.receiver_ref,(o->>'amount_zat')::numeric,
    NULL,NULL,NULL,'phase9-observed',clock_timestamp());
  END IF;
  IF mode='observe_only' THEN
   evidence_id:='observed:'||encode(sha256(convert_to(row_id||o::text,'UTF8')),'hex');
   INSERT INTO darkpool_private.watcher_evidence VALUES(evidence_id,m.id,'OBSERVATION',row_id,NULL,NULL,NULL,
    jsonb_build_object('classification','UNVERIFIED','output',o),clock_timestamp()) ON CONFLICT(id) DO NOTHING;
   CONTINUE;
  END IF;
  accepted:=EXISTS(SELECT 1 FROM darkpool_private.accepted_payment_receipts WHERE receipt_id=row_id);
  IF accepted THEN CONTINUE; END IF;
  h:=NULL; tm:=NULL; idx:=NULL;
  IF o->>'canonical'='true' AND o->>'present'='true' THEN
   IF NOT coalesce(o->>'block_height' ~ '^[0-9]{1,10}$',false) OR NOT coalesce(o->>'block_hash' ~ '^[0-9a-f]{64}$',false)
    OR NOT coalesce(o->>'block_time' ~ '^[0-9]{1,10}$',false) OR NOT coalesce(o->>'tx_index' ~ '^[0-9]{1,10}$',false) THEN
    RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='missing output inclusion'; END IF;
   h:=(o->>'block_height')::bigint; tm:=(o->>'block_time')::bigint; idx:=(o->>'tx_index')::bigint;
   IF h>tip OR idx>4294967295 OR tm>4294967295 OR h<s.anchor_height THEN RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='output outside verified coverage'; END IF;
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN c ? 'close_proof' THEN c->'inclusion_blocks' ELSE c->'mtp_blocks' END) x WHERE (x->>'height')::bigint=h
    AND x->>'hash'=o->>'block_hash' AND x->>'time'=o->>'block_time') THEN
    RAISE EXCEPTION USING ERRCODE='P4903',MESSAGE='output inclusion inconsistent'; END IF;
  END IF;
  classification:=CASE WHEN h IS NULL AND o->>'present'='true' THEN 'pending' WHEN h IS NULL THEN 'orphan'
   WHEN tm::numeric*1000000>=extract(epoch FROM m.closes_at)*1000000 THEN 'late'
   WHEN (o->>'amount_zat')::numeric<t.requested_amount_zat THEN 'under'
   WHEN (o->>'amount_zat')::numeric>t.requested_amount_zat THEN 'over'
   ELSE 'candidate' END;
  evidence_id:='inclusion:'||encode(sha256(convert_to(row_id||o::text,'UTF8')),'hex');
  INSERT INTO darkpool_private.watcher_evidence VALUES(evidence_id,m.id,'INCLUSION',row_id,NULL,NULL,NULL,
   jsonb_build_object('classification',classification,'height',h,'hash',o->>'block_hash','time',tm,'tx_index',idx),clock_timestamp()) ON CONFLICT(id) DO NOTHING;
  UPDATE darkpool_private.payment_receipts SET ticket_id=t.id,block_height=h,
   block_hash=CASE WHEN h IS NULL THEN NULL ELSE decode(o->>'block_hash','hex') END,
   chain_evidence_ref=evidence_id,status_policy_ref='phase9-'||classification WHERE id=row_id;
  IF classification IN ('late','under','over') THEN
   INSERT INTO darkpool_private.payment_liabilities VALUES('principal:'||row_id,m.id,row_id,t.id,(o->>'amount_zat')::numeric,
    'phase9-principal-unresolved','phase9-'||classification,clock_timestamp()) ON CONFLICT(receipt_id) DO UPDATE SET state_policy_ref=EXCLUDED.state_policy_ref;
  END IF;
  UPDATE darkpool_private.payment_liabilities SET state_policy_ref='phase9-'||classification WHERE receipt_id=row_id;
 END LOOP;

 IF mode='snapshot' AND s.hold_ref IS NULL AND m.status='OPEN'
  AND NOT EXISTS(SELECT 1 FROM darkpool_private.ledger_sets WHERE market_id=m.id AND frozen_at IS NOT NULL) THEN
  FOR t IN SELECT * FROM darkpool_private.tickets WHERE market_id=m.id AND accepted_amount_zat=0 ORDER BY id FOR UPDATE LOOP
   SELECT p.* INTO r FROM darkpool_private.payment_receipts p JOIN darkpool_private.watcher_evidence e ON e.id=p.chain_evidence_ref
    WHERE p.market_id=m.id AND p.ticket_id=t.id AND p.status_policy_ref='phase9-candidate'
    ORDER BY p.block_height,(e.details->>'tx_index')::bigint,
      CASE p.value_pool WHEN 'SAPLING' THEN 2 WHEN 'ORCHARD' THEN 3 WHEN 'IRONWOOD' THEN 4 END,p.output_index LIMIT 1;
   IF FOUND AND tip>=r.block_height+2 THEN
    group_id:='accepted:'||t.id;
    INSERT INTO darkpool_private.accepted_payments VALUES(group_id,m.id,t.id,s.profile_ref);
    INSERT INTO darkpool_private.accepted_payment_receipts VALUES(group_id,m.id,t.id,r.id);
    INSERT INTO darkpool_private.watcher_evidence VALUES('acceptance:'||t.id,m.id,'ACCEPTANCE',r.id,NULL,NULL,NULL,
     jsonb_build_object('group_id',group_id,'profile',s.profile_ref,'containing',
      (SELECT details FROM darkpool_private.watcher_evidence WHERE id=r.chain_evidence_ref),
      'chain',c-'mtp_blocks'-'inclusion_blocks','request_id',rid,'ordering','height,tx_index,pool_code,output_index'),clock_timestamp());
    UPDATE darkpool_private.tickets SET payment_state='CONFIRMED',accepted_amount_zat=requested_amount_zat,
     accepted_payment_ref=group_id,accepted_at=clock_timestamp() WHERE id=t.id;
    INSERT INTO darkpool_private.audit_events VALUES('confirmed:'||t.id,1,m.id,'TICKET_CONFIRMED',clock_timestamp(),
     session_user,group_id,NULL,NULL,'acceptance:'||t.id);
    UPDATE darkpool_private.payment_liabilities SET state_policy_ref='phase9-accepted' WHERE receipt_id=r.id;
   END IF;
  END LOOP;
 END IF;
 IF mode='snapshot' THEN
  FOR r IN SELECT p.* FROM darkpool_private.payment_receipts p JOIN darkpool_private.tickets ticket_row ON ticket_row.id=p.ticket_id
   WHERE p.market_id=m.id AND ticket_row.accepted_amount_zat>0 AND NOT EXISTS
    (SELECT 1 FROM darkpool_private.accepted_payment_receipts a WHERE a.receipt_id=p.id) LOOP
   INSERT INTO darkpool_private.payment_liabilities VALUES('principal:'||r.id,m.id,r.id,r.ticket_id,r.amount_zat,
    'phase9-principal-unresolved',CASE WHEN r.status_policy_ref IN ('phase9-orphan','phase9-pending') THEN r.status_policy_ref ELSE 'phase9-additional' END,clock_timestamp())
     ON CONFLICT(receipt_id) DO UPDATE SET state_policy_ref=EXCLUDED.state_policy_ref;
  END LOOP;
  IF boundary IS NOT NULL THEN
   evidence_id:='boundary:'||rid;
   INSERT INTO darkpool_private.watcher_evidence VALUES(evidence_id,m.id,'BOUNDARY',NULL,NULL,NULL,NULL,
    jsonb_build_object('height',boundary,'close_height',boundary-1,'window',
     CASE WHEN c ? 'close_proof' THEN c#>'{close_proof,window}' ELSE (SELECT jsonb_agg(x) FROM jsonb_array_elements(c->'mtp_blocks') x WHERE (x->>'height')::bigint BETWEEN boundary-11 AND boundary) END,
     'tip_height',tip,'tip_hash',c->>'tip_hash','algorithm','preceding-11-first-crossing-v1'),clock_timestamp());
  END IF;
 END IF;
 result:=jsonb_build_object('result',CASE WHEN s.hold_ref IS NOT NULL THEN 'HELD' WHEN mode='observe_only' THEN 'RETAINED' ELSE 'RECONCILED' END,
  'revision',(s.revision+1)::text);
 INSERT INTO darkpool_private.watcher_evidence VALUES(eid,m.id,'RECONCILIATION',NULL,NULL,rid,digest,
  jsonb_build_object('result',result,'mode',mode,'chain',c-'mtp_blocks'-'inclusion_blocks'),clock_timestamp());
 UPDATE darkpool_private.watcher_state SET revision=revision+1,
  checkpoint_ref=CASE WHEN mode='snapshot' AND hold_ref IS NULL THEN eid ELSE checkpoint_ref END WHERE market_id=m.id;
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION darkpool_watcher.reconcile(bigint,jsonb) FROM PUBLIC;
