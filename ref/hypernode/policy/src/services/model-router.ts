export const HYPERNODE_ROUTER_PROVIDER_ID = "hypernode-router";

// This provider is a Desktop-facing control-plane identity. It never reaches
// an inner Codex runtime: HyperNode resolves the selected model to a concrete
// subscription/private/public execution profile at the Thread boundary.
export const HYPERNODE_ROUTER_PROVIDER_CONFIG = Object.freeze({
  name: "HyperNode Router",
  wire_api: "responses",
  requires_openai_auth: false,
});

export function externalModelProvider(): typeof HYPERNODE_ROUTER_PROVIDER_ID {
  return HYPERNODE_ROUTER_PROVIDER_ID;
}

export function internalModelProvider(providerId: unknown): string {
  return typeof providerId === "string" && providerId.length > 0 &&
    providerId !== HYPERNODE_ROUTER_PROVIDER_ID
    ? providerId
    : "openai";
}
