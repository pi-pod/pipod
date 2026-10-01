-- The open-source schema as of the split from the hosted product (2026-10-01).
--
-- Fresh databases start here. A database that already ran the pre-split migrations
-- 001-123 has this schema; the migrator records this file as applied for it (see
-- src/server/db/migrate.ts). New migrations continue at 124.
--
-- Generated from the legacy chain with pg_dump: names are schema-qualified and the
-- function bodies are verbatim. Change the schema with a new migration, not here.

-- SQL-language function bodies may name tables created further down.
SET LOCAL check_function_bodies = false;

CREATE FUNCTION public.job_host_wait_snapshot_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.host_wait_job IS NOT NULL AND (NEW.host_wait_job IS DISTINCT FROM OLD.host_wait_job
    OR NEW.host_wait_deadline IS DISTINCT FROM OLD.host_wait_deadline) THEN
    RAISE EXCEPTION 'scheduled host wait snapshot is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.sandbox_host_identity_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR (OLD.box_id IS NOT NULL AND NEW.box_id IS DISTINCT FROM OLD.box_id) THEN
    RAISE EXCEPTION 'sandbox host identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.sandbox_host_isolated_custody_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.isolated_pod_id IS DISTINCT FROM OLD.isolated_pod_id THEN
    RAISE EXCEPTION 'isolated pod custody is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.isolated_pod_id IS NOT NULL
    AND OLD.box_state IN ('deleted','superseded')
    AND NEW.box_state IS DISTINCT FROM OLD.box_state
    AND NEW.box_state NOT IN ('deleted','superseded') THEN
    RAISE EXCEPTION 'terminal isolated host cannot reenter live custody' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.sandbox_pod_host_identity_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE owner_id text; isolated_id uuid;
BEGIN
  IF TG_OP='UPDATE' AND EXISTS (SELECT 1 FROM sandbox_hosts h
    WHERE h.isolated_pod_id=OLD.id
      AND h.box_state IS DISTINCT FROM 'deleted' AND h.box_state IS DISTINCT FROM 'superseded'
      AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.sandbox_host_id IS DISTINCT FROM h.id)) THEN
    RAISE EXCEPTION 'live isolated pod identity or route cannot change' USING ERRCODE='23514';
  END IF;
  IF NEW.sandbox_host_id IS NOT NULL THEN
    SELECT owner_user_id,isolated_pod_id INTO owner_id,isolated_id FROM sandbox_hosts
      WHERE id=NEW.sandbox_host_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'sandbox host does not exist' USING ERRCODE='23503'; END IF;
    IF NEW.provider <> 'sandbox' OR (owner_id IS NOT NULL AND owner_id <> NEW.user_id)
      OR (isolated_id IS NOT NULL AND isolated_id <> NEW.id) THEN
      RAISE EXCEPTION 'sandbox host custody mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.set_launch_recovery_mode(p_mode text, p_expected_epoch bigint, p_protocol_version integer, p_source_sha text, p_actor text, p_reason_code text) RETURNS TABLE(mode text, epoch bigint, changed_at timestamp with time zone)
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
       AND NOT EXISTS (
         SELECT 1 FROM pod_create_attempts AS a
          WHERE a.pod_id = p.id AND a.phase IN (
            'prepared', 'dispatching', 'unknown', 'sandbox_known',
            'initialization_interrupted', 'legacy_unresolved', 'delete_pending'
          )
       )
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

CREATE TABLE public.audit_log (
    id uuid NOT NULL,
    org_id text NOT NULL,
    actor_id text,
    action text NOT NULL,
    target_type text,
    target_id text,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.client_requests (
    session_id uuid NOT NULL,
    client_request_id text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.cpu_grant_ledger (
    host_id text NOT NULL,
    user_key text NOT NULL,
    revision bigint NOT NULL,
    cpu_cores double precision,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    desired_cpu_cores double precision,
    confirmed_cpu_cores double precision,
    confirmed_revision bigint,
    confirmed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    freshness text DEFAULT 'fresh'::text NOT NULL,
    CONSTRAINT cpu_grant_ledger_confirmed_cpu_cores_check CHECK (((confirmed_cpu_cores IS NULL) OR (confirmed_cpu_cores >= (0)::double precision))),
    CONSTRAINT cpu_grant_ledger_confirmed_revision_check CHECK (((confirmed_revision IS NULL) OR (confirmed_revision >= 0))),
    CONSTRAINT cpu_grant_ledger_cpu_cores_check CHECK (((cpu_cores IS NULL) OR (cpu_cores > (0)::double precision))),
    CONSTRAINT cpu_grant_ledger_desired_cpu_cores_check CHECK (((desired_cpu_cores IS NULL) OR (desired_cpu_cores >= (0)::double precision))),
    CONSTRAINT cpu_grant_ledger_freshness_check CHECK ((freshness = ANY (ARRAY['fresh'::text, 'stale'::text]))),
    CONSTRAINT cpu_grant_ledger_revision_check CHECK ((revision >= 0)),
    CONSTRAINT cpu_grant_ledger_state_check CHECK ((state = ANY (ARRAY['active'::text, 'expired'::text, 'superseded'::text, 'revoked'::text])))
);

CREATE TABLE public.devices (
    id uuid NOT NULL,
    user_id text NOT NULL,
    platform text DEFAULT 'ios'::text NOT NULL,
    apns_token text NOT NULL,
    environment text NOT NULL,
    last_seen_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    token_kind text DEFAULT 'apns'::text NOT NULL
);

CREATE TABLE public.grant_allocator_lease (
    id integer NOT NULL,
    holder text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT grant_allocator_lease_id_check CHECK ((id = 1))
);

CREATE TABLE public.image_builds (
    credential_scope text NOT NULL,
    provider text NOT NULL,
    image_ref text NOT NULL,
    status text NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    attempt integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT image_builds_attempt_check CHECK ((attempt >= 0)),
    CONSTRAINT image_builds_status_check CHECK ((status = ANY (ARRAY['building'::text, 'ready'::text, 'failed'::text])))
);

CREATE TABLE public.job_runs (
    id uuid NOT NULL,
    job_id uuid NOT NULL,
    org_id text NOT NULL,
    pod_id uuid,
    scheduled_at timestamp with time zone NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    prompted_at timestamp with time zone,
    finished_at timestamp with time zone,
    interrupted_at timestamp with time zone,
    host_wait_state text,
    host_wait_job jsonb,
    host_wait_deadline timestamp with time zone,
    host_wait_retry_at timestamp with time zone,
    host_wait_lease_owner text,
    host_wait_lease_until timestamp with time zone,
    host_wait_fence bigint DEFAULT 0 NOT NULL,
    CONSTRAINT job_runs_host_wait_job_check CHECK (((host_wait_job IS NULL) OR (jsonb_typeof(host_wait_job) = 'object'::text))),
    CONSTRAINT job_runs_host_wait_state_check CHECK ((host_wait_state = ANY (ARRAY['waiting'::text, 'dispatching'::text]))),
    CONSTRAINT job_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'interrupted'::text])))
);

