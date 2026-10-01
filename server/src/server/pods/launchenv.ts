/**
 * src/server/pods/launchenv.ts — the pod environment, rebuildable after a provider stop.
 *
 * New launches resolve org, positioned-template, and user rows from `secrets`; key rotation
 * therefore reaches a pod the next time anything starts in it. Request project env is retired,
 * so new launch-env rows are empty/deleted. The schema-1 encrypted reader remains for pods
 * created by older servers: resume must preserve the environment those historical pods ran.
 *
 * {@link composePodEnv} retains the historical overlay operation for that read path. Current
 * launch callers always pass an empty project object.
 */
import { query } from "../db/index.js";
import { decryptSecret, encryptSecret, type KekProvider } from "../secrets/crypto.js";
import { podLaunchEnvContext } from "../secrets/context.js";
import { resolveSecrets, withoutProviderCredentials } from "../secrets/store.js";

/** Compatibility representation for encrypted pre-bundle launch env rows. */
export interface LaunchEnvLayers {
  project: Record<string, string>;
}

interface StoredLaunchEnv {
  schema: 1;
  /** Retained only so old encrypted rows remain readable; new writes always use an empty object. */
  host: Record<string, string>;
  repo: Record<string, string>;
}

/** Keep schema 1 for rolling compatibility, but never persist retired machine env on new writes. */
export function serializeLaunchEnvForStorage(project: Record<string, string>): string {
  return JSON.stringify({ schema: 1, host: {}, repo: project } satisfies StoredLaunchEnv);
}

/** Schema-1 rows predate the unified project layer, so both old local inputs remain frozen env. */
export function deserializeLaunchEnvFromStorage(plaintext: string): LaunchEnvLayers {
  const bundle = JSON.parse(plaintext) as StoredLaunchEnv;
  return { project: { ...(bundle.host ?? {}), ...(bundle.repo ?? {}) } };
}

/**
 * Layer precedence (spec §7): server secrets → project `.pi-pod/env`.
 * Provider credentials are stripped after the merge, not before: a project may legitimately
 * name one, and custody is decided on the final value rather than per layer.
 */
export function composePodEnv(
  serverEnv: Record<string, string>,
  layers: LaunchEnvLayers,
): Record<string, string> {
  return withoutProviderCredentials({ ...serverEnv, ...layers.project });
}

/** Preserve the legacy writer shape; current launches pass empty and clear any prior row. */
export async function savePodLaunchEnv(args: {
  kek: KekProvider;
  podId: string;
  layers: LaunchEnvLayers;
}): Promise<void> {
  const projectKeys = Object.keys(args.layers.project);
  if (projectKeys.length === 0) {
    // Reuse replaces the previous launch contract; an empty project env must not resurrect
    // values from the pod's earlier launch after its next provider stop.
    await query("DELETE FROM pod_launch_env WHERE pod_id = $1", [args.podId]);
    return;
  }
  // Keep the established encrypted shape and database key columns for rolling compatibility.
  // The retired machine slot is always empty; `repo` now carries the unified project layer.
  // New writes are v2 envelopes bound to this pod's identity; the version travels in
  // `encryption_version` (migration 049) so resume keeps reading pre-migration rows.
  const { ciphertext, keyId, encryptionVersion } = encryptSecret(
    args.kek,
    serializeLaunchEnvForStorage(args.layers.project),
    podLaunchEnvContext(args.podId),
  );
  await query(
    `INSERT INTO pod_launch_env (pod_id, ciphertext, key_id, encryption_version, host_keys, repo_keys)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (pod_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, key_id = EXCLUDED.key_id,
       encryption_version = EXCLUDED.encryption_version,
       host_keys = EXCLUDED.host_keys, repo_keys = EXCLUDED.repo_keys, updated_at = now()`,
    [args.podId, ciphertext, keyId, encryptionVersion, [], projectKeys.sort()],
  );
}

/** The stored historical project layer, or an empty one for a current launch. */
export async function loadPodLaunchEnv(kek: KekProvider, podId: string): Promise<LaunchEnvLayers> {
  const rows = await query<{ ciphertext: Buffer; key_id: string; encryption_version: number }>(
    "SELECT ciphertext, key_id, encryption_version FROM pod_launch_env WHERE pod_id = $1",
    [podId],
  );
  const row = rows.rows[0];
  if (!row) return { project: {} };
  // v1 rows predate context binding and the bounded reader ignores it; v2 rows
  // authenticate to this pod's identity, so a transplanted row fails closed.
  return deserializeLaunchEnvFromStorage(
    decryptSecret(
      kek,
      row.ciphertext,
      row.key_id,
      podLaunchEnvContext(podId),
      Number(row.encryption_version),
    ),
  );
}

/**
 * The full environment for a pod as it stands now: stored layers re-resolved so rotation
 * lands, with any historical encrypted launch env replayed for pre-bundle pods.
 */
export async function resolvePodEnv(args: {
  kek: KekProvider;
  podId: string;
  orgId: string;
  userId: string;
  templateId: string | null;
  /** Frozen launch scope; false for pods created by organization-scoped jobs. */
  includeUserLayer?: boolean;
}): Promise<Record<string, string>> {
  const [secrets, layers] = await Promise.all([
    resolveSecrets({
      kek: args.kek,
      orgId: args.orgId,
      userId: args.userId,
      includeUserLayer: args.includeUserLayer,
      templateId: args.templateId,
    }),
    loadPodLaunchEnv(args.kek, args.podId),
  ]);
  return composePodEnv(secrets.env, layers);
}
