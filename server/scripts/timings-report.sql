-- Launch and attach phase timings, aggregated from pods.resolved_config->'timings'.
--
-- Phase key reference:
--   plan             planPodLaunch (template fetch, secret decrypt, settings merge)
--   preflight        provider image lookup + concurrency policy check
--   create           provider sandbox create
--   start            provider sandbox boot (fresh launch) / restart (reuse)
--   prep             hosts seeding + workdir mkdir
--   clone            git clone of the launch source
--   packages         request-scoped Pi package delta install
--   project_packages tracked repo .pi/settings.json package preinstall
--   materialize      skill + pi auth + clone + settings/package overlay (overlapped)
--   init             all init steps end to end
--   reuse            warm-disk refresh script on pod reuse
--   resume_stopped   provider start from 'stopped' (attach/reuse wake)
--   resume_archived  provider start from 'archived' (cold-storage restore)
--   attach_prepare   gateway lease + pod env resolution
--   attach_pty       PTY reattach or shim upload + pi spawn
--   attach_hello     shim/pi RPC handshake
--   attach_total     whole gateway session attach
--
-- Latest value per pod (attach keys are overwritten by each re-attach).

-- p50/p95 per phase over the last 14 days, fresh launches vs reuses.
SELECT
  t.key AS phase,
  (resolved_config->>'reused')::boolean IS TRUE AS reused,
  count(*) AS n,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY t.value::numeric)) AS p50_ms,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY t.value::numeric)) AS p95_ms,
  round(max(t.value::numeric)) AS max_ms
FROM pods,
  LATERAL jsonb_each_text(resolved_config->'timings') AS t(key, value)
WHERE created_at > now() - interval '14 days'
  AND t.value ~ '^[0-9]+(\.[0-9]+)?$'
GROUP BY 1, 2
ORDER BY reused, p50_ms DESC;

-- End-to-end creation critical path per pod (fresh launches), worst first.
SELECT
  id,
  created_at,
  provider,
  (resolved_config->'timings'->>'plan')::numeric AS plan_ms,
  (resolved_config->'timings'->>'preflight')::numeric AS preflight_ms,
  (resolved_config->'timings'->>'create')::numeric AS create_ms,
  (resolved_config->'timings'->>'start')::numeric AS start_ms,
  (resolved_config->'timings'->>'clone')::numeric AS clone_ms,
  (resolved_config->'timings'->>'packages')::numeric AS packages_ms,
  (resolved_config->'timings'->>'project_packages')::numeric AS project_packages_ms,
  (resolved_config->'timings'->>'materialize')::numeric AS materialize_ms,
  (resolved_config->'timings'->>'init')::numeric AS init_ms,
  (resolved_config->'timings'->>'attach_total')::numeric AS attach_total_ms
FROM pods
WHERE created_at > now() - interval '14 days'
  AND resolved_config->'timings' IS NOT NULL
  AND (resolved_config->>'reused')::boolean IS NOT TRUE
ORDER BY (resolved_config->'timings'->>'materialize')::numeric DESC NULLS LAST
LIMIT 50;
