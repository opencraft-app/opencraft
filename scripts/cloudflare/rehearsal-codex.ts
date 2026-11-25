import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { isCodexModelId } from "../../apps/headless-server/src/cloudflare/codex-thread-start.ts";
import {
  bufferedSocket,
  bundleWorker,
  type WorkerInstance,
  type WorkerUpgrade,
} from "../../tests/cloudflare/worker-runtime.ts";
import { CloudflareApi, REHEARSAL_PREFIX } from "./cloudflare-runtime.ts";
import { proveCodex, waitForRoute } from "./rehearsal-codex-proof.ts";
import { REHEARSAL_HEALTH_PATH, REHEARSAL_KEY_HEADER } from "./rehearsal-guard.ts";
import { uploadWorkbenchAssets, workbenchAssetsConfig } from "./workbench-assets.ts";

export const CODEX_SCENARIO = "codex: native Project, streamed Turn and Linux Hands";
const applicationPath = "/containers/applications";
const deploymentEntry = new URL("../../apps/headless-server/src/cloudflare/deployment-worker.mjs", import.meta.url)
  .pathname;
const wranglerTemplate = new URL("../../deploy/cloudflare/wrangler.installation-core.jsonc", import.meta.url).pathname;
const durableObjects = {
  INSTALLATION_CORE: "InstallationCore",
  ACCOUNT_CORE: "AccountCore",
  CLIENT: "ClientDO",
  WORKSPACE_HOST: "WorkspaceHost",
};
const compatibility = ["nodejs_compat", "global_fetch_strictly_public"];
const namePath = (worker: string) => `/workers/scripts/${worker}`;
const secret = (name: string, text: string) => ({ type: "secret_text", name, text });
const plain = (name: string, text: string) => ({ type: "plain_text", name, text });
const nonce = () => randomBytes(32).toString("base64url");
type Application = { id: string; name: string };

async function deploy(api: CloudflareApi, worker: string, code: string, metadata: object) {
  const form = new FormData();
  form.set(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          main_module: "worker.mjs",
          compatibility_date: "2026-11-01",
          compatibility_flags: compatibility,
          ...metadata,
        }),
      ],
      { type: "application/json" },
    ),
  );
  form.set("worker.mjs", new Blob([code], { type: "application/javascript+module" }), "worker.mjs");
  await api.call("PUT", namePath(worker), form);
  await api.call("POST", namePath(worker) + "/subdomain", { enabled: true, previews_enabled: false });
}

async function workspaceNamespace(api: CloudflareApi, worker: string, signal: AbortSignal) {
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    for (let page = 1; page <= 20; page++) {
      signal.throwIfAborted();
      const namespaces = await api.call<{ id: string; script: string; class: string }[]>(
        "GET",
        `/workers/durable_objects/namespaces?per_page=100&page=${page}`,
      );
      const match = namespaces.find(
        (entry) => entry.script === worker && entry.class === durableObjects.WORKSPACE_HOST,
      );
      if (match) return match.id;
      if (namespaces.length < 100) break;
    }
    await delay(1500, undefined, { signal });
  }
  throw new Error("WorkspaceHost namespace was not created");
}