CREATE TABLE public.jobs (
    id uuid NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'active'::text NOT NULL,
    trigger jsonb NOT NULL,
    template_id uuid,
    model text NOT NULL,
    prompt text NOT NULL,
    created_from_pod uuid,
    next_run_at timestamp with time zone,
    last_run_at timestamp with time zone,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    scope text DEFAULT 'user'::text NOT NULL,
    CONSTRAINT jobs_scope_check CHECK ((scope = ANY (ARRAY['user'::text, 'org'::text]))),
    CONSTRAINT jobs_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'completed'::text])))
);

CREATE TABLE public.launch_recovery_control (
    singleton boolean DEFAULT true NOT NULL,
    mode text NOT NULL,
    epoch bigint NOT NULL,
    required_protocol integer NOT NULL,
    cutover_id uuid DEFAULT gen_random_uuid() NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    actor text NOT NULL,
    reason_code text NOT NULL,
    CONSTRAINT launch_recovery_control_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT launch_recovery_control_mode_check CHECK ((mode = ANY (ARRAY['held'::text, 'open'::text]))),
    CONSTRAINT launch_recovery_control_required_protocol_check CHECK ((required_protocol > 0)),
    CONSTRAINT launch_recovery_control_singleton_check CHECK (singleton)
);

CREATE TABLE public.launch_recovery_control_events (
    epoch bigint NOT NULL,
    cutover_id uuid NOT NULL,
    previous_mode text NOT NULL,
    new_mode text NOT NULL,
    protocol_version integer NOT NULL,
    source_sha text,
    actor text NOT NULL,
    reason_code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT launch_recovery_control_events_new_mode_check CHECK ((new_mode = ANY (ARRAY['held'::text, 'open'::text]))),
    CONSTRAINT launch_recovery_control_events_previous_mode_check CHECK ((previous_mode = ANY (ARRAY['held'::text, 'open'::text]))),
    CONSTRAINT launch_recovery_control_events_protocol_version_check CHECK ((protocol_version > 0)),
    CONSTRAINT launch_recovery_control_events_source_sha_check CHECK (((source_sha IS NULL) OR (source_sha ~ '^[0-9a-f]{40}$'::text)))
);

CREATE TABLE public.model_credential_login_tickets (
    id uuid NOT NULL,
    ticket_hash text NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    provider_id text NOT NULL,
    auth_type text NOT NULL,
    pod_id uuid,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT model_credential_login_tickets_auth_type_check CHECK ((auth_type = ANY (ARRAY['oauth'::text, 'api_key'::text])))
);

CREATE TABLE public.model_credentials (
    id uuid NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    provider_id text NOT NULL,
    credential_type text NOT NULL,
    ciphertext bytea NOT NULL,
    key_id text NOT NULL,
    expires_at timestamp with time zone,
    revision bigint DEFAULT 1 NOT NULL,
    last_refresh_at timestamp with time zone,
    last_failure_code text,
    last_failure_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    encryption_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT model_credentials_credential_type_check CHECK ((credential_type = ANY (ARRAY['oauth'::text, 'api_key'::text]))),
    CONSTRAINT model_credentials_encryption_version_check CHECK ((encryption_version = ANY (ARRAY[1, 2])))
);

CREATE TABLE public.organizations (
    id text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    alias text
);

CREATE TABLE public.pending_interactions (
    id uuid NOT NULL,
    session_id uuid NOT NULL,
    seq bigint NOT NULL,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolution jsonb,
    delivered_at timestamp with time zone
);

CREATE TABLE public.pi_auth (
    id uuid NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    ciphertext bytea NOT NULL,
    key_id text NOT NULL,
    providers text[] DEFAULT '{}'::text[] NOT NULL,
    saved_from_pod uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    encryption_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT pi_auth_encryption_version_check CHECK ((encryption_version = ANY (ARRAY[1, 2])))
);

CREATE TABLE public.pod_capacity_wait (
    pod_id uuid NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    operation_key text NOT NULL,
    status text DEFAULT 'waiting'::text NOT NULL,
    reason text,
    detail jsonb,
    attempts integer DEFAULT 0 NOT NULL,
    last_attempt_at timestamp with time zone,
    heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
    deadline_at timestamp with time zone NOT NULL,
    cancel_requested boolean DEFAULT false NOT NULL,
    last_host_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text DEFAULT 'create'::text NOT NULL,
    intent jsonb,
    last_host_id text,
    CONSTRAINT pod_capacity_wait_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT pod_capacity_wait_kind_check CHECK ((kind = ANY (ARRAY['create'::text, 'wake'::text]))),
    CONSTRAINT pod_capacity_wait_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'cancelled'::text, 'expired'::text, 'admitted'::text])))
);

