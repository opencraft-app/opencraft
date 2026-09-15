import { Service, type Inject } from "@deepseek-ai/cordis";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { JsonValue } from "../types/domain.ts";
import type {
  TransparentBindingArtifact,
  TransparentBindingHost,
  TransparentBindingState,
  TransparentRuntimeHint,
  TransparentRuntimeUpdate,
  TransparentThreadBinding,
  TransparentThreadBindingPort,
  TransparentThreadRealm,
} from "../types/transparent-binding.ts";
import { providerIdFromAccountIdentity } from "./transparent-thread-routing.ts";

const SNAPSHOT_NAMESPACE = "transparentCodexBindings";
const SNAPSHOT_VERSION = 4;

interface BindingSnapshotRecord {
  outerThreadId: string;
  innerThreadId: string;
  realm?: TransparentThreadRealm;
  viewId?: string;
  rolloutPath?: string | null;
  lastRuntimeHint?: TransparentRuntimeUpdate;
}

interface RuntimeSnapshotRecord {
  outerThreadId: string;
  runtimeHint: TransparentRuntimeUpdate;
}

interface BindingSnapshot {
  version: number;
  records: BindingSnapshotRecord[];
  runtimeRecords: RuntimeSnapshotRecord[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function runtimeUpdate(value: unknown): TransparentRuntimeUpdate {
  if (!isObject(value)) return {};
  const result: TransparentRuntimeUpdate = {};
  const stringKeys = [
    "ownerUserId", "accountIdentity", "providerId", "model", "backendKey",
    "nextProviderId", "nextModel", "rolloutPath",
  ] as const;
  for (const key of stringKeys) {
    const entry = nullableString(value[key]);
    if (entry !== undefined) result[key] = entry;
  }
  if (value["engineKind"] === "codex" || value["engineKind"] === "dsh") {
    result.engineKind = value["engineKind"];
  }
  if (value["epoch"] === null || typeof value["epoch"] === "number") {
    result.epoch = value["epoch"];
  }
  const threadSettings = value["threadSettings"];
  if (threadSettings === null || isObject(threadSettings)) {
    result.threadSettings = threadSettings as Record<string, JsonValue> | null;
  }
  const nextThreadSettings = value["nextThreadSettings"];
  if (nextThreadSettings === null || isObject(nextThreadSettings)) {
    result.nextThreadSettings = nextThreadSettings as Record<string, JsonValue> | null;
  }
  return result;
}

function parseSnapshot(encoded: string): BindingSnapshot | null {
  const value: unknown = JSON.parse(encoded);
  if (!isObject(value) || typeof value["version"] !== "number" ||
      !Array.isArray(value["records"])) return null;
  const records: BindingSnapshotRecord[] = [];
  for (const candidate of value["records"]) {
    if (!isObject(candidate)) continue;
    const outerThreadId = optionalString(candidate["outerThreadId"]);
    const innerThreadId = optionalString(candidate["innerThreadId"]);
    if (!outerThreadId || !innerThreadId) continue;
    const record: BindingSnapshotRecord = { outerThreadId, innerThreadId };
    if (candidate["realm"] === "localhost" || candidate["realm"] === "workspace") {
      record.realm = candidate["realm"];
    }
    const viewId = optionalString(candidate["viewId"]);
    if (viewId) record.viewId = viewId;
    const rolloutPath = nullableString(candidate["rolloutPath"]);
    if (rolloutPath !== undefined) record.rolloutPath = rolloutPath;
    record.lastRuntimeHint = runtimeUpdate(candidate["lastRuntimeHint"] ?? candidate);
    records.push(record);
  }
  const runtimeRecords: RuntimeSnapshotRecord[] = [];
  if (Array.isArray(value["runtimeRecords"])) {
    for (const candidate of value["runtimeRecords"]) {
      if (!isObject(candidate)) continue;
      const outerThreadId = optionalString(candidate["outerThreadId"]);
      if (!outerThreadId) continue;
      runtimeRecords.push({ outerThreadId, runtimeHint: runtimeUpdate(candidate["runtimeHint"]) });
    }
  }
  return { version: value["version"], records, runtimeRecords };
}

function owns(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function ownerForArtifact(host: TransparentBindingHost, artifact: TransparentBindingArtifact): string | null {
  if (artifact.ownerUserId) return artifact.ownerUserId;
  if (!artifact.accountIdentity) return null;
  const embeddedOwner = /^(?:model-provider|api-key|managed):(user:[^:]+)(?::|$)/
    .exec(artifact.accountIdentity)?.[1];
  if (embeddedOwner && host.users.find(embeddedOwner)) return embeddedOwner;
  for (const user of host.users.list()) {
    if (user.id && host.credentials.resolveUser(user.id)?.accountIdentity === artifact.accountIdentity) {
      return user.id;
    }
  }
  return null;
}

export function persistTransparentBindings(
  state: TransparentBindingState,
  host: TransparentBindingHost,
): void {
  const records = [...state.bindings.entries()]
    .filter(([, binding]) => binding.durable)
    .map(([outerThreadId, binding]) => ({
      outerThreadId,
      innerThreadId: binding.innerThreadId,
      realm: binding.realm,
      viewId: binding.viewId,
      rolloutPath: binding.rolloutPath,
      lastRuntimeHint: state.runtimeHints.get(outerThreadId) ?? null,
    }));
  const runtimeRecords = [...state.runtimeHints.entries()]
    .filter(([outerThreadId, hint]) => (
      !state.bindings.has(outerThreadId) && hint.engineKind === "dsh" &&
      host.threads.find(outerThreadId) !== null && host.threads.isTransparentCodex(outerThreadId)
    ))
    .map(([outerThreadId, runtimeHint]) => ({ outerThreadId, runtimeHint }));
  host.policyStore.set(SNAPSHOT_NAMESPACE, host.principalId, JSON.stringify({
    version: SNAPSHOT_VERSION,
    records,
    runtimeRecords,
  }));
}

export function updateTransparentRuntimeHint(
  state: TransparentBindingState,
  outerThreadId: string,
  runtime: TransparentRuntimeUpdate,
): TransparentRuntimeHint {
  const previous = state.runtimeHints.get(outerThreadId);
  const ownerUserId = runtime.ownerUserId ?? previous?.ownerUserId ?? null;
  const accountIdentity = runtime.accountIdentity ?? previous?.accountIdentity ?? null;
  const result: TransparentRuntimeHint = {
    ownerUserId,
    accountIdentity,
    engineKind: owns(runtime, "engineKind") ? (runtime.engineKind ?? "codex") : (previous?.engineKind ?? "codex"),
    providerId: owns(runtime, "providerId")
      ? (runtime.providerId ?? null)
      : (previous?.providerId ?? providerIdFromAccountIdentity(accountIdentity, ownerUserId)),
    model: owns(runtime, "model") ? (runtime.model ?? null) : (previous?.model ?? null),
    threadSettings: owns(runtime, "threadSettings")
      ? (runtime.threadSettings ?? null)
      : (previous?.threadSettings ?? null),
    backendKey: owns(runtime, "backendKey") ? (runtime.backendKey ?? null) : (previous?.backendKey ?? null),
    epoch: owns(runtime, "epoch") ? (runtime.epoch ?? null) : (previous?.epoch ?? null),
  };
  if (owns(runtime, "nextProviderId")) result.nextProviderId = runtime.nextProviderId ?? null;
  else if (previous && owns(previous, "nextProviderId")) result.nextProviderId = previous.nextProviderId ?? null;
  if (owns(runtime, "nextModel")) result.nextModel = runtime.nextModel ?? null;
  else if (previous && owns(previous, "nextModel")) result.nextModel = previous.nextModel ?? null;
  if (owns(runtime, "nextThreadSettings")) result.nextThreadSettings = runtime.nextThreadSettings ?? null;
  else if (previous && owns(previous, "nextThreadSettings")) {
    result.nextThreadSettings = previous.nextThreadSettings ?? null;
  }
  state.runtimeHints.set(outerThreadId, result);
  return result;
}

export function setTransparentBinding(
  state: TransparentBindingState,
  outerThreadId: string,
  innerThreadId: string,
  durable = false,
  realm: TransparentThreadRealm = "localhost",
  viewId = "main",
  runtime: TransparentRuntimeUpdate = {},
): void {
  const previous = state.bindings.get(outerThreadId);
  if (previous) state.reverseBindings.delete(previous.innerThreadId);
  state.bindings.set(outerThreadId, {
    innerThreadId,
    durable,
    realm,
    viewId,
    rolloutPath: runtime.rolloutPath ?? previous?.rolloutPath ?? null,
  });
  if (runtime.ownerUserId || runtime.accountIdentity || runtime.backendKey || runtime.engineKind) {
    updateTransparentRuntimeHint(state, outerThreadId, runtime);
  }
  state.reverseBindings.set(innerThreadId, outerThreadId);
}

export function clearTransparentBinding(state: TransparentBindingState, outerThreadId: string): boolean {
  const binding = state.bindings.get(outerThreadId);
  if (!binding) return false;
  state.bindings.delete(outerThreadId);
  state.runtimeHints.delete(outerThreadId);
  state.reverseBindings.delete(binding.innerThreadId);
  return true;
}

export function promoteTransparentBinding(state: TransparentBindingState, outerThreadId: string): boolean {
  const binding = state.bindings.get(outerThreadId);
  if (!binding || binding.durable) return false;
  binding.durable = true;
  return true;
}

export function hydrateTransparentBindings(
  state: TransparentBindingState,
  host: TransparentBindingHost,
): boolean {
  let repaired = false;
  const encoded = host.policyStore.get(SNAPSHOT_NAMESPACE, host.principalId);
  if (encoded !== null) {
    const snapshot = parseSnapshot(encoded);
    if (snapshot && [1, 2, 3, 4].includes(snapshot.version)) {
      for (const record of snapshot.records) {
        const artifact = host.artifacts.current(record.outerThreadId);
        const previousRuntime = record.lastRuntimeHint ?? {};
        const artifactOwner = artifact ? ownerForArtifact(host, artifact) : null;
        setTransparentBinding(
          state,
          record.outerThreadId,
          artifact?.innerThreadId ?? record.innerThreadId,
          true,
          record.realm ?? "localhost",
          record.viewId ?? "main",
          {
            ...previousRuntime,
            rolloutPath: artifact?.path ?? record.rolloutPath ?? null,
            ownerUserId: artifactOwner ?? previousRuntime.ownerUserId ?? null,
            accountIdentity: artifact?.accountIdentity ?? previousRuntime.accountIdentity ?? null,
            epoch: artifact?.epoch ?? previousRuntime.epoch ?? null,
          },
        );
        if ((artifact?.innerThreadId && artifact.innerThreadId !== record.innerThreadId) ||
            (artifact?.path && artifact.path !== record.rolloutPath) ||
            (artifactOwner && artifactOwner !== previousRuntime.ownerUserId) ||
            (artifact?.accountIdentity && artifact.accountIdentity !== previousRuntime.accountIdentity)) {
          repaired = true;
        }
      }
      if (snapshot.version >= 4) {
        for (const record of snapshot.runtimeRecords) {
          if (record.runtimeHint.engineKind !== "dsh" || state.bindings.has(record.outerThreadId) ||
              host.threads.find(record.outerThreadId) === null ||
              !host.threads.isTransparentCodex(record.outerThreadId)) continue;
          updateTransparentRuntimeHint(state, record.outerThreadId, record.runtimeHint);
        }
      }
    }
  }
  for (const artifact of host.artifacts.values()) {
    if (state.bindings.has(artifact.threadId)) continue;
    const thread = host.threads.find(artifact.threadId);
    if (!thread || !host.threads.isTransparentCodex(artifact.threadId)) continue;
    const view = host.workspaceViews.recordFor(artifact.threadId);
    const realm: TransparentThreadRealm = view || thread.cwd?.startsWith("/workspace")
      ? "workspace"
      : "localhost";
    setTransparentBinding(
      state,
      artifact.threadId,
      artifact.innerThreadId,
      true,
      realm,
      view?.viewId ?? "main",
      {
        rolloutPath: artifact.path ?? null,
        ownerUserId: ownerForArtifact(host, artifact) ?? host.threads.ownerOf?.(artifact.threadId) ?? null,
        accountIdentity: artifact.accountIdentity ?? null,
        epoch: artifact.epoch ?? null,
      },
    );
    repaired = true;
    console.info(
      `[transparent-binding] recovered durable artifact outer=${artifact.threadId} ` +
      `inner=${artifact.innerThreadId} generation=${artifact.generation ?? "unknown"}`,
    );
  }
  if (repaired) persistTransparentBindings(state, host);
  return repaired;
}

export class TransparentThreadBindingService extends Service implements TransparentThreadBindingPort {
  static inject = [
    "credential",
    "principal",
    "runtimeWorkspace",
    "threadArtifactStore",
    "threadManager",
    "userDirectory",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  readonly bindings = new Map<string, TransparentThreadBinding>();
  readonly runtimeHints = new Map<string, TransparentRuntimeHint>();
  readonly reverseBindings = new Map<string, string>();

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentThreadBinding");
    hydrateTransparentBindings(this, this.host());
  }

  persist(): void {
    persistTransparentBindings(this, this.host());
  }

  setBinding(
    outerThreadId: string,
    innerThreadId: string,
    durable = false,
    persist = true,
    realm: TransparentThreadRealm = "localhost",
    viewId = "main",
    runtime: TransparentRuntimeUpdate = {},
  ): void {
    setTransparentBinding(this, outerThreadId, innerThreadId, durable, realm, viewId, runtime);
    if (persist) this.persist();
  }

  setRuntimeHint(outerThreadId: string, runtime: TransparentRuntimeUpdate, persist = true): void {
    updateTransparentRuntimeHint(this, outerThreadId, runtime);
    if (persist) this.persist();
  }

  runtimeHintFor(outerThreadId: string): TransparentRuntimeHint | null {
    return this.runtimeHints.get(outerThreadId) ?? null;
  }

  clearBinding(outerThreadId: string): void {
    if (clearTransparentBinding(this, outerThreadId)) this.persist();
  }

  promoteBinding(outerThreadId: string): void {
    if (promoteTransparentBinding(this, outerThreadId)) this.persist();
  }

  describe(): ReturnType<TransparentThreadBindingPort["describe"]> {
    return [...this.bindings.entries()].map(([outerThreadId, binding]) => ({
      outerThreadId,
      ...binding,
      lastRuntimeHint: this.runtimeHints.get(outerThreadId) ?? null,
    }));
  }

  private host(): TransparentBindingHost {
    return {
      principalId: this.ctx.principal.current().id,
      policyStore,
      artifacts: this.ctx.threadArtifactStore,
      threads: this.ctx.threadManager,
      workspaceViews: this.ctx.runtimeWorkspace,
      users: this.ctx.userDirectory,
      credentials: this.ctx.credential,
    };
  }
}

type Dependencies =
  | "credential"
  | "principal"
  | "runtimeWorkspace"
  | "threadArtifactStore"
  | "threadManager"
  | "userDirectory";
