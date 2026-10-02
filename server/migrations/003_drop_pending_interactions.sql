-- Approvals are gone: a blocking extension dialog is live session state the gateway keeps in
-- memory until a client answers it, not a stored record with its own inbox and API.
DROP TABLE IF EXISTS pending_interactions;
