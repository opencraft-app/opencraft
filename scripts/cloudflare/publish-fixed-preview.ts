import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CloudflareApi } from "./cloudflare-runtime.ts";
import { inspectPreviewAddress, previewPublicOrigin } from "./preview-address.ts";
import { uploadWorkbenchAssets, workbenchAssetsConfig } from "./workbench-assets.ts";
import { bundleWorker } from "../../tests/cloudflare/worker-runtime.ts";

export const DEFAULT_PREVIEW_WORKER = "opencraft-preview-cf-fac78535";
export const DEFAULT_PREVIEW_ORIGIN = "https://preview.opencraft.app";

const DO_BINDINGS = {
  INSTALLATION_CORE: "InstallationCore",
  ACCOUNT_CORE: "AccountCore",
  WORKSPACE_HOST: "WorkspaceHost",
  CLIENT: "ClientDO",
} as const;

type Binding = { name: string; type: string; class_name?: string; namespace_id?: string; text?: string };
type ContainerConfig = { name: string; class_name: string; images: Record<string, string> };
type Settings = {
  bindings: Binding[];
  compatibility_date: string;
  compatibility_flags: string[];
  observability?: object;
};
type Deployment = { versions: { version_id: string; percentage: number }[]; id: string };
type Application = { id: string; name: string; configuration?: { image?: string } };
type VersionDetails = { id: string; resources?: { script_runtime?: { containers?: ContainerConfig[] } } };

export interface PublishFixedPreviewOptions {
  readonly assetsDir: string;
  readonly worker: string;
  readonly origin: string;
  readonly revision: string;
  readonly accountId: string;
  readonly token: string;
}

export function parsePublishArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): PublishFixedPreviewOptions {
  let assetsDir = "";
  let worker = env.CLOUDFLARE_PREVIEW_WORKER?.trim() || DEFAULT_PREVIEW_WORKER;
  let origin = env.CLOUDFLARE_PREVIEW_ORIGIN?.trim() || DEFAULT_PREVIEW_ORIGIN;
  let revision = (env.OPENCRAFT_PREVIEW_SOURCE_REVISION ?? env.GITHUB_SHA)?.trim() || "";

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === "--assets") assetsDir = value;
    else if (flag === "--worker") worker = value;
    else if (flag === "--origin") origin = value;
    else if (flag === "--revision") revision = value;
    else throw new Error(`Unknown argument: ${flag}`);
    i += 1;
  }

  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() || "";
  const token = env.CLOUDFLARE_API_TOKEN?.trim() || "";
  if (!assetsDir) throw new Error("Expected --assets <prepared-assets-dir>");
  if (!/^[a-f0-9]{32}$/u.test(accountId) || !token)
    throw new Error("Expected CLOUDFLARE_ACCOUNT_ID (32 hex chars) and CLOUDFLARE_API_TOKEN");
  if (!/^[0-9a-f]{7,40}$/u.test(revision))
    throw new Error("Expected --revision, OPENCRAFT_PREVIEW_SOURCE_REVISION, or GITHUB_SHA");

  return { assetsDir: resolve(assetsDir), worker, origin: origin.replace(/\/+$/u, ""), revision, accountId, token };
}

export function buildInheritedBindings(bindings: readonly Binding[]) {
  return bindings.map((binding) => {
    if (binding.type === "secret_text") return { type: "inherit", name: binding.name };
    if (binding.type === "durable_object_namespace") {
      return {
        type: binding.type,
        name: binding.name,
        class_name: binding.class_name,
        namespace_id: binding.namespace_id,
      };
    }
    if (binding.type === "plain_text") return { type: binding.type, name: binding.name, text: binding.text };
    if (binding.type === "assets") return { type: binding.type, name: binding.name };
    throw new Error(`Unsupported preview binding type: ${binding.type}`);
  });
}

function fingerprintBindings(settings: Settings): string {
  return JSON.stringify(settings.bindings.toSorted((a, b) => a.name.localeCompare(b.name)));
}

export function extractVersionContainers(
  version: VersionDetails,
  app: Application | undefined,
  worker: string,
): ContainerConfig[] {
  const fromVersion = version.resources?.script_runtime?.containers;
  if (fromVersion && fromVersion.length > 0) return fromVersion;
  if (app?.configuration?.image) {
    return [{ name: worker, class_name: "WorkspaceHost", images: { workspace: app.configuration.image } }];
  }
  throw new Error(`Missing container configuration on active version ${version.id} and application ${worker}`);
}

