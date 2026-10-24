import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { AccountPoolSecret } from "./store.js";

/** Operator-owned reference. Tokens remain in the external owner's auth.json. */
export interface CodexAuthFileReference {
  readonly kind: "codex-auth-file";
  readonly path: string;
}

export function parseCodexAuthFileReference(value: unknown): CodexAuthFileReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (value as Record<string, unknown>).kind !== "codex-auth-file") return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== "kind" && key !== "path")
    || typeof record.path !== "string" || !isAbsolute(record.path)
    || record.path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(record.path)) {
    throw new Error("Invalid shared Codex credential reference");
  }
  return { kind: "codex-auth-file", path: record.path };
}

export function readCodexAuthFile(reference: CodexAuthFileReference, expectedAccountId?: string): {
  accountId: string; secret: AccountPoolSecret;
} {
  try {
    const text = readFileSync(reference.path, "utf8");
    if (text.length > 1024 * 1024) throw new Error();
    const auth = JSON.parse(text);
    const tokens = auth?.tokens;
    if ((auth.auth_mode && auth.auth_mode !== "chatgpt") || !tokens
      || typeof tokens.account_id !== "string" || !tokens.account_id.trim()
      || (expectedAccountId !== undefined && tokens.account_id !== expectedAccountId)
      || typeof tokens.access_token !== "string" || !tokens.access_token
      || tokens.access_token.length > 65536 || /[\r\n\0]/u.test(tokens.access_token)) throw new Error();
    let expiresAt: number | null = null;
    try {
      const claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString("utf8"));
      if (Number.isSafeInteger(claims.exp) && claims.exp >= 0 && Number.isSafeInteger(claims.exp * 1000)) expiresAt = claims.exp * 1000;
    } catch { /* Opaque access tokens have no locally observable expiry. */ }
    return { accountId: tokens.account_id, secret: {
      accessToken: tokens.access_token, refreshToken: null, idToken: null, expiresAt, external: true,
    } };
  } catch {
    // Do not include file contents, tokens, account IDs or parse errors.
    throw new Error("Shared Codex credentials are unavailable or do not match this account");
  }
}
