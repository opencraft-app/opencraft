import { createHash } from "node:crypto";

/** Stable scope identity only; importing it never loads a local PTY provider. */
export const terminalResourceOwnerId = (actorId: string, hostId: string): string =>
  createHash("sha256")
    .update(JSON.stringify([actorId, hostId]))
    .digest("hex");
