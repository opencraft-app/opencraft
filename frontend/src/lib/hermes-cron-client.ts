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
  script: string;
  effective_window: CronEffectiveWindow | null;
  lightvela_schedule: CronLightVelaSchedule | null;
}

export interface CronEffectiveWindow {
  start_at: string | null;
  end_at: string | null;
  weekdays?: number[] | null;
}

export interface CronLightVelaSchedule {
  kind: "daily_times";
  times: string[];
}

export interface CronLightVelaScriptConfig extends CronEffectiveWindow {
  daily_times?: string[] | null;
}

export interface CronRunRecord {
  id: string;
  job_id: string;
  job_name: string;
  job_prompt: string;
  schedule: CronJob["schedule"] | null;
  deliver: string;
  run_at: string;
  status: string | null;
  output_path: string;
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
  /** 可选 pre-run script 文件名，文件需位于 ~/.hermes/scripts/ */
  script?: string;
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

export interface DebugExecPayload {
  status: string;
  exit_code: number;
  output: string;
}
interface ApiEnvelope<T> {
  code?: number | string;
  data: T;
  message?: string;
}
interface DebugExecErrorPayload {
  message?: string;
  error?: string;
  details?: Partial<DebugExecPayload> & {
    stdout?: string;
    stderr?: string;
    detail?: string;
  };
}
interface CronRunFileRow {
  job_id?: unknown;
  run_at?: unknown;
  output_path?: unknown;
  mtime_ms?: unknown;
  output_status?: unknown;
  agent_skipped?: unknown;
  job_name?: unknown;
  job_prompt?: unknown;
  job_schedule?: unknown;
  job_deliver?: unknown;
  job_last_run_at?: unknown;
  job_last_status?: unknown;
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
  if (input.script) {
    parts.push("--script", shellQuote(input.script));
  }
  return parts.join(" ");
}

/** 同步执行一条命令；非零 exit_code 抛 CronCommandError */
export async function execCommand(botId: string, command: string): Promise<DebugExecPayload> {
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
    let details: DebugExecErrorPayload["details"] | undefined;
    try {
      const errBody = (await resp.json()) as DebugExecErrorPayload;
      details = errBody?.details;
      detail = errBody?.message ?? errBody?.error ?? "";
    } catch { /* ignore */ }
    if (details && (
      typeof details.output === "string"
      || typeof details.stdout === "string"
      || typeof details.stderr === "string"
      || typeof details.detail === "string"
      || typeof details.exit_code === "number"
    )) {
      throw new CronCommandError({
        command,
        output: buildDebugExecDetailsOutput(details),
        status: details.status || `HTTP ${resp.status}`,
        exitCode: details.exit_code ?? -1,
      });
    }
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

function buildDebugExecDetailsOutput(details: DebugExecErrorPayload["details"]): string {
  if (!details) return "";
  const outputs = [
    details.output,
    details.stderr,
    details.stdout,
    details.detail,
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  return outputs[0] ?? "";
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
  const text = (payload.output || "").trimEnd();
  if (!text.trim() || /no scheduled jobs/i.test(text)) return [];
  // 「测试运行」会创建用完即焚的临时任务（名字带 __lvtest_ 前缀，见
  // `buildTestRunMarker`），执行完会自动删除；但删除前存在的短暂窗口内
  // 如果用户恰好刷新列表，不应该让这类内部实现细节暴露给前端。
  const jobs = parseCronListOutput(text).filter((job) => !isTestRunMarkerName(job.name));
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
      const scriptById = new Map<string, string>();
      for (const raw of arr) {
        const r = raw as Record<string, unknown>;
        const id = String(r.id ?? "");
        if (!id) continue;
        const prompt = typeof r.prompt === "string" ? r.prompt : "";
        if (prompt) promptById.set(id, prompt);
        const createdAt = typeof r.created_at === "string" ? r.created_at : "";
        if (createdAt) createdAtById.set(id, createdAt);
        const script = typeof r.script === "string" ? r.script : "";
        if (script) scriptById.set(id, script);
      }
      for (const j of jobs) {
        const p = promptById.get(j.id);
        if (p) j.prompt = p;
        const c = createdAtById.get(j.id);
        if (c) j.created_at = c;
        const script = scriptById.get(j.id);
        if (script) j.script = script;
      }
    }
  } catch {
    /* 读 jobs.json 失败不阻断列表 */
  }
  await hydrateEffectiveWindows(botId, jobs);
  await archiveCronJobMetadata(botId);
  return jobs;
}

export async function listRecentCronRuns(
  botId: string,
  jobs: CronJob[],
  limit = 10,
): Promise<CronRunRecord[]> {
  const payload = await execCommand(botId, buildListRecentCronRunsCommand(limit));
  return parseCronRunFilesOutput(payload.output || "", jobs);
}

function buildListRecentCronRunsCommand(limit: number): string {
  const normalizedLimit = Math.max(1, Math.min(50, Math.floor(limit) || 10));
  const script = [
    "import datetime, json",
    "from pathlib import Path",
    `limit = ${normalizedLimit}`,
    "base = Path.home() / '.hermes' / 'cron' / 'output'",
    "jobs_path = Path.home() / '.hermes' / 'cron' / 'jobs.json'",
    "archive_path = Path.home() / '.hermes' / 'cron' / 'lightvela-jobs-meta.json'",
    "jobs_meta = {}",
    "def absorb(raw_jobs):",
    "    if isinstance(raw_jobs, dict) and 'jobs' not in raw_jobs:",
    "        raw_jobs = list(raw_jobs.values())",
    "    elif isinstance(raw_jobs, dict):",
    "        raw_jobs = raw_jobs.get('jobs', [])",
    "    if isinstance(raw_jobs, list):",
    "        for job in raw_jobs:",
    "            if not isinstance(job, dict):",
    "                continue",
    "            job_id = str(job.get('id') or '')",
    "            if not job_id:",
    "                continue",
    "            jobs_meta[job_id] = {",
    "                'job_name': job.get('name') or job.get('job_name') or '',",
    "                'job_prompt': job.get('prompt') or job.get('job_prompt') or '',",
    "                'job_schedule': job.get('schedule') or job.get('job_schedule'),",
    "                'job_deliver': job.get('deliver') or job.get('job_deliver') or '',",
    "                'job_last_run_at': job.get('last_run_at') or job.get('job_last_run_at') or '',",
    "                'job_last_status': job.get('last_status') or job.get('job_last_status') or '',",
    "            }",
    "try:",
    "    absorb(json.loads(archive_path.read_text(encoding='utf-8')))",
    "except Exception:",
    "    pass",
    "try:",
    "    absorb(json.loads(jobs_path.read_text(encoding='utf-8')))",
    "except Exception:",
    "    pass",
    "def inspect_output(path):",
    "    try:",
    "        text = path.read_text(encoding='utf-8', errors='ignore')",
    "    except Exception:",
    "        return {'output_status': '', 'agent_skipped': False}",
    "    lowered = text.lower()",
    "    compact = ''.join(lowered.split())",
    "    agent_skipped = any(marker in compact for marker in [",
    "        '\"wakeagent\":false',",
    "        \"'wakeagent':false\",",
    "        'wakeagent=false',",
    "    ])",
    "    failure_markers = [",
    "        'traceback (most recent call last)',",
    "        'exit_code: 1',",
    "        'exit code: 1',",
    "        'status: failed',",
    "        'status: failure',",
    "        'status: error',",
    "        'croncommanderror',",
    "    ]",
    "    if any(marker in lowered for marker in failure_markers):",
    "        return {'output_status': 'failed', 'agent_skipped': agent_skipped}",
    "    success_markers = [",
    "        'status: ok',",
    "        'status: success',",
    "        'status: succeeded',",
    "        'exit_code: 0',",
    "        'exit code: 0',",
    "    ]",
    "    if any(marker in lowered for marker in success_markers):",
    "        return {'output_status': 'ok', 'agent_skipped': agent_skipped}",
    "    return {'output_status': 'ok' if text.strip() else '', 'agent_skipped': agent_skipped}",
    "rows = []",
    "if base.exists():",
    "    for path in base.glob('*/*.md'):",
    "        try:",
    "            stat = path.stat()",
    "        except OSError:",
    "            continue",
    "        output_info = inspect_output(path)",
    "        if output_info.get('agent_skipped'):",
    "            continue",
    "        row = {",
    "            'job_id': path.parent.name,",
    "            'run_at': datetime.datetime.fromtimestamp(stat.st_mtime, datetime.timezone.utc).isoformat(),",
    "            'output_path': str(path),",
    "            'mtime_ms': int(stat.st_mtime * 1000),",
    "        }",
    "        row.update(output_info)",
    "        row.update(jobs_meta.get(path.parent.name, {}))",
    "        rows.append(row)",
    "rows.sort(key=lambda item: item['mtime_ms'], reverse=True)",
    "print(json.dumps(rows[:limit], ensure_ascii=False))",
  ].join("\n");
  return `python3 -c ${shellQuote(script)}`;
}

function buildArchiveCronJobMetadataCommand(): string {
  const script = [
    "import json",
    "from pathlib import Path",
    "cron_dir = Path.home() / '.hermes' / 'cron'",
    "jobs_path = cron_dir / 'jobs.json'",
    "archive_path = cron_dir / 'lightvela-jobs-meta.json'",
    "def load(path, fallback):",
    "    try:",
    "        return json.loads(path.read_text(encoding='utf-8'))",
    "    except Exception:",
    "        return fallback",
    "archive_raw = load(archive_path, {})",
    "archive = archive_raw if isinstance(archive_raw, dict) else {}",
    "jobs_raw = load(jobs_path, [])",
    "if isinstance(jobs_raw, dict):",
    "    jobs_raw = jobs_raw.get('jobs', list(jobs_raw.values()))",
    "if isinstance(jobs_raw, list):",
    "    for job in jobs_raw:",
    "        if not isinstance(job, dict):",
    "            continue",
    "        job_id = str(job.get('id') or '')",
    "        if not job_id:",
    "            continue",
    "        archive[job_id] = {",
    "            'id': job_id,",
    "            'name': job.get('name') or '',",
    "            'prompt': job.get('prompt') or '',",
    "            'schedule': job.get('schedule'),",
    "            'deliver': job.get('deliver') or '',",
    "            'last_run_at': job.get('last_run_at') or '',",
    "            'last_status': job.get('last_status') or '',",
    "        }",
    "cron_dir.mkdir(parents=True, exist_ok=True)",
    "archive_path.write_text(json.dumps(archive, ensure_ascii=False), encoding='utf-8')",
  ].join("\n");
  return `python3 -c ${shellQuote(script)}`;
}

async function archiveCronJobMetadata(botId: string): Promise<void> {
  try {
    await execCommand(botId, buildArchiveCronJobMetadataCommand());
  } catch {
    /* 元信息归档失败不影响主流程 */
  }
}

export function parseCronRunFilesOutput(text: string, jobs: CronJob[]): CronRunRecord[] {
  if (!text.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const records: CronRunRecord[] = [];
  for (const raw of parsed) {
    const row = raw as CronRunFileRow;
    const jobId = typeof row.job_id === "string" ? row.job_id : "";
    const runAt = typeof row.run_at === "string" ? row.run_at : "";
    const outputPath = typeof row.output_path === "string" ? row.output_path : "";
    if (!jobId || !runAt || !outputPath) continue;
    if (row.agent_skipped === true) continue;
    const job = jobsById.get(jobId);
    const rowSchedule = normalizeRunSchedule(row.job_schedule);
    records.push({
      id: `${jobId}:${outputPath || runAt}`,
      job_id: jobId,
      job_name: job?.name || stringValue(row.job_name) || jobId,
      job_prompt: job?.prompt || stringValue(row.job_prompt),
      schedule: job?.schedule ?? rowSchedule,
      deliver: job?.deliver || stringValue(row.job_deliver),
      run_at: runAt,
      status: inferRunStatus(row, job),
      output_path: outputPath,
    });
  }
  return records;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeRunSchedule(value: unknown): CronJob["schedule"] | null {
  if (typeof value === "string") {
    const display = value.trim();
    return display ? { kind: detectScheduleKind(display), expr: display, display } : null;
  }
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const display = stringValue(raw.display) || stringValue(raw.expr) || stringValue(raw.value);
  if (!display) return null;
  const expr = stringValue(raw.expr) || display;
  return {
    kind: stringValue(raw.kind) || detectScheduleKind(display),
    expr,
    display,
  };
}

function inferRunStatus(row: CronRunFileRow, job: CronJob | undefined): string | null {
  const lastRunAt = job?.last_run_at || stringValue(row.job_last_run_at);
  const lastStatus = job?.last_status || stringValue(row.job_last_status);
  if (lastRunAt && lastStatus) {
    const runMs = typeof row.mtime_ms === "number" ? row.mtime_ms : Date.parse(String(row.run_at ?? ""));
    const lastRunMs = Date.parse(lastRunAt);
    if (!Number.isNaN(runMs) && !Number.isNaN(lastRunMs) && Math.abs(runMs - lastRunMs) <= 5 * 60 * 1000) {
      return lastStatus;
    }
  }
  return stringValue(row.output_status) || null;
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
    else if (key === "script") current.script = value;
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
    script: p.script || "",
    effective_window: p.effective_window || null,
    lightvela_schedule: p.lightvela_schedule || null,
  };
}

function normalizeDailyScriptTimes(values: readonly string[] | null | undefined): string[] {
  const times = Array.from(new Set((values ?? [])
    .map((v) => v.trim())
    .filter((v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v))));
  return times.sort((a, b) => a.localeCompare(b));
}

export function buildEffectiveWindowScript(args: CronLightVelaScriptConfig): string {
  const startAt = args.start_at ?? "";
  const endAt = args.end_at ?? "";
  const weekdays = Array.isArray(args.weekdays)
    ? Array.from(new Set(args.weekdays.filter((v) => Number.isInteger(v) && v >= 0 && v <= 6))).sort((a, b) => a - b)
    : [];
  const dailyTimes = normalizeDailyScriptTimes(args.daily_times);
  return [
    "#!/usr/bin/env python3",
    "# lightvela-effective-window",
    "# Hermes pre-run gate script. MUST return within ~1s — runs every cron tick",
    "# (up to once per minute when daily_times is used) and blocks the cron loop.",
    "# Keep logic O(1): no I/O, no network, no subprocess.",
    `# start_at=${startAt}`,
    `# end_at=${endAt}`,
    `# weekdays=${weekdays.join(",")}`,
    `# daily_times=${dailyTimes.join(",")}`,
    "import datetime",
    "import json",
    "",
    `START_AT = ${JSON.stringify(startAt)}`,
    `END_AT = ${JSON.stringify(endAt)}`,
    `ALLOWED_WEEKDAYS = ${JSON.stringify(weekdays)}`,
    `ALLOWED_DAILY_TIMES = ${JSON.stringify(dailyTimes)}`,
    "",
    "def parse(value):",
    "    return datetime.datetime.fromisoformat(value) if value else None",
    "",
    "now = datetime.datetime.now()",
    "start_at = parse(START_AT)",
    "end_at = parse(END_AT)",
    "wake = True",
    "if start_at is not None and now < start_at:",
    "    wake = False",
    "if end_at is not None and now > end_at:",
    "    wake = False",
    "# JavaScript/Hermes cron convention: 0=Sunday, 1=Monday, ... 6=Saturday",
    "current_weekday = now.isoweekday() % 7",
    "if ALLOWED_WEEKDAYS and current_weekday not in ALLOWED_WEEKDAYS:",
    "    wake = False",
    "if ALLOWED_DAILY_TIMES and now.strftime(\"%H:%M\") not in ALLOWED_DAILY_TIMES:",
    "    wake = False",
    "print(json.dumps({\"wakeAgent\": wake}))",
    "",
  ].join("\n");
}

export function parseLightVelaCronScript(content: string): {
  effectiveWindow: CronEffectiveWindow | null;
  lightvelaSchedule: CronLightVelaSchedule | null;
} {
  if (!content.includes("lightvela-effective-window")) {
    return { effectiveWindow: null, lightvelaSchedule: null };
  }
  const startAt = /^# start_at=(.*)$/m.exec(content)?.[1]?.trim() ?? "";
  const endAt = /^# end_at=(.*)$/m.exec(content)?.[1]?.trim() ?? "";
  const weekdaysRaw = /^# weekdays=(.*)$/m.exec(content)?.[1]?.trim() ?? "";
  const dailyTimesRaw = /^# daily_times=(.*)$/m.exec(content)?.[1]?.trim() ?? "";
  const weekdays = weekdaysRaw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v >= 0 && v <= 6);
  const dailyTimes = normalizeDailyScriptTimes(dailyTimesRaw.split(","));
  const effectiveWindow = !startAt && !endAt && weekdays.length === 0
    ? null
    : {
        start_at: startAt || null,
        end_at: endAt || null,
        ...(weekdays.length > 0 ? { weekdays } : {}),
      };
  return {
    effectiveWindow,
    lightvelaSchedule: dailyTimes.length > 0
      ? { kind: "daily_times", times: dailyTimes }
      : null,
  };
}

export function parseEffectiveWindowScript(content: string): CronEffectiveWindow | null {
  return parseLightVelaCronScript(content).effectiveWindow;
}

export function createEffectiveWindowScriptName(seed: string): string {
  const normalized = seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const suffix = normalized || "job";
  return `lightvela-effective-window-${suffix}.py`;
}

function isLightVelaEffectiveWindowScript(script: string): boolean {
  return /^lightvela-effective-window-[a-z0-9-]+\.py$/.test(script);
}

export async function writeEffectiveWindowScript(
  botId: string,
  scriptName: string,
  window: CronLightVelaScriptConfig,
): Promise<void> {
  if (!isLightVelaEffectiveWindowScript(scriptName)) {
    throw new Error("invalid LightVela effective window script name");
  }
  const content = buildEffectiveWindowScript(window);
  const path = `~/.hermes/scripts/${scriptName}`;
  const command = [
    "mkdir -p ~/.hermes/scripts",
    `printf %s ${shellQuote(content)} > ${path}`,
    `chmod 600 ${path}`,
  ].join(" && ");
  await execCommand(botId, command);
}

export async function removeEffectiveWindowScript(botId: string, scriptName: string): Promise<void> {
  if (!isLightVelaEffectiveWindowScript(scriptName)) {
    throw new Error("invalid LightVela effective window script name");
  }
  await execCommand(botId, `rm -f ~/.hermes/scripts/${scriptName}`);
}

async function readEffectiveWindowScripts(botId: string, scriptNames: string[]): Promise<Map<string, {
  effectiveWindow: CronEffectiveWindow | null;
  lightvelaSchedule: CronLightVelaSchedule | null;
}>> {
  const safeNames = scriptNames.filter(isLightVelaEffectiveWindowScript);
  const result = new Map<string, {
    effectiveWindow: CronEffectiveWindow | null;
    lightvelaSchedule: CronLightVelaSchedule | null;
  }>();
  for (const scriptName of safeNames) {
    try {
      const payload = await execCommand(botId, `cat ~/.hermes/scripts/${scriptName} 2>/dev/null || true`);
      const parsed = parseLightVelaCronScript(payload.output || "");
      if (parsed.effectiveWindow || parsed.lightvelaSchedule) result.set(scriptName, parsed);
    } catch {
      /* ignore individual script read failures */
    }
  }
  return result;
}

async function hydrateEffectiveWindows(botId: string, jobs: CronJob[]): Promise<void> {
  const scriptNames = Array.from(new Set(
    jobs
      .map((job) => job.script)
      .filter(isLightVelaEffectiveWindowScript),
  ));
  if (scriptNames.length === 0) return;
  const metadata = await readEffectiveWindowScripts(botId, scriptNames);
  for (const job of jobs) {
    const scriptMetadata = metadata.get(job.script);
    if (scriptMetadata?.effectiveWindow) job.effective_window = scriptMetadata.effectiveWindow;
    if (scriptMetadata?.lightvelaSchedule) job.lightvela_schedule = scriptMetadata.lightvelaSchedule;
  }
}

export async function createCronJob(botId: string, input: CreateCronJobInput): Promise<void> {
  await execCommand(botId, buildCreateCommand(input));
  await archiveCronJobMetadata(botId);
}

export async function createCronJobWithScriptRollback(
  botId: string,
  input: CreateCronJobInput,
  rollbackScript?: string,
): Promise<void> {
  try {
    await createCronJob(botId, input);
  } catch (err) {
    if (rollbackScript && isLightVelaEffectiveWindowScript(rollbackScript)) {
      try {
        await removeEffectiveWindowScript(botId, rollbackScript);
      } catch {
        /* keep the original create error */
      }
    }
    throw err;
  }
}

export async function pauseCronJob(botId: string, id: string): Promise<void> {
  await execCommand(botId, `hermes cron pause ${shellQuote(id)}`);
}

export async function resumeCronJob(botId: string, id: string): Promise<void> {
  await execCommand(botId, `hermes cron resume ${shellQuote(id)}`);
}

/**
 * 底层原语：手动触发**指定 id** 的 cron job 执行一次。
 *
 * `hermes cron run <id>` 官方语义是「立即触发执行」：新建一个独立 Agent 会话、
 * 跑 prompt、按 deliver 投递结果。但实测证实这条"强制立即触发"路径在这套
 * CLI/debug-exec 环境下不可靠——触发后即使轮询等满一个完整调度器 tick 周期
 * （90s）仍可能完全没有执行，原因未完全定位（不是纯粹的等待时间不够）。
 *
 * ⚠️ 另外这里的"成功"只代表 Agent 本身跑成功了（Hermes 内部 `last_status`），
 * **不代表通知真的投递出去了**——投递失败会被单独记录在 `last_delivery_error`
 * 字段里，CLI 的 exit code / 文案完全不反映这一点。
 *
 * 因此 `runCronJobAsTest` 现在**不再使用**这个原语，而是完全依赖"普通一次性
 * 任务到点被调度器自然执行"这条已被生产环境验证可靠的路径（见其函数注释）。
 * 这个原语仍保留导出（且有独立单测覆盖其命令拼接行为），但当前没有内部调用方；
 * 如需恢复"强制立即触发"语义，务必先在真实环境里重新验证其可靠性。
 */
export async function runCronJob(botId: string, id: string): Promise<DebugExecPayload> {
  return execCommand(botId, `hermes cron run ${shellQuote(id)}`);
}

const TEST_RUN_MARKER_PREFIX = "__lvtest_";

/** 生成一个几乎不可能撞车的临时任务名，仅用于创建后立刻按名字反查 id */
export function buildTestRunMarker(jobId: string): string {
  return `${TEST_RUN_MARKER_PREFIX}${jobId.slice(0, 8)}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 判断是否为「测试运行」创建的用完即焚临时任务，供 `listCronJobs` 过滤 */
function isTestRunMarkerName(name: string): boolean {
  return name.startsWith(TEST_RUN_MARKER_PREFIX);
}

/**
 * 「测试运行」临时任务用的一次性 schedule。
 *
 * 直接用 Hermes 官方文档给出的**相对延迟**一次性写法（`30m` / `2h` / `1d`
 * 这一族），而不是自己拼 ISO 时间戳——这是关键教训：
 *
 * - 之前这里自己拼了个 `YYYY-MM-DDTHH:MM`（**故意砍掉了秒位**）的 ISO 字符串，
 *   而官方 ISO 示例是带秒的完整格式 `2026-03-15T09:00:00`。这个自造的、缺秒的
 *   格式很可能压根没被解析器正确识别，导致临时任务的 `next_run_at` 算错/为空，
 *   调度器永远扫不到它——这正是「测试运行怎么等都不执行」的根因。
 * - 相对延迟 `2m` 是文档直接给出的一次性任务示例，一定被解析器接受，且天然
 *   就是"未来 2 分钟"，不存在分钟精度截断那套自找的心智负担。
 * - 为什么是 `2m` 而不是 `1m`：调度器 tick 周期固定 60s，`2m` 能稳妥覆盖
 *   "创建到下一次 tick 对齐"的最坏情况；秒级单位（`s`）文档未提及且 60s tick
 *   粒度下无意义，不用。
 */
function buildImmediateOnceSchedule(): string {
  return "2m";
}

/** 从 ~/.hermes/cron/jobs.json 里按 id 读出未经 `hermes cron list` 文本裁剪的原始字段（如 origin / last_delivery_error） */
async function readRawCronJobRecordById(botId: string, jobId: string): Promise<Record<string, unknown> | null> {
  const text = await readCronJobsJsonFile(botId);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    const arr: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { jobs?: unknown[] })?.jobs)
        ? (parsed as { jobs: unknown[] }).jobs
        : [];
    for (const raw of arr) {
      if (raw && typeof raw === "object" && String((raw as Record<string, unknown>).id ?? "") === jobId) {
        return raw as Record<string, unknown>;
      }
    }
  } catch { /* ignore parse失败，走上层兜底 */ }
  return null;
}

/** 按 name 精确匹配反查 job id（临时任务创建后用这个拿到它的真实 id） */
async function findCronJobIdByExactName(botId: string, name: string): Promise<string | null> {
  const text = await readCronJobsJsonFile(botId);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    const arr: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { jobs?: unknown[] })?.jobs)
        ? (parsed as { jobs: unknown[] }).jobs
        : [];
    for (const raw of arr) {
      const r = raw as Record<string, unknown>;
      if (r && r.name === name) {
        const id = String(r.id ?? "");
        if (id) return id;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 把 Hermes / acli 返回的通道名归一化成投递用的 platform key。
 *
 * 与 `openclaw-automations-panel.tsx` 里的 `normalizeHermesChannelKey` 保持一致
 * （此处独立一份，避免 lib 反向依赖 page 组件文件）。
 */
function normalizeChannelKeyForDeliver(channel: string): string {
  const normalized = channel.trim().toLowerCase();
  if (["wechat", "weixin", "openclaw-weixin", "openclaw-wechat"].includes(normalized)) return "weixin";
  if (["qq", "qqbot", "qq-bot", "qqbotplugin", "openclaw-qqbot", "openclaw-qq"].includes(normalized)) return "qqbot";
  if (["wecom", "wework", "work-weixin", "work-wechat", "openclaw-wecom"].includes(normalized)) return "wecom";
  if (["feishu", "lark", "larksuite", "openclaw-feishu", "openclaw-lark"].includes(normalized)) return "feishu";
  if (["telegram", "tg", "openclaw-telegram", "openclaw-tg"].includes(normalized)) return "telegram";
  if (["whatsapp", "whats-app", "whatsapp-business", "whatsapp_business", "openclaw-whatsapp"].includes(normalized)) return "whatsapp";
  if (["discord", "openclaw-discord"].includes(normalized)) return "discord";
  return normalized;
}

/**
 * deliver=origin 但 origin 为空时，兜底选哪个 home channel 的优先级。
 * 排在前面的优先。国内 IM（企业微信/微信/QQ）优先，其次飞书，再是国际通道。
 */
const DELIVER_FALLBACK_CHANNEL_PRIORITY = [
  "wecom",
  "weixin",
  "qqbot",
  "feishu",
  "telegram",
  "whatsapp",
  "discord",
] as const;

/**
 * 从 `acli channel status` 的 JSON 输出里，按优先级挑一个已连接的通道 platform 名。
 *
 * 纯函数（不涉及网络/exec），便于单测。返回的是**不带 chat_id 的 platform 名**
 * （如 `"wecom"`），直接投到该平台的 home channel——已验证 `hermes send --to wecom`
 * 能直达用户（Sent to wecom home channel）。解析失败或无已连接通道时返回 null。
 */
export function pickFallbackChannelFromStatusOutput(output: string): string | null {
  const trimmed = (output || "").trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  const root = parsed as { data?: { platforms?: unknown }; platforms?: unknown } | null;
  const rawPlatforms = root?.data?.platforms ?? root?.platforms;
  if (!Array.isArray(rawPlatforms)) return null;
  const connected = new Set<string>();
  for (const entry of rawPlatforms) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as { name?: unknown; status?: unknown; enabled?: unknown };
    const name = typeof item.name === "string" ? item.name : "";
    if (!name) continue;
    const status = typeof item.status === "string" ? item.status.toLowerCase() : "";
    const ok = item.enabled === true || ["connected", "enabled", "running", "ready"].includes(status);
    if (ok) connected.add(normalizeChannelKeyForDeliver(name));
  }
  if (connected.size === 0) return null;
  for (const key of DELIVER_FALLBACK_CHANNEL_PRIORITY) {
    if (connected.has(key)) return key;
  }
  // 优先级表里没有的其它已连接通道，取任意一个兜底
  return [...connected][0] ?? null;
}

/**
 * 从 `acli channel status` 的输出里挑一个已连接的通道，作为 deliver 兜底目标。
 * 拉取失败返回 null（调用方会退回原样 origin）。
 */
async function resolveFallbackHomeChannel(botId: string): Promise<string | null> {
  try {
    const payload = await execCommand(botId, "acli channel status");
    return pickFallbackChannelFromStatusOutput(payload.output || "");
  } catch {
    return null;
  }
}

/**
 * `deliver === "origin"`（或逗号分隔目标里含 "origin" 这个 token）时，把它替换
 * 成具体的投递目标。
 *
 * 原因：`origin` 依赖任务创建时持久化下来的 `job.origin`（真实聊天会话里创建
 * 才会有），而我们用 CLI 重新创建的临时克隆任务不会有这个上下文，如果不手动把
 * 它换成具体目标，临时任务的 `origin` 投递就会走 Hermes 的兜底逻辑，可能跟原
 * 任务的真实投递目标不一致。
 *
 * 两级还原：
 * 1. 原任务持久化了 concrete origin（`{platform, chat_id}`）→ 换成 `platform:chat_id`；
 * 2. 原任务 `origin` 为空（典型：在网页「自动任务」面板创建的任务——网页不是
 *    IM 会话，没有"原对话"上下文，`origin` 存成 null）→ 此时若原样保留 `origin`，
 *    临时任务投递会**静默丢弃**（任务照记 ok，但用户啥也收不到）。改为兜底到该
 *    bot 已连接的 home channel（如 `wecom`），保证测试运行的通知能真正到达用户。
 *    连一个已连接通道都没有时，才退回原样的 `origin`（此时确实无处可投）。
 */
async function resolveConcreteDeliverForTestRun(botId: string, job: CronJob): Promise<string> {
  const tokens = job.deliver.split(",").map((token) => token.trim()).filter(Boolean);
  if (!tokens.includes("origin")) return job.deliver;
  const raw = await readRawCronJobRecordById(botId, job.id);
  const origin = raw?.origin as { platform?: unknown; chat_id?: unknown } | undefined;
  const hasConcreteOrigin = origin
    && typeof origin.platform === "string"
    && origin.platform
    && origin.chat_id !== undefined
    && origin.chat_id !== null
    && String(origin.chat_id) !== "";
  if (hasConcreteOrigin) {
    const concreteOrigin = `${String((origin as { platform: string }).platform)}:${String((origin as { chat_id: unknown }).chat_id)}`;
    return tokens.map((token) => (token === "origin" ? concreteOrigin : token)).join(",");
  }
  // origin 为空：兜底到该 bot 已连接的 home channel，避免临时任务通知静默丢弃。
  const fallback = await resolveFallbackHomeChannel(botId);
  if (!fallback) return job.deliver;
  const replaced = tokens.map((token) => (token === "origin" ? fallback : token));
  // 去重：万一 tokens 里已经显式含有 fallback 平台，避免出现 "wecom,wecom"
  const deduped = [...new Set(replaced)];
  return deduped.join(",");
}

export interface CronTestRunResult {
  /** 临时任务这次执行的原始 exec 输出 */
  output: string;
  /** 非空表示 Agent 跑成功了，但通知投递失败（来自 Hermes `last_delivery_error`） */
  deliveryError: string | null;
}

/** 点「测试运行」后立刻推送到 IM 通道的即时回执文案 */
const TEST_RUN_ACK_MESSAGE = "已收到测试请求，正在唤起任务，请耐心等待…";

/**
 * 立即往指定 deliver 目标推送一条纯文本消息（`hermes send`）。
 *
 * 和 cron 那套「到点由调度器 tick 执行」不同，`hermes send` 是同步的即时投递
 * 命令（同「设置」里「测试通知通道」用的是同一条命令），不经过调度器、不唤起
 * Agent/LLM，命令返回即代表已经发出。因此适合用来在测试运行真正开始那段漫长
 * 等待之前，先给用户的聊天通道回一句「已收到」。
 *
 * `deliver` 直接沿用 job 的 deliver 字符串（可能是 `weixin:wx_x,feishu:oc_y`
 * 这种逗号分隔的多目标），格式与 `hermes send --to` 接受的目标一致。
 */
async function sendChatNotice(botId: string, deliver: string, message: string): Promise<void> {
  const target = deliver.trim();
  if (!target) return;
  const command = ["hermes", "send", "--to", shellQuote(target), shellQuote(message)].join(" ");
  await execCommand(botId, command);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询间隔 / 超时上限（毫秒）。
 *
 * 关键修正历史：
 * 1. （2026-07-02）`hermes cron run <id>` **不是同步执行**——它只是把目标
 *    job 的 `next_run_at` 改写成"当前时间 + 几秒"就立刻返回，真正的执行要
 *    等 Hermes 调度器的下一次 tick 才会发生。之前按"命令返回 = 已经跑完"
 *    的错误假设写了固定 3s 的 sleep 再读结果，会在 Agent 真正被唤醒之前就
 *    把临时任务删掉，造成「测试运行成功」但用户什么通知都没收到的假阳性。
 * 2. （2026-07-03 上午）改成轮询 `last_run_at`，超时从 45s 上调到 90s——
 *    官方文档确认调度器 tick 周期固定 60s，45s 比一个 tick 周期还短。
 * 3. （2026-07-03 实测发现）即使等满 90s，`hermes cron run` 触发的任务仍
 *    可能不执行——说明问题不是等待时间不够，而是这套 CLI/debug-exec 环境下
 *    `hermes cron run` 的"强制立即触发"语义本身不可靠。而**普通定时任务到
 *    点自然执行**这条路径是被生产环境验证过确实可靠的。所以 `runCronJobAsTest`
 *    现在不再调用 `hermes cron run`，而是完全复用"普通一次性任务到点被
 *    tick 自然执行"这条已验证路径（见 `runCronJobAsTest` 的实现与注释）。
 *
 * 因此这里的轮询超时要覆盖的最坏情况变成：
 *   `buildImmediateOnceSchedule()` 用的相对延迟 `2m`（精确「创建时刻 + 2 分钟」，
 *   无分钟截断问题）+ 调度器下一次 tick 的最坏对齐延迟（~60s）+ Agent 实际跑
 *   一次 prompt 的执行余量。三者加起来预留到 4 分钟，一旦超时仍未执行，明确报错
 *   而不是静默当作成功。
 */
const TEST_RUN_POLL_INTERVAL_MS = 3000;
const TEST_RUN_POLL_TIMEOUT_MS = 240_000;

/**
 * 轮询直到临时任务真正被调度器执行完（`last_run_at` 从空变为非空），或超时。
 *
 * `hermes cron run <id>` 只是把 `next_run_at` 拨到近未来去排队，真正执行发生
 * 在调度器的下一次 tick；`last_run_at` 由 Hermes 在那次 tick 里执行完才写入，
 * 是唯一能用来判断"是否已经真正跑过"的字段（`run` 命令本身的 exit code /
 * 文案完全不反映这一点）。超时后抛错，不静默当作成功。
 */
async function waitForCronJobExecuted(
  botId: string,
  jobId: string,
  pollIntervalMs = TEST_RUN_POLL_INTERVAL_MS,
  timeoutMs = TEST_RUN_POLL_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await readRawCronJobRecordById(botId, jobId);
    const lastRunAt = record?.last_run_at;
    if (typeof lastRunAt === "string" && lastRunAt.trim()) {
      return record as Record<string, unknown>;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `测试运行超时：等待 ${Math.round(timeoutMs / 1000)} 秒后调度器仍未执行该任务，请稍后重试`,
      );
    }
    await delay(pollIntervalMs);
  }
}

/**
 * 测试运行：把 job 的 prompt/skills/deliver 真实执行一次，且**绝不触碰原任务**。
 *
 * 做法：先用 `hermes send` 往同一个 IM 通道即时回一句「已收到测试请求…」（让
 * 用户不用盲等，见 `sendChatNotice`），再创建一个用完即焚的临时一次性任务（同
 * prompt/skills/deliver，但不带生效窗口/daily_times 门控脚本，避免被门控直接跳过
 * 执行；名字带 `__lvtest_` 前缀，`listCronJobs` 会把这类任务从列表里过滤掉，不在
 * 前端展示），让它按自己的 schedule 到点被调度器**自然执行**（不额外催），轮询等到
 * 它真正执行完（见 `waitForCronJobExecuted`）后读取真实投递结果，再把它删除。
 *
 * 为什么不调用 `hermes cron run <id>` 去强制立即触发（哪怕是对临时任务）：
 * 实测证实 `hermes cron run` 在这套 CLI/debug-exec 环境下"强制立即触发"这
 * 条路径不可靠——触发后轮询等满 90s（覆盖一个完整 60s tick 周期）仍可能
 * 完全没有执行。而**普通一次性任务到点被调度器自然扫到执行**这条路径已经
 * 被生产环境反复验证是可靠工作的（这也是「自动任务」功能本身能用的前提）。
 * 所以这里完全复用后一条已验证路径：只创建临时任务、只等待，不再额外调用
 * `run` 去催——用「确定能跑但慢」换掉「可能更快但已知不可靠」。
 *
 * 为什么不能直接对原 job 做类似操作（改 schedule 到近未来）：
 * - 一次性(once)任务：Hermes 执行后会写 `last_run_at`，导致
 *   `compute_next_run` 返回 `None`，任务立刻被标记为 `completed` 并禁用——
 *   原定时间永远不会再触发了，这与"测试不影响原任务"的要求直接冲突。
 * - 周期(interval)任务：改了 schedule 再改回去存在竞态与遗留风险，悄悄让
 *   周期节奏产生漂移。
 * - 门控脚本（生效时间窗口/每日多个时间点）：如果当前时刻不在窗口内，Hermes
 *   会直接跳过执行（Agent 都不会被唤醒），达不到"不管几点都要真实跑一次"的
 *   要求——所以临时任务不带这个门控脚本。
 */
export async function runCronJobAsTest(botId: string, job: CronJob): Promise<CronTestRunResult> {
  const deliver = await resolveConcreteDeliverForTestRun(botId, job);
  // 真正的测试执行要等临时任务被调度器 tick 到（约 2 分钟起步），中间用户是「盲等」的。
  // 所以在开始等待之前，先用 `hermes send` 往同一个 IM 通道即时回一句「已收到」，让用户
  // 立刻知道请求已进入处理。这条回执是 best-effort：发不出去（比如通道未配置）也绝不能
  // 影响后面真正的测试运行，因此单独 try/catch 吞掉错误。
  await sendChatNotice(botId, deliver, TEST_RUN_ACK_MESSAGE).catch(() => {
    /* 即时回执发送失败不影响测试运行主流程 */
  });
  const marker = buildTestRunMarker(job.id);
  await createCronJob(botId, {
    schedule: buildImmediateOnceSchedule(),
    prompt: job.prompt,
    name: marker,
    skills: job.skills,
    deliver,
    // 有意不传 script：跳过生效窗口/daily_times 门控，保证到点真实执行一次
  });
  const tempId = await findCronJobIdByExactName(botId, marker);
  if (!tempId) {
    throw new Error("测试运行失败：未能定位临时任务，请稍后重试");
  }
  try {
    // 有意不调用 hermes cron run 强制触发：让它像任何普通一次性任务一样，
    // 由调度器在到达 schedule 时间后的下一次 tick 自然执行（原因见函数注释）。
    const rawAfterRun = await waitForCronJobExecuted(botId, tempId);
    const deliveryErrorRaw = rawAfterRun?.last_delivery_error;
    const deliveryError = typeof deliveryErrorRaw === "string" && deliveryErrorRaw.trim()
      ? deliveryErrorRaw.trim()
      : null;
    const lastStatusRaw = rawAfterRun?.last_status;
    const output = typeof lastStatusRaw === "string" && lastStatusRaw.trim() ? lastStatusRaw.trim() : "ok";
    return { output, deliveryError };
  } finally {
    await removeCronJob(botId, tempId).catch(() => { /* 清理失败不影响本次结果 */ });
  }
}

export async function removeCronJob(botId: string, id: string): Promise<void> {
  await execCommand(botId, `hermes cron remove ${shellQuote(id)}`);
}

/** 编辑已存在 cron job：传入要更新的字段，未传不动 */
export async function editCronJob(
  botId: string,
  id: string,
  patch: { schedule?: string; prompt?: string; name?: string; deliver?: string; script?: string },
): Promise<void> {
  const parts = ["hermes", "cron", "edit", shellQuote(id)];
  if (patch.schedule !== undefined) parts.push("--schedule", shellQuote(patch.schedule));
  if (patch.prompt !== undefined) parts.push("--prompt", shellQuote(patch.prompt));
  if (patch.name !== undefined) parts.push("--name", shellQuote(patch.name));
  if (patch.deliver !== undefined) parts.push("--deliver", shellQuote(patch.deliver));
  if (patch.script !== undefined) parts.push("--script", shellQuote(patch.script));
  await execCommand(botId, parts.join(" "));
}
