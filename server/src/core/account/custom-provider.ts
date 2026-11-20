import { createHash } from "node:crypto";

export interface CustomProviderBinding {
  baseUrl: string;
  binding: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function baseUrlOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^https:\/\//i.test(value) || /[\\\s?#]/.test(value)) return;
  try {
    const url = new URL(value);
    if (url.username || url.password) return;
    return url.href.replace(/\/+$/, "");
  } catch {
    return;
  }
}

/** V1 is a single declarative endpoint per provider. Catalog additions on that endpoint do not rotate keys. */
export function customProviderBindings(modelsFile: unknown): Map<string, CustomProviderBinding> {
  const bindings = new Map<string, CustomProviderBinding>();
  const providers = object(object(modelsFile)?.["providers"]);
  for (const [id, value] of Object.entries(providers ?? {})) {
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id) || Object.hasOwn(Object.prototype, id) || id === "prototype") continue;
    const provider = object(value);
    if (!provider || provider["oauth"] !== undefined) continue;
    const api = provider["api"];
    if (api !== "openai-completions" && api !== "openai-responses") continue;
    const baseUrl = baseUrlOf(provider["baseUrl"]);
    const authHeader = provider["authHeader"] ?? false;
    if (!baseUrl || typeof authHeader !== "boolean") continue;
    const models = provider["models"];
    if (!Array.isArray(models) || models.length === 0) continue;
    const overrides = provider["modelOverrides"];
    if (overrides !== undefined && !object(overrides)) continue;
    const matches = (value: unknown): boolean => {
      const model = object(value);
      return !!model && (model["api"] === undefined || model["api"] === api) &&
        (model["baseUrl"] === undefined || baseUrlOf(model["baseUrl"]) === baseUrl);
    };
    if (!models.every(matches) || !Object.values(object(overrides) ?? {}).every(matches)) continue;
    const binding = createHash("sha256")
      .update(JSON.stringify(["pipod-custom-provider-v1", id, api, baseUrl, authHeader]))
      .digest("hex");
    bindings.set(id, { baseUrl, binding });
  }
  return bindings;
}
