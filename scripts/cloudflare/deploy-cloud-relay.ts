// Idempotent production deployment script for the Million-Scale Hosted Cloud Relay.
//
// Provisions and updates:
// 1. R2 bucket (`opencraft-relay-blobs` by default) for Offload 3 large payload streaming;
// 2. Worker (`opencraft-cloud-relay` by default) + SQLite Durable Objects
//    (`IdentityIndexDO`, `UserRelayDO`, `MachineRelayDO`), preserving
//    `OPENCRAFT_RELAY_SIGNING_KEY` and DO namespaces across updates with automatic rollback;
// 3. Optional Workers Static Assets (`--assets <dir>`) for Offload 1 Workbench UI;
// 4. Cloudflare Workers Custom Domain (`relay.opencraft.app` by default) with automatic
//    Cloudflare edge TLS certificate + Anycast DNS binding.
//
// Credentials are read strictly from environment variables (`CLOUDFLARE_API_TOKEN`,
// optional `CLOUDFLARE_ACCOUNT_ID`) and are never written to disk.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleWorker, COMPATIBILITY_DATE } from "../../tests/cloudflare/worker-runtime.ts";
import { CloudflareApi } from "./cloudflare-runtime.ts";
import { uploadWorkbenchAssets, workbenchAssetsConfig } from "./workbench-assets.ts";

export const DEFAULT_CLOUD_RELAY_WORKER = "opencraft-cloud-relay";
export const DEFAULT_CLOUD_RELAY_BUCKET = "opencraft-relay-blobs";
export const DEFAULT_CLOUD_RELAY_DOMAIN = "relay.opencraft.app";

const DO_BINDINGS = {
  IDENTITY_INDEX: "IdentityIndexDO",
  USER_RELAY: "UserRelayDO",
  MACHINE_RELAY: "MachineRelayDO",
} as const;

interface BindingRecord {
  readonly name: string;
  readonly type: string;
  readonly class_name?: string;
  readonly namespace_id?: string;
  readonly bucket_name?: string;
  readonly text?: string;
}

interface WorkerSettings {
  readonly bindings: readonly BindingRecord[];
  readonly compatibility_date?: string;
  readonly compatibility_flags?: readonly string[];
}

