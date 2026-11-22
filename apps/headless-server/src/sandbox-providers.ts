import { createSandboxProviderRegistry, type SandboxProviderRegistry } from "@opencraft/sandbox/providers";
import { e2bSandboxProvider } from "@opencraft/sandbox-e2b";
import type { SandboxInstallation } from "@opencraft/plugin-assets/server/sandbox-installations";

export type HeadlessSandboxProviders = SandboxProviderRegistry<SandboxInstallation>;
/** Headless deployment assembly: the only place that names vendor sandbox adapters.
 * Workspace and Bot owners resolve the installation's configured backend through
 * this registry; an unregistered backend fails closed. Loaded in the Assets Worker. */
export function createHeadlessSandboxProviders(): HeadlessSandboxProviders {
  return createSandboxProviderRegistry<SandboxInstallation>({ e2b: e2bSandboxProvider() });
}
