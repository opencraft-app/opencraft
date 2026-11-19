import type { ServerWorkbenchExtension } from '../../../apps/workbench-web/src/runtime/server-product-extensions';
import { overviewCatalogs } from '../plugins/proj-overview/src/messages';

export default {
  id: 'join.proj-overview',
  preload: () => import('../plugins/proj-overview/src/index'),
  localeCatalogs: overviewCatalogs,
  async load({ getClient }) {
    const { createProjectOverviewExtension } = await import('../plugins/proj-overview/src/index');
    return createProjectOverviewExtension(getClient);
  },
} satisfies ServerWorkbenchExtension;
