import { Service, type Inject } from "@deepseek-ai/cordis";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  RuntimePluginApply,
  RuntimePluginCandidate,
  RuntimePluginCapability,
  RuntimePluginGlobalApi,
  RuntimePluginPort,
  RuntimePluginPublicRevision,
  RuntimePluginRecord,
  RuntimePluginRegistryStatus,
  RuntimePluginSlot,
  RuntimePluginSlotStatus,
} from "../types/hot-upgrade.ts";

const PLUGIN_API_VERSION = "hypernode.runtime-plugin/v1";
const LEGACY_SLOT = "evolution";
const SAFE_ID = /^[a-z][a-z0-9.-]{0,63}$/;
const SAFE_REVISION = /^[a-zA-Z0-9._-]{1,128}$/;
const CAPABILITIES = new Set<RuntimePluginCapability>([
  "app-server", "dashboard", "events", "storage", "thread-projection", "workspace-projection",
]);

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("runtime plugin candidate must be an object");
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeCandidate(input: unknown): RuntimePluginCandidate {
  const value = objectValue(input);
  const slot = optionalString(value["slot"]);
  const suppliedId = optionalString(value["id"]);
  const legacy = slot === LEGACY_SLOT && suppliedId === undefined;
  const apiVersion = optionalString(value["apiVersion"])
    ?? (legacy ? PLUGIN_API_VERSION : undefined);
  const id = suppliedId ?? slot;
  const revision = optionalString(value["revision"]);
  const version = optionalString(value["version"]) ?? revision;
  const apply = value["apply"] ?? value["activate"];
  const capabilities = Array.isArray(value["capabilities"])
    ? [...new Set(value["capabilities"].map(String))].sort()
    : [];

  if (apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(`unsupported runtime plugin API: ${String(apiVersion ?? null)}`);
  }
  if (!SAFE_ID.test(id ?? "")) throw new Error(`invalid runtime plugin id: ${String(id)}`);
  if (!SAFE_REVISION.test(revision ?? "")) {
    throw new Error("runtime plugin revision must be a safe identifier");
  }
  if (!SAFE_REVISION.test(version ?? "")) {
    throw new Error("runtime plugin version must be a safe identifier");
  }
  if (typeof apply !== "function") throw new Error("runtime plugin apply must be a function");
  for (const capability of capabilities) {
    if (!CAPABILITIES.has(capability as RuntimePluginCapability)) {
      throw new Error(`unsupported runtime plugin capability: ${capability}`);
    }
  }

  const candidate: RuntimePluginCandidate = {
    apiVersion,
    id: id as string,
    version: version as string,
    revision: revision as string,
    apply: apply as RuntimePluginApply,
    capabilities: capabilities as RuntimePluginCapability[],
  };
  if ("name" in value) candidate.name = value["name"];
  if ("description" in value) candidate.description = value["description"];
  if ("sourceDigest" in value) candidate.sourceDigest = value["sourceDigest"];
  if ("config" in value) candidate.config = value["config"];
  return candidate;
}

function publicRevision(record: RuntimePluginRecord | null | undefined): RuntimePluginPublicRevision | null {
  if (!record) return null;
  return {
    apiVersion: record.apiVersion,
    id: record.id,
    slot: record.id,
    name: record.name ?? record.id,
    description: record.description ?? "",
    version: record.version,
    revision: record.revision,
    capabilities: record.capabilities,
    sourceDigest: record.sourceDigest ?? null,
    stagedAtMs: record.stagedAtMs ?? null,
    activatedAtMs: record.activatedAtMs ?? null,
    status: record.status,
    error: record.error ?? null,
  };
}

function requiredRevision(record: RuntimePluginRecord): RuntimePluginPublicRevision {
  const result = publicRevision(record);
  if (!result) throw new Error("runtime plugin revision is unavailable");
  return result;
}

function newSlot(id: string): RuntimePluginSlot {
  return {
    id,
    active: null,
    previous: null,
    transition: null,
    candidates: new Map(),
    history: [],
  };
}

