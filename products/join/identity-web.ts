import type { ServerWorkbenchExtension } from '../../apps/workbench-web/src/runtime/server-product-extensions';
import { ioaLocaleCatalogs } from './plugins/tencentoa/src/locales';

export const identityWorkbenchExtension: ServerWorkbenchExtension = {
  id: 'tencentoa.identity',
  preload: () => import('./plugins/tencentoa/src/index'),
  localeCatalogs: ioaLocaleCatalogs,
  async load({ fetcher, getClient }) {
    const { createTencentOaExtension, TencentOaController } = await import('./plugins/tencentoa/src/index');
    return createTencentOaExtension(new TencentOaController(fetcher), { getClient, fetcher });
  },
};
