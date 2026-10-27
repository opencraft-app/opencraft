import { boundedJson, externalUrl, record, textContent, type McpAppIdentity, type McpAppPort } from "./contract";

export interface BridgeOptions {
  readonly identity: McpAppIdentity;
  readonly port: McpAppPort;
  readonly contextId: string;
  readonly hostContext: () => Record<string, unknown>;
  readonly input: () => unknown;
  readonly output: () => unknown;
  readonly status?: () => string;
  readonly onHeight: (height: number) => void;
  readonly onWidgetState: (state: unknown) => void;
  readonly onLog?: (level: string, message: string) => void;
}
/** A view owns a bounded request set; disposal fences late results without retrying writes. */
export function createAppBridge(options: BridgeOptions) {
  let disposed = false;
  let initialized = false;
  let initializedNotification = false;
  const requests = new Set<string | number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const rejectors = new Set<(error: Error) => void>();
  const assertCurrent = () => {
    if (disposed) throw new Error("App view is closed");
    options.port.assertCurrent();
  };
  const notify = (send: (data: unknown) => void, method: string, params: unknown) => send({ jsonrpc: "2.0", method, params });
  const toolEvents = (send: (data: unknown) => void) => {
    const status = options.status?.();
    if (status === "interrupted") { notify(send, "ui/notifications/tool-cancelled", { reason: "Tool interrupted" }); return; }
    notify(send, status === "pending" || status === "running" ? "ui/notifications/tool-input-partial" : "ui/notifications/tool-input", { arguments: record(options.input()) });
    const output = options.output();
    if (output != null) notify(send, "ui/notifications/tool-result", output);
  };
  async function dispatch(method: string, params: Record<string, unknown>, legacy: boolean, check: () => void) {
    check();
    if (method === "ui/initialize") {
      if (typeof params.protocolVersion !== "string" || typeof record(params.appInfo).name !== "string") throw new Error("Invalid initialization");
      initialized = true;
      return { protocolVersion: "2026-01-26", hostInfo: { name: "OpenCraft", version: "1.0.0" },
        hostCapabilities: { serverTools: {}, serverResources: {}, openLinks: {}, logging: {}, message: { text: {} }, updateModelContext: { text: {} } },
        hostContext: options.hostContext() };
    }
    if (!legacy && !initialized) throw new Error("Initialize the App first");
    switch (method) {
      case "tools/list": return { tools: Object.values(await options.port.listTools(options.identity.server, options.identity.uri)) };
      case "tools/call": {
        if (typeof params.name !== "string" || (params.arguments !== undefined && (params.arguments === null || Array.isArray(params.arguments) || typeof params.arguments !== "object"))) throw new Error("Invalid tool call");
        const tools = await options.port.listTools(options.identity.server, options.identity.uri);
        check();
        const tool = record(tools[params.name]);
        const visibility = record(record(tool._meta).ui).visibility;
        if (!Object.prototype.hasOwnProperty.call(tools, params.name)
          || (Array.isArray(visibility) && visibility.includes("model") && !visibility.includes("app"))) throw new Error("Tool is not available to this App");
        return options.port.callTool(options.identity.server, params.name, record(params.arguments), options.identity.uri);
      }
      case "resources/read": {
        if (typeof params.uri !== "string" || params.uri !== options.identity.uri) throw new Error("Resource is outside this App");
        return options.port.readResource(options.identity.server, params.uri, options.identity.callId);
      }
      case "ui/message": {
        if (params.role !== "user") throw new Error("Only user messages are supported");
        const text = textContent(params.content);
        if (!text.trim()) throw new Error("Empty App message");
        await options.port.sendMessage(text); return {};
      }
      case "ui/update-model-context": {
        const text = params.content === undefined ? "" : textContent(params.content);
        if (params.structuredContent !== undefined && (params.structuredContent === null || Array.isArray(params.structuredContent) || typeof params.structuredContent !== "object")) throw new Error("Invalid structured context");
        const structured = params.structuredContent === undefined ? "" : boundedJson(params.structuredContent, 32768);
        options.port.updateContext(options.contextId, [text, structured].filter(Boolean).join("\n") || null); return {};
      }
      case "ui/open-link": options.port.openLink(externalUrl(params.url)); return {};
      case "ui/request-display-mode": return { mode: "inline" };
      case "opencraft/widget-state": options.onWidgetState(JSON.parse(boundedJson(params.state, 32768))); return {};
      case "ping": return {};
      default: throw Object.assign(new Error(`Unsupported App method: ${method}`), { code: -32601 });
    }
  }
  return {
    async receive(value: unknown, send: (data: unknown) => void, legacy = false): Promise<void> {
      if (disposed) return;
      const message = record(value);
      if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
      const params = record(message.params);
      const id = message.id;
      if (id === undefined) {
        try {
          assertCurrent();
          if (message.method === "ui/notifications/initialized" && initialized) { initializedNotification = true; toolEvents(send); }
          if (message.method === "ui/notifications/size-changed" && (legacy || initialized)) {
            if (typeof params.height === "number" && Number.isFinite(params.height)) options.onHeight(Math.min(1600, Math.max(80, params.height)));
          }
          if (message.method === "notifications/message" && initialized) options.onLog?.(String(params.level ?? "info"), boundedJson(params.data ?? null, 4096));
        } catch { /* Invalid notifications cannot mutate the host. */ }
        return;
      }
      if (!(typeof id === "string" || typeof id === "number") || requests.has(id)) return;
      if (requests.size >= 16) { send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Too many App requests" } }); return; }
      requests.add(id);
      let active = true;
      const check = () => { assertCurrent(); if (!active) throw new Error("App request expired"); };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectPending: ((error: Error) => void) | undefined;
      try {
        boundedJson(message);
        const timeout = new Promise<never>((_, reject) => {
          rejectPending = reject; rejectors.add(reject);
          timer = setTimeout(() => { active = false; reject(new Error("App request timed out")); }, 30000); timers.add(timer);
        });
        const result = await Promise.race([dispatch(message.method, params, legacy, check), timeout]);
        assertCurrent();
        boundedJson(result, 1048576);
        send({ jsonrpc: "2.0", id, result });
      } catch (error) {
        if (!disposed) send({ jsonrpc: "2.0", id, error: { code: Number(record(error).code) || -32602, message: error instanceof Error ? error.message : "App request failed" } });
      } finally {
        active = false; requests.delete(id);
        if (timer !== undefined) { clearTimeout(timer); timers.delete(timer); }
        if (rejectPending) rejectors.delete(rejectPending);
      }
    },
    update(send: (data: unknown) => void) {
      if (disposed || !initializedNotification) return;
      try { assertCurrent(); notify(send, "ui/notifications/host-context-changed", options.hostContext()); } catch { /* Old views stay inert. */ }
    },
    updateTool(send: (data: unknown) => void) {
      if (disposed || !initializedNotification) return;
      try { assertCurrent(); toolEvents(send); } catch { /* Old views stay inert. */ }
    },
    dispose() {
      disposed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const reject of rejectors) reject(new Error("App view is closed"));
      rejectors.clear(); requests.clear();
    },
  };
}
