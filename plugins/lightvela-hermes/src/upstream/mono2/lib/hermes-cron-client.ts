// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * Hermes cron 客户端
 *
 * 通过 mono ctl 的 `POST /v1/instances/:target/debug/exec` 在 bot sandbox 内
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
import { resolveConfiguredAuthApiBaseUrl } from "./auth-api-base";
import { createDebugExecRequestBody } from "./debug-exec-request";
import {
  getHermesProfileRootCommand,
  toHermesNativeProfileId,
  withHermesAgent,
} from "./hermes-agent-command";
import {
  AUTH_UNAUTHORIZED_EVENT,
  readStoredAuthToken,
  writeStoredAuthToken,
} from "../repositories/http-repositories";

const LOCAL_PREVIEW_AUTH_ENABLED =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_LOCAL_PREVIEW_AUTH === "1")
  || (typeof process !== "undefined" && process.env.VITE_LOCAL_PREVIEW_AUTH === "1")
  || import.meta.env?.VITE_LOCAL_PREVIEW_AUTH === "1";
const LOCAL_PREVIEW_BOT_ID = "bot_local_preview";

function isLocalPreviewBot(botId: string): boolean {
  return LOCAL_PREVIEW_AUTH_ENABLED && botId === LOCAL_PREVIEW_BOT_ID;
}

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
  /** `hermes cron list --all` 返回的当前执行状态，如 running/completed/failed。 */
  execution_status?: string | null;
  created_at: string | null;
  script: string;
  effective_window: CronEffectiveWindow | null;
  lightvela_schedule: CronLightVelaSchedule | null;
  /** Hermes 原生上游任务 ID；null 表示未关联上游。 */
  context_from: string[] | null;
  /** 是否已从 jobs.json 对该任务的 context_from 完成可信水合。 */
  context_from_hydrated?: boolean;
  /** jobs.json 中的任务级推理绑定；null 表示当前无法安全确认。 */
  inference_config: CronInferenceConfig | null;
  /** LightVela 能安全识别的 0 Token 产品配置；外部 no_agent 任务也会有只读兜底。 */
  zero_token_config?: CronZeroTokenConfig | null;
}

export interface CronInferenceConfig {
  provider: string | null;
  model: string | null;
  no_agent: boolean;
}

export type CronZeroTokenKind = "fixed_notification" | "script";
export type CronScriptLanguage = "bash" | "python";

export interface CronZeroTokenConfig {
  kind: CronZeroTokenKind;
  language: CronScriptLanguage;
  /** 只有 LightVela 受管理脚本才返回正文；外部脚本保持 null，避免误判所有权。 */
  content: string | null;
  managed: boolean;
  editable: boolean;
}

export type CronContextCapability = "supported" | "unsupported" | "unknown";

export type CronContextPatch = undefined | string[];

export type CronjobToolPayload = Record<string, unknown> & {
  action: "create" | "update" | "remove";
};

interface CronjobToolResult {
  success: true;
  job_id?: string;
  job?: Record<string, unknown>;
}

export interface CronDependentBinding {
  id: string;
  name: string;
  contextFrom: readonly string[];
}

