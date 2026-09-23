/**
 * 连接器 TAT 执行链（LightVela 版，移植自 AgentChat-web tat.ts / runtimeScript.ts）。
 *
 * 链路：ai-server enable/detach/complete 响应携带 TAT payload →
 *   1. 从七彩石脚本目录（app=ai, group=lightclawsite.scripts）解析
 *      connector-runtime.{hash}.sh 脚本 URL（文件名 hash 即完整性校验值）；
 *   2. 构造 bash 命令：下载缓存脚本（hash 校验）+ payload base64 执行；
 *   3. 经 LightVela 实例命令通道（execDebugCommand）执行到云端虾实例；
 *   4. 解析输出末尾的 CONNECTOR_RESULT_JSON 报告；
 *   5. 由调用方回写 reportDelivery。
 *
 * P1 范围（tencent-meeting = local_cli）：payload 不含
 * ${AGENTCHAT_API_KEY} 占位符，无需 createApiKey 物化；mcp_proxy 型接入时
 * 需补 API key 换取（AgentChat materializeConnectorTatPayload 模式）。
 */

import type { ConnectorTatPayload } from "@/lib/connectors-client";
import { createConnectorApiKey } from "@/lib/connectors-client";

/** 实例命令执行器（LightVela 的 repositories.bots.execDebugCommand） */
export type ConnectorCommandExecutor = (
  command: string,
  options?: { timeoutMs?: number },
) => Promise<{ status: string; exitCode: number; output: string }>;

export interface ConnectorRuntimeScript {
  url: string;
  filename: string;
  hash: string;
}

export interface ConnectorTatReport {
  status: "success" | "success_with_warning" | "failed";
  message: string;
  authUrl?: string;
}

// ─── 七彩石脚本目录（公共接口，无需登录；AgentChat 同源同参） ───

const RAINBOW_SCRIPT_CATALOG_URL =
  "https://dnspod.cloud.tencent.com/ajax/rainbow?action=getRainbowConfig&urltag=lightclawsitescripts";

const RAINBOW_SCRIPT_CACHE_TTL_MS = 5 * 60 * 1000;

let scriptCatalogCache: { at: number; scripts: Record<string, string> } | null = null;

/** 解析 connector-runtime.{hash}.sh URL（文件名 hash 即完整性校验值） */
export function parseConnectorRuntimeScript(url: string): ConnectorRuntimeScript | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    const filename = parsed.pathname.split("/").pop() || "";
    const match = filename.match(/^connector-runtime\.([a-f0-9]{8,64})\.sh$/);
    return match ? { url: parsed.toString(), filename, hash: match[1] } : null;
  } catch {
    return null;
  }
}

/** 从七彩石脚本目录解析 connector-runtime 脚本（带 TTL 缓存 + 一次重试） */
export async function resolveConnectorRuntimeScript(): Promise<ConnectorRuntimeScript | null> {
  let catalog: Record<string, string>;
  if (scriptCatalogCache && Date.now() - scriptCatalogCache.at < RAINBOW_SCRIPT_CACHE_TTL_MS) {
    catalog = scriptCatalogCache.scripts;
  } else {
    let keyValues: Array<{ key: string; value: string }> | undefined;
    for (let attempt = 0; attempt < 2 && !keyValues; attempt += 1) {
      try {
        const res = await fetch(RAINBOW_SCRIPT_CATALOG_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            app: "ai",
            groups: ["lightclawsite.scripts"],
            options: { enableEnv: 1 },
          }),
        });
        const body = (await res.json()) as {
          data?: Array<{ keyValues?: Array<{ key: string; value: string }> }>;
        };
        keyValues = body.data?.[0]?.keyValues;
      } catch {
        // 重试一次后放弃，由调用方抛「脚本获取失败」
      }
    }
    catalog = {};
    if (Array.isArray(keyValues)) {
      for (const { key, value } of keyValues) catalog[key] = value;
    }
    scriptCatalogCache = { at: Date.now(), scripts: catalog };
  }
  const url = catalog["connector_runtime"];
  return url ? parseConnectorRuntimeScript(url) : null;
}

