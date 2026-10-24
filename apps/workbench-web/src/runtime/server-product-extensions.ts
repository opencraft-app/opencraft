import { createObservabilityExtension } from './observability';
import type { AppServerClient } from "@opencraft/appserver-client";
import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import type { LocaleCatalog } from "@opencraft/i18n";

/** Trusted build/application composition, never a deployment JSON module URL. */
export interface ServerWorkbenchExtension {
  readonly id: string;
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
  {id:'opencraft.observability',load:()=>createObservabilityExtension()},
];
