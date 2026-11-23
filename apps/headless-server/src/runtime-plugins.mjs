import { isAbsolute, join, resolve } from "node:path";
import { loadRuntimePlugins, runtimePluginDirectory } from "@opencraft/runtime-plugin-host";

/**
 * Every application namespace the Headless request pipeline owns. The plugin
 * store already rejects its own reserved set; this list also covers the routes
 * the store does not know, so a plugin can never shadow a core endpoint even if
 * a later pipeline change moves the plugin mount. Namespaces core only forwards
 * for an installation's identity composition (`/__opencraft_enterprise_identity`)
 * are not listed: that composition protects the paths it serves through
 * `protectedPaths`, and may host its own runtime plugins underneath.
 */
export const HEADLESS_CORE_ROUTE_PATHS = Object.freeze([
  "/health",
  "/setup",
  "/appserver",
  "/apphost",
  "/ssh-apphost",
  "/desktop",
  ...[
    "access",
    "account",
    "actors",
    "apphost",
    "apphost_diagnostic",
    "assets",
    "auth",
    "browser",
    "connectors",
    "files",
    "health",
    "hub",
    "im",
    "model_gateway",
    "model_policy",
    "notifications",
    "observe",
    "plugin_catalog",
    "plugins",
    "preview",
    "product_plugins",
    "push",
    "relay",
    "resources",
    "runtime_error",
    "server_information",
    "speech",
    "ssh",
    "ssh_servers",
    "update",
    "updates",
    "web_update",
  ].map((name) => "/__opencraft_" + name),
]);

const privatePath = (value) => typeof value === "string" && isAbsolute(value) && resolve(value) !== "/";
const OPTION_KEYS = new Set(["directory", "packageSource", "cacheDirectory", "role", "protectedPaths"]);

/** Shape-check trusted composition before any store, Worker or listener starts. */
export function validateRuntimePluginOptions(value) {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !OPTION_KEYS.has(key)) ||
    (value.directory !== undefined && !privatePath(value.directory)) ||
    (value.cacheDirectory !== undefined && !privatePath(value.cacheDirectory)) ||
    (value.role !== undefined && !["gateway", "execution"].includes(value.role)) ||
    (value.packageSource !== undefined &&
      typeof value.packageSource !== "function" &&
      (!value.packageSource || typeof value.packageSource.readPackage !== "function")) ||
    (value.protectedPaths !== undefined &&
      (!Array.isArray(value.protectedPaths) ||
        value.protectedPaths.length > 64 ||
        value.protectedPaths.some((path) => typeof path !== "string" || !/^\/[A-Za-z0-9_/-]{0,255}$/u.test(path))))
  )
    throw new Error("Invalid Headless runtime plugin configuration");
  return Object.freeze({ ...value, protectedPaths: Object.freeze([...(value.protectedPaths ?? [])]) });
}

/**
 * Load operator-selected runtime plugins once the instance's own authentication
 * and admission owner exists. Gateway routes reuse that owner; a deployment
 * without instance admission keeps every plugin unloaded instead of exposing
 * routes that nobody can authorize.
 */
export async function startHeadlessRuntimePlugins(
  configuration,
  { dataDirectory, instanceAccess, authService, load = loadRuntimePlugins, log = console },
) {
  const role = configuration.role ?? "gateway";
  const report = (diagnostic) => {
    try {
      log.warn("[runtime-plugins]", JSON.stringify({ event: "runtime_plugin_skipped", ...diagnostic }));
    } catch {
      /* Observability never becomes a startup dependency. */
    }
  };
  if (role === "gateway" && !instanceAccess) {
    const diagnostic = Object.freeze({ role, reason: "admission_unavailable" });
    report(diagnostic);
    return emptyHost(role, [diagnostic]);
  }
  const directory = configuration.directory ?? runtimePluginDirectory(dataDirectory);
  if (!directory) {
    const diagnostic = Object.freeze({ role, reason: "catalogue_unavailable" });
    report(diagnostic);
    return emptyHost(role, [diagnostic]);
  }
  const { packageSource } = configuration;
  const host = await load({
    directory,
    role,
    protectedPaths: [...HEADLESS_CORE_ROUTE_PATHS, ...configuration.protectedPaths],
    cacheDirectory: configuration.cacheDirectory ?? join(dataDirectory, "runtime-plugin-cache"),
    ...(packageSource === undefined
      ? {}
      : {
          packageSource: typeof packageSource === "function" ? () => packageSource({ dataDirectory }) : packageSource,
        }),
    ...(role === "gateway"
      ? {
          authority: {
            authenticate: (request) => instanceAccess.authenticate(request),
            // Mirrors the pipeline: an invalidated login session is never re-admitted by another provider.
            admissionStatus: (request) =>
              authService?.invalidSession(request) ? 401 : instanceAccess.admissionStatus(request),
          },
        }
      : {}),
    onDiagnostic: report,
  });
  try {
    log.info(
      "[runtime-plugins]",
      JSON.stringify({
        event: "runtime_plugins_started",
        role,
        selected: host.selected.map((plugin) => plugin.id),
        skipped: host.skipped.length,
      }),
    );
  } catch {
    /* Observability never becomes a startup dependency. */
  }
  return withHealth(role, host);
}

function emptyHost(role, skipped) {
  return withHealth(role, { selected: [], skipped, handle: () => false, close: async () => {} });
}

/** Health shows validated IDs and fixed reason codes, never revisions, errors or configuration. */
function withHealth(role, host) {
  return {
    handle: (request, response) => host.handle(request, response),
    close: () => host.close(),
    health: () => ({
      role,
      selected: host.selected.map(({ id, version }) => ({ id, version })),
      skipped: host.skipped.map(({ id, reason }) => (id ? { id, reason } : { reason })),
    }),
  };
}
