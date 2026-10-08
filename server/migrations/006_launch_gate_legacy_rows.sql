-- Opening the launch gate refuses while a launching or failed pod has no sandbox id and no
-- record in the create-attempt ledger: a launch made outside the ledger may have created a
-- sandbox nobody tracks. The guard used to exempt only pods with an open attempt, so a pod
-- whose attempt had closed also counted. Deleting a pod closes its attempt as `deleted` and
-- leaves the row active and `gone`, so after the first pod deletion a held gate could never
-- be opened again.
--
-- Both launch paths write the pod and its first attempt in one transaction, and the
-- protocol cutover gave every earlier row a `legacy_unresolved` attempt. A pod with any
-- attempt is therefore accounted for: an open attempt is recovered by the ledger, and a
-- closed one (ready, failed_safe, aborted_unsent, deleted) is a resolved outcome. Only a
-- pod with no attempt at all is unaccounted.
--
-- In the hosted ordering this sorts before the hosted chain's own definition of this
-- function (110_pod_create_attempts.sql, with its Boat operation check), so that chain must
-- define it again after this file; its check-pipod script enforces that.
CREATE OR REPLACE FUNCTION public.set_launch_recovery_mode(p_mode text, p_expected_epoch bigint, p_protocol_version integer, p_source_sha text, p_actor text, p_reason_code text) RETURNS TABLE(mode text, epoch bigint, changed_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE current_row launch_recovery_control%ROWTYPE;
BEGIN
  IF p_mode NOT IN ('held', 'open')
     OR p_protocol_version < 1
     OR p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9@._-]{1,200}$'
     OR p_reason_code IS NULL OR p_reason_code !~ '^[a-z_]{1,64}$'
     OR (p_mode = 'open' AND (p_source_sha IS NULL OR p_source_sha !~ '^[0-9a-f]{40}$'))
     OR (p_source_sha IS NOT NULL AND p_source_sha !~ '^[0-9a-f]{40}$') THEN
    RAISE EXCEPTION 'invalid launch recovery transition' USING ERRCODE = '22023';
  END IF;

  SELECT c.* INTO current_row
    FROM launch_recovery_control AS c
   WHERE c.singleton = true
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'launch recovery control missing' USING ERRCODE = '55000';
  END IF;
  IF current_row.epoch <> p_expected_epoch THEN
    RAISE EXCEPTION 'launch recovery epoch changed' USING ERRCODE = '40001';
  END IF;
  IF p_mode = current_row.mode THEN
    RETURN QUERY SELECT current_row.mode, current_row.epoch, current_row.changed_at;
    RETURN;
  END IF;
  IF p_mode = 'open' AND p_protocol_version < current_row.required_protocol THEN
    RAISE EXCEPTION 'launch recovery protocol too old' USING ERRCODE = '55000';
  END IF;
  IF p_mode = 'open' AND EXISTS (
    SELECT 1
      FROM pods AS p
     WHERE p.state = 'active'
       AND p.provider IN ('sandbox', 'host')
       AND p.provider_sandbox_id IS NULL
       AND p.provider_state IN ('preparing_image', 'provisioning', 'starting', 'error', 'gone')
       AND NOT EXISTS (SELECT 1 FROM pod_create_attempts AS a WHERE a.pod_id = p.id)
  ) THEN
    RAISE EXCEPTION 'unaccounted legacy launch rows remain' USING ERRCODE = '55000';
  END IF;

  UPDATE launch_recovery_control AS c
     SET mode = p_mode,
         epoch = c.epoch + 1,
         changed_at = now(),
         actor = p_actor,
         reason_code = p_reason_code
   WHERE c.singleton = true
   RETURNING c.mode, c.epoch, c.changed_at INTO current_row.mode, current_row.epoch, current_row.changed_at;

  INSERT INTO launch_recovery_control_events
    (epoch, cutover_id, previous_mode, new_mode, protocol_version, source_sha, actor, reason_code)
  VALUES
    (current_row.epoch, current_row.cutover_id, CASE WHEN p_mode = 'open' THEN 'held' ELSE 'open' END,
     p_mode, p_protocol_version, p_source_sha, p_actor, p_reason_code);

  RETURN QUERY SELECT current_row.mode, current_row.epoch, current_row.changed_at;
END
$_$;
