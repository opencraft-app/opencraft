// Optional container group of the real-Cloudflare rehearsal:
// `npm run cf:rehearsal -- --containers`. Never part of the default run, `test`,
// `gate` or CI: it builds a Docker image and runs a paid Cloudflare Container.
//
// It deploys tests/execution/workerd/sandbox-cloudflare-worker.ts (a WorkspaceHost-
// shaped Durable Object that drives its container only through the `cloudflare`
// sandbox provider) with a container image running the real `workspace-agent --bare`
// (scripts/cloudflare/container-agent.Dockerfile), then runs
//   create → spawn (env, exit code, PTY) → endpoint round trip → agent probe
//   → Durable Object reset → WorkspaceRuntime attach by receipt → control endpoint
//   → agent stops (provider-reported loss) → new incarnation → close (destroy)
// on the smallest budget the provider maps (1/4 vCPU, 512 MiB, 2 GB disk).
//
// Every resource is named `opencraft-rehearsal-<run>-…`: the worker (deleted with
// `force=true`, which removes its Durable Object namespace), the container
// application, and the image tag in registry.cloudflare.com. No snapshot is taken.
// Leftovers of earlier runs (applications and image tags whose worker is gone) are
// removed first; the account is listed before and after.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { bundleWorker } from "../../tests/cloudflare/worker-runtime.ts";
import { REHEARSAL_PREFIX, type CloudflareApi } from "./cloudflare-runtime.ts";
import { REHEARSAL_HEALTH_PATH, REHEARSAL_KEY_HEADER } from "./rehearsal-guard.ts";

const REGISTRY = "registry.cloudflare.com";
/** The Durable Object Container API (`exec`, labels, custom instances) needs a recent date. */
const CONTAINERS_COMPATIBILITY_DATE = "2026-11-01";
const CONTAINER_CLASS = "WorkspaceContainer";
const WORKER_ENTRY = new URL("../../tests/execution/workerd/sandbox-cloudflare-worker.ts", import.meta.url).pathname;
const GUARD_MODULE = new URL("./rehearsal-guard.ts", import.meta.url).pathname;
const AGENT_ENTRY = new URL("../container-deployment/workspace-agent.mjs", import.meta.url).pathname;
const DOCKERFILE = new URL("./container-agent.Dockerfile", import.meta.url).pathname;
const OWN_NAME = /^opencraft-rehearsal-([0-9a-f]{8})-(?:containers|agent)$/u;
const run = promisify(execFile);

interface Application {
  readonly id: string;
  readonly name: string;
  readonly created_at?: string;
}
export interface ContainerStep {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: unknown;
}
export interface ContainerRehearsalResult {
  readonly steps: ContainerStep[];
  readonly failures: string[];
  readonly before: AccountContainers;
  readonly after: AccountContainers;
}
interface AccountContainers {
  readonly workers: string[];
  readonly applications: string[];
  readonly images: string[];
}

async function docker(args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("docker", args, { env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "",
      err = "";
    child.stdout.on("data", (data) => (out += data));
    child.stderr.on("data", (data) => (err += data));
    child.stdin.end(options.input ?? "");
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`docker ${args[0]} failed (${code}): ${err.slice(-600)}`)),
    );
  });
}

/** Registry credentials from the API (never printed); `v1:<password>` for registry calls. */
async function registryCredentials(api: CloudflareApi, permissions: string[], minutes = 15) {
  const credentials = await api.call<{ username: string; password: string }>(
    "POST",
    `/containers/registries/${REGISTRY}/credentials`,
    { expiration_minutes: minutes, permissions },
  );
  return { ...credentials, basic: Buffer.from(`v1:${credentials.password}`).toString("base64") };
}

