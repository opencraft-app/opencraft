import { createInstalledSandboxProviders } from "./installed-sandbox-providers.mjs";
import { createHash } from "node:crypto";
import { createSandboxAssistantProvider } from "@opencraft/personal-assistant/sandbox";
import { e2bSandboxBackend } from "@opencraft/sandbox-e2b";
import { PLATFORM_ASSET_SCOPE } from "./contract.ts";
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Both sources use the same allocator. Shared custody is not shared Bot execution. */
export function createConfiguredSandboxProviders(
  configurations,
  { actors, getInstanceAccess, installedBudget },
  {
    createProvider = createSandboxAssistantProvider,
    backend = e2bSandboxBackend,
  } = {},
) {
  const providers = new Map(),
    pendingSpawns = new Set(),
    retiring = new Map();
  let stopped = false,
    closing;
  function account(context, session = true) {
    if (
      stopped ||
      !actors ||
      (session && !actors.isCurrent(context)) ||
      !getInstanceAccess()?.admitsActor(context.actorId)
    )
      throw Error("assistant_environment_unavailable");
    const actor = actors.get(context.actorId),
      bindings = actors
        .bindings(context.actorId)
        .filter((p) => p.provider === "tencentoa");
    if (
      actor?.kind !== "human" ||
      !actor.enabled ||
      actor.generation !== context.generation ||
      bindings.length !== 1
    )
      throw Error("assistant_environment_unavailable");
    const principal = bindings[0],
      access = getInstanceAccess(),
      membership = access.store.actorMembership(actor.id);
    const admin = membership
      ? membership.enabled && membership.role === "admin"
      : actors
          .bindings(actor.id)
          .some((binding) => access.store.role(binding) === "admin");
    return { scope: `tencentoa:${principal.subject}`, custom: !!admin };
  }
  const identity = ({ environment, credential }, source = "personal") =>
    hash([
      ...(source === "platform" ? ["platform"] : []),
      environment.id,
      environment.templateId,
      credential.id,
      credential.generation,
      credential.apiUrl,
      credential.sandboxUrl,
    ]);
  // No caller closure is retained by a platform pool. Its per-lease Bot binding is
  // checked by the existing sandbox provider's callbacks, including on renewals.
  function publication(fingerprint) {
    if (stopped) throw Error("assistant_environment_unavailable");
    const match = configurations
      .runtime(PLATFORM_ASSET_SCOPE, true, "platform")
      .find((value) => identity(value, "platform") === fingerprint);
    if (!match) throw Error("assistant_environment_unavailable");
    return match;
  }
  function current(context, scope, fingerprint, source) {
    const owner = account(context, false);
    if (owner.scope !== scope) throw Error("assistant_environment_unavailable");
    if (source === "platform") return publication(fingerprint);
    const match = configurations
      .runtime(scope, owner.custom)
      .find((value) => identity(value) === fingerprint);
    if (!match) throw Error("assistant_environment_unavailable");
    return match;
  }
  const installed = createInstalledSandboxProviders(configurations, {createProvider,backend,authorizeOwner:account,budget:installedBudget});
  return {
    async forContext(context) {
      let owner;
      try {
        owner = account(context);
      } catch {
        return {};
      }
      const installedProviders = await installed.forContext(context);
      const installedIds = new Set(configurations.installedRuntime?.()?.records.map(r=>r.environment.id) ?? []);
      const { scope, custom } = owner,
        result = {};
      const records = [
        ...configurations
          .runtime(scope, custom)
          .map((record) => ({ ...record, source: "personal" })),
        ...configurations
          .runtime(PLATFORM_ASSET_SCOPE, true, "platform")
          .filter(record=>!installedIds.has(record.environment.id))
          .map((record) => ({ ...record, source: "platform" })),
      ];
      const keyFor = (record) =>
        record.source === "platform"
          ? "platform:" + identity(record, "platform")
          : scope + ":" + context.generation + ":" + identity(record);
      const liveKey = (key) => {
        const liveOwner = account(context);
        const live = key.startsWith("platform:")
          ? configurations
              .runtime(PLATFORM_ASSET_SCOPE, true, "platform")
              .map((record) => ({ ...record, source: "platform" }))
          : configurations
              .runtime(scope, liveOwner.custom)
              .map((record) => ({ ...record, source: "personal" }));
        return live.some((record) => keyFor(record) === key);
      };
      for (const [key, promise] of providers) {
        if (
          !(key.startsWith(scope + ":") || key.startsWith("platform:")) ||
          liveKey(key)
        )
          continue;
        const retired = await promise;
        // Construction/cleanup can yield while another request publishes a new version.
        if (providers.get(key) !== promise || liveKey(key)) continue;
        let retirement = retiring.get(key);
        if (!retirement) {
          retirement = Promise.resolve()
            .then(() => retired.close?.())
            .then(() => {
              if (providers.get(key) === promise) providers.delete(key);
              if (retiring.get(key) === retirement) retiring.delete(key);
            });
          retiring.set(key, retirement);
          void retirement.catch(() => {}); // Retain failed cleanup as a fail-closed barrier.
        }
        await retirement;
      }
      account(context);
      for (const record of records) {
        const { source } = record,
          fingerprint = identity(record, source),
          key = keyFor(record);
        const backendId =
          source === "platform"
            ? "e2b-shared-" + hash([fingerprint]).slice(0, 40)
            : "e2b-" +
              hash([scope, context.generation, fingerprint]).slice(0, 40);
        if (retiring.has(key)) await retiring.get(key);
        current(context, scope, fingerprint, source);
        let promise = providers.get(key);
        if (!promise) {
          const binding = () =>
            source === "platform"
              ? publication(fingerprint)
              : current(context, scope, fingerprint, source);
          promise = createProvider({
            backendId,
            templates: [
              {
                id: record.environment.templateId,
                name: record.environment.name,
                workspaceRoot: "/home/user/opencraft",
                resources: { cpuMillis: 2000, memoryBytes: 2147483648 },
              },
            ],
            // One pool per public configuration across all members, not per caller.
            capacity: { cpuMillis: 4000, memoryBytes: 8589934592 },
            maxCommandMs: 60000,
            createBackend: (template, callbacks) =>
              backend({
                apiUrl: record.credential.apiUrl,
                sandboxUrl: record.credential.sandboxUrl,
                templateId: template.id,
                readApiKey: async () => binding().credential.apiKey,
                timeoutMs: 300000,
                requestTimeoutMs: 15000,
                lease: {
                  renewEveryMs: 60000,
                  maxLifetimeMs: 3600000,
                  authorize: async (leaseIdentity) => {
                    binding();
                    await callbacks.authorize(leaseIdentity);
                    binding();
                  },
                  onLost: callbacks.onLost,
                },
              }),
          }).catch((error) => {
            if (providers.get(key) === promise) providers.delete(key);
            throw error;
          });
          providers.set(key, promise);
        }
        const provider = await promise;
        current(context, scope, fingerprint, source);
        const available = () => {
          if (providers.get(key) !== promise || retiring.has(key))
            throw Error("assistant_environment_unavailable");
          return current(context, scope, fingerprint, source);
        };
        result[backendId] = {
          templates: async () => {
            const live = available();
            return [
              { id: live.environment.templateId, name: live.environment.name },
            ];
          },
          validate: async (environment) => {
            available();
            await provider.validate?.(environment);
            available();
          },
          spawn: (environment, options) => {
            const operation = (async () => {
              available();
              const handle = await provider.spawn(environment, {
                ...options,
                // This request belongs to this Bot lease, never the first pool caller.
                // Native command authorization and lease renewal both pass here.
                request: async (...args) => {
                  available();
                  const response = await options.request(...args);
                  available();
                  return response;
                },
              });
              try {
                available();
              } catch (error) {
                await handle.close();
                throw error;
              }
              return handle;
            })();
            pendingSpawns.add(operation);
            operation.then(
              () => pendingSpawns.delete(operation),
              () => pendingSpawns.delete(operation),
            );
            return operation;
          },
        };
      }
      account(context);
      return {...result,...installedProviders};
    },
    close() {
      if (closing) return closing;
      stopped = true;
      return (closing = (async () => {
        await Promise.allSettled([...pendingSpawns]);
        const results = await Promise.allSettled([
          installed.close(),
          ...retiring.values(),
          ...[...providers.values()].map(async (p) => (await p).close?.()),
        ]);
        providers.clear();
        if (results.some((r) => r.status === "rejected"))
          throw Error("Sandbox cleanup unconfirmed");
      })());
    },
  };
}
