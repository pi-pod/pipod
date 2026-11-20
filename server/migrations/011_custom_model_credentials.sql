-- Separate custody so rolling back to a server without endpoint checks cannot lease these keys.
CREATE TABLE custom_model_credentials (
    id uuid PRIMARY KEY,
    org_id text NOT NULL REFERENCES organizations(id),
    user_id text NOT NULL REFERENCES users(id),
    provider_id text NOT NULL,
    provider_binding text NOT NULL CHECK (provider_binding ~ '^[a-f0-9]{64}$'),
    ciphertext bytea NOT NULL,
    key_id text NOT NULL,
    encryption_version integer NOT NULL CHECK (encryption_version = 2),
    revision bigint NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, user_id, provider_id)
);

ALTER TABLE model_credential_login_tickets
    ADD COLUMN custom_binding text CHECK (custom_binding ~ '^[a-f0-9]{64}$');
