/**
 * Canonical encryption contexts for Phase 2 bound envelopes (secure-secrets plan §4).
 *
 * Every encrypted record is authenticated to its immutable row identity via AES-GCM
 * additional authenticated data (AAD). Contexts are built from trusted row identity
 * (what the SELECT/INSERT already pins down), never from a caller-supplied free-form
 * string, so a ciphertext transplanted into another tenant, scope, name, or table
 * fails authentication instead of decrypting.
 *
 * Identity shapes follow the actual schemas, not a single generic tuple:
 * - secrets:           (org_id, scope_type, scope_id, name)
 * - model_credentials: (org_id, user_id, provider_id) — no scope columns exist
 * - pi_auth (legacy):  (org_id, user_id) — whole-file custody
 * - pi_settings (legacy; table dropped by 012): (org_id, scope_type, scope_id)
 * - pod_launch_env:    (pod_id) only
 *
 * The canonical AAD encoding is JSON of a fixed-shape array:
 *   ["<domain label>", 2, ...identityFields]
 * JSON arrays are unambiguous here (no field can collide with a frame boundary the
 * way naive string joining can), and the domain label keeps the five record types
 * cryptographically separated even when field values coincide.
 */

/** Scope literals mirror `SecretScope` in `secrets/store.ts` (re-declared to avoid a cycle). */
export type SecretContextScope = "org" | "user" | "template";

export interface SecretEncryptionContext {
  readonly kind: "secret";
  readonly orgId: string;
  readonly scopeType: SecretContextScope;
  readonly scopeId: string;
  readonly name: string;
}

export interface ModelCredentialEncryptionContext {
  readonly kind: "model_credential";
  readonly orgId: string;
  readonly userId: string;
  readonly providerId: string;
}

export interface PiAuthEncryptionContext {
  readonly kind: "pi_auth";
  readonly orgId: string;
  readonly userId: string;
}

export interface PiSettingsEncryptionContext {
  readonly kind: "pi_settings";
  readonly orgId: string;
  readonly scopeType: string;
  readonly scopeId: string;
}

export interface PodLaunchEnvEncryptionContext {
  readonly kind: "pod_launch_env";
  readonly podId: string;
}

export interface SandboxHostEncryptionContext {
  readonly kind: "sandbox_host";
  readonly hostId: string;
  readonly ownerUserId: string;
}

export type EncryptionContext =
  | SandboxHostEncryptionContext
  | SecretEncryptionContext
  | ModelCredentialEncryptionContext
  | PiAuthEncryptionContext
  | PiSettingsEncryptionContext
  | PodLaunchEnvEncryptionContext;

/** Format version authenticated inside every AAD frame. */
export const ENCRYPTION_CONTEXT_VERSION = 2;

const DOMAIN_LABELS = {
  sandbox_host: "pipod-sandbox-host",
  secret: "pipod-secret",
  model_credential: "pipod-model-credential",
  pi_auth: "pipod-pi-auth",
  pi_settings: "pipod-pi-settings",
  pod_launch_env: "pipod-pod-launch-env",
} as const;

function identityFields(context: EncryptionContext): readonly string[] {
  switch (context.kind) {
    case "sandbox_host":
      return [context.hostId, context.ownerUserId];
    case "secret":
      return [context.orgId, context.scopeType, context.scopeId, context.name];
    case "model_credential":
      return [context.orgId, context.userId, context.providerId];
    case "pi_auth":
      return [context.orgId, context.userId];
    case "pi_settings":
      return [context.orgId, context.scopeType, context.scopeId];
    case "pod_launch_env":
      return [context.podId];
  }
}

function encodeFrame(label: string, context: EncryptionContext, extra: readonly string[]): Buffer {
  return Buffer.from(
    JSON.stringify([label, ENCRYPTION_CONTEXT_VERSION, ...identityFields(context), ...extra]),
    "utf8",
  );
}

/**
 * AAD for the payload layer: binds the plaintext to its record identity and domain.
 * The KEK id is deliberately NOT part of this frame, so KEK rotation (rewrap) never
 * requires payload re-encryption.
 */
export function payloadAad(context: EncryptionContext): Buffer {
  return encodeFrame(DOMAIN_LABELS[context.kind], context, []);
}

/**
 * AAD for the DEK-wrapping layer: binds the wrapped DEK to the same record identity
 * AND to the KEK id that wrapped it. A wrapper cut from one key version or one row
 * cannot be spliced onto another row's payload.
 */
export function wrapAad(context: EncryptionContext, keyId: string): Buffer {
  return encodeFrame("pipod-wrap", context, [DOMAIN_LABELS[context.kind], keyId]);
}

/** Trusted row identity for one row of `secrets`. */
export function secretContext(
  orgId: string,
  scopeType: SecretContextScope,
  scopeId: string,
  name: string,
): SecretEncryptionContext {
  return { kind: "secret", orgId, scopeType, scopeId, name };
}

/** Trusted row identity for one row of `model_credentials`. */
export function modelCredentialContext(
  orgId: string,
  userId: string,
  providerId: string,
): ModelCredentialEncryptionContext {
  return { kind: "model_credential", orgId, userId, providerId };
}

/** Trusted row identity for one legacy `pi_auth` whole-file row. */
export function piAuthContext(orgId: string, userId: string): PiAuthEncryptionContext {
  return { kind: "pi_auth", orgId, userId };
}

/** Trusted row identity for legacy `pi_settings` rows (table dropped by migration 012). */
export function piSettingsContext(
  orgId: string,
  scopeType: string,
  scopeId: string,
): PiSettingsEncryptionContext {
  return { kind: "pi_settings", orgId, scopeType, scopeId };
}

/** Trusted row identity for one `pod_launch_env` row. */
export function podLaunchEnvContext(podId: string): PodLaunchEnvEncryptionContext {
  return { kind: "pod_launch_env", podId };
}
