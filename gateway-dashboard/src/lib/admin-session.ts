import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ADMIN_SESSION_COOKIE, ADMIN_SESSION_TTL_SECONDS } from "./admin-session-constants";

const ADMIN_SESSION_VERSION = "v1";

interface SessionPayload {
  v: 1;
  t: string;
  iat: number;
  exp: number;
}

function base64urlEncode(input: Buffer): string {
  return input.toString("base64url");
}

function base64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

function getSessionSecret(): string {
  const secret =
    process.env.ADMIN_SESSION_SECRET?.trim() ||
    process.env.ADMIN_TOKEN?.trim() ||
    process.env.AUTH_ADMIN_TOKEN?.trim() ||
    process.env.SUBSCRIPTION_ADMIN_TOKEN?.trim();
  if (!secret) {
    throw new Error("ADMIN_SESSION_SECRET not configured");
  }
  return secret;
}

function deriveKey(label: string): Buffer {
  return createHash("sha256").update(`${label}:${getSessionSecret()}`).digest();
}

function parseCookieHeader(cookieHeader: string | null): Map<string, string> {
  const result = new Map<string, string>();
  if (!cookieHeader) {
    return result;
  }
  cookieHeader.split(";").forEach((part) => {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) {
      return;
    }
    result.set(rawName, rawValue.join("="));
  });
  return result;
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    maxAge?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Lax" | "Strict" | "None";
    path?: string;
    expires?: Date;
  }
): string {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${options.path ?? "/admin/gateway"}`);
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.expires) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  return parts.join("; ");
}

export function createAdminSessionValue(token: string, nowSeconds: number = Math.floor(Date.now() / 1000)): string {
  const payload: SessionPayload = {
    v: 1,
    t: token,
    iat: nowSeconds,
    exp: nowSeconds + ADMIN_SESSION_TTL_SECONDS,
  };

  const iv = randomBytes(12);
  const encKey = deriveKey("enc");
  const macKey = deriveKey("mac");
  const cipher = createCipheriv("aes-256-gcm", encKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const exp = String(payload.exp);
  const body = [
    ADMIN_SESSION_VERSION,
    exp,
    base64urlEncode(iv),
    base64urlEncode(ciphertext),
    base64urlEncode(tag),
  ].join(".");
  const mac = createHmac("sha256", macKey).update(body).digest();
  return `${body}.${base64urlEncode(mac)}`;
}

export function readAdminSessionToken(sessionValue: string | undefined, nowSeconds: number = Math.floor(Date.now() / 1000)): string | null {
  if (!sessionValue) {
    return null;
  }

  const parts = sessionValue.split(".");
  if (parts.length !== 6) {
    return null;
  }

  const [version, expRaw, ivRaw, ciphertextRaw, tagRaw, macRaw] = parts;
  if (version !== ADMIN_SESSION_VERSION) {
    return null;
  }

  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp) || nowSeconds >= exp) {
    return null;
  }

  const body = parts.slice(0, 5).join(".");
  const macKey = deriveKey("mac");
  const expectedMac = createHmac("sha256", macKey).update(body).digest();
  const actualMac = base64urlDecode(macRaw);
  if (expectedMac.length !== actualMac.length || !timingSafeEqual(expectedMac, actualMac)) {
    return null;
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey("enc"), base64urlDecode(ivRaw));
    decipher.setAuthTag(base64urlDecode(tagRaw));
    const plaintext = Buffer.concat([
      decipher.update(base64urlDecode(ciphertextRaw)),
      decipher.final(),
    ]).toString("utf8");
    const payload = JSON.parse(plaintext) as SessionPayload;
    if (payload.v !== 1 || payload.exp !== exp || typeof payload.t !== "string" || payload.t.length === 0) {
      return null;
    }
    return payload.t;
  } catch {
    return null;
  }
}

export function readAdminSessionTokenFromCookieHeader(cookieHeader: string | null): string | null {
  if (!cookieHeader) {
    return null;
  }
  const escapedName = ADMIN_SESSION_COOKIE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${escapedName}=([^;]+)`));
  if (!match?.[1]) {
    return null;
  }
  try {
    return readAdminSessionToken(match[1]);
  } catch {
    return null;
  }
}

export function hasAdminSessionCookie(cookieHeader: string | null): boolean {
  return parseCookieHeader(cookieHeader).has(ADMIN_SESSION_COOKIE);
}

export function createAdminSessionCookie(token: string): string {
  return serializeCookie(ADMIN_SESSION_COOKIE, createAdminSessionValue(token), {
    path: "/admin/gateway",
    maxAge: ADMIN_SESSION_TTL_SECONDS,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  });
}

export function createClearedAdminSessionCookie(): string {
  return serializeCookie(ADMIN_SESSION_COOKIE, "", {
    path: "/admin/gateway",
    maxAge: 0,
    expires: new Date(0),
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  });
}

export function attachAdminSessionCookie(response: Response, cookie: string, invalidate: boolean = false): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", cookie);
  if (invalidate) {
    headers.set("X-Admin-Session-Invalid", "1");
  }
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}