export async function publishFixedPreview(options: PublishFixedPreviewOptions) {
  const { assetsDir, worker, origin, revision, accountId, token } = options;
  const api = new CloudflareApi(accountId, token);
  const base = `/workers/scripts/${worker}`;

  const [deploymentsResult, previousSettings, applications, subdomain] = await Promise.all([
    api.call<{ deployments: Deployment[] }>("GET", `${base}/deployments`),
    api.call<Settings>("GET", `${base}/settings`),
    api.call<Application[]>("GET", "/containers/applications"),
    api.subdomain(),
  ]);

  const activeDeployment = deploymentsResult.deployments[0];
  const previousVersion = activeDeployment?.versions[0]?.version_id;
  assert.ok(previousVersion, `No active deployment found for ${worker}`);

  const app = applications.find((item) => item.name === worker);
  assert.ok(app?.id, `Missing container application for ${worker}`);

  const previousVersionDetails = await api.call<VersionDetails>("GET", `${base}/versions/${previousVersion}`);
  const containers = extractVersionContainers(previousVersionDetails, app, worker);

  const address = await inspectPreviewAddress(api, previewPublicOrigin(subdomain));
  assert.equal(
    address?.target,
    worker,
    `Fixed preview address routes to ${address?.target ?? "none"}, expected ${worker}`,
  );

  const edgeBindings = previousSettings.bindings.filter((b) => b.type === "durable_object_namespace");
  assert.equal(edgeBindings.length, 4, `Expected 4 Durable Object bindings, got ${edgeBindings.length}`);

  const html = await readFile(join(assetsDir, "index.html"), "utf8");
  assert.match(
    html,
    /<script type="module" crossorigin src="\/assets\/[A-Za-z0-9._-]+\.js"/u,
    "Built HTML lacks hashed entry script",
  );

  const bundle = await bundleWorker({
    id: worker,
    entry: new URL("./preview-worker.ts", import.meta.url).pathname,
    externalNode: true,
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: DO_BINDINGS,
  });

  const assetJwt = await uploadWorkbenchAssets(api, worker, assetsDir, console.log);
  const bindings = buildInheritedBindings(previousSettings.bindings);

  const form = new FormData();
  form.set(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          main_module: "worker.mjs",
          compatibility_date: previousSettings.compatibility_date,
          compatibility_flags: previousSettings.compatibility_flags,
          observability: previousSettings.observability,
          bindings,
          assets: { jwt: assetJwt, config: workbenchAssetsConfig },
          containers,
          annotations: {
            "workers/tag": `git-${revision.slice(0, 12)}`,
            "workers/message": `OpenCraft fixed preview ${revision.slice(0, 12)}`,
          },
        }),
      ],
      { type: "application/json" },
    ),
  );
  form.set("worker.mjs", new Blob([bundle.code], { type: "application/javascript+module" }), "worker.mjs");

  const candidate = await api.call<{ id: string }>("POST", `${base}/versions`, form);
  assert.match(candidate.id, /^[a-f0-9-]{36}$/u);
  console.log(`Candidate Worker version uploaded: ${candidate.id}`);

  const promote = (versionId: string, message: string) =>
    api.call<Deployment>("POST", `${base}/deployments`, {
      strategy: "percentage",
      versions: [{ version_id: versionId, percentage: 100 }],
      annotations: { "workers/message": message },
    });

  await promote(candidate.id, `OpenCraft fixed preview ${revision.slice(0, 12)}`);
  console.log(`Candidate promoted: ${candidate.id}`);

  try {
    const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(20_000) });
    await response.body?.cancel();
    assert.ok(
      response.status === 200 || response.status === 401,
      `Live origin ${origin}/ returned unexpected HTTP ${response.status}`,
    );

    const [finalSettings, finalApps, finalAddress, finalDeployments, finalVersion] = await Promise.all([
      api.call<Settings>("GET", `${base}/settings`),
      api.call<Application[]>("GET", "/containers/applications"),
      inspectPreviewAddress(api, previewPublicOrigin(subdomain)),
      api.call<{ deployments: Deployment[] }>("GET", `${base}/deployments`),
      api.call<VersionDetails>("GET", `${base}/versions/${candidate.id}`),
    ]);

    assert.equal(
      fingerprintBindings(finalSettings),
      fingerprintBindings(previousSettings),
      "Bindings changed during deploy",
    );
    assert.equal(finalApps.find((item) => item.name === worker)?.id, app.id, "Container application changed");
    assert.equal(finalAddress?.target, worker, "Fixed preview target changed");
    assert.equal(finalDeployments.deployments[0]?.versions[0]?.version_id, candidate.id, "Active deployment mismatch");
    assert.deepEqual(
      finalVersion.resources?.script_runtime?.containers,
      containers,
      "Container configuration changed during deploy",
    );

    console.log(`Fixed preview verified at ${origin} (version ${candidate.id})`);
    return { worker, origin, previousVersion, candidateVersion: candidate.id, revision };
  } catch (error) {
    console.error(`Verification failed, rolling back to ${previousVersion}:`, error);
    await promote(previousVersion, `Rollback OpenCraft fixed preview to ${previousVersion}`);
    throw error;
  }
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  await publishFixedPreview(parsePublishArgs(process.argv.slice(2)));
}
