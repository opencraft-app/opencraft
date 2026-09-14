import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  CodexAccountBoundListener,
  CodexAccountRecord,
} from "../types/account-config.ts";
import type {
  AppServerConnection,
  JsonRpcError,
  JsonRpcResponse,
} from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import { uuidV4 } from "./device-identity.ts";

type Dependencies =
  | "appServer"
  | "deviceIdentity"
  | "transparentAccountEvent"
  | "transparentControlRouting"
  | "userDirectory";

type BindingPhase =
  | "awaitingUser"
  | "bound"
  | "checking"
  | "failed"
  | "preparing"
  | "starting";

interface DeviceLoginResponse {
  type: "chatgptDeviceCode";
  verificationUrl: string;
  userCode: string;
}

interface BindingFlow {
  userId: string;
  username: string;
  phase: BindingPhase;
  startedAtMs: number;
  targets: Map<AppServerConnection, string>;
  response: DeviceLoginResponse | null;
  forceNew: boolean;
  previousAccount: CodexAccountRecord | null;
  stagingId: string | null;
}

interface AccountReadResult {
  account: CodexAccountRecord | null;
  requiresOpenaiAuth: boolean | undefined;
}

function accountLabel(account: CodexAccountRecord | null): string {
  if (!account) return "Codex account";
  if (account.type === "chatgpt") {
    const identity = account.email ? ` ${account.email}` : "";
    const plan = account.planType ? ` (${account.planType})` : "";
    return `ChatGPT${identity}${plan}`;
  }
  return account.type === "apiKey" ? "OpenAI API key" : `Codex ${account.type}`;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function accountRecord(value: unknown): CodexAccountRecord | null {
  const record = objectRecord(value);
  if (!record || typeof record["type"] !== "string") return null;
  return {
    type: record["type"],
    email: typeof record["email"] === "string" ? record["email"] : null,
    planType: typeof record["planType"] === "string" ? record["planType"] : null,
  };
}

function accountReadResult(value: unknown): AccountReadResult {
  const record = objectRecord(value);
  return record === null ? { account: null, requiresOpenaiAuth: undefined } : {
    account: accountRecord(record["account"]),
    requiresOpenaiAuth: typeof record["requiresOpenaiAuth"] === "boolean"
      ? record["requiresOpenaiAuth"]
      : undefined,
  };
}

function deviceLoginResponse(value: unknown): DeviceLoginResponse | null {
  const record = objectRecord(value);
  if (record?.["type"] !== "chatgptDeviceCode" ||
      typeof record["verificationUrl"] !== "string" ||
      typeof record["userCode"] !== "string") return null;
  return {
    type: "chatgptDeviceCode",
    verificationUrl: record["verificationUrl"],
    userCode: record["userCode"],
  };
}

function errorMessage(error: JsonRpcError | null | undefined): string {
  return error?.message ?? "未知错误";
}

export function deviceLoginPrompt(
  username: string,
  response: Pick<DeviceLoginResponse, "verificationUrl" | "userCode">,
): string {
  return [
    `请为 Hypernode 用户 **${username}** 绑定自己的 Codex 账户。`,
    "",
    `打开：${response.verificationUrl}`,
    "",
    `输入一次性验证码：**${response.userCode}**`,
    "",
    "完成后本页面会自动收到绑定结果。验证码不会写入管理会话历史或用户表。",
  ].join("\n");
}

export class CodexAccountBindingService extends Service {
  static inject = [
    "appServer",
    "deviceIdentity",
    "transparentAccountEvent",
    "transparentControlRouting",
    "userDirectory",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  private readonly flows = new Map<string, BindingFlow>();
  private readonly boundListeners = new Set<CodexAccountBoundListener>();

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "codexAccountBinding");
    ctx.effect(() => ctx.transparentAccountEvent.on(
      (userId, message) => this.onAccountEvent(userId, message),
    ));
    ctx.effect(() => ctx.appServer.register(
      "hypernode/accountBinding/read",
      (_params, connection) => ({
        ...ctx.deviceIdentity.read(connection.identity?.id),
        account: this.accountMetadata(connection.identity?.id),
        flow: this.publicFlow(connection.identity?.id),
      }),
    ));
  }

  onBound(listener: CodexAccountBoundListener): () => boolean {
    this.boundListeners.add(listener);
    return () => this.boundListeners.delete(listener);
  }

  emitBound(userId: string, account: CodexAccountRecord): void {
    for (const listener of this.boundListeners) listener(userId, account);
  }

  accountMetadata(userId: string | undefined): Record<string, unknown> | null {
    const user = userId ? this.ctx.userDirectory.find(userId) : null;
    if (!user) return null;
    return {
      authMode: user.codexAuthMode ?? null,
      email: user.codexAccountEmail ?? null,
      planType: user.codexPlanType ?? null,
      credentialRef: user.codexCredentialRef ?? null,
      boundAtMs: user.codexBoundAtMs ?? null,
      lastVerifiedAtMs: user.codexLastVerifiedAtMs ?? null,
    };
  }

  publicFlow(userId: string | undefined): { phase: BindingPhase; startedAtMs: number } | null {
    const flow = userId ? this.flows.get(userId) : undefined;
    return flow ? { phase: flow.phase, startedAtMs: flow.startedAtMs } : null;
  }

  begin(
    connection: AppServerConnection,
    threadId: string,
    options: { forceNew?: boolean } = {},
  ): string {
    const userId = connection.identity?.id;
    if (!userId) return "Codex 账户绑定只对已识别的 SSH 用户开放。";
    const user = this.ctx.userDirectory.find(userId);
    if (!user) return "当前 SSH 用户尚未注册到 Hypernode 用户目录。";

    let flow = this.flows.get(userId);
    if (flow && ["checking", "preparing", "starting", "awaitingUser"].includes(flow.phase)) {
      flow.targets.set(connection, threadId);
      if (flow.response) this.deliverPrompt(flow, connection, threadId);
      return "Codex 账户绑定流程已在进行；登录指引会显示在本管理会话中。";
    }

    flow = {
      userId,
      username: user.username,
      phase: "checking",
      startedAtMs: Date.now(),
      targets: new Map([[connection, threadId]]),
      response: null,
      forceNew: options.forceNew === true,
      previousAccount: null,
      stagingId: null,
    };
    this.flows.set(userId, flow);
    this.ctx.transparentControlRouting.requestUserBackend(
      connection,
      "account/read",
      { refreshToken: false },
      (error, result) => this.onAccountRead(flow, connection, error, result),
    );
    return flow.forceNew
      ? "正在保全当前 Codex 订阅，并准备绑定一个新的订阅槽位。"
      : "正在检查这个 SSH 用户的 Codex 账户。已有凭据会静默复用；仅在未绑定时显示设备登录指引。";
  }

  private onAccountRead(
    flow: BindingFlow,
    connection: AppServerConnection,
    error: JsonRpcError | null | undefined,
    value: unknown,
  ): void {
    if (this.flows.get(flow.userId) !== flow) return;
    if (error) {
      flow.phase = "failed";
      this.deliverToTargets(flow, `Codex 账户检查失败：${errorMessage(error)}`);
      return;
    }
    const result = accountReadResult(value);
    if (result.account) {
      this.emitBound(flow.userId, result.account);
      if (flow.forceNew) {
        flow.previousAccount = result.account;
        this.prepareNewLogin(flow, connection);
        return;
      }
      flow.phase = "bound";
      this.ctx.userDirectory.setCodexAccount(flow.userId, result.account);
      this.deliverToTargets(flow, `已绑定并复用 ${accountLabel(result.account)}，无需再次登录。`);
      return;
    }
    if (result.requiresOpenaiAuth === false) {
      flow.phase = "bound";
      this.ctx.userDirectory.setCodexAccount(flow.userId, null, { authMode: "managed" });
      this.deliverToTargets(flow, "当前 Codex 后端不要求 OpenAI 登录，已可直接使用。");
      return;
    }
    this.startLogin(flow, connection);
  }

  private prepareNewLogin(flow: BindingFlow, connection: AppServerConnection): void {
    flow.phase = "preparing";
    const stagingId = `login-${uuidV4()}`;
    const installationId = uuidV4();
    flow.stagingId = stagingId;
    try {
      this.ctx.transparentControlRouting.resetCodexControlBackend(flow.userId);
      hostIdentity.beginCodexAuthLogin(flow.username, stagingId, installationId);
      this.ctx.userDirectory.setInstallationId(flow.userId, installationId);
    } catch (error) {
      this.rollbackStagedLogin(flow);
      flow.phase = "failed";
      this.deliverToTargets(
        flow,
        `无法创建独立的 Codex 订阅槽位：${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    this.startLogin(flow, connection);
  }

  private startLogin(flow: BindingFlow, connection: AppServerConnection): void {
    flow.phase = "starting";
    this.ctx.userDirectory.setCodexBindingState(flow.userId, "pending");
    this.ctx.transparentControlRouting.requestUserBackend(
      connection,
      "account/login/start",
      { type: "chatgptDeviceCode" },
      (error, response) => this.onLoginStarted(flow, error, response),
    );
  }

  private onLoginStarted(
    flow: BindingFlow,
    error: JsonRpcError | null | undefined,
    value: unknown,
  ): void {
    if (this.flows.get(flow.userId) !== flow) return;
    if (error) {
      this.failLogin(flow);
      this.deliverToTargets(flow, `无法启动 Codex 设备登录：${errorMessage(error)}`);
      return;
    }
    const response = deviceLoginResponse(value);
    if (!response) {
      this.failLogin(flow);
      this.deliverToTargets(flow, "Codex 后端返回了不完整的设备登录响应。请稍后重试。");
      return;
    }
    flow.phase = "awaitingUser";
    flow.response = response;
    for (const [connection, threadId] of flow.targets) {
      this.deliverPrompt(flow, connection, threadId);
    }
  }

  private deliverPrompt(
    flow: BindingFlow,
    connection: AppServerConnection,
    threadId: string,
  ): void {
    if (!flow.response) return;
    this.ctx.userDirectory.deliverAgentMessage(connection, threadId, {
      deliveryText: deviceLoginPrompt(flow.username, flow.response),
      persistedText: `Hypernode 用户 ${flow.username} 已启动一次 Codex 设备绑定；一次性验证码未写入历史。`,
      sensitive: true,
    });
  }

  private deliverToTargets(flow: BindingFlow, text: string): void {
    for (const [connection, threadId] of flow.targets) {
      this.ctx.userDirectory.deliverAgentMessage(connection, threadId, {
        deliveryText: text,
        persistedText: text,
      });
    }
  }

  private rollbackStagedLogin(flow: BindingFlow): void {
    if (!flow.stagingId) return;
    this.ctx.transparentControlRouting.resetCodexControlBackend(flow.userId);
    try {
      const previousInstallationId = hostIdentity.rollbackCodexAuthLogin(
        flow.username,
        flow.stagingId,
      );
      this.ctx.userDirectory.setInstallationId(flow.userId, previousInstallationId);
      if (flow.previousAccount) {
        this.ctx.userDirectory.setCodexAccount(flow.userId, flow.previousAccount);
      }
    } catch (error) {
      console.error(
        `[codex-account-binding] rollback failed user=${flow.userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      flow.stagingId = null;
    }
  }

  private failLogin(flow: BindingFlow): void {
    this.rollbackStagedLogin(flow);
    flow.phase = "failed";
    if (!flow.previousAccount) {
      this.ctx.userDirectory.setCodexBindingState(flow.userId, "unbound");
    }
  }

  private onAccountEvent(userId: string, message: JsonRpcResponse): void {
    const params = objectRecord(message.params) ?? {};
    if (message.method === "account/updated") {
      this.ctx.userDirectory.setCodexAccount(userId, null, {
        authMode: typeof params["authMode"] === "string" ? params["authMode"] : null,
        planType: typeof params["planType"] === "string" ? params["planType"] : null,
      });
    }
    if (message.method !== "account/login/completed") return;
    const flow = this.flows.get(userId);
    if (params["success"] !== true) {
      if (flow) {
        this.failLogin(flow);
        const detail = typeof params["error"] === "string" ? params["error"] : "未知错误";
        this.deliverToTargets(flow, `Codex 账户绑定失败：${detail}`);
      } else {
        this.ctx.userDirectory.setCodexAccount(userId, null);
      }
      return;
    }
    if (!flow) return;
    const connection = flow.targets.keys().next().value;
    if (connection) {
      this.ctx.transparentControlRouting.requestUserBackend(
        connection,
        "account/read",
        { refreshToken: false },
        (error, resultValue) => {
          if (this.flows.get(userId) !== flow) return;
          if (error) {
            this.failLogin(flow);
            this.deliverToTargets(flow, `Codex 账户校验失败：${errorMessage(error)}`);
            return;
          }
          const account = accountReadResult(resultValue).account;
          if (!account) {
            this.failLogin(flow);
            this.deliverToTargets(flow, "Codex 登录已完成，但未能读取新账户；已恢复原账户。");
            return;
          }
          try {
            this.ctx.userDirectory.setCodexAccount(userId, account);
            this.emitBound(userId, account);
            if (flow.stagingId) {
              hostIdentity.commitCodexAuthLogin(flow.username, flow.stagingId);
              flow.stagingId = null;
            }
            flow.phase = "bound";
            this.deliverToTargets(
              flow,
              "Codex 账户绑定成功。该订阅已保存为独立凭据与设备身份；原账户保持登录。",
            );
          } catch (captureError) {
            this.failLogin(flow);
            this.deliverToTargets(
              flow,
              `Codex 账户保存失败：${
                captureError instanceof Error ? captureError.message : String(captureError)
              }`,
            );
          }
        },
      );
    }
  }
}
