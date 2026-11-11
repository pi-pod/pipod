-- Template sharing: the owner of a personal template lets named members of their organization
-- launch from it. src/server/templates/store.ts decides who can see, launch and change a
-- template; this table only records the facts it decides from.
--
-- One row per share: (template, member). The owner is the template's owner, copied here so that
-- the membership foreign keys can end a share when either person's membership row is removed.
-- Deleting a template (archiving it) and making it organization-wide delete its shares in the
-- same transaction; the template foreign key covers a row that is ever hard-deleted.
CREATE TABLE public.template_shares (
    template_id uuid NOT NULL REFERENCES public.pod_templates(id) ON DELETE CASCADE,
    member_user_id text NOT NULL,
    org_id text NOT NULL,
    owner_user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (template_id, member_user_id),
    CONSTRAINT template_shares_not_self CHECK (owner_user_id <> member_user_id),
    CONSTRAINT template_shares_owner_fkey FOREIGN KEY (org_id, owner_user_id)
        REFERENCES public.organization_members (org_id, user_id) ON DELETE CASCADE,
    CONSTRAINT template_shares_member_fkey FOREIGN KEY (org_id, member_user_id)
        REFERENCES public.organization_members (org_id, user_id) ON DELETE CASCADE
);

-- What is shared with a person: every template list and launch asks it.
CREATE INDEX template_shares_member_idx ON public.template_shares (member_user_id, template_id);

-- A deployment whose server connects as a separate non-owner role named pi_pod_app
-- (the migrations run as the owner) gets the grants the server needs.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pi_pod_app') THEN
    GRANT SELECT,INSERT,DELETE ON TABLE public.template_shares TO pi_pod_app;
  END IF;
END
$grants$;