CREATE TABLE public.pod_create_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pod_id uuid NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    provider text NOT NULL,
    protocol_version smallint DEFAULT 1 NOT NULL,
    attempt_no integer NOT NULL,
    operation_key text,
    sandbox_host_id text,
    host_pod_id uuid,
    host_generation bigint,
    host_runtime_sha256 text,
    runtime_boot_id text,
    static_host_url_sha256 text,
    expected_sandbox_id text,
    observed_candidate_sandbox_id text,
    observed_match_count integer,
    last_provider_status text,
    last_provider_resolution text,
    last_provider_error_code text,
    sandbox_id text,
    phase text NOT NULL,
    owner_epoch bigint DEFAULT 1 NOT NULL,
    owner_instance_id uuid,
    owner_token uuid,
    owner_lease_until timestamp with time zone,
    dispatch_owner_epoch bigint,
    launch_control_epoch bigint,
    recovery_epoch bigint DEFAULT 0 NOT NULL,
    recovery_token uuid,
    recovery_lease_until timestamp with time zone,
    reason_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    dispatch_committed_at timestamp with time zone,
    last_observed_at timestamp with time zone,
    next_observe_at timestamp with time zone,
    bound_at timestamp with time zone,
    finished_at timestamp with time zone,
    legacy_deletion_resolution jsonb,
    CONSTRAINT pod_create_attempts_attempt_no_check CHECK ((attempt_no >= 0)),
    CONSTRAINT pod_create_attempts_check CHECK (((owner_token IS NULL) = (owner_lease_until IS NULL))),
    CONSTRAINT pod_create_attempts_check1 CHECK (((recovery_token IS NULL) = (recovery_lease_until IS NULL))),
    CONSTRAINT pod_create_attempts_check2 CHECK (((phase <> 'legacy_unresolved'::text) OR ((attempt_no = 0) AND (operation_key IS NULL) AND (owner_instance_id IS NULL)))),
    CONSTRAINT pod_create_attempts_host_runtime_sha256_check CHECK (((host_runtime_sha256 IS NULL) OR (host_runtime_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT pod_create_attempts_identity_phase_check CHECK (((phase = 'legacy_unresolved'::text) OR ((attempt_no > 0) AND (owner_instance_id IS NOT NULL)) OR (((phase = 'deleted'::text) AND (attempt_no = 0) AND (operation_key IS NULL) AND (owner_instance_id IS NULL) AND (jsonb_typeof(legacy_deletion_resolution) = 'object'::text) AND ((legacy_deletion_resolution ->> 'kind'::text) = 'usage_deleted'::text) AND ((legacy_deletion_resolution ->> 'attemptId'::text) = (id)::text) AND ((legacy_deletion_resolution ->> 'podId'::text) = (pod_id)::text) AND (jsonb_typeof((legacy_deletion_resolution -> 'sandboxId'::text)) = 'string'::text) AND (jsonb_typeof((legacy_deletion_resolution -> 'hostId'::text)) = 'string'::text) AND (jsonb_typeof((legacy_deletion_resolution -> 'receiptSeq'::text)) = 'string'::text) AND (jsonb_typeof((legacy_deletion_resolution -> 'deletedAt'::text)) = 'string'::text) AND (jsonb_typeof((legacy_deletion_resolution -> 'resolvedAt'::text)) = 'string'::text) AND (jsonb_typeof((legacy_deletion_resolution -> 'operator'::text)) = 'string'::text) AND (btrim((legacy_deletion_resolution ->> 'sandboxId'::text)) <> ''::text) AND (btrim((legacy_deletion_resolution ->> 'hostId'::text)) <> ''::text) AND (btrim((legacy_deletion_resolution ->> 'receiptSeq'::text)) <> ''::text) AND (btrim((legacy_deletion_resolution ->> 'deletedAt'::text)) <> ''::text) AND (btrim((legacy_deletion_resolution ->> 'resolvedAt'::text)) <> ''::text) AND (btrim((legacy_deletion_resolution ->> 'operator'::text)) <> ''::text)) IS TRUE))),
    CONSTRAINT pod_create_attempts_last_provider_error_code_check CHECK (((last_provider_error_code IS NULL) OR (last_provider_error_code ~ '^[a-z0-9_]{1,64}$'::text))),
    CONSTRAINT pod_create_attempts_last_provider_resolution_check CHECK (((last_provider_resolution IS NULL) OR (last_provider_resolution = ANY (ARRAY['preallocation'::text, 'cleaned'::text, 'quarantined'::text])))),
    CONSTRAINT pod_create_attempts_last_provider_status_check CHECK (((last_provider_status IS NULL) OR (last_provider_status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))),
    CONSTRAINT pod_create_attempts_legacy_resolution_scope_check CHECK (((legacy_deletion_resolution IS NULL) OR ((phase = 'deleted'::text) AND (attempt_no = 0) AND (operation_key IS NULL) AND (owner_instance_id IS NULL)))),
    CONSTRAINT pod_create_attempts_observed_match_count_check CHECK (((observed_match_count IS NULL) OR (observed_match_count >= 0))),
    CONSTRAINT pod_create_attempts_operation_key_check CHECK (((operation_key IS NULL) OR (operation_key ~ '^[A-Za-z0-9._:-]{8,128}$'::text))),
    CONSTRAINT pod_create_attempts_owner_epoch_check CHECK ((owner_epoch > 0)),
    CONSTRAINT pod_create_attempts_phase_check CHECK ((phase = ANY (ARRAY['prepared'::text, 'dispatching'::text, 'unknown'::text, 'sandbox_known'::text, 'initialization_interrupted'::text, 'ready'::text, 'failed_safe'::text, 'aborted_unsent'::text, 'legacy_unresolved'::text, 'delete_pending'::text, 'deleted'::text]))),
    CONSTRAINT pod_create_attempts_protocol_version_check CHECK ((protocol_version > 0)),
    CONSTRAINT pod_create_attempts_provider_check CHECK ((provider = ANY (ARRAY['sandbox'::text, 'host'::text]))),
    CONSTRAINT pod_create_attempts_reason_code_check CHECK (((reason_code IS NULL) OR (reason_code ~ '^[a-z_]{1,64}$'::text))),
    CONSTRAINT pod_create_attempts_recovery_epoch_check CHECK ((recovery_epoch >= 0)),
    CONSTRAINT pod_create_attempts_static_host_url_sha256_check CHECK (((static_host_url_sha256 IS NULL) OR (static_host_url_sha256 ~ '^[0-9a-f]{64}$'::text)))
);

CREATE TABLE public.pod_fork_seeds (
    pod_id uuid NOT NULL,
    source_pod_id uuid NOT NULL,
    source_path text NOT NULL,
    content bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_at timestamp with time zone
);

CREATE TABLE public.pod_launch_env (
    pod_id uuid NOT NULL,
    ciphertext bytea NOT NULL,
    key_id text NOT NULL,
    host_keys text[] DEFAULT '{}'::text[] NOT NULL,
    repo_keys text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    encryption_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT pod_launch_env_encryption_version_check CHECK ((encryption_version = ANY (ARRAY[1, 2])))
);

CREATE TABLE public.pod_launch_operations (
    org_id text NOT NULL,
    user_id text NOT NULL,
    operation_id uuid NOT NULL,
    template_id uuid,
    state text NOT NULL,
    owner_generation bigint DEFAULT 1 NOT NULL,
    owner_token uuid,
    owner_lease_until timestamp with time zone,
    pod_id uuid,
    error_status integer,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pod_launch_operations_check CHECK ((((state = 'pending'::text) AND (owner_token IS NOT NULL) AND (owner_lease_until IS NOT NULL)) OR ((state <> 'pending'::text) AND (owner_token IS NULL) AND (owner_lease_until IS NULL)))),
    CONSTRAINT pod_launch_operations_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'waiting'::text, 'admitted'::text, 'rejected'::text, 'unknown'::text])))
);

