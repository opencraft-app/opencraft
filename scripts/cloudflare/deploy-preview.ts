import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { CloudflareApi } from "./cloudflare-runtime.ts";
import {
  adoptPreview,
  assertPreviewImage,
  loadPreviewState,
  reconcilePreviews,
  replacePreview,
  savePreviewState,
  type PreviewState,
} from "./preview-state.ts";
import { inspectPreviewAddress, isPreviewCustomOrigin, previewPublicOrigin } from "./preview-address.ts";
import { bundleWorker } from "../../tests/cloudflare/worker-runtime.ts";

import { uploadWorkbenchAssets, workbenchAssetsConfig } from "./workbench-assets.ts";

const [stateFile, mode, ...args] = process.argv.slice(2);
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
if (!stateFile || !mode || !accountId || !/^[a-f0-9]{32}$/u.test(accountId) || !token)
  throw Error("Expected a preview state path and operation, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
const api = new CloudflareApi(accountId, token);
const subdomain = await api.subdomain();
if (mode === "--adopt") {
  const [receipt, image] = args;
  if (!receipt || !image || args.length !== 2) throw Error("Expected --adopt <access-receipt> <image>");
  await adoptPreview(api, subdomain, stateFile, receipt, image);
  console.log("Registered the existing preview");
} else {
  const stateOnly = mode === "--cleanup-only" || mode === "--publish-address";
  if ((mode === "--cleanup-only" && args.length) || (!stateOnly && mode.startsWith("--")) || args.length > 1)
    throw Error("Expected --cleanup-only, --publish-address [custom HTTPS origin] or <assets-dir> [image]");
  const state = await loadPreviewState(stateFile, api.accountId, subdomain);
  if (mode === "--publish-address") {
    const publicOrigin = previewPublicOrigin(subdomain);
    const [customOrigin] = args;
    if (customOrigin !== undefined && (!isPreviewCustomOrigin(customOrigin) || customOrigin === publicOrigin))
      throw Error("Expected a custom HTTPS origin");
    if (customOrigin && state.customOrigin && customOrigin !== state.customOrigin)
      throw Error("This preview already has a different custom address");
    if (!state.publicOrigin) {
      const existing = await inspectPreviewAddress(api, publicOrigin);
      if (existing) throw Error("The fixed preview address is registered to another state file");
      state.publicOrigin = publicOrigin;
    }
    if (customOrigin) state.customOrigin = customOrigin;
    await savePreviewState(stateFile, state);
  }
  await reconcilePreviews(api, stateFile, state);
  if (mode === "--publish-address")
    console.log("Fixed preview address active", state.customOrigin ?? state.publicOrigin);
  if (!stateOnly) await deploy(state, mode, args[0] ?? state.image);
}

async function deploy(state: PreviewState, assetsDir: string, image: string) {
  const worker = "opencraft-preview-cf-" + randomBytes(4).toString("hex");
  const provider = worker + "-model";
  const origin = "https://" + worker + "." + subdomain + ".workers.dev";
  const providerOrigin = "https://" + provider + "." + subdomain + ".workers.dev";
  const setup = randomBytes(32).toString("base64url");
  const providerProof = randomBytes(32).toString("base64url");
  const start = Date.now();
  const scripts = (name: string) => "/workers/scripts/" + name;
  const call = <T>(method: string, path: string, body?: unknown) => api.call<T>(method, path, body);
  const info = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);
  const plain = (name: string, text: string) => ({ type: "plain_text", name, text });
  const secret = (name: string, text: string) => ({ type: "secret_text", name, text });
  const doBindings = {
    INSTALLATION_CORE: "InstallationCore",
    ACCOUNT_CORE: "AccountCore",
    WORKSPACE_HOST: "WorkspaceHost",
    CLIENT: "ClientDO",
  };

  async function uploadScript(name: string, code: string, metadata: unknown) {
    const form = new FormData();
    form.set(
      "metadata",
      new Blob(
        [
          JSON.stringify({
            main_module: "worker.mjs",
            compatibility_date: "2026-11-01",
            compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
            observability: { enabled: true, head_sampling_rate: 1 },
            ...(metadata as object),
          }),
        ],
        { type: "application/json" },
      ),
    );
    form.set("worker.mjs", new Blob([code], { type: "application/javascript+module" }), "worker.mjs");
    await call("PUT", scripts(name), form);
  }

  async function messages() {
    const result = await call<any>("POST", "/workers/observability/telemetry/query", {
      queryId: worker,
      timeframe: { from: start - 60_000, to: Date.now() + 60_000 },
      view: "events",
      limit: 200,
      parameters: { filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: worker }] },
    });
    return (result.events?.events ?? []).flatMap((event: any) => {
      const message = event.source?.message ?? event.$metadata?.message;
      return typeof message === "string" ? [message] : [];
    }) as string[];
  }

  assertPreviewImage(image, api.accountId);
  const registered = await api.listWorkers();
  if (state.active.worker === worker || registered.includes(worker) || registered.includes(provider))
    throw Error("Preview name collision");
  const candidate = { worker, origin };
  await replacePreview(api, stateFile, state, candidate, image, async () => {
    const bundle = await bundleWorker({
      id: worker,
      entry: new URL("./preview-worker.ts", import.meta.url).pathname,
      externalNode: true,
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: doBindings,
    });
    const assets = await uploadWorkbenchAssets(api, worker, assetsDir, info);
    await uploadScript(provider, await readFile(new URL("./rehearsal-codex-workers-ai.mjs", import.meta.url), "utf8"), {
      bindings: [secret("REHEARSAL_PROVIDER_PROOF", providerProof), { type: "ai", name: "AI" }],
    });
    await call("POST", scripts(provider) + "/subdomain", { enabled: true, previews_enabled: false });
    await uploadScript(worker, bundle.code, {
      assets: { jwt: assets, config: workbenchAssetsConfig },
      bindings: [
        { type: "assets", name: "ASSETS" },
        ...Object.entries(doBindings).map(([name, class_name]) => ({
          type: "durable_object_namespace",
          name,
          class_name,
        })),
        secret("OPENCRAFT_SETUP_TOKEN", setup),
        secret("OPENCRAFT_ACCOUNT_SEALING_KEY", "k1." + randomBytes(32).toString("base64url")),
        secret("PREVIEW_PASSWORD", state.password),
        secret("PROVIDER_PROOF", providerProof),
        plain("PREVIEW_ORIGIN", origin),
        plain("PREVIEW_PROVIDER", providerOrigin),
        plain("OPENCRAFT_HUMAN_AUTH", JSON.stringify({ origin, local: true, oidc: [] })),
        plain("OPENCRAFT_WORKSPACE_IMAGE", "workspace"),
        plain("OPENCRAFT_WORKSPACE_USER", "1000:1000"),
        plain("OPENCRAFT_WORKSPACE_ENGINES", "codex,pi"),
        plain("OPENCRAFT_WORKSPACE_IDLE", "120000"),
        plain("OPENCRAFT_WORKSPACE_CODEX_SNAPSHOTS", "true"),
        plain("OPENCRAFT_WORKSPACE_CODEX_ISOLATE_ACTORS", "true"),
        plain("OPENCRAFT_WORKSPACE_CODEX_TURNS", "true"),
        plain("OPENCRAFT_WORKSPACE_CODEX_FILES", "true"),
        plain("OPENCRAFT_WORKSPACE_CODEX_PROJECTS", "true"),
        plain("OPENCRAFT_WORKSPACE_CODEX_DEFAULT", worker),
        plain("OPENCRAFT_WORKSPACE_CODEX_BRIDGE_ENDPOINT", "true"),
        plain("OPENCRAFT_WORKSPACE_CODEX_EGRESS_ORIGIN", "http://workspace-model.invalid"),
        plain("OPENCRAFT_WORKSPACE_CODEX_EGRESS_PROVIDER", "cloud-smoke"),
      ],
      migrations: { new_tag: "v1", new_sqlite_classes: Object.values(doBindings) },
      containers: [{ name: worker, class_name: "WorkspaceHost", images: { workspace: image } }],
    });
    await call("POST", scripts(worker) + "/subdomain", { enabled: !state.publicOrigin, previews_enabled: false });
    let namespace;
    for (const deadline = Date.now() + 70_000; Date.now() < deadline && !namespace;) {
      for (let page = 1; ; page++) {
        const rows = await call<{ id: string; script: string; class: string }[]>(
          "GET",
          "/workers/durable_objects/namespaces?per_page=100&page=" + page,
        );
        namespace = rows.find((value) => value.script === worker && value.class === "WorkspaceHost");
        if (namespace || rows.length < 100) break;
      }
      if (!namespace) await delay(1500);
    }
    if (!namespace) throw new Error("WorkspaceHost namespace missing");
    await call("POST", "/containers/applications", {
      name: worker,
      scheduling_policy: "durable_object",
      durable_objects: { namespace_id: namespace.id },
    });
    const queueId = (await call<{ queue_id: string }>("POST", "/queues", { queue_name: worker + "-verify" })).queue_id;
    await call("POST", "/queues/" + queueId + "/consumers", {
      type: "worker",
      script_name: worker,
      settings: { batch_size: 1, max_concurrency: 1, max_retries: 0, max_wait_time_ms: 0 },
    });
    await delay(7000);
    await call("POST", "/queues/" + queueId + "/messages", { body: "preview verification", content_type: "text" });
    info("Preview deployed", origin);
    const deadline = Date.now() + 210_000;
    for (;;) {
      const events = await messages();
      const result = events.find((value) => value.startsWith("OC_PREVIEW_RESULT "));
      if (result) {
        const status = JSON.parse(result.slice("OC_PREVIEW_RESULT ".length));
        if (status.phase !== "verified") throw Error("Preview verification failed at " + status.stage);
        break;
      }
      if (Date.now() >= deadline) throw Error("Timed out waiting for preview verification");
      await delay(3500);
    }
    await call("DELETE", "/queues/" + queueId);
  });
}
