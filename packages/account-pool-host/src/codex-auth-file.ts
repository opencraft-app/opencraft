import { readFileSync } from "node:fs";
import { EXTERNAL_CODEX_REAUTH_MESSAGE, parseCodexAuthFile, type CodexAuthFileReference } from "./codex-auth-file-format.js";

export * from "./codex-auth-file-format.js";

/** Reads an operator-owned `auth.json` on this machine (Node owners only). */
export function readCodexAuthFile(reference: CodexAuthFileReference, expectedAccountId?: string): ReturnType<typeof parseCodexAuthFile> {
  try { return parseCodexAuthFile(readFileSync(reference.path, "utf8"), expectedAccountId); }
  catch { throw new Error(EXTERNAL_CODEX_REAUTH_MESSAGE); }
}