CREATE TABLE public.pod_owner_init (
    pod_id uuid NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    host_id text NOT NULL,
    sandbox_id text NOT NULL,
    user_key text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pod_owner_init_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT pod_owner_init_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'done'::text, 'conflict'::text, 'live_skipped'::text, 'error'::text])))
);

CREATE TABLE public.pod_rehome_state (
    pod_id uuid NOT NULL,
    holder text NOT NULL,
    stage text NOT NULL,
    target_url text,
    source_url text NOT NULL,
    archive_key text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pod_rehome_state_stage_check CHECK ((stage = ANY (ARRAY['holding'::text, 'manifest_ok'::text, 'imported'::text, 'repointed'::text, 'retired'::text])))
);

CREATE TABLE public.pod_retention (
    pod_id uuid NOT NULL,
    desired_archive_after_minutes integer NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    previous_archive_after_minutes integer,
    status text DEFAULT 'pending'::text NOT NULL,
    provider_archive_after_minutes integer,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    credential_source text,
    CONSTRAINT pod_retention_credential_source_check CHECK ((credential_source = ANY (ARRAY['platform'::text, 'org-secret'::text]))),
    CONSTRAINT pod_retention_desired_archive_after_minutes_check CHECK ((desired_archive_after_minutes >= 0)),
    CONSTRAINT pod_retention_revision_check CHECK ((revision >= 1)),
    CONSTRAINT pod_retention_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text, 'failed'::text, 'skipped'::text])))
);

CREATE TABLE public.pod_templates (
    id uuid NOT NULL,
    org_id text NOT NULL,
    name text NOT NULL,
    description text,
    init_script text,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by text,
    created_from_pod uuid,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_user_id text,
    bake_script text,
    pi_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT pod_templates_pi_settings_object CHECK ((jsonb_typeof(pi_settings) = 'object'::text))
);

CREATE TABLE public.pod_tokens (
    id uuid NOT NULL,
    pod_id uuid NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    token_hash text NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.pods (
    id uuid NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    provider text NOT NULL,
    provider_sandbox_id text,
    state text NOT NULL,
    resolved_config jsonb NOT NULL,
    gateway_id text,
    last_activity_at timestamp with time zone,
    archived_at timestamp with time zone,
    reaped_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    template_id uuid,
    name text NOT NULL,
    gateway_heartbeat_at timestamp with time zone,
    state_reason text,
    project text,
    provider_state text NOT NULL,
    provider_state_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    work_lease_until timestamp with time zone,
    provisioning_heartbeat_at timestamp with time zone,
    parent_pod_id uuid,
    lineage_root_id uuid,
    lineage_depth integer DEFAULT 0 NOT NULL,
    last_pod_seq bigint,
    last_stop_cause text,
    forked_from_pod_id uuid,
    transport text DEFAULT 'ws'::text NOT NULL,
    pi_session_file text,
    host_pod_id uuid,
    credential_providers text[],
    sandbox_host_id text,
    gateway_attached_until timestamp with time zone,
    queued_prompt_demand_after timestamp with time zone,
    CONSTRAINT pods_transport_check CHECK ((transport = ANY (ARRAY['pty'::text, 'ws'::text])))
);

COMMENT ON COLUMN public.pods.transport IS 'Gateway-to-pod carrier selected at launch; pty remains for rollout compatibility.';

CREATE TABLE public.push_queue (
    id uuid NOT NULL,
    user_id text NOT NULL,
    payload jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    failed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.queued_prompts (
    id uuid NOT NULL,
    pod_id uuid NOT NULL,
    user_id text NOT NULL,
    text text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    claimed_at timestamp with time zone,
    delivered_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT queued_prompts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'delivering'::text, 'delivered'::text, 'failed'::text, 'unknown'::text])))
);

CREATE TABLE public.sandbox_hosts (
    id text NOT NULL,
    url text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_user_id text,
    box_id text,
    box_state text,
    hosted_url text,
    last_seen_at timestamp with time zone,
    runtime_boot_id text,
    generation bigint DEFAULT 0 NOT NULL,
    auth_ciphertext bytea,
    auth_key_id text,
    auth_encryption_version integer,
    isolated_pod_id uuid,
    CONSTRAINT sandbox_hosts_auth_complete_check CHECK (((num_nonnulls(auth_ciphertext, auth_key_id, auth_encryption_version) = ANY (ARRAY[0, 3])) AND ((auth_encryption_version IS NULL) OR (auth_encryption_version = 2)))),
    CONSTRAINT sandbox_hosts_box_owner_check CHECK ((((owner_user_id IS NULL) AND (box_state IS NULL) AND (box_id IS NULL) AND (url IS NOT NULL)) OR ((owner_user_id IS NOT NULL) AND (box_state IS NOT NULL)))),
    CONSTRAINT sandbox_hosts_box_state_check CHECK (((box_state IS NULL) OR (box_state = ANY (ARRAY['provisioning'::text, 'starting'::text, 'running'::text, 'stopping'::text, 'stopped'::text, 'error'::text, 'unknown'::text, 'deleting'::text, 'deleted'::text, 'superseded'::text])))),
    CONSTRAINT sandbox_hosts_generation_check CHECK ((generation >= 0)),
    CONSTRAINT sandbox_hosts_hosted_url_public_check CHECK (((hosted_url IS NULL) OR ((hosted_url ~ '^https?://'::text) AND (hosted_url !~ '[?#]'::text) AND (hosted_url !~ '://[^/]*@'::text)))),
    CONSTRAINT sandbox_hosts_isolated_owner_check CHECK (((isolated_pod_id IS NULL) OR (owner_user_id IS NOT NULL))),
    CONSTRAINT sandbox_hosts_owned_url_public_check CHECK (((owner_user_id IS NULL) OR (url IS NULL) OR ((url ~ '^https?://'::text) AND (url !~ '[?#]'::text) AND (url !~ '://[^/]*@'::text)))),
    CONSTRAINT sandbox_hosts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'draining'::text])))
);

