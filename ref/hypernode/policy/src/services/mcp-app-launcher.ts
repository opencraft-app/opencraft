import { Service, type Inject } from "@deepseek-ai/cordis";
import type { AppServerConnection } from "../types/appserver.ts";
import type { CanonicalItem } from "../types/canonical-timeline.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  McpAppLaunchRequest,
  McpRegistryPort,
  McpToolCallResult,
  PendingMcpToolCall,
} from "../types/mcp.ts";
import {
  CALCULATOR_RESOURCE_URI,
  CALCULATOR_SERVER_NAME,
} from "./calculator.ts";
import {
  THREAD_PRIVACY_RESOURCE_URI,
  THREAD_PRIVACY_SERVER_NAME,
} from "./thread-privacy.ts";
import {
  SESSION_STATUS_RESOURCE_URI,
  SESSION_STATUS_SERVER_NAME,
} from "./session-status.ts";
import {
  CODEX_ACCOUNTS_RESOURCE_URI,
  CODEX_ACCOUNTS_SERVER_NAME,
  USERS_RESOURCE_URI,
  USERS_SERVER_NAME,
} from "./management-catalog-apps.ts";
import { uuidV7 } from "./thread-identity.ts";

type Dependencies = "virtualSkills";

export interface McpToolCallItem extends CanonicalItem {
  id: string;
  type: "mcpToolCall";
  server: string;
  tool: string;
  arguments: unknown;
  status: "inProgress" | "completed" | "failed";
  result: McpToolCallResult | null;
  error: { message: string } | null;
  durationMs: number | null;
  pluginId: string | null;
  readOnlyHint: boolean | null;
  mcpAppResourceUri: string | null;
  appContext: {
    connectorId: string;
    appName: string | null;
    actionName: string | null;
    resourceUri: string | null;
    linkId: string | null;
  };
}

