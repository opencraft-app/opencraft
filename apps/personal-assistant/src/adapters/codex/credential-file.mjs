import { lstatSync, readFileSync } from "node:fs";
import { OWNER_ONLY_CREDENTIAL, checkedCodexKey, invalidCredentialFile } from "./credential-file-async.mjs";

export { readCodexKeyAsync } from "./credential-file-async.mjs";

/** The Codex API key, read by the assistant process (not a Host network thread). */
export function readCodexKey(config) {
  if (!config.credentialFile) return undefined;
  if (invalidCredentialFile(lstatSync(config.credentialFile))) throw new Error(OWNER_ONLY_CREDENTIAL);
  return checkedCodexKey(readFileSync(config.credentialFile, "utf8"));
}
