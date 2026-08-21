export const DEEPSEEK_HARNESS_CN_PROVIDERS = [
  "deepseek",
  "minimax-cn",
  "moonshotai-cn",
  "qwen-token-plan-cn",
  "openrouter",
] as const;

export const DEEPSEEK_HARNESS_GLOBAL_PROVIDERS = [
  "deepseek",
  "minimax",
  "minimax-cn",
  "moonshotai",
  "moonshotai-cn",
  "openrouter",
  "anthropic",
  "groq",
  "openai",
] as const;

export type DeepSeekHarnessProviderID =
  | (typeof DEEPSEEK_HARNESS_GLOBAL_PROVIDERS)[number]
  | "qwen-token-plan-cn";
export type DeepSeekHarnessRegion = "cn" | "global";

export interface DeepSeekHarnessProvider {
  id: DeepSeekHarnessProviderID;
  displayName: string;
  configured: boolean;
  active: boolean;
  writable: boolean;
}

export interface DeepSeekHarnessStatus {
  installed: boolean;
  status: string;
  service_status: string;
  healthy: boolean;
}

export interface DeepSeekHarnessInstallation {
  task_id: string;
  status: "pending" | "running" | "succeeded" | "failed" | string;
  stage: string;
  progress: number;
  message: string;
  error?: string;
  updated_at: string;
}

export type DeepSeekHarnessExecDebugCommand = (
  botId: string,
  command: string,
  options?: { timeoutMs?: number },
) => Promise<{ status: string; exitCode: number; output: string }>;

interface DeepSeekHarnessCommandClientOptions {
  createTaskId?: () => string;
}

const INSTALLER = "/usr/local/libexec/lightvela/install-deepseek-harness";
const SERVICE = "deepseek-harness.service";
const TASK_ID_PATTERN = /^dshi-[0-9a-f]{32}$/;
const ALL_PROVIDERS = new Set<string>([
  ...DEEPSEEK_HARNESS_CN_PROVIDERS,
  ...DEEPSEEK_HARNESS_GLOBAL_PROVIDERS,
]);

const STATUS_COMMAND = [
  `if sudo systemctl status ${SERVICE} --no-pager >/dev/null 2>&1; then`,
  `  printf '%s\\n' '{"installed":true,"status":"running","service_status":"active","healthy":true}'`,
  "elif sudo test -x /opt/lightvela/dsh/current/node_modules/.bin/dsh; then",
  `  printf '%s\\n' '{"installed":true,"status":"stopped","service_status":"inactive","healthy":false}'`,
  "else",
  `  printf '%s\\n' '{"installed":false,"status":"not-installed","service_status":"inactive","healthy":false}'`,
  "fi",
].join("\n");

const defaultTaskId = () => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `dshi-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
};

const encodeUtf8Base64 = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const parseJson = <T>(output: string, label: string): T => {
  try {
    return JSON.parse(output.trim()) as T;
  } catch {
    throw new Error(`Invalid DeepSeek Harness ${label} response`);
  }
};

const assertCommandSucceeded = (
  result: { exitCode: number; output: string },
  fallback: string,
) => {
  if (result.exitCode === 0) return;
  const detail = result.output
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
    ?.replace(/^(?:RuntimeError|ValueError):\s*/, "");
  throw new Error(detail || fallback);
};

const assertTaskId = (taskId: string) => {
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error("Invalid DeepSeek Harness task id");
};

const assertProvider = (provider: string): asserts provider is DeepSeekHarnessProviderID => {
  if (!ALL_PROVIDERS.has(provider)) throw new Error("Unsupported DeepSeek Harness provider");
};

export class DeepSeekHarnessCommandClient {
  private readonly createTaskId: () => string;

  constructor(
    private readonly botId: string,
    private readonly execDebugCommand: DeepSeekHarnessExecDebugCommand,
    options: DeepSeekHarnessCommandClientOptions = {},
  ) {
    this.createTaskId = options.createTaskId ?? defaultTaskId;
  }

  async getStatus(): Promise<DeepSeekHarnessStatus> {
    const result = await this.execDebugCommand(this.botId, STATUS_COMMAND, { timeoutMs: 30_000 });
    return parseJson<DeepSeekHarnessStatus>(result.output, "status");
  }

  async startInstall(): Promise<{ task_id: string }> {
    const taskId = this.createTaskId();
    assertTaskId(taskId);
    const command = [
      "sudo -n systemd-run",
      `--unit=lightvela-dsh-install-${taskId}`,
      "--collect",
      "--property=Type=exec",
      "--",
      INSTALLER,
      "install",
      "--task-id",
      taskId,
    ].join(" ");
    await this.execDebugCommand(this.botId, command, { timeoutMs: 30_000 });
    return { task_id: taskId };
  }

  async getInstallation(taskId: string): Promise<DeepSeekHarnessInstallation> {
    assertTaskId(taskId);
    const result = await this.execDebugCommand(
      this.botId,
      `sudo -n ${INSTALLER} installation --task-id ${taskId}`,
      { timeoutMs: 30_000 },
    );
    return parseJson<DeepSeekHarnessInstallation>(result.output, "installation");
  }

  async restart(): Promise<DeepSeekHarnessStatus> {
    await this.execDebugCommand(
      this.botId,
      `sudo systemctl restart ${SERVICE}`,
      { timeoutMs: 120_000 },
    );
    return this.getStatus();
  }

  async listProviders(region: DeepSeekHarnessRegion): Promise<DeepSeekHarnessProvider[]> {
    const result = await this.execDebugCommand(
      this.botId,
      `sudo -n ${INSTALLER} providers --region ${region}`,
      { timeoutMs: 30_000 },
    );
    const payload = parseJson<{ providers: DeepSeekHarnessProvider[] }>(result.output, "providers");
    const allowed = new Set<string>(
      region === "cn" ? DEEPSEEK_HARNESS_CN_PROVIDERS : DEEPSEEK_HARNESS_GLOBAL_PROVIDERS,
    );
    return payload.providers.filter((provider) => allowed.has(provider.id));
  }

  async saveProvider(provider: DeepSeekHarnessProviderID, apiKey: string): Promise<void> {
    assertProvider(provider);
    const value = apiKey.trim();
    if (!value) throw new Error("API key is required");
    const encoded = encodeUtf8Base64(value);
    const command = [
      `printf '%s' '${encoded}'`,
      "| base64 --decode",
      `| sudo -n ${INSTALLER} configure --provider ${provider}`,
    ].join(" ");
    const result = await this.execDebugCommand(this.botId, command, { timeoutMs: 30_000 });
    assertCommandSucceeded(result, "DeepSeek Harness provider configuration failed");
  }

  async removeProvider(provider: DeepSeekHarnessProviderID): Promise<void> {
    assertProvider(provider);
    const result = await this.execDebugCommand(
      this.botId,
      `sudo -n ${INSTALLER} remove-provider --provider ${provider}`,
      { timeoutMs: 30_000 },
    );
    assertCommandSucceeded(result, "DeepSeek Harness provider removal failed");
    parseJson<{ ok: boolean; provider: DeepSeekHarnessProviderID; configured: false }>(
      result.output,
      "provider removal",
    );
  }
}