// ─── 命令构造（缓存脚本 + hash 校验 + payload base64） ───

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

export function buildConnectorTatCommand(
  payload: ConnectorTatPayload,
  script: ConnectorRuntimeScript,
): string {
  const payloadB64 = encodeBase64(JSON.stringify(payload));
  return `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_URL=${shellQuote(script.url)}
SCRIPT_NAME=${shellQuote(script.filename)}
EXPECTED_HASH=${shellQuote(script.hash)}
CACHE_DIR="\${HOME:-/tmp}/.agentchat-connectors/scripts"
SCRIPT_PATH="\${CACHE_DIR}/\${SCRIPT_NAME}"

calculate_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    return 1
  fi
}

verify_script() {
  local actual_hash
  [ -s "$1" ] || return 1
  actual_hash="$(calculate_hash "$1")" || return 1
  case "$actual_hash" in
    "$EXPECTED_HASH"*) return 0 ;;
    *) return 1 ;;
  esac
}

mkdir -p "$CACHE_DIR"
if ! verify_script "$SCRIPT_PATH"; then
  tmp_path="\${SCRIPT_PATH}.tmp.$$"
  trap 'rm -f "$tmp_path"' EXIT
  curl -fsSL --retry 2 --connect-timeout 5 --max-time 30 "$SCRIPT_URL" -o "$tmp_path"
  verify_script "$tmp_path" || {
    echo "connector runtime script hash mismatch" >&2
    exit 1
  }
  chmod 700 "$tmp_path"
  mv -f "$tmp_path" "$SCRIPT_PATH"
  trap - EXIT
fi

PAYLOAD_B64=${shellQuote(payloadB64)} bash "$SCRIPT_PATH"`;
}

// ─── 执行与结果解析 ───

/**
 * 物化 TAT payload：mcp_proxy 型的 server.headers 含 ${AGENTCHAT_API_KEY}
 * 占位符（AgentChat materializeConnectorTatPayload 模式），执行前换成
 * 当前用户+实例维度的真实 access_token，避免实例侧依赖额外环境变量。
 */
export async function materializeConnectorTatPayload(
  launchToken: string,
  payload: ConnectorTatPayload,
): Promise<ConnectorTatPayload> {
  const text = JSON.stringify(payload);
  if (!text.includes("${AGENTCHAT_API_KEY}")) return payload;
  const { access_token: apiKey } = await createConnectorApiKey(launchToken, {
    name: "default",
    device_id: payload.instanceId,
    device_type: "lightvela",
    region: "",
    expires_in: 60 * 60 * 24 * 365 * 10,
  });
  if (!apiKey) throw new Error("获取连接器 apiKey 失败");
  return JSON.parse(text.replace(/\$\{AGENTCHAT_API_KEY\}/g, apiKey)) as ConnectorTatPayload;
}

/**
 * 校验并执行 TAT payload（AgentChat executeConnectorTatPayload 的 LightVela 移植）。
 * 输出末尾的 CONNECTOR_RESULT_JSON={...} 为脚本结构化报告。
 *
 * 执行模式：后台 + 轮询（同步通道撑不住长任务）——LightVela 的 debug/exec
 * 是同步长连接，网关层约 100s 掐断；而连接器安装（下载脚本 + 安装 tmeet
 * CLI）可能执行数分钟。因此分两步：
 *   1. 启动：命令 base64 包装后 nohup 后台执行，输出落日志文件，立即返回 PID；
 *   2. 轮询：每 3s 查一次日志文件——出现 CONNECTOR_RESULT_JSON 即完成；
 *      进程退出但无结果视为失败，返回日志尾部作错误信息。
 * （AgentChat 走腾讯云 TAT 异步任务无此问题；本模式为同步通道等价改造。）
 */

const TAT_OP_TOTAL_TIMEOUT_MS = 5 * 60 * 1000;
const TAT_OP_POLL_INTERVAL_MS = 3000;
const TAT_OP_EXEC_TIMEOUT_MS = 15 * 1000;
const TAT_OP_DIR = "/tmp/agentchat-connectors";