function cloudInstance(origin: string, key: string | undefined, signal: AbortSignal): WorkerInstance {
  const guard = key === undefined ? {} : { [REHEARSAL_KEY_HEADER]: key };
  const open = (url: string, headers?: Readonly<Record<string, string>>) =>
    new Promise<WorkerUpgrade>((resolve, reject) => {
      signal.throwIfAborted();
      const socket = new WebSocket(url.replace(/^https:/u, "wss:"), {
        headers: { ...headers, ...guard },
        handshakeTimeout: 30_000,
        perMessageDeflate: false,
      });
      const abort = () => socket.terminate();
      signal.addEventListener("abort", abort, { once: true });
      socket.once("close", () => signal.removeEventListener("abort", abort));
      socket.once("open", () => resolve({ status: 101, socket: bufferedSocket(socket) }));
      socket.once("unexpected-response", (request, response) => {
        resolve({ status: response.statusCode ?? 0 });
        request.destroy();
      });
      socket.once("error", reject);
    });
  return {
    origin,
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      if (key) headers.set(REHEARSAL_KEY_HEADER, key);
      return fetch(url, { ...init, headers, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
    },
    async upgrade(url, headers) {
      const deadline = Date.now() + 45_000;
      for (;;) {
        const result = await open(url, headers);
        if (result.status !== 404 || Date.now() >= deadline) return result;
        await delay(1000, undefined, { signal });
      }
    },
  };
}

async function deployWithWrangler(options: {
  executable: string;
  api: CloudflareApi;
  worker: string;
  image: string;
  vars: Record<string, string>;
  secrets: Record<string, string>;
}) {
  const { executable, api, worker, image, vars, secrets } = options;
  const { default: ts } = await import("typescript");
  const parsed = ts.parseConfigFileTextToJson(wranglerTemplate, await readFile(wranglerTemplate, "utf8"));
  if (parsed.error) throw new Error("Could not read the Wrangler installation template");
  const template = parsed.config as {
    main: string;
    vars: Record<string, string>;
    containers: Array<{ class_name: string; images: object }>;
  };
  assert.equal(template.containers.length, 1, "Unexpected container applications in the installation template");
  assert.equal(template.containers[0]?.class_name, durableObjects.WORKSPACE_HOST);
  const config = {
    ...template,
    name: worker,
    account_id: api.accountId,
    main: resolve(dirname(wranglerTemplate), template.main),
    compatibility_flags: compatibility,
    workers_dev: true,
    preview_urls: false,
    vars: { ...template.vars, ...vars },
    containers: [{ ...template.containers[0], name: worker, images: { workspace: { image } } }],
  };
  const directory = await mkdtemp(join(tmpdir(), "opencraft-codex-wrangler-"));
  try {
    const configPath = join(directory, "wrangler.json");
    const secretsPath = join(directory, "secrets.json");
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
    await new Promise<void>((done, reject) => {
      const child = spawn(executable, ["deploy", "--config", configPath, "--secrets-file", secretsPath], {
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: api.accountId,
          CLOUDFLARE_API_TOKEN: api.token,
          WRANGLER_SEND_METRICS: "false",
        },
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) done();
        else reject(new Error(`Wrangler deployment exited with ${signal ?? code}`));
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readResponsesProvider(file: string) {
  const value = await readFile(file, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  const fields = value as { baseUrl?: unknown; model?: unknown; apiKey?: unknown } | null;
  const baseUrl = typeof fields?.baseUrl === "string" && URL.canParse(fields.baseUrl) ? new URL(fields.baseUrl) : null;
  if (
    !baseUrl ||
    baseUrl.protocol !== "https:" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    !isCodexModelId(fields?.model) ||
    typeof fields.apiKey !== "string" ||
    !/^[!-~]{1,4096}$/u.test(fields.apiKey)
  )
    throw new Error("Invalid --codex-provider file. Expected an HTTPS baseUrl, a Codex model ID and an API key.");
  return { name: "External Responses provider", baseUrl: baseUrl.href, model: fields.model, apiKey: fields.apiKey };
}

async function waitForCloudProof(
  api: CloudflareApi,
  worker: string,
  provider: string,
  started: number,
  signal: AbortSignal,
  log: (message: string) => void,
  selected: string[],
  restart: boolean,
) {
  const catalogPrefix = "OC_NATIVE_TOOL_CATALOG ";
  const resultPrefix = "OC_NATIVE_CODEX_PROOF ";
  const logs = async (name: string) => {
    const result = await api.call<{
      events?: { events?: Array<{ source?: { message?: unknown }; $metadata?: { message?: unknown } }> };
    }>("POST", "/workers/observability/telemetry/query", {
      queryId: name,
      timeframe: { from: started - 10_000, to: Date.now() + 60_000 },
      view: "events",
      limit: 200,
      parameters: { filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: name }] },
    });
    return (result.events?.events ?? [])
      .map((event) => event.source?.message ?? event.$metadata?.message)
      .filter((message): message is string => typeof message === "string");
  };
  const reported = new Set<string>();
  for (const deadline = started + 570_000; Date.now() < deadline;) {
    signal.throwIfAborted();
    const events = await logs(worker);
    for (const status of events.filter((message) => message.startsWith("OC_NATIVE_SCENARIO_")).reverse()) {
      if (!reported.has(status)) log(status);
      reported.add(status);
    }
    const result = events.find((message) => message.startsWith(resultPrefix));
    if (result) {
      const providerLogs = await logs(provider).catch(() => []);
      for (const catalog of new Set(
        providerLogs.filter(
          (message) => message.startsWith(catalogPrefix) || /^OC_NATIVE_TOOL_(?:CALL|RESULT) /u.test(message),
        ),
      ))
        log(catalog);
      for (const diagnostic of new Set(
        providerLogs.filter(
          (message) => message.startsWith("Workers AI rehearsal ") || message.startsWith("OC_NATIVE_PROBE_OUTPUT "),
        ),
      ))
        log(diagnostic);
      const proof = JSON.parse(result.slice(resultPrefix.length)) as { ok: boolean; checks: string[]; error?: string };
      const calls = new Set(
        providerLogs
          .filter((message) => message.startsWith("OC_NATIVE_TOOL_CALL "))
          .map((message) => JSON.parse(message.slice("OC_NATIVE_TOOL_CALL ".length)).name as string),
      );
      const modelReceipts = new Set(
        providerLogs
          .filter((message) => message.startsWith("OC_NATIVE_TOOL_RESULT "))
          .map((message) => JSON.parse(message.slice("OC_NATIVE_TOOL_RESULT ".length)).name as string),
      );
      const expected = [
        "exec_command",
        "write_stdin",
        "update_plan",
        "apply_patch",
        "request_user_input",
        "view_image",
        "list_mcp_resources",
        "list_mcp_resource_templates",
        "read_mcp_resource",
        "create_goal",
        "get_goal",
        "update_goal",
        "spawn_agent",
        "wait_agent",
        "send_input",
        "close_agent",
        "resume_agent",
      ];
      const missing = (restart ? [] : selected.length ? selected : expected).filter(
        (name) => !calls.has(name) || !modelReceipts.has(name),
      );
      if (missing.length) {
        const evidence = "Missing tool call or result evidence: " + missing.join(", ");
        return { ...proof, ok: false, error: [proof.error, evidence].filter(Boolean).join("\n") };
      }
      return proof;
    }
    await delay(3000, undefined, { signal });
  }
  throw Error("Timed out waiting for the cloud Codex proof");
}

export async function runCodexRehearsal(options: {
  api: CloudflareApi;
  image: string;
  wrangler?: string;
  providerFile?: string;
  bridge?: boolean;
  workersAi?: boolean;
  restart?: boolean;
  crash?: boolean;
  keep: boolean;
  log: (message: string) => void;
  checks: string[];
}) {
  const {
    api,
    image,
    wrangler,
    providerFile,
    bridge = false,
    workersAi = false,
    crash = false,
    keep,
    log,
    checks,
  } = options;
  const restart = options.restart || crash;
  assert.ok(!(workersAi && providerFile), "Choose --codex-workers-ai or --codex-provider");
  assert.ok(!restart || workersAi, "--codex-restart requires --codex-workers-ai");
  assert.ok(
    !crash || !wrangler,
    "--codex-crash uses the in-Cloudflare queue proof and is unavailable with --codex-wrangler",
  );
  const digest = /^registry\.cloudflare\.com\/([0-9a-f]{32})\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u.exec(image);
  assert.ok(digest?.[1] === api.accountId, "--codex-image must be a digest-pinned image in this Cloudflare account");
  const externalProvider = providerFile === undefined ? null : await readResponsesProvider(providerFile);
  const run = randomBytes(4).toString("hex");
  const worker = REHEARSAL_PREFIX + run + "-codex";
  const provider = externalProvider ? null : worker + "-model";
  const names = provider ? [worker, provider] : [worker];
  const applications = () => api.call<Application[]>("GET", applicationPath);
  const [domain, workers, apps, providerCode] = await Promise.all([
    api.subdomain(),
    api.listWorkers(),
    applications(),
    provider
      ? workersAi && !wrangler
        ? bundleWorker({
            id: "codex-model",
            entry: new URL("./rehearsal-codex-workers-ai-probe.mjs", import.meta.url).pathname,
            externalNode: true,
            durableObjects: {},
          }).then((bundle) => bundle.code)
        : readFile(
            new URL(workersAi ? "./rehearsal-codex-workers-ai.mjs" : "./rehearsal-codex-provider.mjs", import.meta.url),
            "utf8",
          )
      : null,
  ]);
  assert.ok(
    names.every((name) => !workers.includes(name)) && !apps.some(({ name }) => name === worker),
    "Temporary Cloudflare resource name collision",
  );
  const hostname = (name: string) => `https://${name}.${domain}.workers.dev`;
  const origin = hostname(worker);
  const key = wrangler ? undefined : nonce();
  const setupToken = nonce();
  const configured = externalProvider ?? {
    name: workersAi ? "Workers AI GPT-OSS 20B" : "Cloudflare rehearsal fixture",
    baseUrl: hostname(provider!) + "/v1",
    model: workersAi ? "gpt-oss-20b" : "gpt-5.4",
    apiKey: nonce(),
  };
  const restartProof = restart ? createHash("sha256").update(configured.apiKey).digest("hex") : undefined;
  const controller = new AbortController();
  const { signal } = controller;
  const abort = () => controller.abort(new Error("Rehearsal interrupted"));
  for (const event of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(event, abort);
  const instance = cloudInstance(origin, key, signal);
  const runInCloud = workersAi && !wrangler;
  const browserEntry = process.env.OPENCRAFT_REHEARSAL_BROWSER_ENTRY;
  const workbenchAssets = process.env.OPENCRAFT_REHEARSAL_WORKBENCH_ASSETS;
  assert.ok(
    (!browserEntry && !workbenchAssets) || (browserEntry && workbenchAssets && runInCloud && restart),
    "Browser rehearsal requires an entry, Workbench assets and the in-Cloudflare restart scenario",
  );
  const selected = (process.env.OPENCRAFT_REHEARSAL_NATIVE_TOOLS ?? "").split(",").filter(Boolean);
  assert.ok(
    selected.every((name) => /^[a-z_]+$/u.test(name)),
    "Invalid native tool selection",
  );
  assert.ok(!restart || selected.length === 0, "Choose --codex-restart or a native tool selection");
  let verifierQueue: string | undefined;
  log(`temporary Worker resources ${names.join(", ")}`);
  try {
    if (provider && providerCode)
      await deploy(api, provider, providerCode, {
        bindings: [
          secret("REHEARSAL_PROVIDER_PROOF", configured.apiKey),
          ...(workersAi ? [{ type: "ai", name: "AI" }, plain("REHEARSAL_TOOL_CATALOG", "1")] : []),
        ],
        ...(workersAi ? { observability: { enabled: true, head_sampling_rate: 1 } } : {}),
      });
    signal.throwIfAborted();
    const providerId = "cloud-rehearsal";
    const credentialRef = "CLOUD_REHEARSAL_MODEL";
    const seeds = {
      OPENCRAFT_SETUP_TOKEN: setupToken,
      OPENCRAFT_ACCOUNT_SEALING_KEY: "k1." + nonce(),
      OPENCRAFT_ACCOUNT_MODEL_BOOTSTRAP: JSON.stringify({
        document: {
          schemaVersion: 1,
          revision: 0,
          defaultModel: null,
          providers: [
            {
              id: providerId,
              name: configured.name,
              enabled: true,
              protocol: "openai-responses",
              baseUrl: configured.baseUrl,
              credentialRef,
              models: [{ id: configured.model, enabled: true, ...(workersAi ? { customToolCalls: true } : {}) }],
            },
          ],
        },
        credentials: { [credentialRef]: configured.apiKey },
      }),
    };
    const vars = {
      OPENCRAFT_HUMAN_AUTH: JSON.stringify({ origin, local: true, oidc: [] }),
      OPENCRAFT_WORKSPACE_IMAGE: "workspace",
      OPENCRAFT_WORKSPACE_USER: "1000:1000",
      OPENCRAFT_WORKSPACE_ENGINES: "codex,pi",
      OPENCRAFT_WORKSPACE_IDLE: "120000",
      OPENCRAFT_WORKSPACE_CODEX_SNAPSHOTS: "true",
      OPENCRAFT_WORKSPACE_CODEX_ISOLATE_ACTORS: "true",
      OPENCRAFT_WORKSPACE_CODEX_TURNS: "true",
      ...(bridge ? { OPENCRAFT_WORKSPACE_CODEX_BRIDGE_ENDPOINT: "true" } : {}),
      OPENCRAFT_WORKSPACE_CODEX_FILES: "true",
      OPENCRAFT_WORKSPACE_CODEX_PROJECTS: "true",
      OPENCRAFT_WORKSPACE_CODEX_DEFAULT: "codex-" + run,
      OPENCRAFT_WORKSPACE_CODEX_EGRESS_ORIGIN: "http://workspace-model.invalid",
      OPENCRAFT_WORKSPACE_CODEX_EGRESS_PROVIDER: providerId,
    };
    if (wrangler) {
      await deployWithWrangler({ executable: wrangler, api, worker, image, vars, secrets: seeds });
    } else {
      const bundle = await bundleWorker(
        {
          id: "codex",
          entry:
            browserEntry ??
            (runInCloud ? new URL("./rehearsal-codex-cloud-worker.ts", import.meta.url).pathname : deploymentEntry),
          externalNode: true,
          compatibilityFlags: compatibility,
          durableObjects,
        },
        runInCloud
          ? undefined
          : { module: new URL("./rehearsal-guard.ts", import.meta.url).pathname, exportName: "rehearsalGuard" },
      );
      const assets = workbenchAssets ? await uploadWorkbenchAssets(api, worker, workbenchAssets, log) : undefined;
      await deploy(api, worker, bundle.code, {
        ...(assets ? { assets: { jwt: assets, config: workbenchAssetsConfig } } : {}),
        bindings: [
          ...(assets
            ? [
                { type: "assets", name: "ASSETS" },
                { type: "browser", name: "BROWSER" },
              ]
            : []),
          ...Object.entries(durableObjects).map(([name, class_name]) => ({
            type: "durable_object_namespace",
            name,
            class_name,
          })),
          secret("REHEARSAL_KEY", key!),
          ...(runInCloud
            ? [
                plain("REHEARSAL_ORIGIN", origin),
                plain("REHEARSAL_BRIDGE", bridge ? "1" : "0"),
                plain("REHEARSAL_NATIVE_TOOLS", selected.join(",")),
              ]
            : []),
          ...(runInCloud && restartProof ? [plain("REHEARSAL_PROVIDER_DIGEST", restartProof)] : []),
          ...(crash ? [plain("REHEARSAL_CRASH", "1")] : []),
          ...Object.entries(seeds).map(([name, value]) => secret(name, value)),
          ...Object.entries(vars).map(([name, value]) => plain(name, value)),
        ],
        ...(runInCloud ? { observability: { enabled: true, head_sampling_rate: 1 } } : {}),
        migrations: { new_tag: "v1", new_sqlite_classes: Object.values(durableObjects) },
        containers: [{ name: worker, class_name: durableObjects.WORKSPACE_HOST, images: { workspace: image } }],
      });
    }
    const namespace = await workspaceNamespace(api, worker, signal);
    if (wrangler) {
      assert.equal(
        (await applications()).find(({ name }) => name === worker)?.id,
        namespace,
        "Wrangler did not provision the WorkspaceHost container application",
      );
    } else {
      await api.call("POST", applicationPath, {
        name: worker,
        scheduling_policy: "durable_object",
        durable_objects: { namespace_id: namespace },
      });
    }
    log("production Worker and WorkspaceHost deployed");
    if (runInCloud) {
      const queueName = worker + "-verify";
      verifierQueue = (await api.call<{ queue_id: string }>("POST", "/queues", { queue_name: queueName })).queue_id;
      await api.call("POST", "/queues/" + verifierQueue + "/consumers", {
        type: "worker",
        script_name: worker,
        settings: { batch_size: 1, max_concurrency: 1, max_retries: 0, max_wait_time_ms: 0 },
      });
      await delay(7000, undefined, { signal });
      const started = Date.now();
      await api.call("POST", "/queues/" + verifierQueue + "/messages", {
        body: "codex native tools proof",
        content_type: "text",
      });
      const proof = await waitForCloudProof(api, worker, provider!, started, signal, log, selected, !!restart);
      checks.push(...proof.checks);
      assert.ok(proof.ok, proof.error);
      return;
    }
    if (key) {
      const health = origin + REHEARSAL_HEALTH_PATH;
      const guarded = await waitForRoute(() => instance.fetch(health), 200, "Guarded Worker health", signal);
      await guarded.body?.cancel();
      assert.equal((await fetch(health, { signal: AbortSignal.timeout(20_000) })).status, 404);
    }
    const apphost = await waitForRoute(() => instance.fetch(origin + "/apphost"), 426, "AppHost readiness", signal);
    await apphost.body?.cancel();
    if (provider) {
      const model = await waitForRoute(
        () =>
          fetch(hostname(provider) + "/v1/models", {
            headers: { authorization: "Bearer " + configured.apiKey },
            signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
          }),
        200,
        "Responses fixture readiness",
        signal,
      );
      await model.body?.cancel();
    }
    await proveCodex(
      instance,
      setupToken,
      checks,
      signal,
      configured.model,
      workersAi || externalProvider !== null,
      bridge,
      undefined,
      restartProof ? { credentialDigest: restartProof } : undefined,
    );
  } finally {
    try {
      if (verifierQueue) {
        await api.call("DELETE", "/queues/" + verifierQueue).catch((error) => {
          if (error.status !== 404) log("verification queue cleanup failed: " + String(error));
        });
      }
      if (keep) {
        log(`--keep: leaving ${names.join(", ")} for debugging`);
      } else {
        const failures: unknown[] = [];
        // Use the exact names checked before the run, even if an upload/create reply was lost.
        try {
          for (const app of await applications()) {
            if (app.name === worker) await api.call("DELETE", `${applicationPath}/${app.id}`);
          }
        } catch (error) {
          failures.push(error);
        }
        for (const name of names) {
          await api.call("DELETE", namePath(name) + "?force=true").catch((error) => {
            if (error.status !== 404) failures.push(error);
          });
        }
        const [remainingWorkers, remainingApps] = await Promise.all([api.listWorkers(), applications()]);
        assert.ok(
          names.every((name) => !remainingWorkers.includes(name)) && !remainingApps.some(({ name }) => name === worker),
          "Temporary Cloudflare resources remain",
        );
        if (failures.length) throw new AggregateError(failures, "Rehearsal cleanup failed");
        log("verified removal of the temporary Worker resources and container application");
      }
    } finally {
      for (const event of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.removeListener(event, abort);
    }
  }
}
