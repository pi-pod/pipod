-- Model-credential sharing: an owner lets named members of their organization use one of their
-- model credentials. src/server/model-credentials/sharing.ts decides which credential serves a
-- person; these tables only record the facts it decides from.
--
-- organization_members is who the server has seen sign in to an organization: a snapshot taken
-- from verified access tokens, like users and organizations. It names who a credential may be
-- shared with. It never authorizes the signed-in person; their token does that.
CREATE TABLE public.organization_members (
    org_id text NOT NULL REFERENCES public.organizations(id),
    user_id text NOT NULL REFERENCES public.users(id),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (org_id, user_id)
);

-- One row per share. The primary key is the rule that a member holds at most one shared
-- credential per provider, so "which shared credential" never has two answers. The owner's
-- credential row and both memberships are foreign keys: removing the credential, or the owner
-- or the member leaving the organization, ends the share. Reconnecting keeps the credential row,
-- and so keeps its shares.
CREATE TABLE public.model_credential_shares (
    org_id text NOT NULL,
    provider_id text NOT NULL,
    member_user_id text NOT NULL,
    owner_user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (org_id, provider_id, member_user_id),
    CONSTRAINT model_credential_shares_not_self CHECK (owner_user_id <> member_user_id),
    CONSTRAINT model_credential_shares_credential_fkey FOREIGN KEY (org_id, owner_user_id, provider_id)
        REFERENCES public.model_credentials (org_id, user_id, provider_id) ON DELETE CASCADE,
    CONSTRAINT model_credential_shares_owner_fkey FOREIGN KEY (org_id, owner_user_id)
        REFERENCES public.organization_members (org_id, user_id) ON DELETE CASCADE,
    CONSTRAINT model_credential_shares_member_fkey FOREIGN KEY (org_id, member_user_id)
        REFERENCES public.organization_members (org_id, user_id) ON DELETE CASCADE
);

CREATE INDEX model_credential_shares_owner_idx
    ON public.model_credential_shares (org_id, owner_user_id, provider_id);

-- A deployment whose server connects as a separate non-owner role named pi_pod_app
-- (the migrations run as the owner) gets the grants the server needs.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pi_pod_app') THEN
    GRANT SELECT,INSERT ON TABLE public.organization_members TO pi_pod_app;
    GRANT SELECT,INSERT,DELETE ON TABLE public.model_credential_shares TO pi_pod_app;
  END IF;
END
$grants$;
