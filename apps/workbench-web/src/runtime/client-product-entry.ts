import type { CreateWebWorkbenchApplicationOptions } from "./web-workbench-application";
import { discoverLocalAccountProduct } from '@opencraft/plugin-local-account/client-scope';
import { serverFetch, serverStorageKey } from './server-context';
import { ServerAccountModelDefaults } from './server-account-model-defaults';
import { ServerThreadReadReceipts } from './server-thread-read-receipts';

function localStorageOrUndefined(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; }
}

/** Public clients keep local/remote Host functionality without a private product. */
export async function clientProductOptions(environment: Readonly<Record<string, unknown>>, desktopKind?: string): Promise<CreateWebWorkbenchApplicationOptions> {
  // Personal model defaults and read receipts of the server's own logins exist only on a Headless server.
  const serverAccount = desktopKind === undefined && environment.VITE_INCLUDE_HEADLESS_APPHOST === 'true';
  const [clientProduct, accountModelDefaults, threadReadReceipts] = await Promise.all([
    discoverLocalAccountProduct(serverFetch, { legacyLocalNamespace: serverStorageKey('local'), capabilityCacheKey: serverStorageKey('opencraft.account-authority.v1') }),
    serverAccount ? ServerAccountModelDefaults.discover(serverFetch) : undefined,
    serverAccount ? ServerThreadReadReceipts.discover(serverFetch, { hint: localStorageOrUndefined(), hintKey: serverStorageKey('opencraft.thread-read.server-actor.v1') }) : undefined,
  ]);
  return { ...(clientProduct ? { clientProduct } : {}), ...(accountModelDefaults ? { accountModelDefaults } : {}),
    ...(threadReadReceipts ? { threadReadReceipts } : {}) };
}