async function registryImages(api: CloudflareApi): Promise<string[]> {
  const { basic } = await registryCredentials(api, ["pull"], 5);
  const images: string[] = [];
  let url: string | undefined = `https://${REGISTRY}/v2/_catalog?tags=true`;
  for (let page = 0; url && page < 50; page++) {
    const response = await fetch(url, { headers: { authorization: `Basic ${basic}` } });
    if (!response.ok) throw new Error(`registry catalog: HTTP ${response.status}`);
    const body = (await response.json()) as { repositories?: Record<string, string[]> };
    for (const [repository, tags] of Object.entries(body.repositories ?? {}))
      for (const tag of tags) images.push(`${repository.replace(/^\/+/u, "")}:${tag}`);
    const next = /<([^>]+)>;\s*rel="?next"?/u.exec(response.headers.get("link") ?? "")?.[1];
    url = next ? new URL(next, `https://${REGISTRY}`).href : undefined;
  }
  return images.sort();
}

/** `<account>/<repository>:<reference>`; the reference may itself be `sha256:<digest>`. */
const splitImage = (image: string) => {
  const at = image.indexOf(":");
  return { repository: image.slice(0, at).replace(/^[0-9a-f]{32}\//u, ""), reference: image.slice(at + 1) };
};

/** Image references the registry refuses to delete because Cloudflare owns them: the
 * image preparation's `btrfs-chain` artifact (409 SINGLETON_ARTIFACT_EXISTS). Reported,
 * never counted as a cleanup failure. */
const retained = new Set<string>();
export const platformRetainedImages = (): readonly string[] => [...retained].sort();

/** Deletes every reference the registry lists for the selected repositories: the pushed
 * tag and the digest manifests kept beside it. A manifest still referenced by another
 * answers 409 until its parent is gone, so deletion runs in passes until nothing more can
 * be removed. Returns what is left (platform-retained artifacts excluded). */
async function deleteImages(
  api: CloudflareApi,
  select: (repository: string) => boolean,
  log: (line: string) => void,
): Promise<string[]> {
  let left: string[] = [];
  for (let pass = 0; pass < 6; pass++) {
    const images = (await registryImages(api)).filter(
      (image) => select(splitImage(image).repository) && !retained.has(image),
    );
    if (!images.length) return [];
    left = [];
    for (const image of images) {
      const { repository, reference } = splitImage(image);
      try {
        if ((await deleteImageReference(api, repository, reference)) === "retained") {
          retained.add(image);
          log(`platform-retained image ${repository}:${reference} (Cloudflare image-preparation artifact)`);
        } else log(`deleted image ${repository}:${reference}`);
      } catch (error) {
        left.push(`${repository}:${reference} (${String(error)})`);
      }
    }
    if (!left.length) return [];
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return left;
}

async function deleteImageReference(
  api: CloudflareApi,
  repository: string,
  tag: string,
): Promise<"deleted" | "retained"> {
  const { basic } = await registryCredentials(api, ["pull", "push"], 5);
  const url = `https://${REGISTRY}/v2/${api.accountId}/${repository}/manifests/${tag}`;
  const accept = "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";
  const response = await fetch(url, { method: "DELETE", headers: { authorization: `Basic ${basic}`, accept } });
  const body = await response.text();
  if (response.status === 409 && body.includes("SINGLETON_ARTIFACT_EXISTS")) return "retained";
  if (!response.ok && response.status !== 404) throw new Error(`delete ${repository}:${tag}: HTTP ${response.status}`);
  await fetch(`https://${REGISTRY}/v2/gc/layers`, {
    method: "PUT",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/json" },
  }).catch(() => undefined);
  return "deleted";
}

const listApplications = (api: CloudflareApi) => api.call<Application[]>("GET", "/containers/applications");

async function accountContainers(api: CloudflareApi): Promise<AccountContainers> {
  return {
    workers: await api.listWorkers(),
    applications: (await listApplications(api)).map((application) => application.name).sort(),
    images: await registryImages(api),
  };
}

/** Applications and image tags of earlier container rehearsals whose worker is gone
 * (the shared leftover sweep deletes stale workers first). */
export async function cleanContainerLeftovers(api: CloudflareApi, log: (line: string) => void): Promise<string[]> {
  const failures: string[] = [];
  const workers = new Set(await api.listWorkers());
  for (const application of await listApplications(api)) {
    const match = OWN_NAME.exec(application.name);
    if (!match || workers.has(application.name)) continue;
    try {
      await api.call("DELETE", `/containers/applications/${application.id}`);
      log(`deleted leftover container application ${application.name}`);
    } catch (error) {
      failures.push(`application ${application.name}: ${String(error)}`);
    }
  }
  const stale = (repository: string) => {
    const match = OWN_NAME.exec(repository);
    return !!match && !workers.has(`${REHEARSAL_PREFIX}${match[1]}-containers`);
  };
  for (const image of await deleteImages(api, stale, (line) => log(`leftover: ${line}`)))
    failures.push(`image ${image}`);
  return failures;
}

export async function runContainerRehearsal(options: {
  readonly api: CloudflareApi;
  readonly log: (line: string) => void;
  /** `opencraft-rehearsal-<run>`. */
  readonly prefix: string;
  readonly key: string;
  readonly subdomain: string;
  readonly keep?: boolean;
}): Promise<ContainerRehearsalResult> {
  const { api, log, prefix, key } = options;
  const worker = `${prefix}-containers`,
    repository = `${prefix}-agent`,
    tag = "rehearsal",
    remote = `${REGISTRY}/${api.accountId}/${repository}:${tag}`;
  if (!OWN_NAME.test(worker) || !OWN_NAME.test(repository)) throw new Error(`unexpected rehearsal names ${prefix}`);
  const steps: ContainerStep[] = [],
    failures: string[] = [];
  const step = async (name: string, action: () => Promise<unknown>) => {
    const started = Date.now();
    try {
      const detail = await action();
      steps.push({ name, ok: true, ms: Date.now() - started, detail });
      log(`pass ${String(Date.now() - started).padStart(6)}ms | containers: ${name}`);
      return detail;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      steps.push({ name, ok: false, ms: Date.now() - started, detail });
      log(`FAIL ${String(Date.now() - started).padStart(6)}ms | containers: ${name}: ${detail.slice(0, 800)}`);
      throw error;
    }
  };
  for (const failure of await cleanContainerLeftovers(api, log)) failures.push(`leftover ${failure}`);
  const before = await accountContainers(api);
  log(
    `containers: account has ${before.workers.length} workers, ${before.applications.length} container applications, ${before.images.length} image tags before the run`,
  );
  if (before.workers.includes(worker) || before.applications.includes(worker))
    throw new Error(`Refusing to touch pre-existing ${worker}`);

  const scratch = await mkdtemp(join(tmpdir(), "cf-containers-"));
  const dockerConfig = await mkdtemp(join(tmpdir(), "cf-docker-"));
  const localTag = `${repository}:${tag}`;
  let workerCreated = false,
    pushed = false,
    applicationId: string | undefined;
  const origin = `https://${worker}.${options.subdomain}.workers.dev`;
  const call = async (action: string, timeoutMs = 300_000) => {
    const response = await fetch(`${origin}/do/workspace/${action}`, {
      method: "POST",
      headers: { [REHEARSAL_KEY_HEADER]: key },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      body = { status: response.status, text: text.slice(0, 500) };
    }
    if (!response.ok && action !== "reset")
      throw new Error(`${action}: HTTP ${response.status} ${JSON.stringify(body)}`);
    return body;
  };
  try {
    await step("build the workspace-agent image", async () => {
      await build({
        entryPoints: [AGENT_ENTRY],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        outfile: join(scratch, "workspace-agent.mjs"),
        banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
        logLevel: "silent",
      });
      await copyFile(DOCKERFILE, join(scratch, "Dockerfile"));
      // One platform manifest, no attestation manifests beside it.
      await docker([
        "build",
        "--platform",
        "linux/amd64",
        "--provenance=false",
        "--sbom=false",
        "-q",
        "-t",
        localTag,
        scratch,
      ]);
      return localTag;
    });
    const image = (await step(`push ${REGISTRY} image`, async () => {
      const { username, password } = await registryCredentials(api, ["push", "pull"], 30);
      const env = { ...process.env, DOCKER_CONFIG: dockerConfig };
      await docker(["login", "--password-stdin", "--username", username, REGISTRY], { env, input: password });
      await docker(["tag", localTag, remote], { env });
      pushed = true;
      await docker(["push", "-q", remote], { env });
      const digests = JSON.parse(
        await docker(["image", "inspect", "--format", "{{json .RepoDigests}}", remote], { env }),
      ) as string[];
      const digest = digests.find((value) => value.startsWith(`${REGISTRY}/${api.accountId}/${repository}@sha256:`));
      if (!digest) throw new Error("pushed image has no registry digest");
      // Cloudflare prepares the image on its network before a Worker version may use it.
      const deadline = Date.now() + 15 * 60_000;
      for (;;) {
        const preparation = await api.call<{ status: string; reason?: string }>(
          "POST",
          "/containers/image-preparations",
          { image: digest },
        );
        if (/ready/iu.test(preparation.status)) break;
        if (/error/iu.test(preparation.status)) throw new Error(preparation.reason ?? "image preparation failed");
        if (Date.now() > deadline) throw new Error("image preparation timed out");
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      return digest;
    })) as string;
    await step("deploy the Worker, Durable Object and container application", async () => {
      const started = Date.now();
      const { code } = await bundleWorker(
        { id: "containers", entry: WORKER_ENTRY, durableObjects: { WORKSPACE: CONTAINER_CLASS } },
        { module: GUARD_MODULE, exportName: "rehearsalGuard" },
      );
      const metadata = {
        main_module: "worker.mjs",
        compatibility_date: CONTAINERS_COMPATIBILITY_DATE,
        bindings: [
          { type: "durable_object_namespace", name: "WORKSPACE", class_name: CONTAINER_CLASS },
          { type: "secret_text", name: "REHEARSAL_KEY", text: key },
          { type: "plain_text", name: "REHEARSAL_GENERATION", text: "1" },
        ],
        migrations: { new_tag: "v1", new_sqlite_classes: [CONTAINER_CLASS] },
        containers: [{ name: worker, class_name: CONTAINER_CLASS, images: { base: image } }],
        observability: { enabled: true, head_sampling_rate: 1 },
      };
      const form = new FormData();
      form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
      form.set("worker.mjs", new Blob([code], { type: "application/javascript+module" }), "worker.mjs");
      workerCreated = true;
      await api.call("PUT", `/workers/scripts/${worker}`, form);
      await api.call("POST", `/workers/scripts/${worker}/subdomain`, { enabled: true, previews_enabled: false });
      // The namespace listing is paged and can lag the upload by a few seconds.
      let namespace: { id: string; script?: string; class?: string } | undefined;
      for (const deadline = Date.now() + 60_000; !namespace;) {
        for (let page = 1; page <= 20 && !namespace; page++) {
          const namespaces = await api.call<{ id: string; script?: string; class?: string }[]>(
            "GET",
            `/workers/durable_objects/namespaces?per_page=100&page=${page}`,
          );
          namespace = namespaces.find((entry) => entry.script === worker && entry.class === CONTAINER_CLASS);
          if (namespaces.length < 100) break;
        }
        if (namespace) break;
        if (Date.now() > deadline) throw new Error("the Durable Object namespace was not created");
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      const application = await api.call<Application>("POST", "/containers/applications", {
        name: worker,
        scheduling_policy: "durable_object",
        durable_objects: { namespace_id: namespace.id },
      });
      applicationId = application.id;
      const deadline = Date.now() + 90_000;
      for (let consecutive = 0; consecutive < 3;) {
        const ok = await fetch(origin + REHEARSAL_HEALTH_PATH, { headers: { [REHEARSAL_KEY_HEADER]: key } }).then(
          (response) => response.ok,
          () => false,
        );
        consecutive = ok ? consecutive + 1 : 0;
        if (Date.now() > deadline) throw new Error("worker did not become reachable");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      // The container binding reaches the Durable Object shortly after the application
      // exists (one run saw `ctx.container` missing right after creation): wait for it.
      let status: Record<string, unknown> | undefined;
      for (const deadline = Date.now() + 120_000; ;) {
        status = await call("status", 30_000).catch(() => undefined);
        if (status && status.running === false) break;
        if (Date.now() > deadline) throw new Error("the container binding did not become available");
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      return { worker, application: application.name, namespace: namespace.id, deployedMs: Date.now() - started };
    });
    await step("create → spawn → endpoint round trip → agent probe", async () => {
      const report = await call("create");
      const command = report.command as { text: string; exit: { code: number } };
      const endpoint = report.endpoint as { equal: boolean; bytes: number };
      const terminal = report.terminal as { text: string };
      if (command.text !== "|command|arg with space" || command.exit.code !== 3)
        throw new Error(`exec env/argv/exit not as expected: ${JSON.stringify(command)}`);
      if (!/45 123/u.test(terminal.text) || !/\/dev\/pts\//u.test(terminal.text))
        throw new Error(`terminal not as expected: ${JSON.stringify(terminal)}`);
      if (!endpoint.equal || endpoint.bytes !== 4 * 1024 * 1024)
        throw new Error(`endpoint round trip differs: ${JSON.stringify(endpoint)}`);
      return report;
    });
    await step("Durable Object reset", async () => {
      await call("reset").catch((error) => ({ error: String(error) }));
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return call("status");
    });
    await step("attach by receipt → control → loss → new incarnation → close", async () => {
      const report = await call("attach", 600_000);
      const events = (report.events as { type: string; reason?: string }[]).map(
        (event) => event.type + (event.reason ? `:${event.reason}` : ""),
      );
      if (!report.runningAtConstruction || !report.sameIncarnation || !report.controlAnswer)
        throw new Error(`receipt attach did not bind the same incarnation: ${JSON.stringify(report)}`);
      if ((report.loss as { reason?: string })?.reason === undefined) throw new Error("no loss was reported");
      if (events[0] !== "attached" || !events.includes("released:lost:exited") || !events.includes("created"))
        throw new Error(`unexpected placement events ${events.join(", ")}`);
      if (report.runningAfterClose !== false || report.inspectAfterClose !== null)
        throw new Error("close did not stop the container");
      return report;
    });
  } catch {
    // Recorded in steps; cleanup follows.
  } finally {
    if (options.keep) log(`--keep: leaving ${worker}, its container application and ${remote}`);
    else {
      try {
        // Stop anything still running before removing the application.
        if (workerCreated) await call("destroy", 60_000).catch(() => undefined);
      } catch {}
      if (applicationId)
        await api
          .call("DELETE", `/containers/applications/${applicationId}`)
          .then(() => log(`deleted container application ${worker}`))
          .catch((error) => failures.push(`application ${worker}: ${String(error)}`));
      if (workerCreated)
        await api
          .call("DELETE", `/workers/scripts/${worker}?force=true`)
          .then(() => log(`deleted worker ${worker}`))
          .catch((error) => {
            if ((error as { status?: number }).status !== 404) failures.push(`worker ${worker}: ${String(error)}`);
          });
      if (pushed)
        for (const image of await deleteImages(api, (name) => name === repository, log).catch((error) => [
          `${repository} (${String(error)})`,
        ]))
          failures.push(`image ${image}`);
      await run("docker", ["image", "rm", "-f", localTag, remote]).catch(() => undefined);
    }
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    await rm(dockerConfig, { recursive: true, force: true }).catch(() => undefined);
  }
  const after = await accountContainers(api);
  const leftovers = [...after.workers, ...after.applications, ...after.images].filter(
    (name) => name.includes(REHEARSAL_PREFIX) && !retained.has(name),
  );
  log(
    `containers: after cleanup ${after.workers.length} workers, ${after.applications.length} container applications [${after.applications.join(", ")}], ${after.images.length} image tags [${after.images.join(", ")}]; rehearsal leftovers: ${leftovers.join(", ") || "none"}`,
  );
  if (retained.size)
    log(
      `containers: the registry refused to delete ${retained.size} Cloudflare image-preparation artifact(s) (SINGLETON_ARTIFACT_EXISTS): ${platformRetainedImages().join(", ")}`,
    );
  if (leftovers.length && !options.keep) failures.push(`leftovers: ${leftovers.join(", ")}`);
  return { steps, failures, before, after };
}
