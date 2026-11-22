import { lstat, readFile } from "node:fs/promises";

// The Codex API key file, as a Host's network thread validates it. The
// assistant process reads it synchronously with credential-file.mjs.
export const invalidCredentialFile = (stat) =>
  !stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()) || stat.size > 4096;
export const checkedCodexKey = (text) => {
  const key = text.trim();
  if (!key || /\s/.test(key)) throw new Error("Codex credentialFile must contain only the API key");
  return key;
};
export const OWNER_ONLY_CREDENTIAL = "Codex credentialFile must be an owner-only regular file (0600)";

export async function readCodexKeyAsync(config) {
  if (!config.credentialFile) return undefined;
  if (invalidCredentialFile(await lstat(config.credentialFile))) throw new Error(OWNER_ONLY_CREDENTIAL);
  return checkedCodexKey(await readFile(config.credentialFile, "utf8"));
}
