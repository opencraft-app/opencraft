import { assertOwnedContributionId } from "@opencraft/extension-contract";
import type { InternalContributionAdapter } from "@opencraft/extension-runtime";
import type { ConnectorProvider, ConnectorRuntime } from "@opencraft/workbench-runtime";

export function connectorProviderAdapter(runtime: ConnectorRuntime): InternalContributionAdapter {
  return { prepare(owner, value) {
    const p = value as Partial<ConnectorProvider> | null;
    if (!p || typeof p.id !== "string" || typeof p.title !== "string"
      || (p.authenticationProviderId !== undefined && typeof p.authenticationProviderId !== "string")
      || !Array.isArray(p.contributions) || p.contributions.some(c => !c || typeof c.id !== "string" || !c.id || !["tools", "skills"].includes(c.kind) || typeof c.prepare !== "function")) throw new TypeError("Invalid Connector provider");
    assertOwnedContributionId(owner.extensionId, p.id);
    return { commit: () => runtime.register(owner.activationId, p as ConnectorProvider) };
  } };
}
