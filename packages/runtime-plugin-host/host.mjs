import { join, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readCatalogue, verifyPackage, checkedDirectory, RUNTIME_PLUGIN_API } from "./store.mjs";
import { snapshotVfsPlugin } from "./source.mjs";

export function runtimePluginDirectory(dataDirectory, env = process.env) {
  const directory = env.OPENCRAFT_RUNTIME_PLUGIN_DIRECTORY ?? join(dataDirectory, "runtime-plugins");
  if (!isAbsolute(directory) || resolve(directory) === "/") return null; // Invalid optional configuration must not stop the core.
  return directory;
}
function freeze(value, depth = 0) {
  if (depth > 16) throw Error("Plugin configuration is too deeply nested");
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child, depth + 1);
    Object.freeze(value);
  }
  return value;
}
/** Trusted operator code, not a sandbox. No scanning, npm install, downloads or hot reload. */
export async function loadRuntimePlugins({
  directory,
  role,
  authority,
  packageSource,
  cacheDirectory,
  protectedPaths = [],
  onDiagnostic = (diagnostic) => console.warn(JSON.stringify({ event: "runtime_plugin_skipped", ...diagnostic })),
  startupTimeoutMs = 5000,
  cleanupTimeoutMs = role === "execution" ? 110000 : 1000,
}) {
  if (!["gateway", "execution", "hands"].includes(role)) throw Error("Invalid runtime plugin role");
  if (
    role === "gateway" &&
    (!authority || typeof authority.authenticate !== "function" || typeof authority.admissionStatus !== "function")
  )
    throw Error("Runtime plugins require the existing Gateway authority");
  if (
    !Array.isArray(protectedPaths) ||
    protectedPaths.some((path) => typeof path !== "string" || !path.startsWith("/"))
  )
    throw Error("Invalid protected product paths");
  if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0 || startupTimeoutMs > 5000)
    throw Error("Invalid runtime plugin startup budget");
  if (!Number.isFinite(cleanupTimeoutMs) || cleanupTimeoutMs <= 0 || cleanupTimeoutMs > 110000)
    throw Error("Invalid plugin cleanup budget");
  const sourceSignal = AbortSignal.timeout(startupTimeoutMs);
  const prepared = [],
    routes = new Map(),
    services = [],
    pending = new Set(),
    selected = [],
    skipped = [];
  let closing = false;
  const deadline = performance.now() + startupTimeoutMs;
  // Diagnostics contain only validated IDs and fixed codes, never plugin exceptions/configuration.
  const report = (id, reason) => {
    const diagnostic = Object.freeze({ ...(id ? { id } : {}), role, reason });
    skipped.push(diagnostic);
    try {
      onDiagnostic(diagnostic);
    } catch {} // Optional observability cannot become a startup dependency.
  };
  const bounded = async (work, milliseconds) => {
    let timer;
    try {
      return await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("Runtime plugin timeout")), Math.max(0, milliseconds));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const duringStartup = (work) => bounded(work, deadline - performance.now());
  let catalogue = { plugins: [] },
    source;
  try {
    catalogue = await duringStartup(readCatalogue(directory));
  } catch {
    report(null, "catalogue_unavailable");
  }
  if (packageSource && catalogue.plugins.some((plugin) => plugin.enabled))
    try {
      source =
        typeof packageSource === "function"
          ? await duringStartup(Promise.resolve().then(packageSource))
          : packageSource;
      if (!source || typeof source.readPackage !== "function") throw Error("Invalid plugin source");
    } catch {
      catalogue = { plugins: [] };
      report(null, "source_unavailable");
    }
  // Verify before import; an invalid selection never disables healthy selections or core owners.
  for (const selection of catalogue.plugins.filter((plugin) => plugin.enabled)) {
    try {
      if (performance.now() >= deadline) throw Error("Startup budget exhausted");
      const verified = await duringStartup(
        (async () => {
          if (source) return snapshotVfsPlugin(source, selection, { cacheDirectory, signal: sourceSignal });
          for (const path of [join(directory, "packages"), join(directory, "packages", selection.id)])
            await checkedDirectory(path);
          return verifyPackage(join(directory, "packages", selection.id, selection.revision), {
            revision: selection.revision,
          });
        })(),
      );
      const manifest = verified.manifest;
      if (manifest.id !== selection.id || Number(process.versions.node.split(".")[0]) !== manifest.nodeMajor)
        throw Error("Runtime plugin identity or Node compatibility mismatch");
      const entryRole = role === "execution" && !manifest.roles.execution ? "hands" : role;
      const definition = manifest.roles[entryRole];
      if (!definition) continue;
      if (
        (definition.routes ?? []).some((route) =>
          protectedPaths.some((path) => route.path === path || route.path.startsWith(path.replace(/\/$/u, "") + "/")),
        )
      )
        throw Error("Protected product path");
      prepared.push({
        manifest,
        directory: verified.directory,
        selection,
        definition,
        entryRole,
        configuration: freeze(
          JSON.parse(
            JSON.stringify(
              selection.configuration[role] ??
                selection.configuration[entryRole] ??
                (role === "execution" ? selection.configuration.hands : undefined) ??
                {},
            ),
          ),
        ),
      });
    } catch {
      report(selection.id, "verification_failed");
    }
  }
  const dispose = async (service, id) => {
    try {
      await bounded(
        Promise.resolve().then(() => service.close()),
        cleanupTimeoutMs,
      );
    } catch {
      report(id, "cleanup_failed");
    }
  };
  for (const plugin of prepared) {
    const id = plugin.manifest.id;
    let failed = false,
      service,
      cleanupPromise;
    const cleanup = () => (service ? (cleanupPromise ??= dispose(service, id)) : Promise.resolve());
    const fail = () => {
      if (failed) return;
      failed = true;
      for (const [path, match] of routes) if (match.selection === plugin.selection) routes.delete(path);
      const index = selected.findIndex((item) => item.id === id);
      if (index >= 0) selected.splice(index, 1);
      report(id, "activation_or_runtime_failed");
      void cleanup();
    };
    try {
      if (performance.now() >= deadline) throw Error("Startup budget exhausted");
      if ((plugin.definition.routes ?? []).some((route) => routes.has(route.path)))
        throw Error("Runtime plugin route collision");
      const activation = (async () => {
        const module = await import(pathToFileURL(join(plugin.directory, plugin.definition.entry)).href);
        if (failed) return;
        if (typeof module.activate !== "function") throw Error("Runtime plugin activation export missing");
        const context = Object.freeze({
          hostApi: RUNTIME_PLUGIN_API,
          role: plugin.entryRole,
          revision: plugin.selection.revision,
          packageRoot: plugin.directory,
          configuration: plugin.configuration,
          onFailure: fail,
          ...(role === "gateway"
            ? {
                authority: Object.freeze({
                  authenticate: (request) => authority.authenticate(request),
                  admissionStatus: (request) => authority.admissionStatus(request),
                }),
              }
            : {}),
        });
        service = await module.activate(context);
        if (failed || closing) {
          await cleanup();
          return;
        }
        if (
          !service ||
          typeof service.close !== "function" ||
          (role === "gateway" && typeof service.handle !== "function")
        )
          throw Error("Runtime plugin returned invalid lifecycle");
      })();
      await duringStartup(activation);
      if (failed) continue;
      services.push(cleanup);
      selected.push({ id, revision: plugin.selection.revision, version: plugin.manifest.version });
      for (const route of plugin.definition.routes ?? [])
        routes.set(route.path, { route, selection: plugin.selection, service });
    } catch {
      fail();
    }
  }
  const closeServices = async () => {
    const reverse = [...services].reverse();
    if (role === "execution") await Promise.all(reverse.map((cleanup) => cleanup()));
    else for (const cleanup of reverse) await cleanup();
  };
  let stopped;
  return {
    selected,
    skipped,
    handle(request, response) {
      const match = routes.get(new URL(request.url ?? "/", "http://opencraft.invalid").pathname);
      if (!match) return false;
      const reply = (status, error) => {
        if (!response.destroyed && !response.writableEnded) {
          response.writeHead(status, { "content-type": "application/json", "cache-control": "private, no-store" });
          response.end(JSON.stringify({ error }));
        }
      };
      if (closing) {
        reply(503, "runtime_plugin_stopping");
        return true;
      }
      if (!match.route.methods.includes(request.method)) {
        response.setHeader("allow", match.route.methods.join(", "));
        reply(405, "method_not_allowed");
        return true;
      }
      const principal = authority.authenticate(request),
        status = authority.admissionStatus(request);
      if (!principal || principal.expiresAt <= Date.now()) {
        reply(401, "unauthenticated");
        return true;
      }
      if (status !== 204) {
        reply(403, "instance_access_denied");
        return true;
      }
      // Existing HTTP admission remains authoritative. A plugin never creates an Actor/session.
      const work = Promise.resolve()
        .then(() => match.service.handle(request, response))
        .catch(() =>
          reply(503, request.method === "GET" ? "runtime_plugin_unavailable" : "runtime_plugin_result_unknown"),
        );
      pending.add(work);
      void work.finally(() => pending.delete(work));
      return true;
    },
    close: () =>
      (stopped ??= (async () => {
        closing = true;
        await Promise.allSettled([...pending]);
        await closeServices();
        try {
          await source?.close?.();
        } catch {
          report(null, "source_cleanup_failed");
        }
      })()),
  };
}
