// How the account owner reaches a configured provider on an engine's behalf.
// Runtime-neutral: the Node proxy projection (service.ts) and the credential
// lease source (provider-credentials.ts) decide with the same rule.
import { engineEndpointAllowed } from "./engine-endpoint.js";

/** Protocols the account Core forwards natively for non-Codex callers (codex-proxy.ts PROVIDER_ROUTE). */
export const PROXY_PROTOCOLS = Object.freeze(["anthropic-messages", "openai-responses", "openai-completions"] as const);

export type RoutedProvider = {
  id: string;
  name?: string;
  protocol: string;
  baseUrl?: string | null;
  credentialRef?: string | null;
  authentication?: string;
  catalogId?: string | null;
};

/**
 * - `account`: the account owner holds its credential and forwards (or leases) on the engine's behalf.
 * - `keyless`: the engine needs no credential (no-auth endpoint, no reference, speech or human contributions,
 *   which engines never execute: speech belongs to the Gateway, human providers to the account Core).
 * - `rejected`: would require the engine to hold a provider key; `why` names the unmet requirement.
 */
export type ProviderRoute =
  | { route: "account"; baseUrl: string }
  | { route: "keyless" }
  | { route: "rejected"; why: "protocol" | "base-url" | "endpoint" };

export function providerRoute(p: RoutedProvider): ProviderRoute {
  if (
    p.authentication === "none" ||
    !p.credentialRef ||
    p.catalogId?.startsWith("opencraft-human-") ||
    p.protocol === "hunyuan-asr"
  )
    return { route: "keyless" };
  if (!(PROXY_PROTOCOLS as readonly string[]).includes(p.protocol)) return { route: "rejected", why: "protocol" };
  if (!p.baseUrl) return { route: "rejected", why: "base-url" };
  if (!engineEndpointAllowed(p.baseUrl)) return { route: "rejected", why: "endpoint" };
  return { route: "account", baseUrl: p.baseUrl };
}
