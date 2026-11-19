import { join } from 'node:path';
import { AccountModelDefaultsStore } from '../../../../../scripts/account-model-defaults-store.ts';
import { TencentOaServerPlugin } from './server.ts';
import { TENCENTOA_MODEL_DEFAULTS_PATH } from './contract.ts';

/** Account preferences are instance data, not shared engine configuration.
 * The wrapper also permits a focused upgrade of an existing product composition. */
export function withTencentOaModelDefaults(composition) {
  return {
    ...composition,
    async createIdentity(context) {
      const identity = await composition.createIdentity(context);
      let defaults, service;
      try {
        defaults = new AccountModelDefaultsStore(join(context.dataDirectory, 'account-model-defaults.sqlite'));
        service = new TencentOaServerPlugin(null, {
          identityResolver: context.resolveIdentity,
          modelDefaults: defaults,
        });
      } catch (error) {
        defaults?.close();
        await identity.close?.();
        throw error;
      }
      let closing;
      return {
        ...identity,
        getStorageOutcomes: () => [...(identity.getStorageOutcomes?.() ?? []),
          { name: 'account-model-defaults', status: defaults.outcome.status }],
        service: {
          ...identity.service,
          handle(request, response) {
            if (new URL(request.url ?? '/', 'http://opencraft.invalid').pathname !== TENCENTOA_MODEL_DEFAULTS_PATH)
              return identity.service.handle(request, response);
            const status = context.getInstanceAccess()?.admissionStatus(request) ?? 403;
            if (status !== 204) {
              response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
              response.end(JSON.stringify({ error: status === 401 ? 'unauthenticated' : 'forbidden' }));
              return true;
            }
            return service.handle(request, response);
          },
        },
        close() {
          return closing ??= (async () => {
            try { await identity.close?.(); }
            finally { service.close(); defaults.close(); }
          })();
        },
      };
    },
  };
}