// RuntimePluginService owns reloadable business extensions only. Transport,
// workspace, process ownership, persistence and the root Cordis Context remain
// stable kernel services and are never replaced by a plugin transition.
export class HotUpgradeService extends Service implements RuntimePluginPort {
  static inject = ["appServer"] satisfies Inject<Pick<HypernodeServices, "appServer">>;

  declare protected ctx: HypernodeContext<"appServer">;

  private readonly slots = new Map<string, RuntimePluginSlot>();
  private generation = 0;

  constructor(ctx: HypernodeContext<"appServer">) {
    super(ctx, "runtimePlugins");
    const api: RuntimePluginGlobalApi = Object.freeze({
      stage: (candidate: unknown) => this.stage(candidate),
      activate: (id: string, revision: string) => this.activate(id, revision),
      rollback: (id: string) => this.rollback(id),
      status: (id?: string) => this.status(id),
      catalog: () => this.catalog(),
    });
    globalThis.hypernodeRuntimePlugins = api;
    globalThis.hypernodeHotUpgrade = api;
    ctx.effect(() => () => {
      if (globalThis.hypernodeRuntimePlugins === api) globalThis.hypernodeRuntimePlugins = undefined;
      if (globalThis.hypernodeHotUpgrade === api) globalThis.hypernodeHotUpgrade = undefined;
    });
    ctx.effect(() => ctx.appServer.register("hypernode/policy/status", () => this.status()));
    ctx.effect(() => ctx.appServer.register("hypernode/runtimePlugins/list", () => ({
      apiVersion: PLUGIN_API_VERSION,
      generation: this.generation,
      plugins: this.catalog(),
    })));
    ctx.effect(() => ctx.appServer.register("hypernode/runtimePlugins/read", (params) => (
      this.status(typeof params["id"] === "string" ? params["id"] : undefined)
    )));
    const baseFiber = ctx.plugin(baseEvolutionPlugin);
    this.adopt({
      apiVersion: PLUGIN_API_VERSION,
      id: LEGACY_SLOT,
      version: "builtin",
      revision: "builtin",
      capabilities: [],
      sourceDigest: "builtin",
      apply: baseEvolutionPlugin,
    }, baseFiber);
  }

  private slot(id: string, create: true): RuntimePluginSlot;
  private slot(id: string, create?: false): RuntimePluginSlot | undefined;
  private slot(id: string, create = false): RuntimePluginSlot | undefined {
    let slot = this.slots.get(id);
    if (!slot && create) {
      slot = newSlot(id);
      this.slots.set(id, slot);
    }
    return slot;
  }

  private adopt(input: unknown, fiber: RuntimePluginRecord["fiber"]): RuntimePluginPublicRevision {
    const candidate = normalizeCandidate(input);
    const slot = this.slot(candidate.id, true);
    if (slot.active) throw new Error(`runtime plugin is already adopted: ${candidate.id}`);
    const record: RuntimePluginRecord = {
      ...candidate,
      status: "active",
      stagedAtMs: Date.now(),
      activatedAtMs: Date.now(),
      fiber,
    };
    slot.active = record;
    slot.candidates.set(record.revision, record);
    this.record(slot, record);
    return requiredRevision(record);
  }

  stage(input: unknown): RuntimePluginPublicRevision {
    const candidate = normalizeCandidate(input);
    const slot = this.slot(candidate.id, true);
    const current = slot.candidates.get(candidate.revision);
    if (current) {
      if (current.sourceDigest !== (candidate.sourceDigest ?? null)) {
        throw new Error(
          `runtime plugin revision exists with different content: ${candidate.id}@${candidate.revision}`,
        );
      }
      return requiredRevision(current);
    }
    const record: RuntimePluginRecord = {
      ...candidate,
      sourceDigest: candidate.sourceDigest ?? null,
      stagedAtMs: Date.now(),
      status: "staged",
      fiber: null,
      error: null,
    };
    slot.candidates.set(record.revision, record);
    this.record(slot, record);
    return requiredRevision(record);
  }

