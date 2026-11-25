import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CloudflareApi } from "./cloudflare-runtime.ts";
import { isPreviewCustomOrigin, previewPublicOrigin, syncPreviewAddress } from "./preview-address.ts";

interface Preview {
  worker: string;
  origin: string;
}

export interface PreviewState {
  accountId: string;
  username: "preview";
  password: string;
  image: string;
  active: Preview;
  publicOrigin?: string;
  customOrigin?: string;
  pending: Preview[];
}

type Api = Pick<CloudflareApi, "accountId" | "call" | "listWorkers">;
type Application = { id: string; name: string };
type Queue = { queue_id: string; queue_name: string };

const workerPattern = /^opencraft-preview-cf-[a-f0-9]{8}$/u;
const idPattern = /^[a-f0-9]{32}$/u;
const modelWorker = (worker: string) => worker + "-model";

function parsePreview(value: unknown, subdomain: string): Preview {
  if (typeof value !== "object" || value === null) throw Error("Invalid preview record");
  const { worker, origin } = value as Record<string, unknown>;
  if (
    typeof worker !== "string" ||
    !workerPattern.test(worker) ||
    origin !== `https://${worker}.${subdomain}.workers.dev`
  )
    throw Error("Invalid preview identity");
  return { worker, origin };
}

export function assertPreviewImage(image: unknown, accountId: string): asserts image is string {
  const prefix = `registry.cloudflare.com/${accountId}/`;
  if (
    typeof image !== "string" ||
    !image.startsWith(prefix) ||
    !/^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u.test(image.slice(prefix.length))
  )
    throw Error("Expected an immutable Cloudflare image belonging to this account");
}

async function readPrivate(path: string) {
  const file = await lstat(path);
  if (!file.isFile() || (file.mode & 0o077) !== 0)
    throw Error("The preview state and receipt require a private regular file");
  return JSON.parse(await readFile(path, "utf8"));
}

function credentials(record: Record<string, unknown>) {
  if (record.username !== "preview" || typeof record.password !== "string" || !record.password)
    throw Error("Existing preview credentials are missing");
  return { username: record.username, password: record.password } as const;
}

export async function loadPreviewState(path: string, accountId: string, subdomain: string): Promise<PreviewState> {
  const record = await readPrivate(path);
  if (record.accountId !== accountId || !Array.isArray(record.pending))
    throw Error("Preview state does not match this account");
  const active = parsePreview(record.active, subdomain);
  const pending = record.pending.map((value) => parsePreview(value, subdomain));
  if (new Set([active.worker, ...pending.map((row) => row.worker)]).size !== pending.length + 1)
    throw Error("Duplicate preview identity in the state");
  assertPreviewImage(record.image, accountId);
  const publicOrigin = record.publicOrigin;
  if (publicOrigin !== undefined && publicOrigin !== previewPublicOrigin(subdomain))
    throw Error("Invalid fixed preview address");
  const customOrigin = record.customOrigin;
  if (
    customOrigin !== undefined &&
    (!publicOrigin || !isPreviewCustomOrigin(customOrigin) || customOrigin === publicOrigin)
  )
    throw Error("Invalid custom preview address");
  return {
    accountId,
    ...credentials(record),
    image: record.image,
    active,
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    ...(customOrigin === undefined ? {} : { customOrigin }),
    pending,
  };
}

export async function savePreviewState(path: string, state: PreviewState) {
  const temporary = path + "." + randomUUID();
  try {
    await writeFile(temporary, JSON.stringify(state) + "\n", { flag: "wx", mode: 0o600, flush: true });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

const applications = (api: Api) => api.call<Application[]>("GET", "/containers/applications");
const queues = (api: Api, name: string) => api.call<Queue[]>("GET", "/queues?name=" + encodeURIComponent(name));

export async function adoptPreview(api: Api, subdomain: string, path: string, receipt: string, image: string) {
  const record = await readPrivate(receipt);
  const active = parsePreview(record, subdomain);
  const auth = credentials(record);
  assertPreviewImage(image, api.accountId);
  const [apps, workers] = await Promise.all([applications(api), api.listWorkers()]);
  if (
    record.provider !== modelWorker(active.worker) ||
    !workers.includes(active.worker) ||
    !workers.includes(record.provider) ||
    !apps.some((row) => row.name === active.worker && row.id === record.application)
  )
    throw Error("The receipt does not match the deployed preview");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const state = { accountId: api.accountId, ...auth, active, image, pending: [] };
  await writeFile(path, JSON.stringify(state) + "\n", { flag: "wx", mode: 0o600, flush: true });
}

async function deleteResource(api: Api, path: string) {
  try {
    await api.call("DELETE", path);
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
  }
}

export async function reconcilePreviews(api: Api, path: string, state: PreviewState) {
  // The journal commits a verified candidate first. Confirm the public binding
  // before reclaiming any previous target, including when resuming after a crash.
  if (state.publicOrigin) await syncPreviewAddress(api, state.publicOrigin, state.active, state.customOrigin);
  for (const { worker } of state.pending) {
    if (!workerPattern.test(worker) || worker === state.active.worker) throw Error("Cannot retire the active preview");
    const provider = modelWorker(worker);
    const queueName = worker + "-verify";
    const [apps, setupQueues] = await Promise.all([applications(api), queues(api, queueName)]);
    for (const queue of setupQueues.filter((row) => row.queue_name === queueName)) {
      if (!idPattern.test(queue.queue_id)) throw Error("Unexpected preview queue identity");
      await deleteResource(api, "/queues/" + queue.queue_id);
    }
    for (const app of apps.filter((row) => row.name === worker)) {
      if (!idPattern.test(app.id)) throw Error("Unexpected preview container identity");
      await deleteResource(api, "/containers/applications/" + app.id);
    }
    await deleteResource(api, "/workers/scripts/" + worker + "?force=true");
    await deleteResource(api, "/workers/scripts/" + provider + "?force=true");
    const [remainingApps, remainingQueues, workers] = await Promise.all([
      applications(api),
      queues(api, queueName),
      api.listWorkers(),
    ]);
    if (
      remainingApps.some((row) => row.name === worker) ||
      remainingQueues.some((row) => row.queue_name === queueName) ||
      workers.includes(worker) ||
      workers.includes(provider)
    )
      throw Error("Preview retirement is still pending: " + worker);
    await savePreviewState(path, { ...state, pending: state.pending.filter((row) => row.worker !== worker) });
    state.pending = state.pending.filter((row) => row.worker !== worker);
    console.log("Retired preview", worker);
  }
}

export async function replacePreview(
  api: Api,
  path: string,
  state: PreviewState,
  candidate: Preview,
  image: string,
  provisionAndVerify: () => Promise<void>,
) {
  if (candidate.worker === state.active.worker || state.pending.length)
    throw Error("Reconcile preview resources before starting a replacement");
  const staging = { ...state, pending: [candidate] };
  await savePreviewState(path, staging);
  const next = { ...state, active: candidate, image, pending: [state.active] };
  try {
    await provisionAndVerify();
    await savePreviewState(path, next);
  } catch (error) {
    try {
      await reconcilePreviews(api, path, staging);
    } catch {
      console.error("Candidate cleanup remains pending in the preview state");
    }
    throw error;
  }
  await reconcilePreviews(api, path, next);
  console.log("Preview verified and active", next.customOrigin ?? next.publicOrigin ?? candidate.origin);
}
