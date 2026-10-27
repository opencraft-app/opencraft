import type { ClientWorkbenchProduct } from "@opencraft/client-product";
import type { ExtensionManifestV1 } from "@opencraft/extension-contract";
import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";

export const OPTIONAL_EXTENSION_ID = "example.optional-workspace";
export const PRODUCT_EXTENSION_ID = "example.product-owner";
export const OPTIONAL_EXTENSION_NAME = "Optional fixture";
export const OPTIONAL_NAVIGATION_TITLE = "Fixture workspace";

const ownerManifest: ExtensionManifestV1 = {
  manifestVersion: 1, id: PRODUCT_EXTENSION_ID, name: "Product fixture",
  version: "1.0.0", apiVersion: 1, trust: "trusted", platforms: ["web"],
  activationEvents: ["onStartupFinished"],
};
const optionalManifest: ExtensionManifestV1 = {
  ...ownerManifest, id: OPTIONAL_EXTENSION_ID, name: OPTIONAL_EXTENSION_NAME,
  dependencies: [PRODUCT_EXTENSION_ID],
};

/** A local composition fixture, with no account, remote service or private plugin. */
export function createSmokeClientProduct(trace: string[] = [], includeOptional = true, useCorePersistence = false): ClientWorkbenchProduct {
  return {
    bootstrap() { trace.push("product.bootstrap"); },
    async create() {
      trace.push("product.create");
      const scope = { namespace: "smoke-product", threadMemoryScope: "smoke-product" };
      const optional: TrustedExtensionDefinition = {
        manifest: optionalManifest,
        activate(api) {
          trace.push("optional.activate");
          api.views.register({ id: `${OPTIONAL_EXTENSION_ID}.view`, title: OPTIONAL_NAVIGATION_TITLE, viewType: "example.workspace" });
          api.navigation.register({ id: `${OPTIONAL_EXTENSION_ID}.entry`, title: OPTIONAL_NAVIGATION_TITLE,
            surface: "sidebar-primary", target: { kind: "view", viewId: `${OPTIONAL_EXTENSION_ID}.view` } });
          return () => { trace.push("optional.dispose"); };
        },
      };
      return {
        ...(useCorePersistence ? {} : { persistenceScope: {
          getSnapshot: () => scope,
          subscribe() {
            trace.push("scope.subscribe");
            return () => { trace.push("scope.unsubscribe"); };
          },
        } }),
        extensions: () => [{ manifest: ownerManifest, activate() {
          trace.push("owner.activate");
          return () => { trace.push("owner.dispose"); };
        } }],
        async preflight() { trace.push("product.preflight"); },
        builtins: includeOptional ? [{ manifest: optionalManifest, defaultEnabled: false, async load() { return optional; } }] : [],
        dispose() { trace.push("product.dispose"); },
      };
    },
  };
}
