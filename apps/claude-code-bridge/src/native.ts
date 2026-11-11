import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeCodeExecutable } from "./executable.js";
import { InputQueue } from "./input-queue.js";
import type {
  InterruptReceipt,
  ModelRow,
  NativeFactory,
  NativeInitInfo,
  NativeSessionPort,
  NativeStartOptions,
  PermissionModeName,
} from "./types.js";

/**
 * Real Agent SDK adapter. The SDK owns the Claude Code process; this module
 * only translates its narrow lifecycle (input stream, interrupt, initialize,
 * message iterator) into the bridge's native port. It never parses protocol
 * frames or assembles client events.
 */
function createClaudeSdkSession(options: NativeStartOptions): NativeSessionPort {
  const input = new InputQueue<SDKUserMessage>();
  // The CLI is owned by the launch environment, never by command-supplied
  // session env. Initialize probes and sessions both enter here, and the SDK
  // must receive that path so it does not run its bundled binary.
  const executable = resolveClaudeCodeExecutable({ explicit: options.executable });
  const sdkQuery = query({
    prompt: input,
    options: {
      sessionId: options.sessionId as `${string}-${string}-${string}-${string}-${string}`,
      cwd: options.cwd,
      includePartialMessages: false,
      // Ask the CLI to replay accepted user messages with their client UUID so
      // the bridge can prove a steer entered the native transcript path.
      extraArgs: { "replay-user-messages": null },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(options.systemPromptAppend ? { append: options.systemPromptAppend } : {}),
      },
      ...(options.model ? { model: options.model } : {}),
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
      ...(options.permissionMode === "bypassPermissions" && options.allowDangerouslySkipPermissions
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(options.allowedTools ? { allowedTools: [...options.allowedTools] } : {}),
      ...(options.disallowedTools ? { disallowedTools: [...options.disallowedTools] } : {}),
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      pathToClaudeCodeExecutable: executable,
      env: { ...process.env, ...(options.env ?? {}) } as Record<string, string>,
    },
  });
  let initialized: Promise<NativeInitInfo> | undefined;
  const initialize = (): Promise<NativeInitInfo> => initialized ??= sdkQuery.initializationResult().then((result) => {
    // The SDK's published type omits several fields the CLI actually returns;
    // read them at the boundary and narrow instead of version-sniffing.
    const raw = result as unknown as Record<string, unknown>;
    const models: ModelRow[] = (result.models ?? []).map((model) => ({
      id: model.value,
      name: model.displayName,
      description: model.description,
      ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
    }));
    const capabilities = Array.isArray(raw.capabilities)
      ? raw.capabilities.filter((entry): entry is string => typeof entry === "string")
      : [];
    const requested = options.model;
    const selected = requested === undefined
      ? result.models?.[0]
      : result.models?.find((model) => model.value === requested || model.resolvedModel === requested);
    return {
      sessionId: options.sessionId,
      version: typeof raw.claude_code_version === "string" ? raw.claude_code_version : "unknown",
      model: selected?.resolvedModel ?? selected?.value ?? requested ?? "unknown",
      permissionMode: typeof raw.current_permission_mode === "string" ? raw.current_permission_mode : null,
      models,
      capabilities,
      pid: typeof raw.pid === "number" ? raw.pid : null,
    };
  });
  return {
    messages: sdkQuery,
    initialize,
    push: (text, uuid) => input.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      uuid: uuid as `${string}-${string}-${string}-${string}-${string}`,
      origin: { kind: "human" },
    }, uuid),
    failInput: (error) => { input.close(error); },
    withdraw: (uuid) => input.withdraw(uuid),
    interrupt: async (): Promise<InterruptReceipt> => {
      // The published SDK type omits the runtime's cancelQueued option. Passing
      // it makes Stop cancel queued user commands when the CLI advertises
      // interrupt_cancel_queued_v1; older CLIs ignore the field.
      const interrupt = sdkQuery.interrupt as unknown as (options?: { cancelQueued?: boolean }) => Promise<{
        still_queued?: unknown;
        cancelled?: unknown;
      } | undefined>;
      const receipt = await interrupt({ cancelQueued: true });
      const list = (value: unknown): string[] => Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
      return { stillQueued: list(receipt?.still_queued), cancelled: list(receipt?.cancelled) };
    },
    close: async () => { input.close(); sdkQuery.close(); },
    setModel: async (model: string) => { await sdkQuery.setModel(model); },
    setPermissionMode: async (mode: PermissionModeName) => { await sdkQuery.setPermissionMode(mode); },
  };
}

/** The real factory used by the bridge process entrypoint. */
export const claudeSdkFactory: NativeFactory = {
  start(options: NativeStartOptions): NativeSessionPort {
    return createClaudeSdkSession(options);
  },
};

export function sessionIdForNewNative(): string {
  return randomUUID();
}
