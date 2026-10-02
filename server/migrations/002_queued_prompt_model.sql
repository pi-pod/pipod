-- The model a queued prompt asks for, as "provider/id". Set by a client that sends a pod's
-- first message before the pod is ready, so that message runs on the model the user chose
-- rather than whatever the provider defaults to. Delivery switches to it when pi has it.
--
-- IF EXISTS: in the hosted ordering this file sorts before the hosted chain creates the table
-- (022_queued_prompts.sql) on a fresh database; the hosted chain adds the column itself there.
ALTER TABLE IF EXISTS queued_prompts ADD COLUMN IF NOT EXISTS model text;
