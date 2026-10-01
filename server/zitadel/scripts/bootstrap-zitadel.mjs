#!/usr/bin/env node
/**
 * DESTRUCTIVE FRESH-PROJECT / DISASTER-RECOVERY TOOL ONLY.
 * This removes an existing `pipod` project (revoking every app, role, grant, and
 * client id under it). NEVER run it against production or any project with data.
 * Use reconcile-zitadel.mjs --apply for non-destructive changes to an existing project.
 */
import { api, apiBase, findProject, requireOk } from "./zitadel-admin.mjs";

const projectName = process.env.ZITADEL_PROJECT ?? "pipod";
if (process.env.ZITADEL_BOOTSTRAP_DESTRUCTIVE_CONFIRM !== projectName) {
  console.error(`refusing destructive bootstrap: set ZITADEL_BOOTSTRAP_DESTRUCTIVE_CONFIRM=${projectName}`);
  process.exit(1);
}

const existing = await findProject(projectName);
if (existing) {
  console.error(`deleting existing project ${projectName} (${existing.id})`);
  await requireOk(await api("DELETE", `/management/v1/projects/${existing.id}`), "delete project");
}

console.error(`bootstrapping ${projectName} on ${apiBase()} via the reconciler`);
process.env.ZITADEL_EXPECTED_ISSUER = process.env.ZITADEL_EXPECTED_ISSUER ?? apiBase();
process.argv = [process.argv[0], "reconcile-zitadel.mjs", "--apply"];
await import("./reconcile-zitadel.mjs");
