import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationResourceLegacyJournal } from "./conversation-resources.js";

/** The retired `conversation-resources.json` beside the Server database. Read
 * only inside the owner Worker; it is kept unchanged as the pre-import backup. */
export function conversationResourceLegacyJournal(directory: string): ConversationResourceLegacyJournal {
  const name = "conversation-resources.json";
  return {
    name,
    read() {
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(directory, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
        throw error;
      }
      return {
        kind: "present",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        text: bytes.toString("utf8"),
      };
    },
  };
}