CREATE VIEW public.sandbox_host_auth AS
 SELECT id,
    owner_user_id,
    auth_ciphertext AS ciphertext,
    auth_key_id AS key_id,
    auth_encryption_version AS encryption_version,
    updated_at
   FROM public.sandbox_hosts
  WHERE (auth_ciphertext IS NOT NULL);

CREATE TABLE public.secrets (
    id uuid NOT NULL,
    org_id text NOT NULL,
    scope_type text NOT NULL,
    scope_id text NOT NULL,
    name text NOT NULL,
    ciphertext bytea NOT NULL,
    key_id text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    encryption_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT secrets_encryption_version_check CHECK ((encryption_version = ANY (ARRAY[1, 2]))),
    CONSTRAINT secrets_scope_type_check CHECK ((scope_type = ANY (ARRAY['org'::text, 'user'::text, 'template'::text])))
);

CREATE TABLE public.session_events (
    session_id uuid NOT NULL,
    seq bigint NOT NULL,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.sessions (
    id uuid NOT NULL,
    pod_id uuid NOT NULL,
    user_id text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    end_reason text,
    events_truncated_below_seq bigint
);

CREATE TABLE public.settings (
    id uuid NOT NULL,
    scope_type text NOT NULL,
    scope_id text NOT NULL,
    org_id text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    init_script text DEFAULT ''::text NOT NULL,
    bake_script text DEFAULT ''::text NOT NULL,
    pi_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT settings_pi_settings_object CHECK ((jsonb_typeof(pi_settings) = 'object'::text)),
    CONSTRAINT settings_scope_type_check CHECK ((scope_type = ANY (ARRAY['org_defaults'::text, 'user_defaults'::text, 'org_policy'::text])))
);

CREATE TABLE public.settings_proposals (
    id uuid NOT NULL,
    org_id text NOT NULL,
    scope_type text NOT NULL,
    scope_id text NOT NULL,
    config jsonb,
    init_script text,
    secret_names text[] DEFAULT '{}'::text[] NOT NULL,
    note text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_by text NOT NULL,
    created_from_pod uuid NOT NULL,
    resolved_by text,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    bake_script text,
    CONSTRAINT settings_proposals_scope_type_check CHECK ((scope_type = 'org_defaults'::text)),
    CONSTRAINT settings_proposals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text, 'rejected'::text])))
);

