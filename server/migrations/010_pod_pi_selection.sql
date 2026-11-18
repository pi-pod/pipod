-- The model and thinking level pi was last seen on in a pod. A pod's pi is restarted every
-- time the pod wakes, and it starts on the launch configuration's defaults; the gateway puts
-- this selection back so waking a pod does not undo a choice made in its conversation.
ALTER TABLE public.pods
    ADD COLUMN pi_model text,
    ADD COLUMN pi_thinking text;
