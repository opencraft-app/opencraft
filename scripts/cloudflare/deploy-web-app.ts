// Idempotent deployment script for the standalone OpenCraft Web Workbench (`https://my.opencraft.app`),
// keeping `https://relay.opencraft.app` strictly a pure API/WebSocket relay gateway.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { COMPATIBILITY_DATE } from "../../tests/cloudflare/worker-runtime.ts";
import { CloudflareApi } from "./cloudflare-runtime.ts";
import { uploadWorkbenchAssets, workbenchAssetsConfig } from "./workbench-assets.ts";

export const DEFAULT_WEB_APP_WORKER = "opencraft-web-app";
export const DEFAULT_WEB_APP_DOMAIN = "my.opencraft.app";

const STANDALONE_WEB_WORKER_SOURCE = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname === "/__opencraft_web/live") {
      return new Response(JSON.stringify({ ok: true, service: "opencraft-web-app" }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    if (env.ASSETS && (request.method === "GET" || request.method === "HEAD")) {
      const wrapHead = (res) =>
        request.method === "HEAD" ? new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers }) : res;
      const targetPath = pathname === "/" ? "/index.html" : pathname;
      const assetRes = await env.ASSETS.fetch(new Request(new URL(targetPath, url.origin), { method: "GET" }));
      if (assetRes.status !== 404) return wrapHead(assetRes);
      const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
      const isSpaRoute =
        !lastSegment.includes(".") ||
        pathname === "/pair" ||
        pathname === "/claim" ||
        pathname.startsWith("/s/") ||
        Boolean(request.headers.get("accept")?.includes("text/html"));
      if (isSpaRoute) {
        const spaRes = await env.ASSETS.fetch(new Request(new URL("/index.html", url.origin), { method: "GET" }));
        return wrapHead(spaRes);
      }
    }
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  },
};
`;

interface ZoneRecord {
  readonly id: string;
  readonly name: string;
}

interface CustomDomainRecord {
  readonly hostname: string;
  readonly service: string;
}

async function findZoneForHostname(token: string, accountId: string, hostname: string): Promise<ZoneRecord | null> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones?account.id=${accountId}&per_page=50`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { success?: boolean; result?: ZoneRecord[] };
  if (!res.ok || !body.success || !body.result) return null;
  const normalized = hostname.toLowerCase();
  return (
    body.result
      .filter((z) => normalized === z.name.toLowerCase() || normalized.endsWith(`.${z.name.toLowerCase()}`))
      .sort((a, b) => b.name.length - a.name.length)[0] ?? null
  );
}

async function waitForWebLive(origin: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unreachable";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/__opencraft_web/live`, { signal: AbortSignal.timeout(8_000) });
      if (res.status === 200) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error(`Timed out waiting for ${origin}/__opencraft_web/live (${lastError})`);
}

export async function deployWebApp(options: {
  readonly accountId: string;
  readonly token: string;
  readonly assetsDir: string;
  readonly worker?: string;
  readonly customDomain?: string;
}) {
  const worker = options.worker ?? DEFAULT_WEB_APP_WORKER;
  const customDomain = options.customDomain ?? DEFAULT_WEB_APP_DOMAIN;
  const api = new CloudflareApi(options.accountId, options.token);
  const log = (msg: string) => console.log(`[deploy:web-app] ${msg}`);

  const subdomain = await api.subdomain();
  const workersDevOrigin = `https://${worker}.${subdomain}.workers.dev`;
  const existingWorkers = await api.listWorkers();
  const isFirstDeploy = !existingWorkers.includes(worker);

  if (isFirstDeploy) {
    // Bootstrap empty Worker script first so assets-upload-session endpoint exists for this script name
    const initForm = new FormData();
    initForm.set(
      "metadata",
      new Blob(
        [
          JSON.stringify({
            main_module: "worker.mjs",
            compatibility_date: COMPATIBILITY_DATE,
            compatibility_flags: [],
            bindings: [],
          }),
        ],
        { type: "application/json" },
      ),
    );
    initForm.set(
      "worker.mjs",
      new Blob([STANDALONE_WEB_WORKER_SOURCE], { type: "application/javascript+module" }),
      "worker.mjs",
    );
    await api.call("PUT", `/workers/scripts/${worker}`, initForm);
    await api.call("POST", `/workers/scripts/${worker}/subdomain`, { enabled: true, previews_enabled: false });
    log(`initialized Worker ${worker}`);
  }

  const assetJwt = await uploadWorkbenchAssets(api, worker, options.assetsDir, log, [], { allowHostless: true });
  const form = new FormData();
  form.set(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          main_module: "worker.mjs",
          compatibility_date: COMPATIBILITY_DATE,
          compatibility_flags: [],
          observability: { enabled: true, head_sampling_rate: 1 },
          bindings: [{ type: "assets", name: "ASSETS" }],
          assets: { jwt: assetJwt, config: workbenchAssetsConfig },
        }),
      ],
      { type: "application/json" },
    ),
  );
  form.set(
    "worker.mjs",
    new Blob([STANDALONE_WEB_WORKER_SOURCE], { type: "application/javascript+module" }),
    "worker.mjs",
  );

  const candidate = await api.call<{ id: string }>("POST", `/workers/scripts/${worker}/versions`, form);
  await api.call("POST", `/workers/scripts/${worker}/deployments`, {
    strategy: "percentage",
    versions: [{ version_id: candidate.id, percentage: 100 }],
  });
  await waitForWebLive(workersDevOrigin, 60_000);
  log(`promoted Worker ${worker} version ${candidate.id} (${workersDevOrigin})`);

  const zone = await findZoneForHostname(options.token, options.accountId, customDomain);
  let customDomainActive = false;
  if (zone) {
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
      log(`bound custom domain ${customDomain} -> ${worker}`);
    } else {
      log(`custom domain ${customDomain} already bound to ${worker}`);
    }
    await waitForWebLive(`https://${customDomain}`, 90_000);
    customDomainActive = true;
    log(`verified custom domain live: https://${customDomain}`);
  }

  return {
    accountId: options.accountId,
    worker,
    versionId: candidate.id,
    workersDevOrigin,
    canonicalOrigin: customDomainActive ? `https://${customDomain}` : workersDevOrigin,
    customDomainActive,
  };
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const assetsArgIdx = process.argv.indexOf("--assets");
  const assetsDir = assetsArgIdx >= 0 ? process.argv[assetsArgIdx + 1] : undefined;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || "";
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim() || "";
  if (!assetsDir || !accountId || !token) {
    throw new Error("Usage: CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... tsx deploy-web-app.ts --assets <dir>");
  }
  const summary = await deployWebApp({ accountId, token, assetsDir: resolve(assetsDir) });
  console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
}