interface ZoneRecord {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

interface CustomDomainRecord {
  readonly id: string;
  readonly zone_id: string;
  readonly zone_name: string;
  readonly hostname: string;
  readonly service: string;
  readonly environment: string;
}

export interface DeployCloudRelayOptions {
  readonly accountId: string;
  readonly token: string;
  readonly worker: string;
  readonly bucket: string;
  readonly customDomain: string | null;
  readonly freeMachineLimit: string;
  readonly assetsDir?: string;
}

async function resolveAccountId(token: string, explicit?: string): Promise<string> {
  if (explicit && /^[a-f0-9]{32}$/u.test(explicit)) return explicit;
  const res = await fetch("https://api.cloudflare.com/client/v4/accounts?per_page=5", {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { success?: boolean; result?: { id: string }[] };
  if (!res.ok || !body.success || !body.result?.length) {
    throw new Error("Could not resolve CLOUDFLARE_ACCOUNT_ID from token; set CLOUDFLARE_ACCOUNT_ID explicitly");
  }
  if (body.result.length > 1) {
    throw new Error("Token has access to multiple accounts; set CLOUDFLARE_ACCOUNT_ID explicitly");
  }
  return body.result[0]!.id;
}

async function findZoneForHostname(token: string, accountId: string, hostname: string): Promise<ZoneRecord | null> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones?account.id=${accountId}&per_page=50`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { success?: boolean; result?: ZoneRecord[] };
  if (!res.ok || !body.success || !body.result) return null;
  const normalized = hostname.toLowerCase();
  const candidates = body.result
    .filter((z) => normalized === z.name.toLowerCase() || normalized.endsWith(`.${z.name.toLowerCase()}`))
    .sort((a, b) => b.name.length - a.name.length);
  return candidates[0] ?? null;
}

export async function parseDeployCloudRelayArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<DeployCloudRelayOptions> {
  let worker = env.OPENCRAFT_CLOUD_RELAY_WORKER?.trim() || DEFAULT_CLOUD_RELAY_WORKER;
  let bucket = env.OPENCRAFT_CLOUD_RELAY_BUCKET?.trim() || DEFAULT_CLOUD_RELAY_BUCKET;
  let customDomain: string | null = env.OPENCRAFT_CLOUD_RELAY_DOMAIN?.trim() ?? DEFAULT_CLOUD_RELAY_DOMAIN;
  let freeMachineLimit = env.OPENCRAFT_RELAY_FREE_MACHINE_LIMIT?.trim() || "3";
  let assetsDir: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--no-custom-domain") {
      customDomain = null;
      continue;
    }
    const val = argv[i + 1];
    if (!val) throw new Error(`Missing value for ${flag}`);
    if (flag === "--worker") worker = val;
    else if (flag === "--bucket") bucket = val;
    else if (flag === "--domain") customDomain = val;
    else if (flag === "--free-machine-limit") freeMachineLimit = val;
    else if (flag === "--assets") assetsDir = resolve(val);
    else throw new Error(`Unknown flag: ${flag}`);
    i += 1;
  }

  const token = env.CLOUDFLARE_API_TOKEN?.trim() || "";
  if (!token) throw new Error("Expected CLOUDFLARE_API_TOKEN environment variable");
  const accountId = await resolveAccountId(token, env.CLOUDFLARE_ACCOUNT_ID?.trim());

  return {
    accountId,
    token,
    worker,
    bucket,
    customDomain: customDomain === "" ? null : customDomain,
    freeMachineLimit,
    ...(assetsDir ? { assetsDir } : {}),
  };
}

async function waitForRelayLive(origin: string, timeoutMs = 90_000): Promise<{ status: number; body: unknown }> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unreachable";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/__opencraft_relay/live`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (res.status === 200) {
        const body = (await res.json()) as { ok?: boolean; protocol?: number };
        if (body.ok === true && body.protocol === 2) {
          return { status: res.status, body };
        }
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error(`Timed out waiting for ${origin}/__opencraft_relay/live (${lastError})`);
}

export async function deployCloudRelay(options: DeployCloudRelayOptions) {
  const { accountId, token, worker, bucket, customDomain, freeMachineLimit, assetsDir } = options;
  const api = new CloudflareApi(accountId, token);
  const log = (msg: string) => console.log(`[deploy:cloud-relay] ${msg}`);

  // 1. Ensure R2 bucket exists
  const existingBuckets = await api.listBuckets();
  if (!existingBuckets.includes(bucket)) {
    await api.call("POST", "/r2/buckets", { name: bucket });
    log(`created R2 bucket: ${bucket}`);
  } else {
    log(`reusing existing R2 bucket: ${bucket}`);
  }

  // 2. Determine public canonical origin (custom domain if zone exists, otherwise workers.dev)
  const subdomain = await api.subdomain();
  const workersDevOrigin = `https://${worker}.${subdomain}.workers.dev`;
  let zone: ZoneRecord | null = null;
  if (customDomain) {
    zone = await findZoneForHostname(token, accountId, customDomain);
    if (!zone) {
      log(`zone for ${customDomain} not found on account; falling back to ${workersDevOrigin}`);
    }
  }
  const canonicalOrigin = customDomain && zone ? `https://${customDomain}` : workersDevOrigin;

  // 3. Bundle neutral Cloud Relay Worker + DOs
  const entry = resolve(fileURLToPath(import.meta.url), "../../../apps/relay-server/src/cloudflare/worker.ts");
  const bundle = await bundleWorker({
    id: worker,
    entry,
    durableObjects: DO_BINDINGS,
    r2Buckets: ["RELAY_BLOBS"],
  });
  const nodeImports = Object.values(bundle.metafile.inputs).flatMap((i) =>
    i.imports.filter((imp) => imp.path.startsWith("node:")).map((imp) => imp.path),
  );
  assert.deepEqual(nodeImports, [], "Cloud Relay bundle must remain 100% runtime-neutral");
  log(`bundled neutral Worker (${(bundle.code.length / 1024).toFixed(1)} KiB)`);

  // 4. Check whether Worker already exists
  const existingWorkers = await api.listWorkers();
  const isFirstDeploy = !existingWorkers.includes(worker);
  const assetJwt = assetsDir
    ? await uploadWorkbenchAssets(api, worker, assetsDir, log, [], { allowHostless: true })
    : undefined;

  let activeVersionId: string;
  if (isFirstDeploy) {
    const signingKey = process.env.OPENCRAFT_RELAY_SIGNING_KEY?.trim() || randomBytes(32).toString("hex");
    const bindings: Record<string, unknown>[] = [
      ...Object.entries(DO_BINDINGS).map(([name, className]) => ({
        type: "durable_object_namespace",
        name,
        class_name: className,
      })),
      { type: "r2_bucket", name: "RELAY_BLOBS", bucket_name: bucket },
      { type: "secret_text", name: "OPENCRAFT_RELAY_SIGNING_KEY", text: signingKey },
      { type: "plain_text", name: "OPENCRAFT_RELAY_ORIGIN", text: canonicalOrigin },
      { type: "plain_text", name: "OPENCRAFT_RELAY_FREE_MACHINE_LIMIT", text: freeMachineLimit },
      ...(assetJwt ? [{ type: "assets", name: "ASSETS" }] : []),
    ];
    const metadata = {
      main_module: "worker.mjs",
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: [],
      bindings,
      observability: { enabled: true, head_sampling_rate: 1 },
      migrations: {
        new_tag: "v1",
        new_sqlite_classes: Object.values(DO_BINDINGS),
      },
      ...(assetJwt ? { assets: { jwt: assetJwt, config: workbenchAssetsConfig } } : {}),
    };
    const form = new FormData();
    form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.set("worker.mjs", new Blob([bundle.code], { type: "application/javascript+module" }), "worker.mjs");

    await api.call("PUT", `/workers/scripts/${worker}`, form);
    await api.call("POST", `/workers/scripts/${worker}/subdomain`, {
      enabled: true,
      previews_enabled: false,
    });
    const deployments = await api.call<{ deployments: { versions: { version_id: string }[] }[] }>(
      "GET",
      `/workers/scripts/${worker}/deployments`,
    );
    activeVersionId = deployments.deployments[0]?.versions[0]?.version_id ?? "initial";
    log(`created initial Worker ${worker} (version ${activeVersionId})`);
  } else {
    const [previousSettings, deploymentsRes] = await Promise.all([
      api.call<WorkerSettings>("GET", `/workers/scripts/${worker}/settings`),
      api.call<{ deployments: { versions: { version_id: string }[] }[] }>(
        "GET",
        `/workers/scripts/${worker}/deployments`,
      ),
    ]);
    const previousVersionId = deploymentsRes.deployments[0]?.versions[0]?.version_id;
    assert.ok(previousVersionId, `No active version found on existing Worker ${worker}`);

    const existingDoMap = new Map(
      previousSettings.bindings.filter((b) => b.type === "durable_object_namespace").map((b) => [b.name, b]),
    );
    const hasSigningSecret = previousSettings.bindings.some(
      (b) => b.name === "OPENCRAFT_RELAY_SIGNING_KEY" && b.type === "secret_text",
    );
    const webAppOrigin =
      process.env.OPENCRAFT_WEB_APP_ORIGIN?.trim() ||
      (canonicalOrigin === "https://relay.opencraft.app" ? "https://my.opencraft.app" : "");

    const bindings: Record<string, unknown>[] = [
      ...Object.entries(DO_BINDINGS).map(([name, className]) => {
        const prev = existingDoMap.get(name);
        return {
          type: "durable_object_namespace",
          name,
          class_name: className,
          ...(prev?.namespace_id ? { namespace_id: prev.namespace_id } : {}),
        };
      }),
      { type: "r2_bucket", name: "RELAY_BLOBS", bucket_name: bucket },
      hasSigningSecret && !process.env.OPENCRAFT_RELAY_SIGNING_KEY
        ? { type: "inherit", name: "OPENCRAFT_RELAY_SIGNING_KEY" }
        : {
            type: "secret_text",
            name: "OPENCRAFT_RELAY_SIGNING_KEY",
            text: process.env.OPENCRAFT_RELAY_SIGNING_KEY?.trim() || randomBytes(32).toString("hex"),
          },
      { type: "plain_text", name: "OPENCRAFT_RELAY_ORIGIN", text: canonicalOrigin },
      ...(webAppOrigin ? [{ type: "plain_text", name: "OPENCRAFT_WEB_APP_ORIGIN", text: webAppOrigin }] : []),
      { type: "plain_text", name: "OPENCRAFT_RELAY_FREE_MACHINE_LIMIT", text: freeMachineLimit },
      ...(assetJwt ? [{ type: "assets", name: "ASSETS" }] : []),
    ];

    const form = new FormData();
    form.set(
      "metadata",
      new Blob(
        [
          JSON.stringify({
            main_module: "worker.mjs",
            compatibility_date: previousSettings.compatibility_date ?? COMPATIBILITY_DATE,
            compatibility_flags: previousSettings.compatibility_flags ?? [],
            observability: { enabled: true, head_sampling_rate: 1 },
            bindings,
            ...(assetJwt ? { assets: { jwt: assetJwt, config: workbenchAssetsConfig } } : {}),
          }),
        ],
        { type: "application/json" },
      ),
    );
    form.set("worker.mjs", new Blob([bundle.code], { type: "application/javascript+module" }), "worker.mjs");

    const candidate = await api.call<{ id: string }>("POST", `/workers/scripts/${worker}/versions`, form);
    await api.call("POST", `/workers/scripts/${worker}/deployments`, {
      strategy: "percentage",
      versions: [{ version_id: candidate.id, percentage: 100 }],
    });
    try {
      await waitForRelayLive(workersDevOrigin, 45_000);
    } catch (err) {
      log(`candidate ${candidate.id} failed health check, rolling back to ${previousVersionId}`);
      await api.call("POST", `/workers/scripts/${worker}/deployments`, {
        strategy: "percentage",
        versions: [{ version_id: previousVersionId, percentage: 100 }],
      });
      throw err;
    }
    activeVersionId = candidate.id;
    log(`promoted Worker ${worker} version ${activeVersionId}`);
  }

  // 5. Verify workers.dev origin
  await waitForRelayLive(workersDevOrigin, 60_000);
  log(`verified workers.dev live: ${workersDevOrigin}`);

  // 6. Bind custom domain (e.g. `relay.opencraft.app`) if zone is present
  let customDomainActive = false;
  if (customDomain && zone) {
    const existingDomains = await api.call<CustomDomainRecord[]>("GET", "/workers/domains");
    const bound = existingDomains.find((d) => d.hostname.toLowerCase() === customDomain.toLowerCase());
    if (bound && bound.service !== worker) {
      throw new Error(`Custom domain ${customDomain} is already bound to another Worker (${bound.service})`);
    }
    if (!bound) {
      await api.call("PUT", "/workers/domains", {
        zone_id: zone.id,
        hostname: customDomain,
        service: worker,
        environment: "production",
      });
      log(`bound custom domain ${customDomain} (zone ${zone.name}) -> ${worker}`);
    } else {
      log(`custom domain ${customDomain} already bound to ${worker}`);
    }
    await waitForRelayLive(`https://${customDomain}`, 90_000);
    customDomainActive = true;
    log(`verified custom domain live: https://${customDomain}`);
  }

  return {
    accountId,
    worker,
    bucket,
    versionId: activeVersionId,
    workersDevOrigin,
    canonicalOrigin,
    customDomainActive,
  };
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const opts = await parseDeployCloudRelayArgs(process.argv.slice(2));
  const summary = await deployCloudRelay(opts);
  console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
}
