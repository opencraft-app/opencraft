import { createHash } from "node:crypto";
/** Compatibility identity is deliberately e2b: changing it would orphan existing
 * Bot placements and derive different persistent workspace IDs. */
export function createInstalledSandboxProviders(
  configurations,
  { createProvider, backend, authorizeOwner, budget },
) {
  let active,
    serial = Promise.resolve(),
    stopped = false;
  const snapshot = () => configurations.installedRuntime?.() ?? null;
  const fingerprint = (value) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          value.policy,
          value.records.map((r) => [
            r.environment.id,
            r.environment.templateId,
            r.credential.id,
            r.credential.generation,
            r.credential.apiUrl,
            r.credential.sandboxUrl,
          ]),
        ]),
      )
      .digest("hex");
  const unavailable = () => {
    throw Error("assistant_environment_unavailable");
  };
  const current = (key) => {
    if (stopped) unavailable();
    const v = snapshot();
    if (!v || !v.records.length || fingerprint(v) !== key) unavailable();
    return v;
  };
  async function refresh() {
    if (stopped) unavailable();
    let value = snapshot(),
      key = value?.records.length ? fingerprint(value) : null;
    if (active?.key === key) return active;
    if (active) {
      await active.provider.close();
      active = null;
    }
    value = snapshot();
    key = value?.records.length ? fingerprint(value) : null;
    if (!key) return null;
    const { policy, records } = value;
    const provider = await createProvider({
      backendId: "e2b",
      templates: records.map((r) => ({
        id: r.environment.templateId,
        name: r.environment.name,
        workspaceRoot: r.policy.workspaceRoot,
        resources: r.policy.resources,
        ...(r.policy.python ? { python: r.policy.python } : {}),
      })),
      capacity: policy.capacity,
      maxCommandMs: policy.maxCommandMs,
      persistentWorkspaces: policy.persistentWorkspaces,
      onReconciliation: identity => console.warn("assistant_environment_reconciliation_required", identity),
      createBackend: (template, callbacks) => {
        const binding = () => {
          const r = current(key).records.find(
            (r) => r.environment.templateId === template.id,
          );
          if (!r) unavailable();
          return r;
        };
        const record = binding();
        const selected = backend({
          apiUrl: record.credential.apiUrl,
          sandboxUrl: record.credential.sandboxUrl,
          templateId: template.id,
          python: template.python,
          readApiKey: async () => binding().credential.apiKey,
          readWorkspaceId: callbacks.workspaceId,
          timeoutMs: policy.lease.timeoutMs,
          requestTimeoutMs: 15000,
          lease: {
            renewEveryMs: policy.lease.renewEveryMs,
            maxLifetimeMs: policy.lease.maxLifetimeMs,
            authorize: async (identity) => {
              binding();
              await callbacks.authorize(identity);
              binding();
            },
            onLost: callbacks.onLost,
          },
        });
        return budget ? budget.wrap("bot", selected) : selected;
      },
    });
    active = { key, provider };
    return active;
  }
  return {
    async forContext(context) {
      authorizeOwner(context);
      const operation = serial.then(refresh);
      serial = operation.then(
        () => {},
        () => {},
      );
      const entry = await operation;
      if (!entry) return {};
      const available = () => {
        authorizeOwner(context, false);
        if (active !== entry) unavailable();
        return current(entry.key);
      };
      available();
      return {
        e2b: {
          templates: async () =>
            available().records.map((r) => ({
              id: r.environment.templateId,
              name: r.environment.name,
            })),
          validate: async (environment) => {
            available();
            await entry.provider.validate(environment);
            available();
          },
          spawn: async (environment, options) => {
            available();
            const handle = await entry.provider.spawn(environment, {
              ...options,
              request: async (...args) => {
                available();
                const response = await options.request(...args);
                available();
                return response;
              },
            });
            try {
              available();
            } catch (e) {
              await handle.close();
              throw e;
            }
            return handle;
          },
        },
      };
    },
    async close() {
      stopped = true;
      await serial;
      if (active) await active.provider.close();
      active = null;
    },
  };
}
