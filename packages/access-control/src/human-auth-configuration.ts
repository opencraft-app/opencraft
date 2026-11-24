// Human login configuration (runtime-neutral). The Node root reads it from a
// private file (`apps/headless-server/src/assembly/root-inputs-node.mjs`); any
// root validates the same value here.
export interface OidcProviderConfiguration {
  readonly id: string;
  readonly label: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post" | "none";
}
export interface HumanAuthConfiguration {
  readonly origin: string;
  readonly local: boolean;
  readonly oidc: readonly OidcProviderConfiguration[];
  /** Optional operator-owned bootstrap proof; existing installations remain closed. */
  readonly setupTokenFile?: string;
}
export function secureUrl(value: unknown): URL {
  if (typeof value !== "string") throw new Error("Authentication URL required");
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Authentication URLs require HTTPS (or HTTP loopback)");
  return url;
}
export function parseHumanAuthConfiguration(input: unknown): HumanAuthConfiguration {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid human authentication configuration");
  const v = input as Record<string, unknown>;
  if (Object.keys(v).some((key) => !["origin", "local", "oidc", "setupTokenFile"].includes(key)))
    throw new Error("Unknown authentication option");
  if (
    v.setupTokenFile !== undefined &&
    (v.local !== true ||
      typeof v.setupTokenFile !== "string" ||
      !v.setupTokenFile.startsWith("/") ||
      v.setupTokenFile.includes("\0"))
  )
    throw new Error("Setup requires local accounts and an absolute private token file");
  const origin = secureUrl(v.origin);
  if (origin.origin !== v.origin || typeof v.local !== "boolean" || !Array.isArray(v.oidc) || v.oidc.length > 16)
    throw new Error("Invalid authentication origin/providers");
  const ids = new Set<string>();
  const providers = v.oidc.map((item: unknown): OidcProviderConfiguration => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid OIDC provider");
    const p = item as Record<string, unknown>;
    if (
      Object.keys(p).some(
        (key) => !["id", "label", "issuer", "clientId", "clientSecret", "tokenEndpointAuthMethod"].includes(key),
      ) ||
      typeof p.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,31}$/u.test(p.id) ||
      ids.has(p.id) ||
      typeof p.label !== "string" ||
      !p.label.trim() ||
      p.label.length > 80 ||
      /[\x00-\x1f]/u.test(p.label) ||
      typeof p.clientId !== "string" ||
      !p.clientId ||
      p.clientId.length > 256 ||
      (p.clientSecret !== undefined &&
        (typeof p.clientSecret !== "string" || !p.clientSecret || p.clientSecret.length > 4096)) ||
      (p.tokenEndpointAuthMethod !== undefined &&
        !["none", "client_secret_basic", "client_secret_post"].includes(p.tokenEndpointAuthMethod as string))
    )
      throw new Error("Invalid OIDC provider");
    secureUrl(p.issuer);
    ids.add(p.id);
    if (
      (p.tokenEndpointAuthMethod === "none" && p.clientSecret !== undefined) ||
      (p.tokenEndpointAuthMethod?.toString().startsWith("client_secret_") && p.clientSecret === undefined)
    )
      throw new Error("OIDC client authentication mismatch");
    return {
      id: p.id,
      label: p.label,
      issuer: p.issuer as string,
      clientId: p.clientId,
      ...(typeof p.clientSecret === "string" ? { clientSecret: p.clientSecret } : {}),
      ...(p.tokenEndpointAuthMethod
        ? { tokenEndpointAuthMethod: p.tokenEndpointAuthMethod as OidcProviderConfiguration["tokenEndpointAuthMethod"] }
        : {}),
    };
  });
  if (!v.local && !providers.length) throw new Error("At least one login method is required");
  return {
    origin: origin.origin,
    local: v.local,
    oidc: providers,
    ...(typeof v.setupTokenFile === "string" ? { setupTokenFile: v.setupTokenFile } : {}),
  };
}
