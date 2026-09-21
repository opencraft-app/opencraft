import type { AppServerClient } from "@opencraft/appserver-client";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec,
} from "@opencraft/appserver-protocol/generated/v2";

import type { ConversationTerminalSessionRegistry } from "./conversation-terminal";

export const READ_THREAD_TERMINAL_TOOL_NAME = "read_thread_terminal";

export const OPENCRAFT_TERMINAL_DYNAMIC_TOOLS: readonly DynamicToolSpec[] = Object.freeze([{
  type: "function",
  name: READ_THREAD_TERMINAL_TOOL_NAME,
  description: "Read the current in-app terminal output for this conversation. This tool takes no arguments.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  }),
}]);

export interface ConversationTerminalToolContext {
  readonly hostId: string;
  readonly threadId: string;
}

export interface ConversationTerminalToolHost {
  readCurrent(context: ConversationTerminalToolContext): unknown | Promise<unknown>;
}

export class RegistryConversationTerminalToolHost implements ConversationTerminalToolHost {
  constructor(
    private readonly terminals: ConversationTerminalSessionRegistry,
    private readonly resolveOwner: (context: ConversationTerminalToolContext) => string | null,
  ) {}

  readCurrent(context: ConversationTerminalToolContext): unknown {
    const ownerId = this.resolveOwner(context);
    if (ownerId === null) throw new Error("No active OpenCraft conversation is bound to this Thread.");
    const snapshot = this.terminals.getSnapshotForConversation(ownerId);
    if (snapshot === null) throw new Error("No in-app terminal session is attached to this conversation yet.");
    return [
      "In-app terminal snapshot for this conversation:",
      `cwd: ${snapshot.cwd}`,
      `shell: ${snapshot.shell}`,
      `status: ${snapshot.phase}`,
      snapshot.truncated ? "note: output is truncated to the latest terminal buffer kept by the app." : null,
      "```text",
      snapshot.buffer.length > 0 ? snapshot.buffer : "[terminal has no output yet]",
      "```",
    ].filter((line) => line !== null).join("\n");
  }
}

function response(text: string, success: boolean): DynamicToolCallResponse {
  return { success, contentItems: [{ type: "inputText", text }] };
}

function hasNoArguments(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 0;
}

export function installConversationTerminalDynamicToolHandler(
  client: Pick<AppServerClient, "interceptServerRequest">,
  host: ConversationTerminalToolHost,
  options: { readonly hostId: string },
): () => void {
  return client.interceptServerRequest(async (request, next) => {
    if (request.method !== "item/tool/call") return next();
    const params = request.params as DynamicToolCallParams;
    if (params.namespace !== null || params.tool !== READ_THREAD_TERMINAL_TOOL_NAME) return next();
    if (!hasNoArguments(params.arguments)) {
      return response(`${READ_THREAD_TERMINAL_TOOL_NAME} takes no arguments.`, false);
    }
    try {
      const value = await host.readCurrent({
        hostId: options.hostId,
        threadId: params.threadId,
      });
      return response(typeof value === "string" ? value : JSON.stringify(value), true);
    } catch (error) {
      return response(error instanceof Error ? error.message : String(error), false);
    }
  });
}
