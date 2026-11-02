import { parseRef, type RefPattern } from "../../core/account/ref.js";
import { PiPodError } from "../../core/errors.js";
import { query } from "../db/index.js";
import { HttpError } from "../httperrors.js";
import { MAX_LINEAGE_DEPTH } from "./lineage.js";

export interface PodRefMatch {
  id: string;
  name: string;
  state: "active" | "archived";
}

/** A ref lookup never loads launch reports for an account's entire history. */
export async function lookupPodRef(args: {
  orgId: string;
  userId: string;
  lineageRootPodId: string | null;
  ref: string;
}): Promise<{ matches: PodRefMatch[]; total: number }> {
  let pattern: RefPattern | null = null;
  let invalid: PiPodError | null = null;
  try {
    pattern = parseRef(args.ref);
  } catch (error) {
    if (!(error instanceof PiPodError)) throw error;
    // Exact names win even when they resemble an invalid/too-short hex ref.
    invalid = error;
  }
  const rows = await query<PodRefMatch & { match_count: number }>(
    `WITH RECURSIVE subtree AS (
       SELECT id, 0 AS steps FROM pods WHERE id=$6::uuid AND org_id=$1
       UNION ALL
       SELECT p.id, subtree.steps+1 FROM pods p
         JOIN subtree ON p.parent_pod_id=subtree.id OR p.host_pod_id=subtree.id
        WHERE p.org_id=$1 AND subtree.steps<$7
     ), candidates AS (
       SELECT p.id, p.name, p.state,
              CASE WHEN p.name=$3 THEN 0 ELSE 1 END AS priority
         FROM pods p
        WHERE p.org_id=$1 AND p.user_id=$2 AND p.provider_state<>'gone'
          AND ($6::uuid IS NULL OR p.id IN (SELECT id FROM subtree))
          AND (($8::uuid IS NOT NULL AND p.id=$8) OR
               ($8::uuid IS NULL AND (p.name=$3 OR
                 ($4::text IS NOT NULL AND
                   (replace(p.id::text,'-','') LIKE '%' || $4 OR
                    ($5::boolean AND p.id::text LIKE $4 || '%'))))))
     ), preferred AS (
       SELECT id, name, state FROM candidates
        WHERE priority=(SELECT min(priority) FROM candidates)
     )
     SELECT id, name, state, count(*) OVER()::int AS match_count
       FROM preferred ORDER BY id LIMIT 20`,
    [args.orgId, args.userId, args.ref,
      pattern && pattern.kind !== "uuid" ? pattern.value : null,
      pattern?.kind === "hex", args.lineageRootPodId, MAX_LINEAGE_DEPTH,
      pattern?.kind === "uuid" ? pattern.value : null],
  );
  if (rows.rows.length === 0 && invalid) {
    throw new HttpError(400, invalid.message, { hint: invalid.hint });
  }
  return {
    matches: rows.rows.map(({ id, name, state }) => ({ id, name, state })),
    total: rows.rows[0]?.match_count ?? 0,
  };
}
