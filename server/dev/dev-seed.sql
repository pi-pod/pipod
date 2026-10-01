-- Idempotent dev identity snapshots matching dev/mint.mjs defaults.
-- ids are the Zitadel subject / organization id. No membership or role rows.

INSERT INTO users (id, email, display_name)
VALUES (
  '018f0000-0000-7000-8000-000000000001',
  'dev@example.com',
  'Dev User'
)
ON CONFLICT (id) DO UPDATE
SET email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    updated_at = now();

INSERT INTO organizations (id, name, alias)
VALUES (
  '018f0000-0000-7000-8000-000000000010',
  'Dev Org',
  'dev'
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    alias = EXCLUDED.alias,
    updated_at = now();
