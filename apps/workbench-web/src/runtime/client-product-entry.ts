import type { CreateWebWorkbenchApplicationOptions } from "./web-workbench-application";
import { discoverLocalAccountProduct } from '@opencraft/plugin-local-account/client-scope';
import { serverFetch, serverStorageKey } from './server-context';

/** Public clients keep local/remote Host functionality without a private product. */
export async function clientProductOptions(_environment: Readonly<Record<string, unknown>>, _desktopKind?: string): Promise<CreateWebWorkbenchApplicationOptions> {
  const clientProduct = await discoverLocalAccountProduct(serverFetch, { legacyLocalNamespace: serverStorageKey('local') });
  return clientProduct ? { clientProduct } : {};
}
