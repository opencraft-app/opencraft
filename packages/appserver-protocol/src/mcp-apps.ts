/** Shared wire names only; this module must remain free of Node dependencies. */
export const MCP_APPS_SERVER = "opencraft-app-builder";
export const MCP_APPS_URI = "ui://opencraft/app-builder/v1.html";
export const MCP_APPS_METHOD = "opencraft/mcpApps/manage";
export const MCP_APPS_NAMESPACE = "opencraft_apps";
/** Optional metadata selects an exact card without changing legacy server names. */
export const MCP_APP_RESOURCE_META = "opencraft/app-resource-uri";
export const MCP_APPS_DYNAMIC_TOOLS = [
  {
    type: "namespace" as const,
    name: MCP_APPS_NAMESPACE,
    description:
      "Create, validate, publish, version and open interactive MCP Apps in this conversation.",
    tools: [
      {
        type: "function" as const,
        name: "manage",
        description:
          "Create/update/open an interactive App. Start with action help to load the exact workflow/spec schema; list/get before writes. Published Apps render directly in this conversation. Generated backend JavaScript is isolated and cannot access files, network or credentials.",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "openBuilder",
                "help",
                "list",
                "get",
                "validate",
                "saveDraft",
                "publish",
                "rollback",
                "unpublish",
                "delete",
                "open",
              ],
            },
            appId: { type: "string" },
            spec_json: { type: "string" },
            expectedVersion: { type: "integer", minimum: 0 },
            revision: { type: "integer", minimum: 1 },
            offset: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 1, maximum: 20 },
          },
          required: ["action"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
    ],
  },
];
export function appEnvelope(
  value: unknown,
): { server: string; resourceUri: string; result: unknown } | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  if (
    p.kind !== "opencraft-mcp-app" ||
    typeof p.server !== "string" ||
    (p.server !== MCP_APPS_SERVER &&
      !/^opencraft-app-[a-z][a-z0-9-]{1,39}-r[1-9][0-9]*$/.test(p.server)) ||
    typeof p.resourceUri !== "string" ||
    !(
      p.resourceUri === MCP_APPS_URI ||
      p.resourceUri.startsWith("ui://opencraft/apps/")
    ) ||
    !p.result ||
    typeof p.result !== "object"
  )
    return null;
  return { server: p.server, resourceUri: p.resourceUri, result: p.result };
}

export function ownsServer(value: unknown) {
  return (
    value === MCP_APPS_SERVER ||
    (typeof value === "string" && value.startsWith("opencraft-app-"))
  );
}