interface McpToolCallBase {
  id: string;
  type: "mcpToolCall";
  server: string;
  tool: string;
  arguments: unknown;
  pluginId: string | null;
  readOnlyHint: boolean | null;
  mcpAppResourceUri: string | null;
  appContext: McpToolCallItem["appContext"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMcpAppLaunchRequest(value: unknown): value is McpAppLaunchRequest {
  return isRecord(value) && value["kind"] === "mcpAppLaunch" &&
    typeof value["server"] === "string" && value["server"].length > 0 &&
    typeof value["tool"] === "string" && value["tool"].length > 0 &&
    typeof value["resourceUri"] === "string" && value["resourceUri"].startsWith("ui://");
}

function baseItem(request: McpAppLaunchRequest, id: string): McpToolCallBase {
  return {
    id,
    type: "mcpToolCall",
    server: request.server,
    tool: request.tool,
    arguments: request.arguments,
    pluginId: request.pluginId ?? null,
    readOnlyHint: request.readOnlyHint ?? null,
    mcpAppResourceUri: request.resourceUri,
    appContext: {
      connectorId: request.server,
      appName: request.appName ?? null,
      actionName: request.actionName ?? null,
      resourceUri: request.resourceUri,
      linkId: null,
    },
  };
}

export function projectMcpAppLaunch(
  request: McpAppLaunchRequest,
  result: McpToolCallResult,
  durationMs: number,
  id = uuidV7(),
): { started: McpToolCallItem; completed: McpToolCallItem } {
  const base = baseItem(request, id);
  return {
    started: {
      ...base,
      status: "inProgress",
      result: null,
      error: null,
      durationMs: null,
    },
    completed: {
      ...base,
      status: "completed",
      result,
      error: null,
      durationMs: Math.max(0, durationMs),
    },
  };
}

function pendingToolCall(
  value: McpToolCallResult | PendingMcpToolCall,
): value is PendingMcpToolCall {
  return "kind" in value && value.kind === "pending";
}

export function executeMcpAppLaunch(
  registry: Pick<McpRegistryPort, "callTool">,
  request: McpAppLaunchRequest,
  connection: AppServerConnection,
  threadId: string,
  itemId = uuidV7(),
): { started: McpToolCallItem; completed: McpToolCallItem } {
  const startedAtMs = Date.now();
  const result = registry.callTool({
    server: request.server,
    tool: request.tool,
    threadId,
    arguments: request.arguments,
    meta: { source: "hypernode-virtual-skill" },
  }, connection);
  if (pendingToolCall(result)) {
    result.cancel?.();
    throw new Error("MCP App launch tools must complete synchronously");
  }
  if (result.isError === true) throw new Error("MCP App launch tool returned an error");
  return projectMcpAppLaunch(request, result, Date.now() - startedAtMs, itemId);
}

export function calculatorLaunchRequest(): McpAppLaunchRequest {
  return {
    kind: "mcpAppLaunch",
    server: CALCULATOR_SERVER_NAME,
    tool: "calculator.compute",
    arguments: { expression: "0" },
    resourceUri: CALCULATOR_RESOURCE_URI,
    pluginId: "hypernode-control",
    appName: "HyperNode 计算器",
    actionName: "打开计算器",
    readOnlyHint: true,
  };
}

export function threadPrivacyLaunchRequest(preferredThreadId?: string | null): McpAppLaunchRequest {
  return {
    kind: "mcpAppLaunch",
    server: THREAD_PRIVACY_SERVER_NAME,
    tool: "threadPrivacy.list",
    arguments: preferredThreadId ? { preferredThreadId } : {},
    resourceUri: THREAD_PRIVACY_RESOURCE_URI,
    pluginId: "hypernode-control",
    appName: "设置可见性",
    actionName: "设置会话可见性",
    readOnlyHint: true,
  };
}

export function sessionStatusLaunchRequest(): McpAppLaunchRequest {
  return {
    kind: "mcpAppLaunch",
    server: SESSION_STATUS_SERVER_NAME,
    tool: "sessionStatus.get",
    arguments: {},
    resourceUri: SESSION_STATUS_RESOURCE_URI,
    pluginId: "hypernode-control",
    appName: "当前会话状态",
    actionName: "查看会话状态",
    readOnlyHint: true,
  };
}

export function usersLaunchRequest(): McpAppLaunchRequest {
  return {
    kind: "mcpAppLaunch",
    server: USERS_SERVER_NAME,
    tool: "users.list",
    arguments: {},
    resourceUri: USERS_RESOURCE_URI,
    pluginId: "hypernode-control",
    appName: "用户列表",
    actionName: "查看用户列表",
    readOnlyHint: true,
  };
}

export function codexAccountsLaunchRequest(): McpAppLaunchRequest {
  return {
    kind: "mcpAppLaunch",
    server: CODEX_ACCOUNTS_SERVER_NAME,
    tool: "codexAccounts.list",
    arguments: {},
    resourceUri: CODEX_ACCOUNTS_RESOURCE_URI,
    pluginId: "hypernode-control",
    appName: "Codex 账户",
    actionName: "查看 Codex 绑定",
    readOnlyHint: true,
  };
}

export function sharedCodexLaunchRequest(): McpAppLaunchRequest {
  return {
    kind: "mcpAppLaunch",
    server: CODEX_ACCOUNTS_SERVER_NAME,
    tool: "codexAccounts.list",
    arguments: { mode: "shared" },
    resourceUri: CODEX_ACCOUNTS_RESOURCE_URI,
    pluginId: "hypernode-control",
    appName: "共享 Codex",
    actionName: "选择共享 Codex 订阅",
    readOnlyHint: true,
  };
}

export class McpAppLauncherService extends Service {
  static inject = ["virtualSkills"] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "mcpAppLauncher");
    ctx.effect(() => ctx.virtualSkills.register({
      name: "users",
      aliases: ["user-list", "members"],
      description: "打开交互式用户列表，查看 SSH 用户、登录信息与 Codex 绑定状态。",
      displayName: "用户列表",
      shortDescription: "查看 SSH 用户、登录信息与 Codex 绑定状态",
      defaultPrompt: "查看用户列表",
      run: usersLaunchRequest,
    }));
    ctx.effect(() => ctx.virtualSkills.register({
      name: "accounts",
      aliases: ["account-list", "list-accounts"],
      description: "打开交互式账户列表，查看当前可见的 Codex 绑定与订阅槽位。",
      displayName: "Codex 账户",
      shortDescription: "查看 Codex 账户绑定与订阅槽位",
      defaultPrompt: "查看 Codex 账户",
      run: codexAccountsLaunchRequest,
    }));
    ctx.effect(() => ctx.virtualSkills.register({
      name: "shared-codex",
      aliases: ["codex-share", "public-codex", "共享Codex"],
      description: "打开节点共享 Codex 选择器，使用其他成员公开的原生 Codex 订阅槽位。",
      displayName: "共享 Codex",
      shortDescription: "查看并切换节点成员公开的 Codex 订阅",
      defaultPrompt: "选择共享 Codex 订阅",
      run: sharedCodexLaunchRequest,
    }));
    ctx.effect(() => ctx.virtualSkills.register({
      name: "calculator",
      aliases: ["calc", "currency-converter", "fx-calculator"],
      description: "打开 HyperNode 计算器，并按招商银行实时牌价换算人民币与港币。",
      displayName: "HyperNode 计算器",
      shortDescription: "计算算式并按实时牌价换算人民币与港币",
      defaultPrompt: "打开 HyperNode 计算器",
      run: calculatorLaunchRequest,
    }));
    ctx.effect(() => ctx.virtualSkills.register({
      name: "set-visibility",
      aliases: [
        "private-thread", "thread-privacy", "make-private", "private-conversation",
        "thread-visibility", "share-thread", "make-shared", "public-thread", "visibility",
      ],
      description: "打开仅限会话创建者操作的 MCP App，将会话设为私有或节点公开。",
      displayName: "设置可见性",
      shortDescription: "将自己的会话设为私有或节点公开",
      defaultPrompt: "设置会话可见性",
      run: (_input, invocation) => threadPrivacyLaunchRequest(invocation.threadId),
    }));
    ctx.effect(() => ctx.virtualSkills.register({
      name: "session-status",
      aliases: ["current-session", "thread-status", "engine-status", "model-status"],
      description: "打开只读 MCP App，查看当前会话的引擎、模型、运行状态与 Codex 账户。",
      displayName: "当前会话状态",
      shortDescription: "查看当前引擎、模型与 Codex 账户",
      defaultPrompt: "查看当前会话状态",
      run: sessionStatusLaunchRequest,
    }));
  }
}
