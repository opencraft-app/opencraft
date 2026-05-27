/**
 * Hermes cron 客户端
 *
 * 通过 mono ctl 的 `POST /v1/instances/:botId/debug/exec` 在 bot sandbox 内
 * 调 `hermes cron ...` 命令完成增删查改，把命令的 stdout/stderr 解析回前端。
 *
 * Hermes 文档：https://hermes-agent.nousresearch.com/docs/user-guide/features/cron
 *
 * 设计取舍（Karpathy: Simplicity First）：
 * - 不在 SDK adapter 链路里加新通道，直接在这里独立 fetch；automations panel 内
 *   自己 try/catch + 自己 toast，避免污染 buddy/skill/channel 那条公用 SDK pipeline。
 * - 仅暴露 v1 真正需要的：list / create / pause / resume / remove。
 * - 不解析 list 文本输出；优先 `--json`，失败直接抛错让 toast 展示原始 stderr。
 */
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import {
  AUTH_UNAUTHORIZED_EVENT,
  readStoredAuthToken,
  writeStoredAuthToken,
} from "@/repositories/http-repositories";

/** Hermes 单个 cron job（只挑 UI 需要的字段，多余字段忽略） */
export interface CronJob {
  id: string;
  name: string;
  prompt: string;
  schedule: { kind: string; expr: string; display: string };
  skills: string[];
  enabled: boolean;
  state: string;
  deliver: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  created_at: string | null;
}

/** 调用方传给 create() 的入参 */
export interface CreateCronJobInput {
  /** Hermes schedule 字符串，例：`0 9 * * *` / `every 2h` / `2026-05-26T09:00:00` */
  schedule: string;
  /** 任务提示词 */
  prompt: string;
  /** 任务名称 */
  name: string;
  /** 可选附加技能 slug 列表 */
  skills?: string[];
  /** 可选 deliver target：local（默认）/ weixin / wecom / telegram / origin / 等 */
  deliver?: string;
}

/** 命令失败时抛出，message 已准备好直接进 toast */
export class CronCommandError extends Error {
  readonly command: string;
  readonly output: string;
  readonly status: string;
  readonly exitCode: number;
  constructor(args: { command: string; output: string; status: string; exitCode: number }) {
    super(buildErrorMessage(args.output, args.status));
    this.name = "CronCommandError";
    this.command = args.command;
    this.output = args.output;
    this.status = args.status;
    this.exitCode = args.exitCode;
  }
}

interface DebugExecPayload {
  status: string;
  exit_code: number;
  output: string;
}
interface ApiEnvelope<T> {
  code?: number | string;
  data: T;
  message?: string;
}

/** 把命令 output 末尾几行清洗成 toast 文案 */
function buildErrorMessage(output: string, status: string): string {
  const clean = output
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join("；");
  return clean || status || "Unknown error";
}

/** 单个 shell 参数加引号（仅处理单引号，足够给 hermes cron 用） */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 拼装一条 hermes cron 命令行 */
export function buildCreateCommand(input: CreateCronJobInput): string {
  const parts = [
    "hermes",
    "cron",
    "create",
    shellQuote(input.schedule),
    shellQuote(input.prompt),
    "--name",
    shellQuote(input.name),
  ];
  for (const skill of input.skills ?? []) {
    parts.push("--skill", shellQuote(skill));
  }
  // deliver=local 是 hermes CLI 默认，省略以减少噪声
  if (input.deliver && input.deliver !== "local") {
    parts.push("--deliver", shellQuote(input.deliver));
  }
  return parts.join(" ");
}

