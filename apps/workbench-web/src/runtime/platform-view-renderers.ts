import type { InternalContributionAdapter } from "@opencraft/extension-runtime";
import {
  PlatformViewRendererRegistry,
  type PlatformViewRendererContribution,
} from "@opencraft/extension-react";

export function createPlatformViewRendererContributionAdapter(
  registry: PlatformViewRendererRegistry,
): InternalContributionAdapter {
  return {
    prepare(owner, value) {
      if (typeof value !== "object" || value === null || !("viewType" in value) || !("Component" in value)) {
        throw new TypeError("Platform View renderer contribution is invalid");
      }
      const contribution = value as PlatformViewRendererContribution;
      if (typeof contribution.viewType !== "string" || typeof contribution.Component !== "function") {
        throw new TypeError("Platform View renderer requires viewType and Component");
      }
      if (registry.resolve(contribution.viewType) !== null) {
        throw new Error(`Platform View renderer ${contribution.viewType} is already registered`);
      }
      return { commit: () => registry.register(owner.activationId, contribution) };
    },
  };
}
