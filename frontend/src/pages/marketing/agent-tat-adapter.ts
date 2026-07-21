/**
 * tea-sdk-lightclaw 产品配置扩展 —— 通过 mono ctl 的 debug/exec 接口执行命令
 *
 * ## 背景
 *
 * SDK 默认走腾讯云 TAT OpenAPI（`sandboxAdapter.ExecCommand`）执行脚本。
 * 但 mono 的存量业务（channel 配置、onboard、debug 排错等）都**刻意绕开**
 * TAT，统一走沙箱内置的 **envd process stream**：
 *   - 直连 sandbox agent，延迟毫秒级（vs TAT 秒级轮询）
 *   - 支持流式 stdout/stderr（vs TAT 只能轮询 Output 字段）
 *   - 不占腾讯云配额，不受云侧 QPS 限制
 *
 * 后端已经暴露了一个通用入口：
 *
 *   POST /v1/instances/:botId/debug/exec    body: { command: string }
 *
 * 后端内部自动：
 *   1. 查出该 bot 对应的 sandbox 与 cloud instance
 *   2. 走 envd process stream 执行命令
 *   3. 等命令结束后一次性返回 `{ status, exit_code, output, invocation_id, ... }`
 *
 * 本适配器把 SDK 的 TAT 语义桥接到 debug/exec：
 *
 * | SDK 约定 (TAT)                             | mono debug/exec         |
 * |-------------------------------------------|-------------------------|
 * | `Content` 为 Base64 编码                   | `command` 为明文        |
 * | `InstanceIds[0]` 为 cloud InstanceId      | path param 用 botId     |
 * | `RegionId` 选择 TAT endpoint               | 忽略                    |
 * | 异步：先 RunCommand 拿 InvocationId，再轮询 | 同步：一次返回最终结果   |
 * | 返回 `TaskResult.Output` 为 Base64         | 返回 `output` 为明文    |
 *
 * 实现上，因为 debug/exec 是同步接口，`runCommand` 调用时其实命令已经
 * 执行完毕，我们把结果缓存到一个临时 Map，然后返回一个合成 invocationId；
 * 后续 SDK 调 `getInvocationTask` 时直接从缓存取走结果、立即返回 Final 状态，
 * 避免 SDK 的默认轮询行为浪费时间。
 */

import type { IProductConfig } from "@tencent/tea-sdk-lightclaw";

/**
 * UTF-8 安全的 Base64 编解码。
 *
 * 浏览器原生 `btoa`/`atob` 只处理 latin1 字节。要支持中文/emoji，
 * 必须先用 TextEncoder/TextDecoder 在字符串与 UTF-8 字节间转换。
 */
const b64 = {
  encode(utf8Text: string): string {
    const bytes = new TextEncoder().encode(utf8Text);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]!);
    }
    return btoa(binary);
  },
  decode(base64: string): string {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  },
};

/** SDK 的 runCommand 入参形状（与 IRunCommandParams 同形） */
type RunCommandRequest = {
  RegionId: number;
  InstanceIds: string[];
  SaveCommand: boolean;
  CommandType: string;
  Content: string;
  Timeout: number;
};

/** mono ctl `/v1/instances/:botId/debug/exec` 成功响应的 `data` 字段 */
interface DebugExecPayload {
  status: string;
  exit_code: number;
  output: string;
  invocation_id?: string;
  command_id?: string;
  start_time?: string;
  end_time?: string;
}

/** 后端统一 envelope 结构 */
interface ApiEnvelope<T> {
  code?: number | string;
  data: T;
  message?: string;
}

/**
 * 合成 invocationId 对应的缓存结果：
 *
 * - `runCommand` 执行完命令后，把命令结果（含 Base64 编码过的 output）放进缓存
 * - `getInvocationTask` 通过 invocationId 取出
 */
interface CachedInvocationResult {
  /** 归一化后的大写状态（SUCCESS / FAILED / TIMEOUT …） */
  status: string;
  /** 已经 Base64 编码的 output（对应 SDK 期望的 TaskResult.Output） */
  base64Output: string;
}

export interface CreateMonoDebugExecAdapterOptions {
  /**
   * 后端地址前缀。通常来自 `resolveConfiguredAuthApiBaseUrl()`，
   * 例如：`https://api.lightclaw.tech`。末尾斜杠可有可无。
   */
  baseUrl: string;
  /**
   * 返回调用所需的鉴权头。mono 的 `/v1/instances/...` 接口要求
   * `Authorization: Bearer <jwt>`；调用方通常把 `readStoredAuthToken()`
   * 的结果包一层再传进来。
   */
  getAuthHeader?: () => string | null | undefined;
  /** 可选命令生命周期；用于宿主在执行特定命令前确认、成功后做关联更新。 */
  commandLifecycle?: DebugExecCommandLifecycle;
}

export interface DebugExecCommandContext {
  botId: string;
  command: string;
}

export interface DebugExecCommandResult {
  status: string;
  exitCode: number;
  output: string;
}

