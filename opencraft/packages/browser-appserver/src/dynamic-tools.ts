import type { AppServerClient } from "@opencraft/appserver-client";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec,
} from "@opencraft/appserver-protocol/generated/v2";

export const OPENCRAFT_BROWSER_EXTENSION = "vela/browser-use";

export const OPENCRAFT_BROWSER_CAPABILITY = Object.freeze({
  version: 1,
  backends: ["iframe-presentation", "preview-bridge"] as const,
  previewBridgeProtocol: 1,
  actions: [
    "open",
    "read-context",
    "list-tabs",
    "navigate",
    "back",
    "forward",
    "reload",
    "stop",
    "inspect",
    "click",
    "fill",
    "press",
    "scroll",
    "wait",
    "screenshot",
    "close",
  ] as const,
  supportsCaptureViewport: false,
});

const openInOpenCraftSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    url: { type: "string", description: "Absolute http(s) URL to open." },
    tab_id: { type: "string", description: "Existing OpenCraft browser tab ID." },
    placement: { type: "string", enum: ["right"], default: "right" },
    visible: { type: "boolean", default: true, description: "False creates a background browser tab without taking focus. Open the same tab_id with visible=true to show it." },
  },
  anyOf: [{ required: ["url"] }, { required: ["tab_id"] }],
});

const getTabContextSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["tab_id"],
  properties: {
    tab_id: { type: "string" },
    include_selection: { type: "boolean", default: true },
    max_inline_chars: { type: "integer", minimum: 1_000, maximum: 200_000 },
  },
});

const browserUseSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: [
        "list_tabs", "navigate", "back", "forward",
        "reload", "stop", "inspect", "click", "fill", "press", "scroll",
        "wait", "screenshot", "close",
      ],
    },
    tab_id: { type: "string" },
    url: { type: "string" },
    ref: { type: "string" },
    expected_revision: { type: "integer", minimum: 0 },
    value: { type: "string" },
    key: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    timeout_ms: { type: "integer", minimum: 0, maximum: 30_000 },
    text: { type: "string", description: "Page text to wait for." },
  },
});

export const OPENCRAFT_BROWSER_DYNAMIC_TOOLS: readonly DynamicToolSpec[] = Object.freeze([
  {
    type: "namespace",
    name: "vela_app",
    description: "OpenCraft application presentation tools.",
    tools: [{
      type: "function",
      name: "open_in_vela",
      description: "Open or focus a browser page in OpenCraft. This does not inspect or verify it.",
      inputSchema: openInOpenCraftSchema,
    }],
  },
  {
    type: "namespace",
    name: "vela_browser",
    description: "Read and operate OpenCraft's in-app browser.",
    tools: [
      {
        type: "function",
        name: "get_tab_context",
        description: "Read a browser tab as untrusted page content with sensitive controls redacted.",
        inputSchema: getTabContextSchema,
      },
      {
        type: "function",
        name: "browser_use",
        description: "Inspect or operate a OpenCraft browser tab using revision-scoped element refs.",
        inputSchema: browserUseSchema,
      },
    ],
  },
]);

export interface BrowserDynamicToolContext {
  /** Host identity is supplied by the client runtime that owns this socket. */
  readonly hostId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
}

export interface BrowserDynamicToolHost {
  open(
    context: BrowserDynamicToolContext,
    argumentsValue: Readonly<Record<string, unknown>>,
  ): unknown | Promise<unknown>;
  getTabContext(
    context: BrowserDynamicToolContext,
    argumentsValue: Readonly<Record<string, unknown>>,
  ): unknown | Promise<unknown>;
  browserUse(
    context: BrowserDynamicToolContext,
    argumentsValue: Readonly<Record<string, unknown>>,
  ): unknown | Promise<unknown>;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function textResponse(value: unknown, success = true): DynamicToolCallResponse {
  const serialized = typeof value === "string"
    ? value
    : JSON.stringify(value) ?? String(value);
  return {
    success,
    contentItems: [{
      type: "inputText",
      text: serialized,
    }],
  };
}

function contextOf(
  hostId: string,
  params: DynamicToolCallParams,
): BrowserDynamicToolContext {
  return {
    hostId,
    threadId: params.threadId,
    turnId: params.turnId,
    callId: params.callId,
  };
}

async function executeBrowserTool(
  host: BrowserDynamicToolHost,
  hostId: string,
  params: DynamicToolCallParams,
): Promise<DynamicToolCallResponse | null> {
  const argumentsValue = record(params.arguments);
  if (argumentsValue === null) return textResponse("Browser tool arguments must be an object", false);
  try {
    if (params.namespace === "vela_app" && params.tool === "open_in_vela") {
      return textResponse(await host.open(contextOf(hostId, params), argumentsValue));
    }
    if (params.namespace === "vela_browser" && params.tool === "get_tab_context") {
      return textResponse(await host.getTabContext(contextOf(hostId, params), argumentsValue));
    }
    if (params.namespace === "vela_browser" && params.tool === "browser_use") {
      const result = await host.browserUse(contextOf(hostId, params), argumentsValue);
      const image = record(result);
      if (image?.["screenshot"] === true && typeof image["imageUrl"] === "string")
        return { success: true, contentItems: [{ type: "inputImage", imageUrl: image["imageUrl"] }] };
      return textResponse(result);
    }
    return null;
  } catch (error) {
    return textResponse({
      code: error instanceof BrowserToolError ? error.code : "BROWSER_TOOL_FAILED",
      message: error instanceof Error ? error.message : String(error),
      retryable: error instanceof BrowserToolError ? error.retryable : false,
    }, false);
  }
}

export class BrowserToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "BrowserToolError";
  }
}

export function installBrowserDynamicToolHandler(
  client: Pick<AppServerClient, "interceptServerRequest">,
  host: BrowserDynamicToolHost,
  options: { readonly hostId: string },
): () => void {
  return client.interceptServerRequest(async (request, next) => {
    if (request.method !== "item/tool/call") return next();
    const params = request.params as DynamicToolCallParams;
    const result = await executeBrowserTool(host, options.hostId, params);
    return result ?? next();
  });
}