CREATE TABLE public.users (
    id text NOT NULL,
    email text NOT NULL,
    display_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ws_tickets (
    id uuid NOT NULL,
    ticket text NOT NULL,
    user_id text NOT NULL,
    pod_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.client_requests
    ADD CONSTRAINT client_requests_pkey PRIMARY KEY (session_id, client_request_id);

ALTER TABLE ONLY public.cpu_grant_ledger
    ADD CONSTRAINT cpu_grant_ledger_pkey PRIMARY KEY (host_id, user_key);

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_apns_token_key UNIQUE (apns_token);

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.grant_allocator_lease
    ADD CONSTRAINT grant_allocator_lease_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.image_builds
    ADD CONSTRAINT image_builds_pkey PRIMARY KEY (credential_scope, provider, image_ref);

ALTER TABLE ONLY public.job_runs
    ADD CONSTRAINT job_runs_job_id_scheduled_at_key UNIQUE (job_id, scheduled_at);

ALTER TABLE ONLY public.job_runs
    ADD CONSTRAINT job_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.launch_recovery_control_events
    ADD CONSTRAINT launch_recovery_control_events_pkey PRIMARY KEY (epoch);

ALTER TABLE ONLY public.launch_recovery_control
    ADD CONSTRAINT launch_recovery_control_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY public.model_credential_login_tickets
    ADD CONSTRAINT model_credential_login_tickets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.model_credential_login_tickets
    ADD CONSTRAINT model_credential_login_tickets_ticket_hash_key UNIQUE (ticket_hash);

ALTER TABLE ONLY public.model_credentials
    ADD CONSTRAINT model_credentials_org_id_user_id_provider_id_key UNIQUE (org_id, user_id, provider_id);

ALTER TABLE ONLY public.model_credentials
    ADD CONSTRAINT model_credentials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pending_interactions
    ADD CONSTRAINT pending_interactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pi_auth
    ADD CONSTRAINT pi_auth_org_id_user_id_key UNIQUE (org_id, user_id);

ALTER TABLE ONLY public.pi_auth
    ADD CONSTRAINT pi_auth_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pod_capacity_wait
    ADD CONSTRAINT pod_capacity_wait_pkey PRIMARY KEY (pod_id);

ALTER TABLE ONLY public.pod_create_attempts
    ADD CONSTRAINT pod_create_attempts_operation_key_key UNIQUE (operation_key);

ALTER TABLE ONLY public.pod_create_attempts
    ADD CONSTRAINT pod_create_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pod_fork_seeds
    ADD CONSTRAINT pod_fork_seeds_pkey PRIMARY KEY (pod_id);

ALTER TABLE ONLY public.pod_launch_env
    ADD CONSTRAINT pod_launch_env_pkey PRIMARY KEY (pod_id);

ALTER TABLE ONLY public.pod_launch_operations
    ADD CONSTRAINT pod_launch_operations_pkey PRIMARY KEY (org_id, user_id, operation_id);

ALTER TABLE ONLY public.pod_launch_operations
    ADD CONSTRAINT pod_launch_operations_pod_id_key UNIQUE (pod_id);

ALTER TABLE ONLY public.pod_owner_init
    ADD CONSTRAINT pod_owner_init_pkey PRIMARY KEY (pod_id);

ALTER TABLE ONLY public.pod_rehome_state
    ADD CONSTRAINT pod_rehome_state_pkey PRIMARY KEY (pod_id);

ALTER TABLE ONLY public.pod_retention
    ADD CONSTRAINT pod_retention_pkey PRIMARY KEY (pod_id);

ALTER TABLE ONLY public.pod_templates
    ADD CONSTRAINT pod_templates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pod_tokens
    ADD CONSTRAINT pod_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pod_tokens
    ADD CONSTRAINT pod_tokens_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.pods
    ADD CONSTRAINT pods_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pods
    ADD CONSTRAINT pods_provider_sandbox_id_key UNIQUE (provider_sandbox_id);

ALTER TABLE ONLY public.push_queue
    ADD CONSTRAINT push_queue_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.queued_prompts
    ADD CONSTRAINT queued_prompts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sandbox_hosts
    ADD CONSTRAINT sandbox_hosts_box_id_key UNIQUE (box_id);

ALTER TABLE ONLY public.sandbox_hosts
    ADD CONSTRAINT sandbox_hosts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sandbox_hosts
    ADD CONSTRAINT sandbox_hosts_url_key UNIQUE (url);

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_org_scope_name_key UNIQUE (org_id, scope_type, scope_id, name);

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.session_events
    ADD CONSTRAINT session_events_pkey PRIMARY KEY (session_id, seq);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.settings_proposals
    ADD CONSTRAINT settings_proposals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_scope_type_scope_id_org_id_key UNIQUE (scope_type, scope_id, org_id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ws_tickets
    ADD CONSTRAINT ws_tickets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ws_tickets
    ADD CONSTRAINT ws_tickets_ticket_key UNIQUE (ticket);

CREATE INDEX audit_log_org_idx ON public.audit_log USING btree (org_id, created_at DESC);

CREATE INDEX cpu_grant_ledger_state_idx ON public.cpu_grant_ledger USING btree (state, expires_at) WHERE (state = 'active'::text);

CREATE INDEX devices_user_kind_idx ON public.devices USING btree (user_id, token_kind);

CREATE INDEX image_builds_active_lease_idx ON public.image_builds USING btree (lease_expires_at) WHERE (status = 'building'::text);

CREATE INDEX job_runs_by_job ON public.job_runs USING btree (job_id, started_at DESC);

CREATE INDEX job_runs_host_wait_due ON public.job_runs USING btree (host_wait_retry_at) WHERE ((status = 'running'::text) AND (host_wait_state = 'waiting'::text));

CREATE INDEX job_runs_interrupted ON public.job_runs USING btree (interrupted_at) WHERE (status = 'interrupted'::text);

CREATE INDEX job_runs_running ON public.job_runs USING btree (started_at) WHERE (status = 'running'::text);

CREATE INDEX jobs_due ON public.jobs USING btree (next_run_at) WHERE ((status = 'active'::text) AND (archived_at IS NULL));

CREATE UNIQUE INDEX jobs_org_live_name ON public.jobs USING btree (org_id, name) WHERE ((archived_at IS NULL) AND (scope = 'org'::text));

CREATE UNIQUE INDEX jobs_user_live_name ON public.jobs USING btree (org_id, user_id, name) WHERE ((archived_at IS NULL) AND (scope = 'user'::text));

CREATE INDEX model_credentials_expires_at_idx ON public.model_credentials USING btree (expires_at) WHERE (expires_at IS NOT NULL);

CREATE INDEX model_credentials_subject_idx ON public.model_credentials USING btree (org_id, user_id);

CREATE INDEX pending_interactions_created_idx ON public.pending_interactions USING btree (created_at);

CREATE INDEX pending_interactions_open_idx ON public.pending_interactions USING btree (session_id) WHERE (resolved_at IS NULL);

CREATE INDEX pending_interactions_undelivered_idx ON public.pending_interactions USING btree (session_id) WHERE ((resolved_at IS NOT NULL) AND (delivered_at IS NULL));

CREATE INDEX pod_capacity_wait_deadline_idx ON public.pod_capacity_wait USING btree (deadline_at) WHERE (status = 'waiting'::text);

CREATE INDEX pod_capacity_wait_status_idx ON public.pod_capacity_wait USING btree (status, created_at) WHERE (status = 'waiting'::text);

CREATE INDEX pod_capacity_wait_user_idx ON public.pod_capacity_wait USING btree (user_id, status, created_at) WHERE (status = 'waiting'::text);

CREATE INDEX pod_create_attempts_host_idx ON public.pod_create_attempts USING btree (sandbox_host_id, phase, created_at) WHERE (sandbox_host_id IS NOT NULL);

CREATE UNIQUE INDEX pod_create_attempts_one_open_per_pod_idx ON public.pod_create_attempts USING btree (pod_id) WHERE (phase = ANY (ARRAY['prepared'::text, 'dispatching'::text, 'unknown'::text, 'sandbox_known'::text, 'initialization_interrupted'::text, 'legacy_unresolved'::text, 'delete_pending'::text]));

CREATE UNIQUE INDEX pod_create_attempts_pod_attempt_idx ON public.pod_create_attempts USING btree (pod_id, attempt_no);

CREATE INDEX pod_create_attempts_recovery_due_idx ON public.pod_create_attempts USING btree (next_observe_at, created_at) WHERE (phase = ANY (ARRAY['dispatching'::text, 'unknown'::text, 'sandbox_known'::text, 'initialization_interrupted'::text, 'legacy_unresolved'::text, 'delete_pending'::text]));

CREATE INDEX pod_create_attempts_user_hold_idx ON public.pod_create_attempts USING btree (user_id, phase, updated_at) WHERE (phase = ANY (ARRAY['dispatching'::text, 'unknown'::text, 'sandbox_known'::text, 'initialization_interrupted'::text, 'legacy_unresolved'::text, 'delete_pending'::text]));

CREATE INDEX pod_launch_operations_owner_idx ON public.pod_launch_operations USING btree (org_id, user_id, updated_at DESC);

CREATE INDEX pod_owner_init_status_idx ON public.pod_owner_init USING btree (status, updated_at) WHERE (status = ANY (ARRAY['pending'::text, 'error'::text, 'live_skipped'::text]));

CREATE INDEX pod_rehome_state_stage_idx ON public.pod_rehome_state USING btree (stage, updated_at);

CREATE INDEX pod_retention_status_idx ON public.pod_retention USING btree (status, updated_at);

CREATE UNIQUE INDEX pod_templates_org_live_name ON public.pod_templates USING btree (org_id, name) WHERE ((archived_at IS NULL) AND (owner_user_id IS NULL));

CREATE UNIQUE INDEX pod_templates_user_live_name ON public.pod_templates USING btree (org_id, owner_user_id, name) WHERE ((archived_at IS NULL) AND (owner_user_id IS NOT NULL));

CREATE INDEX pod_tokens_pod_id_idx ON public.pod_tokens USING btree (pod_id);

CREATE INDEX pods_host_pod_idx ON public.pods USING btree (host_pod_id) WHERE (host_pod_id IS NOT NULL);

CREATE INDEX pods_idle_activity_idx ON public.pods USING btree (provider_state, work_lease_until, last_activity_at) WHERE (provider_state = 'started'::text);

CREATE INDEX pods_lineage_idx ON public.pods USING btree (lineage_root_id);

CREATE INDEX pods_logical_state_idx ON public.pods USING btree (org_id, state, created_at DESC);

CREATE INDEX pods_org_idx ON public.pods USING btree (org_id, created_at DESC);

CREATE INDEX pods_parent_idx ON public.pods USING btree (parent_pod_id) WHERE (parent_pod_id IS NOT NULL);

CREATE INDEX pods_provider_state_idx ON public.pods USING btree (provider_state);

CREATE INDEX pods_queued_prompt_demand_due ON public.pods USING btree (queued_prompt_demand_after, id) WHERE ((state = 'active'::text) AND (provider_state = ANY (ARRAY['started'::text, 'stopped'::text, 'archived'::text])));

CREATE INDEX pods_quota_org_idx ON public.pods USING btree (org_id, provider_state, provider);

CREATE INDEX pods_quota_user_idx ON public.pods USING btree (user_id, provider_state, provider);

CREATE INDEX pods_repo_slug_idx ON public.pods USING btree (org_id, project) WHERE (project IS NOT NULL);

CREATE INDEX pods_sandbox_host_id_idx ON public.pods USING btree (sandbox_host_id) WHERE (sandbox_host_id IS NOT NULL);

CREATE INDEX pods_state_idx ON public.pods USING btree (state);

CREATE INDEX push_queue_pending_idx ON public.push_queue USING btree (next_attempt) WHERE ((delivered_at IS NULL) AND (failed_at IS NULL));

CREATE INDEX queued_prompts_created_terminal_idx ON public.queued_prompts USING btree (created_at) WHERE (status = ANY (ARRAY['delivered'::text, 'failed'::text]));

CREATE INDEX queued_prompts_delivery_idx ON public.queued_prompts USING btree (pod_id, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'delivering'::text]));

CREATE INDEX queued_prompts_stale_claim_idx ON public.queued_prompts USING btree (claimed_at) WHERE (status = 'delivering'::text);

CREATE INDEX sandbox_hosts_active_idx ON public.sandbox_hosts USING btree (id) WHERE (status = 'active'::text);

CREATE INDEX sandbox_hosts_isolated_pod_history_idx ON public.sandbox_hosts USING btree (isolated_pod_id) WHERE (isolated_pod_id IS NOT NULL);

CREATE UNIQUE INDEX sandbox_hosts_one_live_isolated_pod_idx ON public.sandbox_hosts USING btree (isolated_pod_id) WHERE ((isolated_pod_id IS NOT NULL) AND (box_state IS DISTINCT FROM 'deleted'::text) AND (box_state IS DISTINCT FROM 'superseded'::text));

CREATE UNIQUE INDEX sandbox_hosts_one_live_owner_idx ON public.sandbox_hosts USING btree (owner_user_id) WHERE ((owner_user_id IS NOT NULL) AND (isolated_pod_id IS NULL) AND (box_state IS DISTINCT FROM 'deleted'::text) AND (box_state IS DISTINCT FROM 'superseded'::text));

CREATE INDEX session_events_created_idx ON public.session_events USING btree (created_at);

CREATE INDEX sessions_ended_idx ON public.sessions USING btree (ended_at);

CREATE INDEX sessions_pod_idx ON public.sessions USING btree (pod_id, started_at DESC);

CREATE INDEX settings_proposals_org_status ON public.settings_proposals USING btree (org_id, status);

CREATE TRIGGER job_host_wait_snapshot_guard BEFORE UPDATE ON public.job_runs FOR EACH ROW EXECUTE FUNCTION public.job_host_wait_snapshot_guard();

CREATE TRIGGER sandbox_host_identity_immutable BEFORE UPDATE ON public.sandbox_hosts FOR EACH ROW EXECUTE FUNCTION public.sandbox_host_identity_immutable();

CREATE TRIGGER sandbox_host_isolated_custody_guard_trigger BEFORE UPDATE OF isolated_pod_id, box_state ON public.sandbox_hosts FOR EACH ROW EXECUTE FUNCTION public.sandbox_host_isolated_custody_guard();

CREATE TRIGGER sandbox_pod_host_identity_guard BEFORE INSERT OR UPDATE OF id, sandbox_host_id, user_id, provider ON public.pods FOR EACH ROW EXECUTE FUNCTION public.sandbox_pod_host_identity_guard();

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.client_requests
    ADD CONSTRAINT client_requests_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.job_runs
    ADD CONSTRAINT job_runs_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id);