export interface DebugExecCommandLifecycle {
  beforeExecute?: (context: DebugExecCommandContext) => Promise<unknown>;
  afterExecute?: (context: DebugExecCommandContext & {
    metadata: unknown;
    result: DebugExecCommandResult;
  }) => Promise<void>;
}

/** 归一化命令状态：mono 可能返回 SUCCESS/Succeeded/success 等不同大小写 */
function normalizeStatus(raw: string | undefined): string {
  return (raw || "").trim().toUpperCase();
}

/** 构造绝对 URL（处理 baseUrl 末尾斜杠） */
function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

/**
 * 构造 SDK 命令执行适配器。返回的对象可以直接展开到 `IProductConfig`：
 *
 * ```ts
 * const adapter = createMonoDebugExecAdapter({
 *   baseUrl: resolveConfiguredAuthApiBaseUrl() ?? "",
 *   getAuthHeader: () => {
 *     const token = readStoredAuthToken();
 *     return token ? `Bearer ${token}` : undefined;
 *   },
 * });
 * const sdkProductConfig = {
 *   ...createLighthouseConfig(),
 *   runCommand: adapter.runCommand,
 *   getInvocationTask: adapter.getInvocationTask,
 * };
 * ```
 *
 * 配合页面把 `activeBot.id` 作为 `instance.InstanceId` 传给 SDK，
 * 适配器即可从 `InstanceIds[0]` 直接取到 botId 并拼出后端路径。
 */