function parseResultOutput(output: string, exitFailed: boolean): ConnectorTatReport & { tatTaskId: string } {
  const match = output.match(/CONNECTOR_RESULT_JSON=(\{.*\})/);
  let parsed: { status?: string; message?: string; authUrl?: string } | null = null;
  if (match) {
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      parsed = null;
    }
  }
  if (!match || exitFailed) {
    return {
      status: "failed",
      // 失败时给日志尾部（截断），比静默 failed 更可诊断
      message: output.slice(-500) || "连接器配置下发失败",
      tatTaskId: "",
    };
  }
  return {
    status: parsed?.status || "success_with_warning",
    message: parsed?.message || "",
    authUrl: parsed?.authUrl,
    tatTaskId: "",
  };
}

export async function executeConnectorTat(
  executor: ConnectorCommandExecutor,
  payload: ConnectorTatPayload,
  launchToken?: string,
): Promise<ConnectorTatReport & { tatTaskId: string }> {
  if (payload.protocolVersion !== 2) {
    throw new Error("连接器运行协议版本不一致，请刷新页面后重试");
  }
  // mcp_proxy 型占位符替换（local_cli 型 payload 不含占位符，直接透传）
  const effectivePayload = launchToken
    ? await materializeConnectorTatPayload(launchToken, payload)
    : payload;
  const script = await resolveConnectorRuntimeScript();
  if (!script) {
    throw new Error("连接器运行脚本获取失败，请稍后重试");
  }

  // ── 第 1 步：后台启动 ──
  const opId = `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const logFile = `${TAT_OP_DIR}/${opId}.log`;
  const scriptB64 = encodeBase64(buildConnectorTatCommand(effectivePayload, script));
  const startCommand = [
    `mkdir -p ${TAT_OP_DIR}`,
    `nohup bash -c 'echo ${shellQuote(scriptB64)} | base64 -d | bash' > ${shellQuote(logFile)} 2>&1 &`,
    `echo "OP_PID=$!"`,
  ].join("\n");

  const start = await executor(startCommand, { timeoutMs: TAT_OP_EXEC_TIMEOUT_MS });
  if (start.status !== "SUCCESS" || start.exitCode !== 0) {
    throw new Error(start.output.slice(-300) || "连接器任务启动失败");
  }
  const pidMatch = start.output.match(/OP_PID=(\d+)/);
  if (!pidMatch) {
    throw new Error("连接器任务启动失败（无法获取任务进程）");
  }
  const pid = pidMatch[1];

  // ── 第 2 步：轮询日志文件 ──
  const pollCommand = [
    `LOG=${shellQuote(logFile)}; PID=${pid}`,
    'if grep -q "CONNECTOR_RESULT_JSON=" "$LOG" 2>/dev/null; then',
    '  echo "OP_DONE"; cat "$LOG"',
    "elif ! kill -0 \"$PID\" 2>/dev/null; then",
    '  echo "OP_EXITED"; cat "$LOG" 2>/dev/null || echo "(no output)"',
    "else",
    '  echo "OP_RUNNING"',
    "fi",
  ].join("\n");

  const deadline = Date.now() + TAT_OP_TOTAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, TAT_OP_POLL_INTERVAL_MS));
    const poll = await executor(pollCommand, { timeoutMs: TAT_OP_EXEC_TIMEOUT_MS });
    if (poll.status !== "SUCCESS" || poll.exitCode !== 0) {
      // 轮询本身失败（网络抖动等）：重试直到总超时
      continue;
    }
    if (poll.output.includes("OP_DONE")) {
      return parseResultOutput(poll.output, false);
    }
    if (poll.output.includes("OP_EXITED")) {
      // 进程已退但无结果行 → 失败，日志尾部是错误现场
      return parseResultOutput(poll.output, true);
    }
    // OP_RUNNING → 继续轮询
  }
  // 总超时：进程可能还在跑，kill 掉避免悬挂，报错
  await executor(`kill ${pid} 2>/dev/null; true`, { timeoutMs: TAT_OP_EXEC_TIMEOUT_MS }).catch(
    () => undefined,
  );
  throw new Error("连接器任务执行超时，请稍后重试");
}
