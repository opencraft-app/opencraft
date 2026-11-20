/** Tool definitions are platform data; wire adapters choose their envelope. */
export type BrowserToolJsonValue = string | number | boolean | null
  | BrowserToolJsonValue[] | { [key: string]: BrowserToolJsonValue };

export interface BrowserToolDefinition {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, BrowserToolJsonValue>>;
}
export interface BrowserToolNamespace {
  readonly type: "namespace";
  readonly name: string;
  readonly description: string;
  readonly tools: readonly BrowserToolDefinition[];
}

export const OPENCRAFT_BROWSER_EXTENSION = "opencraft/browser-use";

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
    visible: { type: "boolean", default: false, description: "Defaults to background without taking focus. Explicit true presents the tab in an active Workbench and waits for its foreground acknowledgement." },
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

export const BROWSER_TOOL_CATALOG: readonly BrowserToolNamespace[] = Object.freeze([
  {
    type: "namespace",
    name: "opencraft_app",
    description: "OpenCraft application presentation tools.",
    tools: [{
      type: "function",
      name: "open_in_opencraft",
      description: "Create or recover a browser page in OpenCraft. Defaults to background; visible=true requests foreground presentation and waits for acknowledgement. This does not inspect or verify the page.",
      inputSchema: openInOpenCraftSchema,
    }],
  },
  {
    type: "namespace",
    name: "opencraft_browser",
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