ALTER TABLE ONLY public.job_runs
    ADD CONSTRAINT job_runs_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.job_runs
    ADD CONSTRAINT job_runs_pod_id_fkey FOREIGN KEY (pod_id) REFERENCES public.pods(id);

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.pod_templates(id);

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.model_credential_login_tickets
    ADD CONSTRAINT model_credential_login_tickets_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.model_credential_login_tickets
    ADD CONSTRAINT model_credential_login_tickets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.model_credentials
    ADD CONSTRAINT model_credentials_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.model_credentials
    ADD CONSTRAINT model_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.pending_interactions
    ADD CONSTRAINT pending_interactions_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.pending_interactions
    ADD CONSTRAINT pending_interactions_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id);

ALTER TABLE ONLY public.pi_auth
    ADD CONSTRAINT pi_auth_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.pi_auth
    ADD CONSTRAINT pi_auth_saved_from_pod_fkey FOREIGN KEY (saved_from_pod) REFERENCES public.pods(id);

ALTER TABLE ONLY public.pi_auth
    ADD CONSTRAINT pi_auth_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.pod_capacity_wait
    ADD CONSTRAINT pod_capacity_wait_pod_id_fkey FOREIGN KEY (pod_id) REFERENCES public.pods(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.pod_fork_seeds
    ADD CONSTRAINT pod_fork_seeds_pod_id_fkey FOREIGN KEY (pod_id) REFERENCES public.pods(id);

ALTER TABLE ONLY public.pod_launch_env
    ADD CONSTRAINT pod_launch_env_pod_id_fkey FOREIGN KEY (pod_id) REFERENCES public.pods(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.pod_launch_operations
    ADD CONSTRAINT pod_launch_operations_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.pod_launch_operations
    ADD CONSTRAINT pod_launch_operations_pod_id_fkey FOREIGN KEY (pod_id) REFERENCES public.pods(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.pod_launch_operations
    ADD CONSTRAINT pod_launch_operations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.pod_owner_init
    ADD CONSTRAINT pod_owner_init_pod_id_fkey FOREIGN KEY (pod_id) REFERENCES public.pods(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.pod_rehome_state
    ADD CONSTRAINT pod_rehome_state_pod_id_fkey FOREIGN KEY (pod_id) REFERENCES public.pods(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.pod_retention
    ADD CONSTRAINT pod_retention_pod_id_fkey FOREIGN KEY (pod_id) REFERENCES public.pods(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.pod_templates
    ADD CONSTRAINT pod_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.pod_templates
    ADD CONSTRAINT pod_templates_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.pod_templates
    ADD CONSTRAINT pod_templates_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.pod_tokens
    ADD CONSTRAINT pod_tokens_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.pod_tokens
    ADD CONSTRAINT pod_tokens_pod_id_fkey FOREIGN KEY (pod_id) REFERENCES public.pods(id);

ALTER TABLE ONLY public.pod_tokens
    ADD CONSTRAINT pod_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.pods
    ADD CONSTRAINT pods_host_pod_id_fkey FOREIGN KEY (host_pod_id) REFERENCES public.pods(id);

ALTER TABLE ONLY public.pods
    ADD CONSTRAINT pods_lineage_root_id_fkey FOREIGN KEY (lineage_root_id) REFERENCES public.pods(id);

ALTER TABLE ONLY public.pods
    ADD CONSTRAINT pods_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.pods
    ADD CONSTRAINT pods_parent_pod_id_fkey FOREIGN KEY (parent_pod_id) REFERENCES public.pods(id);

ALTER TABLE ONLY public.pods
    ADD CONSTRAINT pods_sandbox_host_id_fkey FOREIGN KEY (sandbox_host_id) REFERENCES public.sandbox_hosts(id);

ALTER TABLE ONLY public.pods
    ADD CONSTRAINT pods_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.pod_templates(id);

ALTER TABLE ONLY public.pods
    ADD CONSTRAINT pods_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.push_queue
    ADD CONSTRAINT push_queue_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.queued_prompts
    ADD CONSTRAINT queued_prompts_pod_id_fkey FOREIGN KEY (pod_id) REFERENCES public.pods(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.queued_prompts
    ADD CONSTRAINT queued_prompts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.sandbox_hosts
    ADD CONSTRAINT sandbox_hosts_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.session_events
    ADD CONSTRAINT session_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pod_id_fkey FOREIGN KEY (pod_id) REFERENCES public.pods(id);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.settings_proposals
    ADD CONSTRAINT settings_proposals_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.settings_proposals
    ADD CONSTRAINT settings_proposals_created_from_pod_fkey FOREIGN KEY (created_from_pod) REFERENCES public.pods(id);

ALTER TABLE ONLY public.settings_proposals
    ADD CONSTRAINT settings_proposals_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.settings_proposals
    ADD CONSTRAINT settings_proposals_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.ws_tickets
    ADD CONSTRAINT ws_tickets_pod_id_fkey FOREIGN KEY (pod_id) REFERENCES public.pods(id);

ALTER TABLE ONLY public.ws_tickets
    ADD CONSTRAINT ws_tickets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

REVOKE ALL ON FUNCTION public.set_launch_recovery_mode(p_mode text, p_expected_epoch bigint, p_protocol_version integer, p_source_sha text, p_actor text, p_reason_code text) FROM PUBLIC;

-- A deployment whose server connects as a separate non-owner role named pi_pod_app
-- (the migrations run as the owner) gets the grants the server needs.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pi_pod_app') THEN
    GRANT ALL ON FUNCTION public.set_launch_recovery_mode(p_mode text, p_expected_epoch bigint, p_protocol_version integer, p_source_sha text, p_actor text, p_reason_code text) TO pi_pod_app;
    GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cpu_grant_ledger TO pi_pod_app;
    GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.grant_allocator_lease TO pi_pod_app;
    GRANT SELECT ON TABLE public.launch_recovery_control TO pi_pod_app;
    GRANT SELECT ON TABLE public.launch_recovery_control_events TO pi_pod_app;
    GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.pod_capacity_wait TO pi_pod_app;
    GRANT SELECT,INSERT,UPDATE ON TABLE public.pod_create_attempts TO pi_pod_app;
    GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.pod_owner_init TO pi_pod_app;
    GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.pod_rehome_state TO pi_pod_app;
    GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.pod_retention TO pi_pod_app;
    GRANT SELECT,UPDATE ON TABLE public.sandbox_host_auth TO pi_pod_app;
  END IF;
END
$grants$;

-- Every new server starts with launch admission held (see launch-control.ts):
-- `fleet launch-gate open` releases it once the deployment is verified.
INSERT INTO public.launch_recovery_control
  (singleton, mode, epoch, required_protocol, actor, reason_code)
VALUES
  (true, 'held', 1, 1, 'migration', 'recovery_cutover');

INSERT INTO public.launch_recovery_control_events
  (epoch, cutover_id, previous_mode, new_mode, protocol_version, actor, reason_code)
SELECT epoch, cutover_id, 'held', mode, required_protocol, actor, reason_code
  FROM public.launch_recovery_control
 WHERE singleton = true;