/** 同步执行一条命令；非零 exit_code 抛 CronCommandError */
async function execCommand(botId: string, command: string): Promise<DebugExecPayload> {
  const baseUrl = resolveConfiguredAuthApiBaseUrl();
  if (baseUrl === null) {
    throw new Error("[hermes-cron] auth API base URL not configured");
  }
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = readStoredAuthToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const url = `${baseUrl.replace(/\/+$/, "")}/v1/instances/${encodeURIComponent(botId)}/debug/exec`;
  const resp = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify({ command, run_as_user: "agentuser" }),
  });
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      writeStoredAuthToken(null);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
      }
      throw new CronCommandError({
        command,
        output: "登录已过期，请重新登录",
        status: `HTTP ${resp.status}`,
        exitCode: -1,
      });
    }
    let detail = "";
    try {
      const errBody = (await resp.json()) as { message?: string; error?: string };
      detail = errBody?.message ?? errBody?.error ?? "";
    } catch { /* ignore */ }
    throw new CronCommandError({
      command,
      output: detail || `HTTP ${resp.status}`,
      status: `HTTP ${resp.status}`,
      exitCode: -1,
    });
  }
  const envelope = (await resp.json()) as ApiEnvelope<DebugExecPayload>;
  if (!envelope?.data) {
    throw new CronCommandError({ command, output: "missing envelope.data", status: "BAD_RESPONSE", exitCode: -1 });
  }
  const payload = envelope.data;
  const ok = payload.exit_code === 0 && payload.status?.toUpperCase() !== "FAILED";
  if (!ok) {
    throw new CronCommandError({
      command,
      output: payload.output || "",
      status: payload.status || "FAILED",
      exitCode: payload.exit_code ?? -1,
    });
  }
  return payload;
}

/** 读 cron jobs 列表
 *
 * `hermes cron list` 当前版本只输出人类可读文本（无 `--json` flag）。
 * 文档说 jobs 存于 `~/.hermes/cron/jobs.json`，但实测 `cat` 不一定能读到
 * （路径或权限差异）。直接解析 `hermes cron list` 的文本输出，跟用户在
 * 终端看到的完全一致。
 *
 * 输出格式（每个 job 一段，4 个空格缩进字段）：
 *
 * ```text
 * ┌──...──┐
 * │   Scheduled Jobs   │
 * └──...──┘
 *
 *   <id> [<state>]
 *     Name:      <name>
 *     Schedule:  <schedule_display>
 *     Repeat:    <repeat>
 *     Next run:  <next_run_iso>
 *     Deliver:   <deliver_target>
 * ```
 *
 * 空列表：`No scheduled jobs. Create one with ...`
 */
export async function listCronJobs(botId: string): Promise<CronJob[]> {
  // 必须带 --all：默认 list 只展示 active jobs，paused/disabled 的会被过滤掉，
  // 导致前端暂停操作后整张卡片消失（看起来像被删除）。
  const command = "hermes cron list --all";
  const payload = await execCommand(botId, command);
  const text = (payload.output || "").trim();
  if (!text || /no scheduled jobs/i.test(text)) return [];
  const jobs = parseCronListOutput(text);
  // hermes cron list 文本输出不含 prompt；额外尝试读 jobs.json 补 prompt 字段
  // 文件不存在/读不到时静默跳过，仅影响 prompt 显示，不影响列表本身
  try {
    const fileText = await readCronJobsJsonFile(botId);
    if (fileText) {
      const parsed = JSON.parse(fileText) as unknown;
      const arr: unknown[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { jobs?: unknown[] })?.jobs)
          ? ((parsed as { jobs: unknown[] }).jobs)
          : [];
      const promptById = new Map<string, string>();
      const createdAtById = new Map<string, string>();
      for (const raw of arr) {
        const r = raw as Record<string, unknown>;
        const id = String(r.id ?? "");
        if (!id) continue;
        const prompt = typeof r.prompt === "string" ? r.prompt : "";
        if (prompt) promptById.set(id, prompt);
        const createdAt = typeof r.created_at === "string" ? r.created_at : "";
        if (createdAt) createdAtById.set(id, createdAt);
      }
      for (const j of jobs) {
        const p = promptById.get(j.id);
        if (p) j.prompt = p;
        const c = createdAtById.get(j.id);
        if (c) j.created_at = c;
      }
    }
  } catch {
    /* 读 jobs.json 失败不阻断列表 */
  }
  return jobs;
}

/** 兜底读 ~/.hermes/cron/jobs.json，失败返回空字符串 */
async function readCronJobsJsonFile(botId: string): Promise<string> {
  try {
    const payload = await execCommand(
      botId,
      "cat ~/.hermes/cron/jobs.json 2>/dev/null || echo ''",
    );
    return (payload.output || "").trim();
  } catch {
    return "";
  }
}

