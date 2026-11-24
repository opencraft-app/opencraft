import { serverUrl } from './server-context';
import { createObservabilityExtension } from './observability';
import type { AppServerClient } from "@opencraft/appserver-client";
import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import type { LocaleCatalog } from "@opencraft/i18n";
import type { ServerAssetsContribution } from "@opencraft/plugin-assets/client";
import type { ApplicationRoute } from "./workbench-navigation";

/** Trusted build/application composition, never a deployment JSON module URL. */
export interface ServerWorkbenchExtension {
  readonly id: string;
  /** Optional product capabilities for the shared Server Assets page. */
  readonly assets?: ServerAssetsContribution;
  /** Normalizes previously published product routes before navigation. */
  resolveRoute?(route: ApplicationRoute): ApplicationRoute;
  readonly chatRenderExtensions?: readonly import("@deepseek-ai/cordis").Plugin[];
  /** Prepare public code only; never construct services, read account data or activate. */
  readonly preload?: () => Promise<unknown>;
  /** Product-owned messages for the application's existing language choices. */
  readonly localeCatalogs?: readonly LocaleCatalog[];
  load(context: {
    readonly fetcher: typeof fetch;
    readonly getClient: (hostId: string) => AppServerClient | undefined;
  }): TrustedExtensionDefinition | Promise<TrustedExtensionDefinition>;
}

// A generic Headless connection does not imply any enterprise identity source.
// The build owner can explicitly replace this entry with a product assembly.
export const serverWorkbenchExtensions: readonly ServerWorkbenchExtension[] = [
  {id:'opencraft.account',preload:()=>import('@opencraft/plugin-local-account/client'),async load({fetcher}) { return (await import('@opencraft/plugin-local-account/client')).createLocalAccountExtension(fetcher, serverUrl('/__opencraft_account/')); }},
  // Registers its Settings page only when the server enables the policy and the viewer administers it.
  {id:'opencraft.login-admission',async load({fetcher}) { return (await import('@opencraft/plugin-login-admission/client')).createLoginAdmissionExtension(fetcher, serverUrl('/__opencraft_access/login-admission')); }},
  {id:'opencraft.observability',load:()=>createObservabilityExtension()},
];
