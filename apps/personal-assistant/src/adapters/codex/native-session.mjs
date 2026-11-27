import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { validateCodexConfig } from "./config.mjs";
import { readCodexKey } from "./credential-file.mjs";
export const SUPPORTED_CODEX_VERSION = "codex-cli 0.167.2";
export const nativeUsage = (u) =>
  u
    ? {
        input: u.inputTokens,
        output: u.outputTokens,
        totalTokens: u.totalTokens,
        cacheRead: u.cachedInputTokens,
      }
    : undefined;
function restrictedModel(slug, imageInput = false) {
  return {
    slug,
    display_name: slug,
    description: null,
    supported_reasoning_levels: [],
    shell_type: "disabled",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    availability_nux: null,
    upgrade: null,
    base_instructions: "Use only the host-provided protocol and tools.",
    model_messages: null,
    supports_reasoning_summary_parameter: false,
    support_verbosity: false,
    apply_patch_tool_type: null,
    truncation_policy: { mode: "tokens", limit: 100000 },
    context_window: 128000,
    experimental_supported_tools: [],
    input_modalities: imageInput ? ["text", "image"] : ["text"],
    include_skills_usage_instructions: false,
    include_apps_usage_instructions: false,
    include_plugin_usage_instructions: false,
    node_repl_disabled: true,
    multi_agent_version: "disabled",
  };
}
/** One native process and RPC handles; no durable business state. */
export class NativeCodexSession {
  static async open(config, options) {
    const s = new NativeCodexSession(config, options);
    try {
      await (s.telemetry
        ? s.telemetry.run("codex.startup", {}, () => s.start())
        : s.start());
      return s;
    } catch (e) {
      await s.close();
      throw e;
    }
  }
  constructor(
    config,
    {
      home,
      cwd,
      signal,
      onRequest,
      onNotification = () => {},
      onFailure = () => {},
      modelTimeoutMs = 120000,
      telemetry,
      resolveModel,
      modelRole = "execution",
      imageInput = false,
    },
  ) {
    this.config = structuredClone(validateCodexConfig(config));
    Object.assign(this, {
      home,
      cwd,
      signal,
      onRequest,
      onNotification,
      onFailure,
      modelTimeoutMs,
      telemetry,
      resolveModel,
      modelRole,
      imageInput,
    });
    this.outputFrameLimit = 2000000;
    this.outputStreamLimit = 16000000;
    this.imageEchoBudget = 0;
    this.pending = new Map();
    this.nextId = 0;
    this.stop = () =>
      this.fail(signal.reason ?? new Error("Codex request aborted"));
    signal?.addEventListener("abort", this.stop, { once: true });
  }
  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.onFailure(error);
    this.versionProcess?.kill("SIGKILL");
    this.child?.kill("SIGKILL");
  }
  async start() {
    this.signal?.throwIfAborted();
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await mkdir(this.cwd, { recursive: true, mode: 0o700 });
    if(this.config.managed && !this.resolveModel)throw Error('Managed Codex resolver required');
    this.resolvedModel=this.config.managed ? await this.resolveModel(this.config, { purpose: this.modelRole }) : null;
    const key = this.resolvedModel?.apiKey ?? (this.config.managed?undefined:readCodexKey(this.config)),
      env = {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: this.home,
        CODEX_HOME: this.home,
        LANG: "C.UTF-8",
        ...(key ? { SUPERAPP_CODEX_API_KEY: key } : {}),
      };
    this.signal?.throwIfAborted();
    const checkVersion = async () => {
      this.versionProcess = spawn(this.config.binary, ["--version"], {
        env,
        cwd: this.cwd,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let version = "";
      this.versionProcess.stdout.on("data", (c) => {
        if (version.length < 1000) version += c;
      });
      const [code] = await once(this.versionProcess, "close");
      this.signal?.throwIfAborted();
      if (code !== 0 || version.trim() !== SUPPORTED_CODEX_VERSION)
        throw new Error(
          `Codex binary must be the verified ${SUPPORTED_CODEX_VERSION}`,
        );
    };
    if (this.telemetry)
      await this.telemetry.run("codex.version_check", {}, checkVersion);
    else await checkVersion();
    await writeFile(
      join(this.home, "models.json"),
      JSON.stringify({ models: [restrictedModel(this.config.modelId, this.imageInput)] }),
      { mode: 0o600 },
    );
    const runtimeConfig={...this.config,...this.resolvedModel};
    const settings = {
      model: this.config.modelId,
      ...(runtimeConfig.reasoningEffort !== undefined
        ? { model_reasoning_effort: runtimeConfig.reasoningEffort }
        : {}),
      model_provider: "superapp",
      model_catalog_json: join(this.home, "models.json"),
      approval_policy: "never",
      sandbox_mode: "read-only",
      project_doc_max_bytes: 0,
      web_search: "disabled",
      "tools.update_plan.enabled": false,
      "tools.experimental_request_user_input.enabled": false,
      "agents.enabled": false,
      "features.multi_agent_v2": false,
      ...Object.fromEntries(
        [
          "shell_tool",
          // Native shell snapshots serialize environment variables even when no shell tool is exposed.
          "shell_snapshot",
          "view_image",
          "multi_agent",
          "apps",
          "plugins",
          "skills",
          "code_mode",
          "js_repl",
          "request_permissions_tool",
          "current_time_reminder",
          "sleep_tool",
          "send_message_to_user_async",
          "goals",
        ].map((k) => [`features.${k}`, false]),
      ),
      "model_providers.superapp.name": "Explicit assistant Responses endpoint",
      "model_providers.superapp.base_url": runtimeConfig.baseUrl,
      "model_providers.superapp.wire_api": "responses",
      "model_providers.superapp.requires_openai_auth": false,
      "model_providers.superapp.request_max_retries": 0,
      "model_providers.superapp.stream_max_retries": 0,
      "model_providers.superapp.stream_idle_timeout_ms": this.modelTimeoutMs,
      ...(key
        ? { "model_providers.superapp.env_key": "SUPERAPP_CODEX_API_KEY" }
        : {}),
    };
    this.settings = settings;
    this.signal?.throwIfAborted();
    this.child = spawn(
      this.config.binary,
      [
        "app-server",
        "--stdio",
        ...Object.entries(settings).flatMap(([k, v]) => [
          "-c",
          `${k}=${JSON.stringify(v)}`,
        ]),
      ],
      { env, cwd: this.cwd, stdio: ["pipe", "pipe", "ignore"] },
    );
    this.exited = new Promise((r) => this.child.once("close", r));
    this.child.on("error", () =>
      this.fail(new Error("Codex app-server could not start")),
    );
    this.child.on("close", () => {
      const error = new Error(
        "Codex app-server exited before request completion",
      );
      error.code = "CODEX_NATIVE_EXITED";
      this.fail(error);
    });
    this.child.stdin.on("error", () =>
      this.fail(new Error("Codex app-server input closed")),
    );
    let bytes = 0;
    this.child.stdout.on("data", (c) => {
      bytes += c.length;
      if (bytes > this.outputStreamLimit)
        this.fail(new Error("Codex protocol stream exceeded limit"));
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      if (this.failure) return;
      try {
        if (Buffer.byteLength(line) > this.outputFrameLimit)
          throw new Error("Codex protocol output exceeded limit");
        const p = JSON.parse(line);
        if (p.method && p.id !== undefined) {
          if (!this.onRequest) {
            this.send({
              id: p.id,
              error: {
                code: -32601,
                message: "No host tools or approvals are available",
              },
            });
            throw new Error("Codex unexpectedly requested host tool authority");
          }
          Promise.resolve()
            .then(() => this.onRequest(p))
            .then((result) => {
              if (!this.failure) this.send({ id: p.id, result });
            })
            .catch((e) => this.fail(e));
        } else if (p.id !== undefined) {
          const call = this.pending.get(p.id);
          if (!call) return;
          this.pending.delete(p.id);
          p.error
            ? call.reject(
                new Error(`Codex RPC failed (${p.error.code ?? "unknown"})`),
              )
            : call.resolve(p.result);
        } else this.onNotification(p);
      } catch (e) {
        this.fail(e);
      }
    });
    await this.rpc("initialize", {
      clientInfo: { name: "superapp-native-harness", version: "0.2.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized", params: {} });
  }
  send(packet) {
    if (!this.failure) this.child.stdin.write(JSON.stringify(packet) + "\n");
  }
  async rpc(method, params) {
    if(method==='turn/start' && this.config.managed) {
      const current=await this.resolveModel(this.config, { purpose: this.modelRole });
      if(JSON.stringify(current)!==JSON.stringify(this.resolvedModel))throw Error('Assistant model connection changed; retry with a fresh session');
      this.signal?.throwIfAborted();
    }
    if (this.telemetry)
      return this.telemetry.run(
        "codex.rpc",
        { "app.native_method": method },
        () => this.rawRpc(method, params),
      );
    return this.rawRpc(method, params);
  }
  rawRpc(method, params) {
    if (this.failure) return Promise.reject(this.failure);
    if (method === "turn/start" && this.imageInput) {
      // Native item/started and item/completed echo user image data URLs.
      // Reserve only for actual transmitted images, not arbitrary model output;
      // text-only sessions retain the original limits. All budgets stay finite.
      const images = (params.input ?? []).filter(p => p.type === "image");
      const imageBytes = images.reduce((sum, p) => sum + Buffer.byteLength(p.url ?? ""), 0);
      if (images.length > 8 || imageBytes > 96 * 1024 * 1024 ||
          this.imageEchoBudget + imageBytes > 128 * 1024 * 1024)
        return Promise.reject(Error("Codex image input exceeded protocol budget"));
      this.imageEchoBudget += imageBytes;
      this.outputFrameLimit = Math.max(this.outputFrameLimit, 2000000 + imageBytes);
      this.outputStreamLimit = 16000000 + 2 * this.imageEchoBudget;
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }
  close() {
    return (this.closing ??= (async () => {
      this.signal?.removeEventListener("abort", this.stop);
      this.fail(new Error("Codex native session closed"));
      this.lines?.close();
      if (this.exited) await this.exited;
      if (
        this.versionProcess &&
        this.versionProcess.exitCode === null &&
        this.versionProcess.signalCode === null
      ) {
        const ended = once(this.versionProcess, "close").catch(() => {});
        this.versionProcess.kill("SIGKILL");
        await ended;
      }
    })());
  }
}
