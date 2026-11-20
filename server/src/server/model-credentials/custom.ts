/** Declarative, owner-only API keys; no provider code or network runs in the broker. */
import { customProviderBindings } from "../../core/account/custom-provider.js";
import { PACKAGE_PROVIDERS } from "../../core/piregistry.js";
import { query } from "../db/index.js";
import { HttpError } from "../httperrors.js";
import { uuidv7 } from "../ids.js";
import { decryptSecret, encryptSecret, type KekProvider } from "../secrets/crypto.js";
import { readLayer } from "../settings/merge.js";
import { pinnedPiProviders } from "./dependencies.js";
import type { BrokerAuthInteraction, CredentialStatus, CredentialSubject } from "./types.js";

const packageIds = new Set(PACKAGE_PROVIDERS.flatMap((entry) => entry.providers));

export async function accountCustomProviders(subject: CredentialSubject) {
  const [user, pinned] = await Promise.all([
    readLayer("user_defaults", subject.userId, subject.orgId),
    pinnedPiProviders(),
  ]);
  const bindings = customProviderBindings(user.piFiles.models);
  for (const id of bindings.keys()) {
    if (pinned.has(id) || packageIds.has(id)) bindings.delete(id);
  }
  return bindings;
}

export type PodCustomBindings = Readonly<Record<string, string>>;

/** Freeze only user registrations that agree with the models.json the launch will install. */
export async function planCustomCredentials(subject: CredentialSubject, models: unknown) {
  const effective = customProviderBindings(models);
  if (effective.size === 0) return { bindings: {}, ready: [], changed: [] };
  const [registered, rows] = await Promise.all([accountCustomProviders(subject), listCustomCredentialMeta(subject)]);
  const bindings: Record<string, string> = {};
  const ready: string[] = [];
  const changed: string[] = [];
  for (const row of rows) {
    const id = row.provider_id;
    const binding = row.provider_binding;
    if (effective.get(id)?.binding === binding && registered.get(id)?.binding === binding) {
      bindings[id] = binding;
      ready.push(id);
    } else changed.push(id);
  }
  return { bindings, ready, changed };
}

interface CustomMeta {
  id: string;
  provider_id: string;
  provider_binding: string;
  revision: string;
}

export async function listCustomCredentialMeta(subject: CredentialSubject): Promise<CustomMeta[]> {
  const result = await query<CustomMeta>(
    `SELECT id, provider_id, provider_binding, revision FROM custom_model_credentials
     WHERE org_id = $1 AND user_id = $2 ORDER BY provider_id`,
    [subject.orgId, subject.userId],
  );
  return result.rows;
}

export function customStatus(row: CustomMeta, binding?: string): CredentialStatus {
  const base = { providerId: row.provider_id, type: "api_key" as const, revision: Number(row.revision) };
  return binding === row.provider_binding
    ? { ...base, state: "ready" }
    : { ...base, state: "reconnect_required", reason: "provider_configuration_changed" };
}

function context(subject: CredentialSubject, providerId: string, binding: string) {
  return { kind: "custom_model_credential" as const, ...subject, providerId, binding };
}

function changed(providerId: string): HttpError {
  return new HttpError(400, "login_failed", {
    code: "login_failed", provider: providerId,
    message: "The custom provider configuration changed. Review the endpoint and reconnect.",
  });
}

export async function storeCustomLogin(
  kek: KekProvider, subject: CredentialSubject, providerId: string, binding: string,
  interaction: BrokerAuthInteraction,
): Promise<CredentialStatus> {
  const before = (await accountCustomProviders(subject)).get(providerId);
  if (before?.binding !== binding) throw changed(providerId);
  const key = await interaction.prompt({ type: "secret", message: `API key for ${providerId} (${before.baseUrl})` });
  interaction.signal?.throwIfAborted();
  if (key.length === 0 || key.length > 8192 || /[^!-~]/.test(key)) {
    throw new HttpError(400, "login_failed", {
      code: "login_failed", provider: providerId,
      message: "Enter a non-empty API key with no whitespace and at most 8192 characters.",
    });
  }
  if ((await accountCustomProviders(subject)).get(providerId)?.binding !== binding) throw changed(providerId);
  interaction.signal?.throwIfAborted();
  const { ciphertext, keyId, encryptionVersion } = encryptSecret(kek, key, context(subject, providerId, binding));
  const result = await query<CustomMeta>(
    `INSERT INTO custom_model_credentials
       (id, org_id, user_id, provider_id, provider_binding, ciphertext, key_id, encryption_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (org_id, user_id, provider_id) DO UPDATE SET
       provider_binding = EXCLUDED.provider_binding, ciphertext = EXCLUDED.ciphertext,
       key_id = EXCLUDED.key_id, encryption_version = EXCLUDED.encryption_version,
       revision = custom_model_credentials.revision + 1, updated_at = now()
     RETURNING id, provider_id, provider_binding, revision`,
    [uuidv7(), subject.orgId, subject.userId, providerId, binding, ciphertext, keyId, encryptionVersion],
  );
  return customStatus(result.rows[0]!, binding);
}

export async function deleteCustomCredential(subject: CredentialSubject, providerId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM custom_model_credentials WHERE org_id = $1 AND user_id = $2 AND provider_id = $3`,
    [subject.orgId, subject.userId, providerId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Only callers holding the frozen binding and the current account binding may get plaintext. */
export async function readBoundCustomCredential(
  kek: KekProvider, subject: CredentialSubject, providerId: string, binding: string,
) {
  const result = await query<CustomMeta & { ciphertext: Buffer; key_id: string; encryption_version: number }>(
    `SELECT id, provider_id, provider_binding, revision, ciphertext, key_id, encryption_version
     FROM custom_model_credentials
     WHERE org_id = $1 AND user_id = $2 AND provider_id = $3 AND provider_binding = $4`,
    [subject.orgId, subject.userId, providerId, binding],
  );
  const row = result.rows[0];
  if (!row) return;
  const key = decryptSecret(kek, row.ciphertext, row.key_id, context(subject, providerId, binding), row.encryption_version);
  // Pi auth.json treats leading ! and dollars as commands/env templates. Escape only at the Pi boundary.
  const literal = (key.startsWith("!") ? "$" : "") + key.replaceAll("$", () => "$$");
  return { row, entry: { type: "api_key", key: literal } };
}
