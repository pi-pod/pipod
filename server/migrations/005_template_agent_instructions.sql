-- What a template's author tells the agent in every pod launched from it, chiefly the access
-- the template is meant to have ("read-write in staging, read-only in production"). Advisory:
-- the pod's credentials and egress are what enforce access. NULL and '' both mean none.
--
-- In the hosted ordering this sorts after the hosted chain creates pod_templates (002).
ALTER TABLE pod_templates ADD COLUMN IF NOT EXISTS agent_instructions text;
