import { randomUUID } from "node:crypto";

/** Unique for this Node process; recovery never mistakes its own live owner for a dead one. */
export const SERVER_PROCESS_INCARNATION = randomUUID();
