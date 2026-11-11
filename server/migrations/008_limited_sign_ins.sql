-- Limited sign-ins: a machine signed in as a person, but able to launch from one template and
-- reach only that person's pods from it. src/server/auth/limited-sign-in.ts is the only code that
-- reads or writes these tables.
--
-- One limited sign-in. The limit is template_id, fixed when the person confirms; nothing changes
-- it afterwards. `permissions` are the account's own, as its identity provider last stated them
-- (`checked_at`); the sign-in may use only some of them. The machine holds the preimage of
-- refresh_token_hash (set when it collects the sign-in) and short-lived access tokens, all opaque
-- to the identity provider.
CREATE TABLE public.limited_sign_ins (
    id uuid PRIMARY KEY,
    org_id text NOT NULL REFERENCES public.organizations(id),
    user_id text NOT NULL REFERENCES public.users(id),
    template_id uuid NOT NULL REFERENCES public.pod_templates(id),
    refresh_token_hash text UNIQUE,
    permissions text[] DEFAULT '{}'::text[] NOT NULL,
    checked_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    revoked_reason text
);

-- The account's own session at the identity provider, which a live sign-in renews whenever the
-- machine renews its token: the sign-in ends when that session does. Envelope-encrypted (context:
-- the sign-in id) and deleted when the sign-in ends.
CREATE TABLE public.limited_sign_in_identities (
    sign_in_id uuid PRIMARY KEY REFERENCES public.limited_sign_ins(id) ON DELETE CASCADE,
    ciphertext bytea NOT NULL,
    key_id text NOT NULL,
    encryption_version integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Access tokens: SHA-256 only, each good for minutes. Several may be live at once, so two
-- processes on one machine renewing together do not undo each other.
CREATE TABLE public.limited_sign_in_tokens (
    token_hash text PRIMARY KEY,
    sign_in_id uuid NOT NULL REFERENCES public.limited_sign_ins(id) ON DELETE CASCADE,
    expires_at timestamp with time zone NOT NULL
);

CREATE INDEX limited_sign_in_tokens_sign_in_idx ON public.limited_sign_in_tokens (sign_in_id);

-- A machine asks first (`pipod login --device --template <name>`), and a person decides on a page
-- of this server. Until then the request holds only what the machine asked for; the person's
-- decision creates the sign-in, which names the account, the organization and the template by id.
CREATE TABLE public.limited_sign_in_requests (
    id uuid PRIMARY KEY,
    -- SHA-256 of the secret the machine polls with; the user code is what the person types.
    device_code_hash text NOT NULL UNIQUE,
    user_code text NOT NULL UNIQUE,
    -- The template exactly as the machine named it, a name or an id: resolved for the person who
    -- confirms, since one name can mean different templates to different people.
    template_ref text NOT NULL,
    requested_from text,
    state text DEFAULT 'pending' NOT NULL,
    sign_in_id uuid REFERENCES public.limited_sign_ins(id) ON DELETE SET NULL,
    decided_by text,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT limited_sign_in_requests_state CHECK (state IN ('pending', 'approved', 'denied', 'redeemed'))
);

CREATE INDEX limited_sign_in_requests_expires_idx ON public.limited_sign_in_requests (expires_at);

-- A deployment whose server connects as a separate non-owner role named pi_pod_app
-- (the migrations run as the owner) gets the grants the server needs.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pi_pod_app') THEN
    GRANT SELECT,INSERT,UPDATE ON TABLE public.limited_sign_ins TO pi_pod_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.limited_sign_in_identities TO pi_pod_app;
    GRANT SELECT,INSERT,DELETE ON TABLE public.limited_sign_in_tokens TO pi_pod_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.limited_sign_in_requests TO pi_pod_app;
  END IF;
END
$grants$;