export function createMonoDebugExecAdapter(
  options: CreateMonoDebugExecAdapterOptions,
): Pick<Required<IProductConfig>, "runCommand" | "getInvocationTask"> {
  const { baseUrl, commandLifecycle, getAuthHeader } = options;

  /**
   * invocationId → 命令结果缓存。
   *
   * `runCommand` 在同步等到命令执行完毕后，把结果放入缓存并返回一个
   * invocationId；`getInvocationTask` 通过 invocationId 取走结果、
   * 删除缓存，避免内存泄漏。
   */
  const resultCache = new Map<string, CachedInvocationResult>();

  async function postDebugExec(botId: string, command: string): Promise<DebugExecPayload> {
    const headers = new Headers({ "Content-Type": "application/json" });
    const authHeader = getAuthHeader?.();
    if (authHeader) headers.set("Authorization", authHeader);

    const resp = await fetch(
      joinUrl(baseUrl, `/v1/instances/${encodeURIComponent(botId)}/debug/exec`),
      {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ command, "run_as_user": "agentuser" }),
      },
    );

    if (!resp.ok) {
      // 尝试读取后端错误 envelope
      let detail = "";
      try {
        const errBody = (await resp.json()) as { message?: string; error?: string };
        detail = errBody?.message ?? errBody?.error ?? "";
      } catch {
        // ignore
      }
      throw new Error(
        `[debug-exec-adapter] POST /v1/instances/${botId}/debug/exec failed (${resp.status})${detail ? `: ${detail}` : ""
        }`,
      );
    }

    const envelope = (await resp.json()) as ApiEnvelope<DebugExecPayload>;
    if (!envelope || typeof envelope !== "object" || !envelope.data) {
      throw new Error("[debug-exec-adapter] response missing envelope.data");
    }
    return envelope.data;
  }

  /**
   * SSE 流式执行命令。
   *
   * 当 SDK 的 runWithProgress 需要实时输出时（如扫码生成二维码），
   * 用 `Accept: text/event-stream` 请求后端，实时接收 stdout chunk，
   * 每收到一条就回调 onProgress（传 Base64 编码的累积输出，与 TAT 模式语义一致）。
   * 命令结束后返回最终结果。
   */
  async function postDebugExecStream(
    botId: string,
    command: string,
    onProgress: (base64Output: string) => void,
  ): Promise<DebugExecPayload> {
    const headers = new Headers({
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    });
    const authHeader = getAuthHeader?.();
    if (authHeader) headers.set("Authorization", authHeader);

    const resp = await fetch(
      joinUrl(baseUrl, `/v1/instances/${encodeURIComponent(botId)}/debug/exec`),
      {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ command, "run_as_user": "agentuser" }),
      },
    );

    if (!resp.ok) {
      let detail = "";
      try {
        const errBody = (await resp.json()) as { message?: string; error?: string };
        detail = errBody?.message ?? errBody?.error ?? "";
      } catch { /* ignore */ }
      throw new Error(
        `[debug-exec-adapter] SSE /v1/instances/${botId}/debug/exec failed (${resp.status})${detail ? `: ${detail}` : ""}`,
      );
    }

    // 读取 SSE 流
    const reader = resp.body?.getReader();
    if (!reader) throw new Error("[debug-exec-adapter] response body is not readable");

    const decoder = new TextDecoder();
    let accumulatedOutput = "";
    let finalPayload: DebugExecPayload | null = null;
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // 按双换行分割 SSE 事件
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        const lines = part.split("\n");
        let eventType = "";
        let dataStr = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) eventType = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataStr = line.slice(6);
        }
        if (!dataStr) continue;

        try {
          const parsed = JSON.parse(dataStr);
          if (eventType === "stdout" && parsed.chunk) {
            accumulatedOutput += parsed.chunk;
            // 回调 Base64 编码的累积输出（与 TAT getInvocationTask 语义一致）
            onProgress(b64.encode(accumulatedOutput));
          } else if (eventType === "finished" && parsed.response) {
            finalPayload = {
              status: parsed.response.status || "SUCCESS",
              exit_code: parsed.response.exit_code ?? 0,
              output: parsed.response.output || accumulatedOutput,
              invocation_id: parsed.invocation_id || parsed.response.invocation_id,
              command_id: parsed.command_id || parsed.response.command_id,
              start_time: parsed.response.start_time,
              end_time: parsed.response.end_time,
            };
          }
        } catch {
          // 非 JSON data，跳过
        }
      }
    }

    if (finalPayload) return finalPayload;

    // 未收到 finished 事件，用累积输出兜底
    return {
      status: accumulatedOutput ? "SUCCESS" : "FAILED",
      exit_code: accumulatedOutput ? 0 : 1,
      output: accumulatedOutput,
    };
  }

  const runCommand: IProductConfig["runCommand"] = async (data: RunCommandRequest) => {
    // SDK 透传 `instance.InstanceId` 到 InstanceIds[0]。业务侧约定：
    // 这里的 InstanceId 就是 mono 的 botId（由页面构造 IInstanceInfo 决定）。
    const botId = data.InstanceIds?.[0]?.trim();
    if (!botId) {
      throw new Error(
        "[debug-exec-adapter] instance.InstanceId 为空，请在构造 SDK instance 时传入 activeBot.id",
      );
    }

    // SDK 把脚本 Base64 编码塞进 Content；后端 `command` 字段期望明文。
    const command = b64.decode(data.Content ?? "");
    const metadata = await commandLifecycle?.beforeExecute?.({ botId, command });

    // 把 botId 和 command 缓存，供 getInvocationTask 使用
    const invocationId = `mono-debug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 暂存 pending 状态，表示命令尚未执行（等 getInvocationTask 决定走同步还是流式）
    pendingCommands.set(invocationId, { botId, command, metadata });

    return { InvocationId: invocationId };
  };

  /**
   * pending 命令缓存：runCommand 只记录命令，不执行；
   * getInvocationTask 根据是否有 onProgress 决定走同步/流式执行。
   */
  const pendingCommands = new Map<string, {
    botId: string;
    command: string;
    metadata: unknown;
  }>();

  async function notifyCommandFinished(
    pending: { botId: string; command: string; metadata: unknown },
    payload: DebugExecPayload,
  ): Promise<void> {
    await commandLifecycle?.afterExecute?.({
      botId: pending.botId,
      command: pending.command,
      metadata: pending.metadata,
      result: {
        status: normalizeStatus(payload.status),
        exitCode: payload.exit_code,
        output: payload.output || "",
      },
    });
  }

  const getInvocationTask: IProductConfig["getInvocationTask"] = async (
    _regionId,
    invocationId,
    pollingOptions,
  ) => {
    if (!invocationId) {
      throw new Error("[debug-exec-adapter] getInvocationTask: invocationId is empty");
    }

    // 优先检查 pending 命令（新流程：延迟执行）
    const pending = pendingCommands.get(invocationId);
    if (pending) {
      pendingCommands.delete(invocationId);

      if (pollingOptions?.onProgress) {
        // 有 onProgress → 走 SSE 流式模式，实时推送每个 stdout chunk
        const payload = await postDebugExecStream(
          pending.botId,
          pending.command,
          pollingOptions.onProgress,
        );
        await notifyCommandFinished(pending, payload);
        return {
          TaskStatus: normalizeStatus(payload.status),
          TaskResult: { Output: payload.output ? b64.encode(payload.output) : "" },
        };
      }

      // 无 onProgress → 走普通同步模式
      const payload = await postDebugExec(pending.botId, pending.command);
      await notifyCommandFinished(pending, payload);
      return {
        TaskStatus: normalizeStatus(payload.status),
        TaskResult: { Output: payload.output ? b64.encode(payload.output) : "" },
      };
    }

    // 兼容旧缓存（如果有的话）
    const cached = resultCache.get(invocationId);
    if (cached) {
      resultCache.delete(invocationId);
      if (pollingOptions?.onProgress && cached.base64Output) {
        try {
          pollingOptions.onProgress(cached.base64Output);
        } catch { /* ignore */ }
      }
      return {
        TaskStatus: cached.status,
        TaskResult: { Output: cached.base64Output },
      };
    }

    throw new Error(
      `[debug-exec-adapter] invocationId=${invocationId} 未在本次会话下发，结果已不可用`,
    );
  };

  return { runCommand, getInvocationTask };
}

/**
 * @deprecated 兼容旧命名；新代码请直接用 `createMonoDebugExecAdapter`。
 */
export const createMonoTatCommandAdapter = createMonoDebugExecAdapter;