/** 解析 `hermes cron list` 文本输出。导出仅为单测用 */
export function parseCronListOutput(text: string): CronJob[] {
  const lines = text.split("\n");
  const jobs: CronJob[] = [];
  let current: Partial<CronJob> | null = null;
  // 匹配 job 头：两空格缩进，id（hex 8+ 位）+ 可选 [state]
  const headerRe = /^ {2}([0-9a-f]{8,})\s*(?:\[([^\]]+)\])?\s*$/i;
  // 匹配字段：四空格缩进 + Key: Value
  const fieldRe = /^ {4}([A-Za-z][A-Za-z ]*?):\s*(.*)$/;

  const flush = () => {
    if (current && current.id) jobs.push(finalizeJob(current));
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\u001b\[[0-9;]*m/g, ""); // 去 ANSI
    const headerMatch = headerRe.exec(line);
    if (headerMatch) {
      flush();
      const stateRaw = (headerMatch[2] || "").trim();
      current = {
        id: headerMatch[1],
        state: stateRaw,
        enabled: stateRaw.toLowerCase() !== "paused",
        skills: [],
      };
      continue;
    }
    if (!current) continue;
    const fieldMatch = fieldRe.exec(line);
    if (!fieldMatch) continue;
    const key = (fieldMatch[1] ?? "").trim().toLowerCase();
    const value = (fieldMatch[2] ?? "").trim();
    if (key === "name") current.name = value;
    else if (key === "schedule") {
      current.schedule = { kind: detectScheduleKind(value), expr: value, display: value };
    } else if (key === "next run") current.next_run_at = value;
    else if (key === "last run") {
      const parsed = splitLastRunValue(value);
      current.last_run_at = parsed.lastRunAt;
      if (parsed.lastStatus) current.last_status = parsed.lastStatus;
    }
    else if (key === "last status") current.last_status = value;
    else if (key === "deliver") current.deliver = value;
    else if (key === "skills" || key === "skill") {
      const items = value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
      current.skills = items;
    }
  }
  flush();
  return jobs;
}

export function splitLastRunValue(value: string): { lastRunAt: string; lastStatus: string | null } {
  const trimmed = value.trim();
  const match = /^(.+?(?:Z|[+-]\d{2}:?\d{2}))(?:\s+(.+))?$/.exec(trimmed);
  if (!match) return { lastRunAt: trimmed, lastStatus: null };
  return { lastRunAt: match[1] || trimmed, lastStatus: (match[2] || "").trim() || null };
}

function detectScheduleKind(display: string): string {
  if (/^once\b/i.test(display)) return "once";
  if (/^every\b/i.test(display)) return "interval";
  if (/^\d+\s+\S+(\s+\S+){2,}/.test(display)) return "cron";
  return "";
}

function finalizeJob(p: Partial<CronJob>): CronJob {
  return {
    id: p.id || "",
    name: p.name || "",
    prompt: p.prompt || "",
    schedule: p.schedule || { kind: "", expr: "", display: "" },
    skills: p.skills || [],
    enabled: p.enabled !== false,
    state: p.state || "",
    deliver: p.deliver || "",
    next_run_at: p.next_run_at || null,
    last_run_at: p.last_run_at || null,
    last_status: p.last_status || null,
    created_at: p.created_at || null,
  };
}

export async function createCronJob(botId: string, input: CreateCronJobInput): Promise<void> {
  await execCommand(botId, buildCreateCommand(input));
}

export async function pauseCronJob(botId: string, id: string): Promise<void> {
  await execCommand(botId, `hermes cron pause ${shellQuote(id)}`);
}

export async function resumeCronJob(botId: string, id: string): Promise<void> {
  await execCommand(botId, `hermes cron resume ${shellQuote(id)}`);
}

export async function removeCronJob(botId: string, id: string): Promise<void> {
  await execCommand(botId, `hermes cron remove ${shellQuote(id)}`);
}

/** 编辑已存在 cron job：传入要更新的字段，未传不动 */
export async function editCronJob(
  botId: string,
  id: string,
  patch: { schedule?: string; prompt?: string; name?: string; deliver?: string },
): Promise<void> {
  const parts = ["hermes", "cron", "edit", shellQuote(id)];
  if (patch.schedule !== undefined) parts.push("--schedule", shellQuote(patch.schedule));
  if (patch.prompt !== undefined) parts.push("--prompt", shellQuote(patch.prompt));
  if (patch.name !== undefined) parts.push("--name", shellQuote(patch.name));
  if (patch.deliver !== undefined) parts.push("--deliver", shellQuote(patch.deliver));
  await execCommand(botId, parts.join(" "));
}