interface CronDependentMutationSummary {
  success: boolean;
  updated: string[];
  rollback_failed: string[];
  error?: string;
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

export interface CronZeroTokenScriptConfig extends CronLightVelaScriptConfig {
  kind: CronZeroTokenKind;
  language: CronScriptLanguage;
  content: string;
}

export interface CronRunRecord {
  id: string;
  job_id: string;
  job_name: string;
  job_prompt: string;
  skills: string[];
  schedule: CronJob["schedule"] | null;
  deliver: string;
  run_at: string;
  status: string | null;
  output_path: string;
  /** 该次执行所属的 0 Token 产品类型；普通 Agent 任务不设置。 */
  zero_token_config?: CronZeroTokenConfig | null;
  skip_reason?: "model_changed";
}

/** 调用方传给 create() 的入参 */
export interface CreateCronJobInput {
  /** Hermes schedule 字符串，例：`0 9 * * *` / `every 2h` / `2026-05-26T09:00:00` */
  schedule: string;
  /** 任务提示词 */
  prompt?: string;
  /** 任务名称 */
  name: string;
  /** 可选附加技能 slug 列表 */
  skills?: string[];
  /** 可选 deliver target：local（默认）/ weixin / wecom / telegram / origin / 等 */
  deliver?: string;
  /** 可选 pre-run script 文件名，文件需位于 ~/.hermes/scripts/ */
  script?: string;
  /** Hermes script-only 模式；必须提供 script，且不携带 prompt/Skill/model。 */
  noAgent?: boolean;
  /**
   * 创建后尽力把任务模型显式钉住（避免后续切换全局默认模型导致 fail-closed 停跑）。
   * 默认 false，避免影响旧调用方与单测语义。
   */
  pinCurrentModel?: boolean;
}

export interface EditCronJobPatch {
  schedule?: string;
  prompt?: string;
  name?: string;
  deliver?: string;
  script?: string;
  model?: string;
  /** undefined = keep existing; [] = clear; non-empty = replace with these slugs */
  skills?: string[];
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
  invocation_id?: string;
  command_id?: string;
  start_time?: string;
  end_time?: string;
}

export interface HermesAutomationBlueprintField {
  name: string;
  type: string;
  label: string;
  default: unknown;
  options: string[];
  optional: boolean;
  strict: boolean;
  help: string;
}

export interface HermesAutomationBlueprint {
  key: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  fields: HermesAutomationBlueprintField[];
  scheduleHuman: string;
  spec: {
    name: string;
    prompt: string;
    schedule: string;
    deliver: string;
    skills: string[];
  };
}

export interface ExecCommandStreamOptions {
  signal?: AbortSignal;
  onOutput?: (output: string) => void;
}

export type HermesCronTarget = string | {
  instanceId: string;
  profileId: string;
};

function resolveCronTarget(target: HermesCronTarget): { instanceId: string; profileId?: string } {
  return typeof target === "string"
    ? { instanceId: target }
    : { instanceId: target.instanceId, profileId: target.profileId };
}

export function scopeHermesCronCommand(command: string, profileId?: string): string {
  if (!profileId) return command;
  const nativeProfileId = toHermesNativeProfileId(profileId);
  let scoped = command.replace(/\bhermes\s+(?=(?:cron|send)\b)/g, `hermes -p ${shellQuote(nativeProfileId)} `);
  if (/^acli channel\s/.test(scoped.trim())) {
    scoped = withHermesAgent(scoped, profileId);
  }
  scoped = scoped
    .replace(/~\/\.hermes\/(cron|scripts)\/([A-Za-z0-9._/-]+)/g, '"$HERMES_PROFILE_ROOT/$1/$2"')
    .replace(/~\/\.hermes\/(cron|scripts)\b/g, '"$HERMES_PROFILE_ROOT/$1"');
  const profileRoot = getHermesProfileRootCommand(profileId);
  const directCronTool = command.includes("from tools.cronjob_tools import cronjob");
  return `${profileRoot}; export HERMES_PROFILE_ROOT; ${directCronTool ? 'export HERMES_HOME="$HERMES_PROFILE_ROOT"; ' : ""}${scoped}`;
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
  skip_reason?: unknown;
  job_name?: unknown;
  job_prompt?: unknown;
  job_skills?: unknown;
  job_schedule?: unknown;
  job_deliver?: unknown;
  job_last_run_at?: unknown;
  job_last_status?: unknown;
  job_no_agent?: unknown;
  job_script?: unknown;
  job_zero_token_kind?: unknown;
  job_zero_token_language?: unknown;
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

const AUTOMATION_BLUEPRINT_CATALOG_MARKER = "LIGHTVELA_AUTOMATION_BLUEPRINT_CATALOG=";

export function buildListAutomationBlueprintsCommand(): string {
  const script = [
    "import json",
    "from cron.blueprint_catalog import CATALOG, blueprint_catalog_entry, fill_blueprint",
    "rows = []",
    "for blueprint in CATALOG:",
    "    try:",
    "        row = blueprint_catalog_entry(blueprint)",
    '        row["spec"] = fill_blueprint(blueprint, {})',
    "        rows.append(row)",
    "    except Exception:",
    "        continue",
    `print("${AUTOMATION_BLUEPRINT_CATALOG_MARKER}" + json.dumps(rows, ensure_ascii=False))`,
  ].join("\n");
  return `cd "$HOME/.hermes/hermes-agent" && ./venv/bin/python -B -c ${shellQuote(script)}`;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function parseAutomationBlueprintField(value: unknown): HermesAutomationBlueprintField | null {
  if (!isRecord(value)) return null;
  if (typeof value.name !== "string" || typeof value.type !== "string" || typeof value.label !== "string") {
    return null;
  }
  return {
    name: value.name,
    type: value.type,
    label: value.label,
    default: value.default,
    options: asStringArray(value.options),
    optional: value.optional === true,
    strict: value.strict !== false,
    help: typeof value.help === "string" ? value.help : "",
  };
}

export function parseAutomationBlueprintCatalog(output: string): HermesAutomationBlueprint[] {
  const markerLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(AUTOMATION_BLUEPRINT_CATALOG_MARKER))
    .at(-1);
  const payload = markerLine
    ? markerLine.slice(AUTOMATION_BLUEPRINT_CATALOG_MARKER.length)
    : output.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const blueprints: HermesAutomationBlueprint[] = [];
  for (const value of parsed) {
    if (!isRecord(value) || !isRecord(value.spec)) continue;
    const spec = value.spec;
    if (
      typeof value.key !== "string"
      || typeof value.title !== "string"
      || typeof value.description !== "string"
      || typeof value.category !== "string"
      || typeof value.scheduleHuman !== "string"
      || !Array.isArray(value.fields)
      || typeof spec.name !== "string"
      || typeof spec.prompt !== "string"
      || typeof spec.schedule !== "string"
    ) continue;
    const fields = value.fields.map(parseAutomationBlueprintField);
    if (fields.some((field) => field === null)) continue;
    blueprints.push({
      key: value.key,
      title: value.title,
      description: value.description,
      category: value.category,
      tags: asStringArray(value.tags),
      fields: fields as HermesAutomationBlueprintField[],
      scheduleHuman: value.scheduleHuman,
      spec: {
        name: spec.name,
        prompt: spec.prompt,
        schedule: spec.schedule,
        deliver: typeof spec.deliver === "string" ? spec.deliver : "local",
        skills: asStringArray(spec.skills),
      },
    });
  }
  return blueprints;
}

export async function listAutomationBlueprints(target: HermesCronTarget): Promise<HermesAutomationBlueprint[]> {
  if (isLocalPreviewBot(resolveCronTarget(target).instanceId)) return [];
  const payload = await execCommand(target, buildListAutomationBlueprintsCommand());
  return parseAutomationBlueprintCatalog(payload.output || "");
}

export function normalizeCronContextFrom(value: unknown): string[] | null {
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const normalized = [...new Set(values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
  return normalized.length > 0 ? normalized : null;
}

const CRON_CONTEXT_CAPABILITY_MARKER = "LIGHTVELA_CRON_CONTEXT_CAPABILITY=";
const CRON_CONTEXT_RESULT_MARKER = "LIGHTVELA_CRON_CONTEXT_RESULT=";

export function buildDetectCronContextFromCapabilityCommand(): string {
  const script = [
    "import inspect, json",
    "from tools.cronjob_tools import cronjob",
    'supported = "context_from" in inspect.signature(cronjob).parameters',
    `print("${CRON_CONTEXT_CAPABILITY_MARKER}" + json.dumps({"supported": supported}))`,
  ].join("\n");
  return `cd "$HOME/.hermes/hermes-agent" && ./venv/bin/python -c ${shellQuote(script)}`;
}

export function parseCronContextCapabilityOutput(output: string): CronContextCapability {
  const markerLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(CRON_CONTEXT_CAPABILITY_MARKER))
    .at(-1);
  if (!markerLine) return "unknown";
  try {
    const parsed: unknown = JSON.parse(markerLine.slice(CRON_CONTEXT_CAPABILITY_MARKER.length));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const supported = (parsed as Record<string, unknown>).supported;
      if (supported === true) return "supported";
      if (supported === false) return "unsupported";
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

export function buildCronjobToolCommand(payload: CronjobToolPayload): string {
  const serializedPayload = JSON.stringify(payload);
  const script = [
    "import json",
    "from tools.cronjob_tools import cronjob",
    `payload = json.loads(${JSON.stringify(serializedPayload)})`,
    "result = cronjob(**payload)",
    "parsed = json.loads(result)",
    `print("${CRON_CONTEXT_RESULT_MARKER}" + json.dumps(parsed, ensure_ascii=False))`,
  ].join("\n");
  return `cd "$HOME/.hermes/hermes-agent" && ./venv/bin/python -c ${shellQuote(script)}`;
}

function cronjobToolOutputError(code: string): CronCommandError {
  return new CronCommandError({
    command: "cronjob",
    output: code,
    status: "CRONJOB_TOOL_FAILED",
    exitCode: 1,
  });
}

export function parseCronjobToolOutput(output: string): CronjobToolResult {
  const markerLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(CRON_CONTEXT_RESULT_MARKER))
    .at(-1);
  if (!markerLine) throw cronjobToolOutputError("missing result marker");

  let parsed: unknown;
  try {
    parsed = JSON.parse(markerLine.slice(CRON_CONTEXT_RESULT_MARKER.length));
  } catch {
    throw cronjobToolOutputError("invalid result payload");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw cronjobToolOutputError("invalid result payload");
  }
  const record = parsed as Record<string, unknown>;
  if (record.success !== true) throw cronjobToolOutputError("cronjob operation failed");
  const job = record.job;
  if (job !== undefined && (!job || typeof job !== "object" || Array.isArray(job))) {
    throw cronjobToolOutputError("invalid result job");
  }
  const jobId = typeof record.job_id === "string" ? record.job_id.trim() : "";
  return {
    success: true,
    ...(jobId ? { job_id: jobId } : {}),
    ...(job === undefined ? {} : { job: job as Record<string, unknown> }),
  };
}

export async function detectCronContextFromCapability(target: HermesCronTarget): Promise<CronContextCapability> {
  try {
    const payload = await execCommand(target, buildDetectCronContextFromCapabilityCommand());
    return parseCronContextCapabilityOutput(payload.output || "");
  } catch {
    return "unknown";
  }
}

/** 拼装一条 hermes cron 命令行 */
export function buildCreateCommand(input: CreateCronJobInput): string {
  const parts = ["hermes", "cron", "create", shellQuote(input.schedule)];
  if (input.noAgent) {
    if (!input.script) throw new Error("no-agent cron job requires a script");
    parts.push("--no-agent", "--script", shellQuote(input.script), "--name", shellQuote(input.name));
  } else {
    if (!input.prompt?.trim()) throw new Error("agent cron job requires a prompt");
    parts.push(shellQuote(input.prompt), "--name", shellQuote(input.name));
    for (const skill of input.skills ?? []) {
      parts.push("--skill", shellQuote(skill));
    }
  }
  // deliver=local 是 hermes CLI 默认，省略以减少噪声
  if (input.deliver && input.deliver !== "local") {
    parts.push("--deliver", shellQuote(input.deliver));
  }
  if (input.script && !input.noAgent) {
    parts.push("--script", shellQuote(input.script));
  }
  return parts.join(" ");
}

/** 关闭 Hermes 默认的 Cronjob/job_id 包装，只投递任务本身的最终消息。 */
export function buildSetCleanCronDeliveryCommand(): string {
  const script = [
    "from pathlib import Path",
    "import os, yaml",
    "root = Path(os.environ.get('HERMES_PROFILE_ROOT') or (Path.home() / '.hermes'))",
    "path = root / 'config.yaml'",
    "path.parent.mkdir(parents=True, exist_ok=True)",
    "config = yaml.safe_load(path.read_text(encoding='utf-8')) if path.exists() else {}",
    "config = config if isinstance(config, dict) else {}",
    "config.setdefault('cron', {})['wrap_response'] = False",
    "path.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True), encoding='utf-8')",
  ].join("\n");
  return `~/.hermes/hermes-agent/venv/bin/python -c ${shellQuote(script)}`;
}

export async function ensureCleanCronDelivery(target: HermesCronTarget): Promise<void> {
  await execCommand(target, buildSetCleanCronDeliveryCommand());
}

/** 拼装编辑命令；Skill 使用三态区分保持、替换与清空。 */
export function buildEditCommand(id: string, patch: EditCronJobPatch): string {
  const parts = ["hermes", "cron", "edit", shellQuote(id)];
  if (patch.schedule !== undefined) parts.push("--schedule", shellQuote(patch.schedule));
  if (patch.prompt !== undefined) parts.push("--prompt", shellQuote(patch.prompt));
  if (patch.name !== undefined) parts.push("--name", shellQuote(patch.name));
  if (patch.deliver !== undefined) parts.push("--deliver", shellQuote(patch.deliver));
  if (patch.script !== undefined) parts.push("--script", shellQuote(patch.script));
  if (patch.model !== undefined) parts.push("--model", shellQuote(patch.model));
  if (patch.skills !== undefined) {
    if (patch.skills.length === 0) {
      parts.push("--clear-skills");
    } else {
      for (const skill of patch.skills) parts.push("--skill", shellQuote(skill));
    }
  }
  return parts.join(" ");
}

/** 同步执行一条命令；非零 exit_code 抛 CronCommandError */
export async function execCommand(target: HermesCronTarget, command: string): Promise<DebugExecPayload> {
  const baseUrl = resolveConfiguredAuthApiBaseUrl();
  if (baseUrl === null) {
    throw new Error("[hermes-cron] auth API base URL not configured");
  }
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = readStoredAuthToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const { instanceId, profileId } = resolveCronTarget(target);
  const routedCommand = scopeHermesCronCommand(command, profileId);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/instances/${encodeURIComponent(instanceId)}/debug/exec`;
  const resp = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(createDebugExecRequestBody(routedCommand)),
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

export async function execCommandStream(
  target: HermesCronTarget,
  command: string,
  options: ExecCommandStreamOptions = {},
): Promise<DebugExecPayload> {
  const baseUrl = resolveConfiguredAuthApiBaseUrl();
  if (baseUrl === null) {
    throw new Error("[hermes-cron] auth API base URL not configured");
  }
  const headers = new Headers({
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
  });
  const token = readStoredAuthToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const { instanceId, profileId } = resolveCronTarget(target);
  const routedCommand = scopeHermesCronCommand(command, profileId);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/instances/${encodeURIComponent(instanceId)}/debug/exec`;
  const resp = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers,
    signal: options.signal,
    body: JSON.stringify({ command: routedCommand, run_as_user: "agentuser" }),
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
      const errBody = (await resp.json()) as DebugExecErrorPayload;
      detail = errBody?.message ?? errBody?.error ?? "";
    } catch { /* ignore */ }
    throw new CronCommandError({
      command,
      output: detail || `HTTP ${resp.status}`,
      status: `HTTP ${resp.status}`,
      exitCode: -1,
    });
  }

  const reader = resp.body?.getReader();
  if (!reader) {
    throw new CronCommandError({
      command,
      output: "response body is not readable",
      status: "BAD_RESPONSE",
      exitCode: -1,
    });
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let accumulatedOutput = "";
  let finalPayload: DebugExecPayload | null = null;

  const handleEvent = (part: string) => {
    const parsed = parseDebugExecSseEvent(part);
    if (!parsed) return;
    if ((parsed.eventType === "stdout" || parsed.eventType === "stderr") && typeof parsed.data.chunk === "string") {
      accumulatedOutput += parsed.data.chunk;
      options.onOutput?.(accumulatedOutput);
      return;
    }
    if (parsed.eventType === "finished" && isRecord(parsed.data.response)) {
      const response = parsed.data.response;
      finalPayload = {
        status: typeof response.status === "string" ? response.status : "SUCCESS",
        exit_code: typeof response.exit_code === "number" ? response.exit_code : 0,
        output: typeof response.output === "string" ? response.output : accumulatedOutput,
        invocation_id: typeof response.invocation_id === "string" ? response.invocation_id : typeof parsed.data.invocation_id === "string" ? parsed.data.invocation_id : undefined,
        command_id: typeof response.command_id === "string" ? response.command_id : typeof parsed.data.command_id === "string" ? parsed.data.command_id : undefined,
        start_time: typeof response.start_time === "string" ? response.start_time : undefined,
        end_time: typeof response.end_time === "string" ? response.end_time : undefined,
      };
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) handleEvent(part);
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleEvent(buffer);

  const payload = finalPayload ?? {
    status: accumulatedOutput ? "SUCCESS" : "FAILED",
    exit_code: accumulatedOutput ? 0 : 1,
    output: accumulatedOutput,
  };
  const ok = payload.exit_code === 0 && payload.status?.toUpperCase() !== "FAILED";
  if (!ok) {
    throw new CronCommandError({
      command,
      output: payload.output || accumulatedOutput,
      status: payload.status || "FAILED",
      exitCode: payload.exit_code ?? -1,
    });
  }
  return payload;
}

function parseDebugExecSseEvent(part: string): { eventType: string; data: Record<string, unknown> } | null {
  const lines = part.split("\n");
  let eventType = "";
  let dataStr = "";
  for (const line of lines) {
    if (line.startsWith("event: ")) eventType = line.slice(7).trim();
    else if (line.startsWith("data: ")) dataStr += line.slice(6);
  }
  if (!dataStr) return null;
  try {
    const data = JSON.parse(dataStr) as unknown;
    return isRecord(data) ? { eventType, data } : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
export async function listCronJobs(
  target: HermesCronTarget,
  { hydrateContextFrom = true }: { hydrateContextFrom?: boolean } = {},
): Promise<CronJob[]> {
  if (isLocalPreviewBot(resolveCronTarget(target).instanceId)) return [];
  // 必须带 --all：默认 list 只展示 active jobs，paused/disabled 的会被过滤掉，
  // 导致前端暂停操作后整张卡片消失（看起来像被删除）。
  const command = "hermes cron list --all";
  const payload = await execCommand(target, command);
  const text = (payload.output || "").trimEnd();
  if (!text.trim() || /no scheduled jobs/i.test(text)) return [];
  // 「测试运行」会创建用完即焚的临时任务（名字末尾带一段不可见的零宽 marker，见
  // `buildTestRunMarker`），执行完会自动删除；但删除前存在的短暂窗口内
  // 如果用户恰好刷新列表，不应该让这类内部实现细节暴露给前端。
  const jobs = parseCronListOutput(text).filter((job) => !isTestRunMarkerName(job.name));
  // hermes cron list 文本输出不含 prompt；额外尝试读 jobs.json 补 prompt 字段
  // 文件不存在/读不到时静默跳过，仅影响 prompt 显示，不影响列表本身
  try {
    const fileText = await readCronJobsJsonFile(target);
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
      const contextFromById = new Map<string, string[] | null>();
      const contextHydratedIds = new Set<string>();
      const inferenceConfigById = new Map<string, CronInferenceConfig>();
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
        if (hydrateContextFrom) {
          contextFromById.set(id, normalizeCronContextFrom(r.context_from));
          contextHydratedIds.add(id);
        }
        inferenceConfigById.set(id, {
          provider: typeof r.provider === "string" && r.provider.trim() ? r.provider.trim() : null,
          model: typeof r.model === "string" && r.model.trim() ? r.model.trim() : null,
          no_agent: r.no_agent === true,
        });
      }
      for (const j of jobs) {
        const p = promptById.get(j.id);
        if (p) j.prompt = p;
        const c = createdAtById.get(j.id);
        if (c) j.created_at = c;
        const script = scriptById.get(j.id);
        if (script) j.script = script;
        if (hydrateContextFrom) {
          j.context_from = contextFromById.get(j.id) ?? null;
          j.context_from_hydrated = contextHydratedIds.has(j.id);
        }
        j.inference_config = inferenceConfigById.get(j.id) ?? null;
      }
    }
  } catch {
    /* 读 jobs.json 失败不阻断列表 */
  }
  await hydrateEffectiveWindows(target, jobs);
  await archiveCronJobMetadata(target);
  return jobs;
}

export async function listRecentCronRuns(
  target: HermesCronTarget,
  jobs: CronJob[],
  limit = 10,
): Promise<CronRunRecord[]> {
  const payload = await execCommand(target, buildListRecentCronRunsCommand(limit));
  return parseCronRunFilesOutput(payload.output || "", jobs);
}

function buildListRecentCronRunsCommand(limit: number): string {
  const normalizedLimit = Math.max(1, Math.min(50, Math.floor(limit) || 10));
  const script = [
    "import datetime, json, os",
    "from pathlib import Path",
    `limit = ${normalizedLimit}`,
    "root = Path(os.environ.get('HERMES_PROFILE_ROOT') or (Path.home() / '.hermes'))",
    "base = root / 'cron' / 'output'",
    "jobs_path = root / 'cron' / 'jobs.json'",
    "archive_path = root / 'cron' / 'lightvela-jobs-meta.json'",
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
    "                'job_skills': job.get('skills') or job.get('job_skills') or [],",
    "                'job_schedule': job.get('schedule') or job.get('job_schedule'),",
    "                'job_deliver': job.get('deliver') or job.get('job_deliver') or '',",
    "                'job_last_run_at': job.get('last_run_at') or job.get('job_last_run_at') or '',",
    "                'job_last_status': job.get('last_status') or job.get('job_last_status') or '',",
    "                'job_no_agent': job.get('no_agent') is True or job.get('job_no_agent') is True,",
    "                'job_script': job.get('script') or job.get('job_script') or '',",
    "                'job_zero_token_kind': job.get('zero_token_kind') or job.get('job_zero_token_kind') or '',",
    "                'job_zero_token_language': job.get('zero_token_language') or job.get('job_zero_token_language') or '',",
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
    "    model_changed = all(marker in lowered for marker in [",
    "        'skipped to prevent unintended spend',",
    "        'global inference config drifted since this job was created',",
    "    ])",
    "    if model_changed:",
    "        return {'output_status': 'not_executed', 'agent_skipped': False, 'skip_reason': 'model_changed'}",
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
    "import base64, json, os, re",
    "from pathlib import Path",
    "root = Path(os.environ.get('HERMES_PROFILE_ROOT') or (Path.home() / '.hermes'))",
    "cron_dir = root / 'cron'",
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
    "        script_name = str(job.get('script') or '')",
    "        no_agent = job.get('no_agent') is True",
    "        zero_token_kind = ''",
    "        zero_token_language = ''",
    "        if no_agent and re.fullmatch(r'lightvela-zero-token-[a-z0-9-]+\\.py', script_name):",
    "            try:",
    "                script_text = (root / 'scripts' / script_name).read_text(encoding='utf-8')",
    "                match = re.search(r'^META_B64 = \"([A-Za-z0-9+/=]+)\"$', script_text, re.MULTILINE)",
    "                meta = json.loads(base64.b64decode(match.group(1)).decode('utf-8')) if match else {}",
    "                if meta.get('kind') in ('fixed_notification', 'script'):",
    "                    zero_token_kind = meta.get('kind')",
    "                if meta.get('language') in ('bash', 'python'):",
    "                    zero_token_language = meta.get('language')",
    "            except Exception:",
    "                pass",
    "        archive[job_id] = {",
    "            'id': job_id,",
    "            'name': job.get('name') or '',",
    "            'prompt': job.get('prompt') or '',",
    "            'skills': job.get('skills') or [],",
    "            'schedule': job.get('schedule'),",
    "            'deliver': job.get('deliver') or '',",
    "            'last_run_at': job.get('last_run_at') or '',",
    "            'last_status': job.get('last_status') or '',",
    "            'no_agent': no_agent,",
    "            'script': script_name,",
    "            'zero_token_kind': zero_token_kind,",
    "            'zero_token_language': zero_token_language,",
    "        }",
    "cron_dir.mkdir(parents=True, exist_ok=True)",
    "archive_path.write_text(json.dumps(archive, ensure_ascii=False), encoding='utf-8')",
  ].join("\n");
  return `python3 -c ${shellQuote(script)}`;
}

async function archiveCronJobMetadata(target: HermesCronTarget): Promise<void> {
  try {
    await execCommand(target, buildArchiveCronJobMetadataCommand());
  } catch {
    /* 元信息归档失败不影响主流程 */
  }
}

/**
 * 把执行记录里要展示给用户的任务名规范化（纵深防御，第二道防线）。
 *
 * 正常情况下 `parseCronRunFilesOutput` 已在入口把测试运行临时任务记录整条过滤掉
 * （见 CR P2），不会再走到这里带 marker 的名字。但万一有边界场景漏过（如 archive
 * meta 缺失只剩 output 目录、名字来源异常），这里再兜一层：识别到零宽 marker 就
 * 剥掉 marker/反查原任务名，绝不把零宽字符或内部临时串暴露给用户。
 *   - 是测试运行临时任务 → 剥掉零宽 marker，用可读部分（`{原任务名}测试运行`）；
 *     可读部分意外为空则按 marker 里编码的原 jobId 前缀反查原任务名，再兜底成「测试运行」。
 *   - 非测试运行任务 → 原样返回。
 */
function displayNameForRun(rawName: string, jobs: CronJob[]): string {
  if (!isTestRunMarkerName(rawName)) return rawName;
  const visible = stripTestRunMarker(rawName).trim();
  if (visible) return visible;
  const idPrefix = parseTestRunMarkerJobIdPrefix(rawName);
  const origin = idPrefix ? jobs.find((job) => job.id.startsWith(idPrefix)) : undefined;
  const originName = (origin?.name || "").trim();
  return originName ? `${originName}测试运行` : "测试运行";
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
    const inferredStatus = inferRunStatus(row, job);
    const modelChanged = row.skip_reason === "model_changed"
      || isModelConfigDriftMessage(inferredStatus);
    const rawName = modelChanged
      ? firstNonModelConfigDriftText(job?.name, row.job_name, jobId)
      : job?.name || stringValue(row.job_name) || jobId;
    const jobPrompt = modelChanged
      ? firstNonModelConfigDriftText(job?.prompt, row.job_prompt)
      : job?.prompt || stringValue(row.job_prompt);
    const rowNoAgent = row.job_no_agent === true;
    const isZeroToken = job?.inference_config?.no_agent === true || rowNoAgent;
    const archivedScript = stringValue(row.job_script);
    const archivedKind = row.job_zero_token_kind === "fixed_notification" ? "fixed_notification" : "script";
    const archivedLanguage = (row.job_zero_token_language === "bash"
      || (!row.job_zero_token_language && /\.(?:sh|bash)$/i.test(archivedScript)))
      ? "bash"
      : "python";
    const zeroTokenConfig = job?.zero_token_config ?? (isZeroToken
      ? {
          kind: archivedKind,
          language: archivedLanguage,
          content: null,
          managed: false,
          editable: false,
        } satisfies CronZeroTokenConfig
      : null);
    // 「测试运行」创建的临时任务是内部实现细节，不应出现在「最近执行」里：它的
    // cron output 目录在任务删除后仍存在，archive/jobs_meta 里也可能留有其 meta，
    // 导致这里解析出带零宽 marker 的临时任务名/临时 job id。凡是 job.name 或
    // archive 里的 job_name 任一命中 marker，都直接过滤掉，避免内部实现细节
    // （零宽 marker 名 / 临时 job id）泄漏到用户界面（见 CR P2）。
    if (isTestRunMarkerName(job?.name ?? "") || isTestRunMarkerName(stringValue(row.job_name))) {
      continue;
    }
    records.push({
      id: `${jobId}:${outputPath || runAt}`,
      job_id: jobId,
      job_name: displayNameForRun(rawName, jobs),
      job_prompt: jobPrompt,
      skills: job?.skills ?? normalizeRunSkills(row.job_skills),
      schedule: job?.schedule ?? rowSchedule,
      deliver: job?.deliver || stringValue(row.job_deliver),
      run_at: runAt,
      status: modelChanged ? "not_executed" : inferredStatus,
      output_path: outputPath,
      ...(zeroTokenConfig ? { zero_token_config: zeroTokenConfig } : {}),
      ...(modelChanged ? { skip_reason: "model_changed" as const } : {}),
    });
  }
  return records;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeRunSkills(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isModelConfigDriftMessage(value: unknown): boolean {
  const normalized = stringValue(value).toLowerCase();
  return normalized.includes("skipped to prevent unintended spend")
    && normalized.includes("global inference config drifted since this job was created");
}

function firstNonModelConfigDriftText(...values: unknown[]): string {
  for (const value of values) {
    const text = stringValue(value);
    if (text && !isModelConfigDriftMessage(text)) return text;
  }
  return "";
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
async function readCronJobsJsonFile(target: HermesCronTarget): Promise<string> {
  try {
    const payload = await execCommand(
      target,
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
        enabled: !["paused", "disabled"].includes(stateRaw.toLowerCase()),
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
    else if (key === "execution") current.execution_status = value.split(/\s+/, 1)[0]?.toLowerCase() || null;
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
    execution_status: p.execution_status || null,
    created_at: p.created_at || null,
    script: p.script || "",
    effective_window: p.effective_window || null,
    lightvela_schedule: p.lightvela_schedule || null,
    context_from: p.context_from || null,
    context_from_hydrated: p.context_from_hydrated === true,
    inference_config: p.inference_config || null,
    zero_token_config: p.zero_token_config || null,
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

interface ZeroTokenScriptMetadata {
  version: 1;
  kind: CronZeroTokenKind;
  language: CronScriptLanguage;
  content: string;
  start_at: string;
  end_at: string;
  weekdays: number[];
  daily_times: string[];
}

const ZERO_TOKEN_SCRIPT_MARKER = "lightvela-zero-token-v1";
const ZERO_TOKEN_METADATA_PREFIX = "META_B64 = ";

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function normalizeZeroTokenMetadata(args: CronZeroTokenScriptConfig): ZeroTokenScriptMetadata {
  const weekdays = Array.isArray(args.weekdays)
    ? Array.from(new Set(args.weekdays.filter((value) => Number.isInteger(value) && value >= 0 && value <= 6)))
      .sort((left, right) => left - right)
    : [];
  return {
    version: 1,
    kind: args.kind,
    language: args.language,
    content: args.content,
    start_at: args.start_at ?? "",
    end_at: args.end_at ?? "",
    weekdays,
    daily_times: normalizeDailyScriptTimes(args.daily_times),
  };
}

/** 构建 LightVela 自有的 no-agent wrapper；正文只作为 base64 JSON 数据，不参与代码拼接。 */
export function buildZeroTokenScript(args: CronZeroTokenScriptConfig): string {
  const metadata = normalizeZeroTokenMetadata(args);
  const encodedMetadata = encodeBase64Utf8(JSON.stringify(metadata));
  return [
    "#!/usr/bin/env python3",
    `# ${ZERO_TOKEN_SCRIPT_MARKER}`,
    "import base64",
    "import datetime",
    "import json",
    "import subprocess",
    "import sys",
    "",
    `${ZERO_TOKEN_METADATA_PREFIX}${JSON.stringify(encodedMetadata)}`,
    "meta = json.loads(base64.b64decode(META_B64).decode('utf-8'))",
    "now = datetime.datetime.now()",
    "start_at = datetime.datetime.fromisoformat(meta['start_at']) if meta['start_at'] else None",
    "end_at = datetime.datetime.fromisoformat(meta['end_at']) if meta['end_at'] else None",
    "allowed = True",
    "if start_at is not None and now < start_at:",
    "    allowed = False",
    "if end_at is not None and now > end_at:",
    "    allowed = False",
    "if meta['weekdays'] and now.isoweekday() % 7 not in meta['weekdays']:",
    "    allowed = False",
    "if meta['daily_times'] and now.strftime('%H:%M') not in meta['daily_times']:",
    "    allowed = False",
    "if not allowed:",
    "    raise SystemExit(0)",
    "if meta['kind'] == 'fixed_notification':",
    "    sys.stdout.write(meta['content'])",
    "    raise SystemExit(0)",
    "command = ['bash'] if meta['language'] == 'bash' else [sys.executable]",
    "completed = subprocess.run(command, input=meta['content'], text=True, check=False)",
    "raise SystemExit(completed.returncode)",
    "",
  ].join("\n");
}

export function parseZeroTokenScript(content: string): {
  zeroTokenConfig: CronZeroTokenConfig;
  effectiveWindow: CronEffectiveWindow | null;
  lightvelaSchedule: CronLightVelaSchedule | null;
} | null {
  if (!content.includes(ZERO_TOKEN_SCRIPT_MARKER)) return null;
  const encoded = new RegExp(`^${ZERO_TOKEN_METADATA_PREFIX}"([A-Za-z0-9+/=]+)"$`, "m")
    .exec(content)?.[1];
  if (!encoded) return null;
  try {
    const raw = JSON.parse(decodeBase64Utf8(encoded)) as Partial<ZeroTokenScriptMetadata>;
    if (raw.version !== 1
      || (raw.kind !== "fixed_notification" && raw.kind !== "script")
      || (raw.language !== "bash" && raw.language !== "python")
      || typeof raw.content !== "string") return null;
    const weekdays = Array.isArray(raw.weekdays)
      ? Array.from(new Set(raw.weekdays.filter((value): value is number =>
        Number.isInteger(value) && value >= 0 && value <= 6))).sort((left, right) => left - right)
      : [];
    const dailyTimes = normalizeDailyScriptTimes(raw.daily_times);
    const startAt = typeof raw.start_at === "string" ? raw.start_at : "";
    const endAt = typeof raw.end_at === "string" ? raw.end_at : "";
    return {
      zeroTokenConfig: {
        kind: raw.kind,
        language: raw.language,
        content: raw.content,
        managed: true,
        editable: true,
      },
      effectiveWindow: !startAt && !endAt && weekdays.length === 0
        ? null
        : {
            start_at: startAt || null,
            end_at: endAt || null,
            ...(weekdays.length > 0 ? { weekdays } : {}),
          },
      lightvelaSchedule: dailyTimes.length > 0
        ? { kind: "daily_times", times: dailyTimes }
        : null,
    };
  } catch {
    return null;
  }
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

export function createZeroTokenScriptName(seed: string): string {
  const normalized = seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `lightvela-zero-token-${normalized || "job"}.py`;
}

function isLightVelaEffectiveWindowScript(script: string): boolean {
  return /^lightvela-effective-window-[a-z0-9-]+\.py$/.test(script);
}

export function isLightVelaZeroTokenScriptName(script: string): boolean {
  return /^lightvela-zero-token-[a-z0-9-]+\.py$/.test(script);
}

function isLightVelaManagedScript(script: string): boolean {
  return isLightVelaEffectiveWindowScript(script) || isLightVelaZeroTokenScriptName(script);
}

export async function writeEffectiveWindowScript(
  target: HermesCronTarget,
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
  await execCommand(target, command);
}

export async function removeEffectiveWindowScript(target: HermesCronTarget, scriptName: string): Promise<void> {
  if (!isLightVelaEffectiveWindowScript(scriptName)) {
    throw new Error("invalid LightVela effective window script name");
  }
  await execCommand(target, `rm -f ~/.hermes/scripts/${scriptName}`);
}

export async function writeZeroTokenScript(
  target: HermesCronTarget,
  scriptName: string,
  config: CronZeroTokenScriptConfig,
): Promise<void> {
  if (!isLightVelaZeroTokenScriptName(scriptName)) {
    throw new Error("invalid LightVela zero-token script name");
  }
  const content = buildZeroTokenScript(config);
  const path = `~/.hermes/scripts/${scriptName}`;
  const command = [
    "mkdir -p ~/.hermes/scripts",
    `printf %s ${shellQuote(content)} > ${path}`,
    `chmod 600 ${path}`,
  ].join(" && ");
  await execCommand(target, command);
}

export async function removeZeroTokenScript(target: HermesCronTarget, scriptName: string): Promise<void> {
  if (!isLightVelaZeroTokenScriptName(scriptName)) {
    throw new Error("invalid LightVela zero-token script name");
  }
  await execCommand(target, `rm -f ~/.hermes/scripts/${scriptName}`);
}

interface LightVelaScriptMetadata {
  effectiveWindow: CronEffectiveWindow | null;
  lightvelaSchedule: CronLightVelaSchedule | null;
  zeroTokenConfig: CronZeroTokenConfig | null;
}

async function readLightVelaScripts(
  target: HermesCronTarget,
  scriptNames: string[],
): Promise<Map<string, LightVelaScriptMetadata>> {
  const safeNames = scriptNames.filter(isLightVelaManagedScript);
  const result = new Map<string, LightVelaScriptMetadata>();
  for (const scriptName of safeNames) {
    try {
      const payload = await execCommand(
        target,
        `cat ~/.hermes/scripts/${scriptName} 2>/dev/null || true`,
      );
      const content = payload.output || "";
      const zeroToken = parseZeroTokenScript(content);
      if (zeroToken) {
        result.set(scriptName, {
          effectiveWindow: zeroToken.effectiveWindow,
          lightvelaSchedule: zeroToken.lightvelaSchedule,
          zeroTokenConfig: zeroToken.zeroTokenConfig,
        });
        continue;
      }
      const parsed = parseLightVelaCronScript(content);
      if (parsed.effectiveWindow || parsed.lightvelaSchedule) {
        result.set(scriptName, { ...parsed, zeroTokenConfig: null });
      }
    } catch {
      /* ignore individual script read failures */
    }
  }
  return result;
}

async function hydrateEffectiveWindows(target: HermesCronTarget, jobs: CronJob[]): Promise<void> {
  const scriptNames = Array.from(new Set(
    jobs
      .map((job) => job.script)
      .filter(isLightVelaManagedScript),
  ));
  const metadata = scriptNames.length > 0
    ? await readLightVelaScripts(target, scriptNames)
    : new Map<string, LightVelaScriptMetadata>();
  for (const job of jobs) {
    const scriptMetadata = metadata.get(job.script);
    if (scriptMetadata?.effectiveWindow) job.effective_window = scriptMetadata.effectiveWindow;
    if (scriptMetadata?.lightvelaSchedule) job.lightvela_schedule = scriptMetadata.lightvelaSchedule;
    if (scriptMetadata?.zeroTokenConfig) job.zero_token_config = scriptMetadata.zeroTokenConfig;
    if (job.inference_config?.no_agent && !job.zero_token_config) {
      job.zero_token_config = {
        kind: "script",
        language: /\.(?:sh|bash)$/i.test(job.script) ? "bash" : "python",
        content: null,
        managed: false,
        editable: false,
      };
    }
  }
}

/**
 * `hermes cron create` 的输出里若出现这些错误特征，说明「命令 exit 0 了但其实没建成」。
 *
 * 背景（2026-07-03 实测）：`execCommand` 只在 `exit_code !== 0` 或 `status === "FAILED"`
 * 时抛错。但这套 debug-exec 环境里，`hermes cron create` 遇到部分错误时会把错误打印到
 * stdout 却仍以 exit 0 返回——于是 `createCronJob` 会「假成功」，上层拿不到任何异常，
 * 用户既没收到结果也没看到报错。这里对 output 文本做一层内容级校验，命中错误特征就主动
 * 抛错，把「假成功」转成显式失败。
 */
const CRON_CREATE_FAILURE_PATTERNS: RegExp[] = [
  /\berror\b/i,
  /\bfailed\b/i,
  /\bpanic\b/i,
  /unknown\s+(platform|flag|command|option)/i,
  /invalid\s+(schedule|argument|value)/i,
  /usage:/i,
];

/** 判断 `hermes cron create` 的 stdout 是否暗示「其实没建成」（尽管 exit 0） */
export function detectCronCreateFailure(output: string): string | null {
  const clean = (output ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim();
  if (!clean) return null;
  for (const pattern of CRON_CREATE_FAILURE_PATTERNS) {
    if (pattern.test(clean)) {
      // 回一段末尾几行做诊断文案（错误通常在末尾）
      return clean.split("\n").map((l) => l.trim()).filter(Boolean).slice(-4).join("；") || clean;
    }
  }
  return null;
}

function pickStringValue(raw: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function resolvePinnedModelFromRawCronRecord(raw: Record<string, unknown> | null): string | null {
  if (!raw) return null;
  const directModel = pickStringValue(raw, ["model", "model_id", "modelId", "model_name", "modelName"]);
  if (directModel.includes("/")) return directModel;
  const provider = pickStringValue(raw, ["provider", "provider_name", "providerName", "provider_id", "providerId"]);
  if (directModel && provider) return `${provider}/${directModel}`;
  if (directModel) return directModel;
  const modelObj = raw.model;
  if (modelObj && typeof modelObj === "object") {
    const obj = modelObj as Record<string, unknown>;
    const nestedModel = pickStringValue(obj, ["id", "model", "model_id", "modelId", "name"]);
    const nestedProvider = pickStringValue(obj, ["provider", "provider_name", "providerName", "provider_id", "providerId"]);
    if (nestedModel.includes("/")) return nestedModel;
    if (nestedModel && nestedProvider) return `${nestedProvider}/${nestedModel}`;
    if (nestedModel) return nestedModel;
  }
  return null;
}

function parseRawCronJobsJson(text: string): Record<string, unknown>[] {
  if (!text.trim()) return [];
  const parsed = JSON.parse(text) as unknown;
  const arr: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { jobs?: unknown[] })?.jobs)
      ? (parsed as { jobs: unknown[] }).jobs
      : [];
  return arr.filter((raw): raw is Record<string, unknown> => Boolean(raw && typeof raw === "object"));
}

async function readRawCronJobRecords(target: HermesCronTarget): Promise<Record<string, unknown>[]> {
  const text = await readCronJobsJsonFile(target);
  if (!text) return [];
  try {
    return parseRawCronJobsJson(text);
  } catch {
    return [];
  }
}

async function pinCronJobModelByIdBestEffort(target: HermesCronTarget, jobId: string): Promise<void> {
  const raw = await readRawCronJobRecordById(target, jobId);
  const model = resolvePinnedModelFromRawCronRecord(raw);
  if (!model) return;
  try {
    await editCronJob(target, jobId, { model });
  } catch {
    /* 某些 CLI 版本可能暂不支持 --model，保持 best-effort，不阻断创建流程 */
  }
}

async function pinCronJobModelBestEffort(target: HermesCronTarget, jobName: string): Promise<void> {
  const jobId = await findCronJobIdByExactNameWithRetry(target, jobName);
  if (jobId) await pinCronJobModelByIdBestEffort(target, jobId);
}

export async function createCronJob(target: HermesCronTarget, input: CreateCronJobInput): Promise<void> {
  const payload = await execCommand(target, buildCreateCommand(input));
  // 二次校验：即便 exit 0，也要看 stdout 里有没有错误特征，避免「假成功」（详见上方注释）。
  const failure = detectCronCreateFailure(payload.output || "");
  if (failure) {
    throw new CronCommandError({
      command: buildCreateCommand(input),
      output: failure,
      status: "CREATE_FAILED",
      exitCode: payload.exit_code ?? 0,
    });
  }
  if (input.pinCurrentModel && !input.noAgent) {
    await pinCronJobModelBestEffort(target, input.name);
  }
  await archiveCronJobMetadata(target);
}

export async function createCronJobWithScriptRollback(
  target: HermesCronTarget,
  input: CreateCronJobInput,
  rollbackScript?: string,
): Promise<void> {
  try {
    await createCronJob(target, input);
  } catch (err) {
    if (rollbackScript && isLightVelaManagedScript(rollbackScript)) {
      try {
        if (isLightVelaZeroTokenScriptName(rollbackScript)) {
          await removeZeroTokenScript(target, rollbackScript);
        } else {
          await removeEffectiveWindowScript(target, rollbackScript);
        }
      } catch {
        /* keep the original create error */
      }
    }
    throw err;
  }
}

function buildCronjobCreatePayload(input: CreateCronJobInput, upstreamId: string): CronjobToolPayload {
  const payload: CronjobToolPayload = {
    action: "create",
    schedule: input.schedule,
    name: input.name,
    context_from: [upstreamId],
  };
  if (input.prompt !== undefined) payload.prompt = input.prompt;
  if (input.noAgent) payload.no_agent = true;
  if (input.skills !== undefined && !input.noAgent) payload.skills = input.skills;
  if (input.deliver !== undefined) payload.deliver = input.deliver;
  if (input.script !== undefined) payload.script = input.script;
  return payload;
}

async function executeCronjobTool(target: HermesCronTarget, payload: CronjobToolPayload): Promise<CronjobToolResult> {
  const command = buildCronjobToolCommand(payload);
  let execResult: DebugExecPayload;
  try {
    execResult = await execCommand(target, command);
  } catch {
    throw cronjobToolOutputError("cronjob execution failed");
  }
  return parseCronjobToolOutput(execResult.output || "");
}

export async function createCronJobWithContextAndScriptRollback(
  target: HermesCronTarget,
  input: CreateCronJobInput,
  upstreamId: string,
  rollbackScript?: string,
): Promise<string> {
  try {
    const result = await executeCronjobTool(target, buildCronjobCreatePayload(input, upstreamId));
    const nestedJobId = typeof result.job?.id === "string" ? result.job.id.trim() : "";
    const jobId = result.job_id ?? nestedJobId;
    if (!jobId) throw cronjobToolOutputError("missing created job id");
    if (input.pinCurrentModel && !input.noAgent) await pinCronJobModelByIdBestEffort(target, jobId);
    await archiveCronJobMetadata(target);
    return jobId;
  } catch (error) {
    if (rollbackScript && isLightVelaManagedScript(rollbackScript)) {
      try {
        if (isLightVelaZeroTokenScriptName(rollbackScript)) {
          await removeZeroTokenScript(target, rollbackScript);
        } else {
          await removeEffectiveWindowScript(target, rollbackScript);
        }
      } catch {
        /* keep the original create error */
      }
    }
    throw error;
  }
}

export async function pauseCronJob(target: HermesCronTarget, id: string): Promise<void> {
  await execCommand(target, `hermes cron pause ${shellQuote(id)}`);
}

export async function resumeCronJob(target: HermesCronTarget, id: string): Promise<void> {
  await execCommand(target, `hermes cron resume ${shellQuote(id)}`);
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
export async function runCronJob(target: HermesCronTarget, id: string): Promise<DebugExecPayload> {
  return execCommand(target, `hermes cron run ${shellQuote(id)}`);
}

/** 「测试运行」后缀：用户在 IM 标题里看到的可读部分就以它结尾 */
const TEST_RUN_NAME_SUFFIX = "测试运行";

/**
 * 「测试运行」临时任务名字里嵌入的隐藏 marker。
 *
 * 背景：hermes 投递通知时，标题直接取任务的 `name` 字段（`Cronjob Response: <name>`），
 * 且没有独立的「标题」字段可配。所以标题里必然带 name 的全部内容。而这个 name 又要
 * 同时承担「程序用的内部标识」——列表过滤、执行完精确定位删除、避免和真实任务撞名。
 *
 * 取舍：把内部标识编码成一串**零宽字符**（对用户完全不可见）附在名字末尾。这样
 *   - IM 标题 / 执行记录里用户只看到干净的「{原任务名}测试运行」；
 *   - 程序仍能靠这段零宽 marker 100% 可靠地识别临时任务、精确反查其 id 去清理，
 *     且几乎不可能误伤名字恰好也叫「xx测试运行」的真实任务（真实任务名不会含零宽字符）。
 *
 * 编码用两个零宽字符表示 0/1：`\u200B`=0、`\u200C`=1；首尾各夹一个 `\u2063`
 * （INVISIBLE SEPARATOR）作为 marker 的边界哨兵，便于识别与剥离。
 */
const ZW_SENTINEL = "\u2063"; // marker 边界哨兵（不可见）
const ZW_ZERO = "\u200B"; // 比特 0（不可见）
const ZW_ONE = "\u200C"; // 比特 1（不可见）
/** 匹配「哨兵 + 任意个 0/1 零宽位 + 哨兵」这一整段隐藏 marker */
const ZW_MARKER_RE = new RegExp(`${ZW_SENTINEL}[${ZW_ZERO}${ZW_ONE}]*${ZW_SENTINEL}`);

/** 把一段 ascii 文本编码成零宽比特串（每字符 8 bit） */
function encodeZeroWidth(payload: string): string {
  let bits = "";
  for (const ch of payload) {
    bits += ch.charCodeAt(0).toString(2).padStart(8, "0");
  }
  const zw = bits.replace(/0/g, ZW_ZERO).replace(/1/g, ZW_ONE);
  return `${ZW_SENTINEL}${zw}${ZW_SENTINEL}`;
}

/** 把 `encodeZeroWidth` 产生的零宽 marker 解回原始 ascii 文本；解析不出返回空串 */
function decodeZeroWidth(name: string): string {
  const match = ZW_MARKER_RE.exec(name);
  if (!match) return "";
  const body = match[0].slice(1, -1); // 去掉首尾哨兵
  const bits = body.replace(new RegExp(ZW_ZERO, "g"), "0").replace(new RegExp(ZW_ONE, "g"), "1");
  let out = "";
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    out += String.fromCharCode(parseInt(bits.slice(i, i + 8), 2));
  }
  return out;
}

/**
 * 生成「测试运行」临时任务的名字：`{原任务名}测试运行` + 末尾不可见的零宽 marker。
 *
 * 可见部分就是投递标题会显示的文案；零宽 marker 里编码了「原 jobId 前 8 位 + 随机串」，
 * 既保证名字唯一（反查/清理可靠、不撞名），又能供执行记录反解出原 jobId。
 */
export function buildTestRunMarker(jobId: string, originName?: string): string {
  const visible = `${(originName ?? "").trim()}${TEST_RUN_NAME_SUFFIX}`;
  const token = `${jobId.slice(0, 8)}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${visible}${encodeZeroWidth(token)}`;
}

/** 判断是否为「测试运行」创建的用完即焚临时任务，供 `listCronJobs` 过滤 */
export function isTestRunMarkerName(name: string): boolean {
  return ZW_MARKER_RE.test(name);
}

/**
 * 从测试运行 marker 名字里解析出「原任务 id 的前 8 位」。
 *
 * marker 里零宽段编码的 token 形如 `dcb4fee9_mr4pinvyzd1t82`（原 jobId 前 8 位 + `_` + 随机）。
 * 这里解出前 8 位，供执行记录反查原任务名。解析不出则返回 null。
 */
function parseTestRunMarkerJobIdPrefix(name: string): string | null {
  if (!isTestRunMarkerName(name)) return null;
  const token = decodeZeroWidth(name);
  const prefix = token.split("_")[0] ?? "";
  return prefix || null;
}

/** 去掉名字里的零宽 marker，得到给用户看的干净文案（`{原任务名}测试运行`） */
function stripTestRunMarker(name: string): string {
  return name.replace(ZW_MARKER_RE, "");
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
async function readRawCronJobRecordById(target: HermesCronTarget, jobId: string): Promise<Record<string, unknown> | null> {
  const records = await readRawCronJobRecords(target);
  for (const raw of records) {
    if (String(raw.id ?? "") === jobId) return raw;
  }
  return null;
}

/** 按 name 精确匹配反查 job id（临时任务创建后用这个拿到它的真实 id） */
async function findCronJobIdByExactName(target: HermesCronTarget, name: string): Promise<string | null> {
  const records = await readRawCronJobRecords(target);
  for (const raw of records) {
    if (raw.name === name) {
      const id = String(raw.id ?? "");
      if (id) return id;
    }
  }
  return null;
}

/** 临时任务定位重试参数：覆盖 jobs.json 写入延迟 / 短暂读失败的窗口 */
const TEMP_JOB_LOOKUP_RETRIES = 3;
const TEMP_JOB_LOOKUP_INTERVAL_MS = 500;

/**
 * 按 name 精确反查 job id，失败重试若干次。
 *
 * `createCronJob` 已成功但 jobs.json 可能有写入延迟 / 短暂读失败 / 解析不到 marker，
 * 首次读不到不代表任务没建成。这里带几次快重试（间隔 {@link TEMP_JOB_LOOKUP_INTERVAL_MS}），
 * 尽量拿到刚创建的临时任务 id，避免误判「没定位到」而走清理+报错路径（见 CR P1）。
 */
async function findCronJobIdByExactNameWithRetry(
  target: HermesCronTarget,
  name: string,
  retries = TEMP_JOB_LOOKUP_RETRIES,
  intervalMs = TEMP_JOB_LOOKUP_INTERVAL_MS,
): Promise<string | null> {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const id = await findCronJobIdByExactName(target, name);
    if (id) return id;
    if (attempt < retries) await delay(intervalMs);
  }
  return null;
}

/**
 * 兜底清理：即便反查不到 id，也尽力把「name 精确匹配」的临时任务删掉。
 *
 * 用于 create 成功但 lookup 最终失败的场景（见 CR P1）：先再尝试反查一次 id 去删，
 * 保证任何已创建的临时任务都不会残留后被调度器真实执行。best-effort，找不到就放弃。
 */
async function removeCronJobByExactName(target: HermesCronTarget, name: string): Promise<void> {
  const id = await findCronJobIdByExactNameWithRetry(target, name);
  if (id) await removeCronJob(target, id);
}

/**
 * 把 Hermes / acli 返回的通道名归一化成投递用的 platform key。
 *
 * 与 `agent-automations-panel.tsx` 里的 `normalizeHermesChannelKey` 保持一致
 * （此处独立一份，避免 lib 反向依赖 page 组件文件）。
 */
function normalizeChannelKeyForDeliver(channel: string): string {
  const normalized = channel.trim().toLowerCase();
  if (["wechat", "weixin", "openclaw-weixin", "openclaw-wechat"].includes(normalized)) return "weixin";
  if (["qq", "qqbot", "qq-bot", "qqbotplugin", "openclaw-qqbot", "openclaw-qq"].includes(normalized)) return "qqbot";
  if (["wecom", "wework", "work-weixin", "work-wechat", "openclaw-wecom"].includes(normalized)) return "wecom";
  if (["dingtalk", "openclaw-dingtalk"].includes(normalized)) return "dingtalk";
  if (["feishu", "lark", "larksuite", "openclaw-feishu", "openclaw-lark"].includes(normalized)) return "feishu";
  if (["telegram", "tg", "openclaw-telegram", "openclaw-tg"].includes(normalized)) return "telegram";
  if (["whatsapp", "whats-app", "whatsapp-business", "whatsapp_business", "openclaw-whatsapp"].includes(normalized)) return "whatsapp";
  if (["discord", "openclaw-discord"].includes(normalized)) return "discord";
  if (["slack", "openclaw-slack"].includes(normalized)) return "slack";
  return normalized;
}

/**
 * deliver=origin 但 origin 为空时，兜底选哪个 home channel 的优先级。
 * 排在前面的优先。国内 IM（企业微信/微信/QQ）优先，其次飞书/钉钉，再是国际通道。
 */
const DELIVER_FALLBACK_CHANNEL_PRIORITY = [
  "wecom",
  "weixin",
  "qqbot",
  "feishu",
  "dingtalk",
  "telegram",
  "whatsapp",
  "discord",
  "slack",
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
async function resolveFallbackHomeChannel(target: HermesCronTarget): Promise<string | null> {
  try {
    const payload = await execCommand(target, "acli channel status");
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
 * 2. 原任务 `origin` 为空（典型：在网页「定时任务」面板创建的任务——网页不是
 *    IM 会话，没有"原对话"上下文，`origin` 存成 null）→ 此时若原样保留 `origin`，
 *    临时任务投递会**静默丢弃**（任务照记 ok，但用户啥也收不到）。改为兜底到该
 *    bot 已连接的 home channel（如 `wecom`），保证测试运行的通知能真正到达用户。
 *    连一个已连接通道都没有时，才退回原样的 `origin`（此时确实无处可投）。
 */
async function resolveConcreteDeliverForTestRun(target: HermesCronTarget, job: CronJob): Promise<string> {
  const tokens = job.deliver.split(",").map((token) => token.trim()).filter(Boolean);
  if (!tokens.includes("origin")) return job.deliver;
  const raw = await readRawCronJobRecordById(target, job.id);
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
  const fallback = await resolveFallbackHomeChannel(target);
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
 * `deliver` 沿用 job 的 deliver 字符串，**可能是 `weixin:wx_x,feishu:oc_y` 这种
 * 逗号分隔的多目标**（网页多选 IM 时就会这样，用户勾了几个就要收到几条）。
 *
 * 注意：`hermes send --to` 与 `hermes cron create --deliver` 的目标解析规则**不同**——
 * `cron create --deliver` 支持逗号分隔的多目标，但 `hermes send --to` **只接受单个
 * 目标**，把 `'wecom,qqbot'` 整串当成一个平台名会直接报 `Unknown platform: wecom,qqbot`
 * 并以 exit 1 失败（后端 debug-exec 表现为 500）。因此这里必须**按逗号把 deliver 拆开，
 * 对每个目标各发一条 `hermes send`**，才能让用户创建任务时勾选的每个 IM 都收到即时回执。
 *
 * 每个目标独立 best-effort：任一目标发送失败（通道未配置/掉线等）都不影响其它目标，
 * 也不影响后续真正的测试运行主流程。
 */
export interface HermesChatNoticeResult {
  sent: number;
  failed: number;
}

export async function sendHermesChatNotice(
  cronTarget: HermesCronTarget,
  deliver: string,
  message: string,
): Promise<HermesChatNoticeResult> {
  const targets = deliver
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  if (targets.length === 0) return { sent: 0, failed: 0 };
  const quotedMessage = shellQuote(message);
  const results = await Promise.allSettled(
    targets.map((deliverTarget) =>
      execCommand(
        cronTarget,
        ["hermes", "send", "--to", shellQuote(deliverTarget), quotedMessage].join(" "),
      ),
    ),
  );
  const failed = results.filter((result) => result.status === "rejected").length;
  return { sent: results.length - failed, failed };
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
 * 因此这里的轮询超时要覆盖的最坏情况：
 *   `buildImmediateOnceSchedule()` 用的相对延迟 `2m`（精确「创建时刻 + 2 分钟」，
 *   无分钟截断问题）+ 调度器下一次 tick 的最坏对齐延迟（~60s）+ Agent 实际跑
 *   一次 prompt 的执行余量。前两者是硬下限（约 3 分钟），执行余量给 30~60s 足矣。
 *
 * 注意（2026-07-03 下午）：现在 UI 走 `startCronTestRun`，发完即时回执就撤转圈、
 * 剩下的等待丢后台 fire-and-forget，用户已经不再对着 loading 盲等这段时长。所以这个
 * 超时只用于后台阶段「等多久还没执行就放弃、清理临时任务并把 completion 判为失败」。
 *
 * ⚠️ 修正（2026-07-03 傍晚，实测）：之前一度收敛到 180s（3 分钟），但真实观测发现一次
 * `once` 临时任务从 `run_at` 到点（17:06）到「Agent 真正跑完 prompt 并投递」用了约 3~5
 * 分钟——180s 会在任务其实还在正常执行时就误判超时。既然用户侧已不盲等（转圈早撤），
 * 超时放宽对用户完全无感，只影响后台「何时放弃并清理」。因此上调到 300s（5 分钟），
 * 给「2m 相对延迟 + ~60s tick 对齐 + Agent 跑 prompt 的真实耗时」留足余量，避免把
 * 「跑得慢但会成功」误判成失败。
 */
const TEST_RUN_POLL_INTERVAL_MS = 3000;
const TEST_RUN_POLL_TIMEOUT_MS = 300_000;

/**
 * 轮询直到临时任务真正被调度器执行完（`last_run_at` 从空变为非空），或超时。
 *
 * `hermes cron run <id>` 只是把 `next_run_at` 拨到近未来去排队，真正执行发生
 * 在调度器的下一次 tick；`last_run_at` 由 Hermes 在那次 tick 里执行完才写入，
 * 是唯一能用来判断"是否已经真正跑过"的字段（`run` 命令本身的 exit code /
 * 文案完全不反映这一点）。超时后抛错，不静默当作成功。
 */
async function waitForCronJobExecuted(
  target: HermesCronTarget,
  jobId: string,
  pollIntervalMs = TEST_RUN_POLL_INTERVAL_MS,
  timeoutMs = TEST_RUN_POLL_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await readRawCronJobRecordById(target, jobId);
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
 * 执行；名字形如「{原任务名}测试运行」+ 末尾一段不可见的零宽 marker，`listCronJobs`
 * 会靠这段零宽 marker 把这类任务从列表里过滤掉，不在
 * 前端展示），让它按自己的 schedule 到点被调度器**自然执行**（不额外催），轮询等到
 * 它真正执行完（见 `waitForCronJobExecuted`）后读取真实投递结果，再把它删除。
 *
 * 为什么不调用 `hermes cron run <id>` 去强制立即触发（哪怕是对临时任务）：
 * 实测证实 `hermes cron run` 在这套 CLI/debug-exec 环境下"强制立即触发"这
 * 条路径不可靠——触发后轮询等满 90s（覆盖一个完整 60s tick 周期）仍可能
 * 完全没有执行。而**普通一次性任务到点被调度器自然扫到执行**这条路径已经
 * 被生产环境反复验证是可靠工作的（这也是「定时任务」功能本身能用的前提）。
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
/**
 * `startCronTestRun` 的返回：把测试运行拆成「用户可感知的前置阶段」和「后台长跑阶段」。
 *
 * - 前置阶段（本函数 await 完成后就返回）：发即时回执 + 创建临时任务 + 定位到它。
 *   这几步都很快（秒级），完成即代表「请求已收到、任务已挂上、马上会跑」。UI 只要等到
 *   这里就可以撤掉「正在测试运行」的转圈提示了——不必再让用户盲等真正执行完。
 * - 后台阶段（`completion`）：等临时任务被调度器 tick 到并执行完（约 2 分钟起步）、读取
 *   真实投递结果、清理临时任务。这段挂在 `completion` promise 上，调用方可 fire-and-forget
 *   （不 await），让它在后台自然跑完；也可以 await 拿最终结果（`runCronJobAsTest` 就这么用）。
 */
export interface StartedCronTestRun {
  /** 后台长跑阶段：等待真实执行完成、读取投递结果、清理临时任务。可 await 也可丢后台。 */
  completion: Promise<CronTestRunResult>;
}

/**
 * 启动一次测试运行，但**只等到「即时回执已发 + 临时任务已挂上」这段快操作**就返回，
 * 把真正漫长的「等调度器执行 + 读结果 + 清理」丢进 `completion` promise 交给调用方决定
 * 何时（或是否）等待。
 *
 * 这样 UI 就能在发完 `hermes send` 回执后立刻撤掉转圈——用户看到 IM 里的「已收到」即可，
 * 剩下的执行在后台继续，不必再对着 loading 盲等两三分钟。
 *
 * 前置阶段里 `sendHermesChatNotice` 是 best-effort（发不出去也不阻断）；但 `createCronJob` /
 * 定位 tempId 若失败会 throw，让调用方能把「连任务都没挂上」这种真失败反馈出来。
 */
export async function startCronTestRun(target: HermesCronTarget, job: CronJob): Promise<StartedCronTestRun> {
  const deliver = await resolveConcreteDeliverForTestRun(target, job);
  const noAgent = job.inference_config?.no_agent === true;
  // 真正的测试执行要等临时任务被调度器 tick 到（约 2 分钟起步）。在挂任务之前，先用
  // `hermes send` 往同一个 IM 通道即时回一句「已收到」，让用户立刻知道请求已进入处理，
  // UI 随即就能撤掉转圈。这条回执是 best-effort：发不出去（比如通道未配置）也绝不能影响
  // 后面真正的测试运行，因此单独 try/catch 吞掉错误。
  if (!noAgent) {
    await sendHermesChatNotice(target, deliver, TEST_RUN_ACK_MESSAGE).catch(() => {
      /* 即时回执发送失败不影响测试运行主流程 */
    });
  }
  const marker = buildTestRunMarker(job.id, job.name);
  let temporaryScript: string | null = null;
  let testScript = noAgent ? job.script : undefined;
  if (noAgent && job.zero_token_config?.managed && job.zero_token_config.content !== null) {
    temporaryScript = createZeroTokenScriptName(
      `test-${job.id}-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`,
    );
    await writeZeroTokenScript(target, temporaryScript, {
      kind: job.zero_token_config.kind,
      language: job.zero_token_config.language,
      content: job.zero_token_config.content,
      start_at: null,
      end_at: null,
    });
    testScript = temporaryScript;
  }
  if (noAgent && !testScript) {
    throw new Error("测试运行失败：0 Token 任务缺少可执行脚本");
  }
  const input: CreateCronJobInput = {
    schedule: buildImmediateOnceSchedule(),
    name: marker,
    deliver,
    ...(noAgent
      ? { noAgent: true, script: testScript }
      : { prompt: job.prompt, skills: job.skills }),
    // Agent 任务有意不传 script；受管理 no-agent 任务使用无门控的临时 wrapper。
  };
  const upstreamId = noAgent ? "" : job.context_from?.length === 1 ? job.context_from[0]?.trim() : "";
  let tempId: string | null = null;
  try {
    if (upstreamId) {
      // 表单试跑必须使用当前尚未保存的上游选择；structured cronjob create 会直接返回临时任务 id。
      tempId = await createCronJobWithContextAndScriptRollback(target, input, upstreamId);
    } else {
      await createCronJobWithScriptRollback(target, input, temporaryScript ?? undefined);
      tempId = await findCronJobIdByExactNameWithRetry(target, marker);
    }
  } catch {
    await removeCronJobByExactName(target, marker).catch(() => {
      /* 兜底清理失败不影响中文错误上抛 */
    });
    if (temporaryScript) {
      await removeZeroTokenScript(target, temporaryScript).catch(() => {
        /* 兜底清理失败不影响中文错误上抛 */
      });
    }
    throw new Error("临时测试任务创建异常，已尝试清理，请稍后重试");
  }
  // create 已成功 → 临时任务几乎肯定已经落进 cron。从这里开始，任何后续失败都必须
  // 保证「已创建的临时任务能被删除」，否则它会在约 2 分钟后被调度器真实执行并投递，
  // 违背「测试失败不产生后续副作用」的预期（见 CR P1）。
  //
  // lookup 用 marker 名精确反查 tempId，但 jobs.json 可能有写入延迟 / 短暂读失败 /
  // 解析不到 marker，首次读可能拿不到。这里带重试；仍拿不到时不直接裸抛，而是先按
  // marker 名做一次兜底删除（`hermes cron remove --name` 语义走不了，用 list 反查
  // 一次或直接按名删），把已创建的临时任务清掉，再抛错。
  if (!tempId) {
    // 兜底：即便反查不到 id，也尽力按 marker 名把这个已创建的临时任务删掉，
    // 避免它残留后被调度器真实执行。best-effort，失败也不阻断错误上抛。
    await removeCronJobByExactName(target, marker).catch(() => {
      /* 兜底清理失败不影响错误上抛 */
    });
    if (temporaryScript) {
      await removeZeroTokenScript(target, temporaryScript).catch(() => {
        /* 兜底清理失败不影响错误上抛 */
      });
    }
    throw new Error("测试运行失败：未能定位临时任务，已尝试清理，请稍后重试");
  }
  // 前置阶段到此结束（这些都很快）。剩下的长跑阶段封进 completion，交给调用方处理。
  const completion = (async (): Promise<CronTestRunResult> => {
    try {
      // 有意不调用 hermes cron run 强制触发：让它像任何普通一次性任务一样，
      // 由调度器在到达 schedule 时间后的下一次 tick 自然执行（原因见函数注释）。
      const rawAfterRun = await waitForCronJobExecuted(target, tempId);
      const deliveryErrorRaw = rawAfterRun?.last_delivery_error;
      const deliveryError = typeof deliveryErrorRaw === "string" && deliveryErrorRaw.trim()
        ? deliveryErrorRaw.trim()
        : null;
      const lastStatusRaw = rawAfterRun?.last_status;
      const output = typeof lastStatusRaw === "string" && lastStatusRaw.trim() ? lastStatusRaw.trim() : "ok";
      return { output, deliveryError };
    } finally {
      await removeCronJob(target, tempId).catch(() => { /* 清理失败不影响本次结果 */ });
      if (temporaryScript) {
        await removeZeroTokenScript(target, temporaryScript).catch(() => {
          /* 清理失败不影响本次结果 */
        });
      }
    }
  })();
  return { completion };
}

/**
 * 完整同步语义：发回执 + 挂临时任务 + 等它真正执行完 + 读结果 + 清理，全部 await 完才返回。
 *
 * 实际是 `startCronTestRun` 的「等到底」组合。UI 若希望「发完回执即撤转圈、后台继续跑」，
 * 应直接用 `startCronTestRun` 拿到 `completion` 后自行 fire-and-forget，不要用这个。
 */
export async function runCronJobAsTest(target: HermesCronTarget, job: CronJob): Promise<CronTestRunResult> {
  const { completion } = await startCronTestRun(target, job);
  return completion;
}

export async function removeCronJob(target: HermesCronTarget, id: string): Promise<void> {
  await execCommand(target, `hermes cron remove ${shellQuote(id)}`);
}

/** Cron 已成功删除后，才清理可证明归属且未被其它任务引用的 LightVela 脚本。 */
export async function removeManagedCronScriptIfUnreferenced(
  target: HermesCronTarget,
  removedJob: CronJob,
  jobsBeforeRemoval: readonly CronJob[],
): Promise<void> {
  const scriptName = removedJob.script;
  if (!isLightVelaManagedScript(scriptName)) return;
  if (jobsBeforeRemoval.some((job) => job.id !== removedJob.id && job.script === scriptName)) return;
  if (isLightVelaZeroTokenScriptName(scriptName)) {
    // 文件名只是候选边界；只有成功解析出 LightVela marker/metadata 的脚本才可证明归属。
    // 外部工具可能碰巧使用同名前缀，绝不能仅凭名称删除用户脚本。
    if (removedJob.zero_token_config?.managed !== true) return;
    await removeZeroTokenScript(target, scriptName);
  } else {
    await removeEffectiveWindowScript(target, scriptName);
  }
}

async function rollbackCronDependentBindings(
  target: HermesCronTarget,
  updated: readonly CronDependentBinding[],
): Promise<string[]> {
  const rollbackFailed: string[] = [];
  for (const dependent of [...updated].reverse()) {
    try {
      await executeCronjobTool(target, {
        action: "update",
        job_id: dependent.id,
        context_from: dependent.contextFrom,
      });
    } catch {
      rollbackFailed.push(dependent.id);
    }
  }
  return rollbackFailed;
}

function cronDependentMutationError(summary: CronDependentMutationSummary): CronCommandError {
  const details = [summary.error ?? "dependent mutation failed"];
  if (summary.rollback_failed.length > 0) {
    details.push(`rollback_failed:${summary.rollback_failed.join(",")}`);
  }
  return new CronCommandError({
    command: "cronjob dependent removal",
    output: details.join(";"),
    status: "CRON_DEPENDENT_MUTATION_FAILED",
    exitCode: 1,
  });
}

export async function removeCronJobWithDependentRollback(
  target: HermesCronTarget,
  targetId: string,
  dependents: readonly CronDependentBinding[],
): Promise<void> {
  const updated: CronDependentBinding[] = [];
  for (const dependent of dependents) {
    try {
      await executeCronjobTool(target, {
        action: "update",
        job_id: dependent.id,
        context_from: dependent.contextFrom.filter((id) => id !== targetId),
      });
      updated.push(dependent);
    } catch {
      const rollbackFailed = await rollbackCronDependentBindings(target, updated);
      throw cronDependentMutationError({
        success: false,
        updated: updated.map((item) => item.id),
        rollback_failed: rollbackFailed,
        error: `update_failed:${dependent.id}`,
      });
    }
  }

  try {
    await executeCronjobTool(target, { action: "remove", job_id: targetId });
  } catch {
    const rollbackFailed = await rollbackCronDependentBindings(target, updated);
    throw cronDependentMutationError({
      success: false,
      updated: updated.map((item) => item.id),
      rollback_failed: rollbackFailed,
      error: `remove_failed:${targetId}`,
    });
  }
}

/** 编辑已存在 cron job：传入要更新的字段，未传不动 */
export async function editCronJob(
  target: HermesCronTarget,
  id: string,
  patch: EditCronJobPatch,
): Promise<void> {
  await execCommand(target, buildEditCommand(id, patch));
}

export async function editCronJobWithContext(
  target: HermesCronTarget,
  id: string,
  patch: EditCronJobPatch,
  contextFrom: CronContextPatch,
): Promise<void> {
  if (contextFrom === undefined) {
    await editCronJob(target, id, patch);
    return;
  }
  const payload: CronjobToolPayload = {
    action: "update",
    job_id: id,
    context_from: contextFrom,
  };
  if (patch.schedule !== undefined) payload.schedule = patch.schedule;
  if (patch.prompt !== undefined) payload.prompt = patch.prompt;
  if (patch.name !== undefined) payload.name = patch.name;
  if (patch.deliver !== undefined) payload.deliver = patch.deliver;
  if (patch.script !== undefined) payload.script = patch.script;
  if (patch.model !== undefined) payload.model = patch.model;
  if (patch.skills !== undefined) payload.skills = patch.skills;
  await executeCronjobTool(target, payload);
}
