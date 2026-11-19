import { configuredModelGatewayPath, ModelGatewayStore } from "./model-gateway-store.js";

/** Connection ownership, rather than an installation-wide switch, determines
 * which requests require Human admission. Withdrawn connections stay protected. */
export function modelGatewayProvider(model: unknown): string | null {
  if (typeof model !== "string" || !model.startsWith("configured/")) return null;
  const parts = model.slice("configured/".length).split("/");
  if (parts.length !== 2) return null;
  try {
    return decodeURIComponent(parts[0]!);
  } catch {
    return null;
  }
}
export function requiresModelGateway(model: unknown, path = configuredModelGatewayPath()): boolean {
  const provider = modelGatewayProvider(model);
  if (!path || provider === null) return false;
  const store = new ModelGatewayStore(path);
  try {
    return store.contribution(provider) !== null;
  } finally {
    store.close();
  }
}