  async activate(id: string, revision: string): Promise<RuntimePluginPublicRevision> {
    if (!SAFE_ID.test(id ?? "")) throw new Error(`invalid runtime plugin id: ${id}`);
    const slot = this.slot(id);
    if (!slot) throw new Error(`unknown runtime plugin: ${id}`);
    if (slot.transition) {
      throw new Error(`runtime plugin transition already in progress: ${id}:${slot.transition}`);
    }
    const candidate = slot.candidates.get(revision);
    if (!candidate) throw new Error(`unknown runtime plugin revision: ${id}@${revision}`);
    if (candidate === slot.active) return requiredRevision(candidate);
    slot.transition = `activate:${revision}`;
    const old = slot.active;
    try {
      if (old?.fiber) await old.fiber.dispose();
      const fiber = this.ctx.plugin(candidate.apply, candidate.config);
      await fiber;
      candidate.fiber = fiber;
      candidate.status = "active";
      candidate.activatedAtMs = Date.now();
      candidate.error = null;
      if (old) old.status = "superseded";
      slot.previous = old;
      slot.active = candidate;
      this.record(slot, candidate);
      return requiredRevision(candidate);
    } catch (error) {
      candidate.status = "failed";
      candidate.error = errorMessage(error);
      this.record(slot, candidate);
      if (old) {
        try {
          const restoredFiber = this.ctx.plugin(old.apply, old.config);
          await restoredFiber;
          old.fiber = restoredFiber;
          old.status = "active";
          old.activatedAtMs = Date.now();
          slot.active = old;
        } catch (rollbackError) {
          old.status = "rollbackFailed";
          old.error = errorMessage(rollbackError);
          slot.active = null;
        }
      }
      throw error;
    } finally {
      slot.transition = null;
    }
  }

  async rollback(id: string): Promise<RuntimePluginPublicRevision> {
    const slot = this.slot(id);
    if (!slot?.previous) throw new Error(`runtime plugin has no previous revision: ${id}`);
    return this.activate(id, slot.previous.revision);
  }

  private slotStatus(slot: RuntimePluginSlot | undefined): RuntimePluginSlotStatus | null {
    if (!slot) return null;
    return {
      id: slot.id,
      transition: slot.transition,
      active: publicRevision(slot.active),
      previous: publicRevision(slot.previous),
      candidates: [...slot.candidates.values()].map(requiredRevision),
      history: slot.history.slice(-32),
    };
  }

  catalog(): RuntimePluginSlotStatus[] {
    const result: RuntimePluginSlotStatus[] = [];
    for (const slot of this.slots.values()) {
      const status = this.slotStatus(slot);
      if (status) result.push(status);
    }
    return result.sort((left, right) => left.id.localeCompare(right.id));
  }

  status(id?: string): RuntimePluginRegistryStatus | RuntimePluginSlotStatus {
    if (id) {
      const result = this.slotStatus(this.slot(id));
      if (!result) throw new Error(`unknown runtime plugin: ${id}`);
      return result;
    }
    const legacy = this.slotStatus(this.slot(LEGACY_SLOT));
    return {
      apiVersion: PLUGIN_API_VERSION,
      generation: this.generation,
      plugins: this.catalog(),
      reloadableSlots: [...this.slots.keys()].sort(),
      transition: legacy?.transition ?? null,
      active: legacy?.active ?? null,
      previous: legacy?.previous ?? null,
      candidates: legacy?.candidates ?? [],
    };
  }

  private record(slot: RuntimePluginSlot, record: RuntimePluginRecord): void {
    this.generation++;
    slot.history.push({
      generation: this.generation,
      revision: record.revision,
      status: record.status,
      atMs: Date.now(),
      error: record.error ?? null,
    });
    if (slot.history.length > 128) slot.history.splice(0, slot.history.length - 128);
  }
}

export function baseEvolutionPlugin(): void {}
