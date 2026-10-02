-- Settings proposals are gone: an agent in a pod reads the layers behind its launch and hands
-- the change to its person, who makes it with their own sign-in. A pending proposal is not
-- applied; its content is kept as a settings.proposal.discarded audit row, so nothing an agent
-- drafted disappears without a trace, and then the table goes.
DO $$
BEGIN
  IF to_regclass('public.settings_proposals') IS NOT NULL THEN
    INSERT INTO audit_log (id, org_id, actor_id, action, target_type, target_id, detail)
    SELECT gen_random_uuid(), org_id::text, NULL, 'settings.proposal.discarded', 'settings_proposal', id::text,
           jsonb_build_object(
             'scope', scope_type, 'config', config, 'initScript', init_script,
             'bakeScript', bake_script, 'secretNames', to_jsonb(secret_names), 'note', note,
             'createdBy', created_by, 'createdFromPod', created_from_pod, 'createdAt', created_at)
      FROM settings_proposals
     WHERE status = 'pending';
    DROP TABLE settings_proposals;
  END IF;
END $$;
