import { EnvKekProvider, type KekProvider } from "./crypto.js";

/** CLI-only boot capture. Parse failures never echo credential-bearing JSON. */
export function operatorKek(env: NodeJS.ProcessEnv = process.env): KekProvider | undefined {
  const current = env.SECRETS_KEK;
  if (!current) return undefined;
  const keyId = env.SECRETS_KEK_ID ?? "kek-1";
  let previous: unknown;
  try { previous = JSON.parse(env.SECRETS_KEK_PREVIOUS?.trim() || "{}"); }
  catch { throw new Error("invalid previous KEK configuration"); }
  if (!previous || typeof previous !== "object" || Array.isArray(previous) ||
      Object.values(previous).some((value) => typeof value !== "string") || Object.hasOwn(previous,keyId)) {
    throw new Error("invalid previous KEK configuration");
  }
  return new EnvKekProvider(keyId,current,previous as Record<string,string>);
}
