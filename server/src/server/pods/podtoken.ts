import { createHash, randomBytes } from "node:crypto";
import { query, type Queryable } from "../db/index.js";
import { uuidv7 } from "../ids.js";

/** Pod-bound API tokens (spec §8.5): opaque, stored hashed, and scoped to agent self-service. */
export const POD_TOKEN_PREFIX = "ppt_";

export function mintPodTokenValue(): string {
  return `${POD_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashPodToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createPodToken(args: {
  podId: string;
  orgId: string;
  userId: string;
}): Promise<string> {
  const token = mintPodTokenValue();
  await query(
    `INSERT INTO pod_tokens (id, pod_id, org_id, user_id, token_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [uuidv7(), args.podId, args.orgId, args.userId, hashPodToken(token)],
  );
  return token;
}

/** Revoke every live token for one pod on the caller's transaction/client. */
export async function revokePodTokensIn(client: Queryable, podId: string): Promise<number> {
  const result = await client.query(
    "UPDATE pod_tokens SET revoked_at = now() WHERE pod_id = $1 AND revoked_at IS NULL",
    [podId],
  );
  return result.rowCount ?? 0;
}

export async function revokePodToken(podId: string): Promise<void> {
  await query("UPDATE pod_tokens SET revoked_at = now() WHERE pod_id = $1 AND revoked_at IS NULL", [
    podId,
  ]);
}
