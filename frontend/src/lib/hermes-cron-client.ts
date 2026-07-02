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
 * 测试运行：立即手动触发一个 cron job 执行一次（不等原定调度时间）。
 *
 * `hermes cron run <id>` 本身就是「立即触发执行」：新建一个独立 Agent 会话、跑
 * prompt、按 deliver 投递结果，命令返回即代表这次执行已经跑完（成功/失败）。
 *
 * ⚠️ 之前这里还会额外调用一次 `hermes cron tick`，是对 Hermes 能力的误解——
 * Hermes CLI 并没有 `cron tick` 子命令（tick 只是调度器内部周期函数的名字，不是
 * 可执行的 CLI 命令），额外调用一条不存在的子命令必定报错，导致「测试运行」
 * 即使 `cron run` 已经成功也总是被判定为失败。这里去掉这条多余且必错的调用，
 * 做法与「发送测试消息」一致：一条命令、直接拿 exec 的成功/失败结果。
 */
export async function runCronJob(botId: string, id: string): Promise<DebugExecPayload> {
  return execCommand(botId, `hermes cron run ${shellQuote(id)}`);
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
