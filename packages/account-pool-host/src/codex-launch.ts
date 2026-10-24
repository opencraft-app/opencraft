import { createHmac } from "node:crypto";

export const OPENCRAFT_CODEX_POOL_AUTH_TOKEN_ENV = "OPENCRAFT_CODEX_POOL_AUTH_TOKEN";

function loopbackBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) {
    throw new TypeError("Account Pool URL must be loopback HTTP");
  }
  if (url.username || url.password || url.search || url.hash) throw new TypeError("Invalid Account Pool URL");
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

export function createCodexAccountPoolLaunch(input: {
  readonly baseUrl: string;
  readonly hostToken: string;
}): { readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>;
  readonly auth: { readonly type: "chatgptAuthTokens"; readonly accessToken: string; readonly chatgptAccountId: string } } {
  const baseUrl = `${loopbackBaseUrl(input.baseUrl)}/v1`;
  if (!input.hostToken || input.hostToken.length > 4096 || /[\r\n\0]/u.test(input.hostToken)) {
    throw new TypeError("Invalid Account Pool Host token");
  }
  // This is a local broker credential, not an upstream OAuth token or subscription claim.
  // Native external auth is ephemeral and enables the native ChatGPT tool surface.
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: "opencraft-account-pool", aud: baseUrl, sub: "local-codex",
  })}`;
  const accessToken = `${payload}.${createHmac("sha256", input.hostToken).update(payload).digest("base64url")}`;
  return {
    auth: { type: "chatgptAuthTokens", accessToken, chatgptAccountId: "opencraft-account-pool" },
    args: [
      "-c", `chatgpt_base_url=${JSON.stringify(loopbackBaseUrl(input.baseUrl))}`,
      "-c", `openai_base_url=${JSON.stringify(baseUrl)}`,
      "-c", 'model_provider="opencraft-account-pool"',
      "-c", 'model_providers.opencraft-account-pool.name="OpenAI"',
      "-c", `model_providers.opencraft-account-pool.base_url=${JSON.stringify(baseUrl)}`,
      "-c", 'model_providers.opencraft-account-pool.wire_api="responses"',
      "-c", "model_providers.opencraft-account-pool.requires_openai_auth=true",
      "-c", "model_providers.opencraft-account-pool.supports_websockets=false",
      "-c", `model_providers.opencraft-account-pool.env_http_headers.x-opencraft-account-pool-token=${JSON.stringify(OPENCRAFT_CODEX_POOL_AUTH_TOKEN_ENV)}`,
    ],
    env: { [OPENCRAFT_CODEX_POOL_AUTH_TOKEN_ENV]: input.hostToken },
  };
}
