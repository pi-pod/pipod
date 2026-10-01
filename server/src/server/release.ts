/**
 * Which build this process is, and whether its database matches it — what an operator asks
 * first after an upgrade, and what `pipod doctor` prints.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import { readSchemaStatus } from "./db/upgrade.js";
import { readLaunchControl } from "./pods/launch-control.js";
import { edition } from "./edition.js";

export interface ReleaseIdentity {
  /** `package.json` version. */
  version: string;
  /** Source commit, baked into the image by CI as PIPOD_SOURCE_SHA; null for an unlabelled build. */
  revision: string | null;
}

let identity: ReleaseIdentity | null = null;

export function releaseIdentity(): ReleaseIdentity {
  if (!identity) {
    // The working directory is the package root, as for the migrations directory.
    let version = "unknown";
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
        version?: unknown;
      };
      if (typeof pkg.version === "string") version = pkg.version;
    } catch {
      // An unreadable manifest leaves the version unknown rather than failing the boot.
    }
    const sha = process.env["PIPOD_SOURCE_SHA"]?.trim() ?? "";
    identity = { version, revision: /^[0-9a-f]{40}$/.test(sha) ? sha : null };
  }
  return identity;
}

/**
 * GET /v1/version. Schema and launch-admission state are best effort: a runtime database role
 * that may not read `schema_migrations` reports null rather than failing the request.
 */
export function registerVersionRoute(app: FastifyInstance): void {
  app.get(
    "/version",
    { preHandler: [app.authenticate], config: { allowNoOrganization: true, allowPodToken: true } },
    async () => {
      const schema = await readSchemaStatus(edition().migrations())
        .then(({ state, pending, unknown }) => ({ state, pending: pending.length, unknown: unknown.length }))
        .catch(() => null);
      const launchAdmission = await readLaunchControl()
        .then((gate) => gate.mode)
        .catch(() => null);
      return { ...releaseIdentity(), schema, launchAdmission };
    },
  );
}
