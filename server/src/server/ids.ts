import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Zitadel user and organization ids are opaque numeric strings. Keycloak-era
 * UUID rows remain valid (`uuid::text` in 045). Pod/template/job ids stay UUIDv7.
 */
export const IdentityId = z
  .string()
  .regex(/^[0-9A-Za-z._-]{1,64}$/, "Invalid identity id");

/** UUIDv7 (time-ordered), per the data-model decision in the server spec §5. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
