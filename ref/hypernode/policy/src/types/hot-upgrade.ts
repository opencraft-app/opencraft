import type { Fiber, Plugin } from "@deepseek-ai/cordis";

export type RuntimePluginCapability =
  | "app-server"
  | "dashboard"
  | "events"
  | "storage"
  | "thread-projection"
  | "workspace-projection";

export type RuntimePluginStatus =
  | "staged"
  | "active"
  | "superseded"
  | "failed"
  | "rollbackFailed";

export type RuntimePluginApply =
  | Plugin.Function<unknown>
  | Plugin.Constructor<unknown>;

export interface RuntimePluginCandidate {
  apiVersion: string;
  id: string;
  version: string;
  revision: string;
  apply: RuntimePluginApply;
  capabilities: RuntimePluginCapability[];
  name?: unknown;
  description?: unknown;
  sourceDigest?: unknown;
  config?: unknown;
}

export interface RuntimePluginRecord extends RuntimePluginCandidate {
  status: RuntimePluginStatus;
  stagedAtMs: number;
  activatedAtMs?: number;
  fiber: Fiber | null;
  error?: string | null;
}

export interface RuntimePluginPublicRevision {
  apiVersion: string;
  id: string;
  slot: string;
  name: unknown;
  description: unknown;
  version: string;
  revision: string;
  capabilities: RuntimePluginCapability[];
  sourceDigest: unknown;
  stagedAtMs: number | null;
  activatedAtMs: number | null;
  status: RuntimePluginStatus;
  error: string | null;
}

export interface RuntimePluginHistoryEntry {
  generation: number;
  revision: string;
  status: RuntimePluginStatus;
  atMs: number;
  error: string | null;
}

export interface RuntimePluginSlot {
  id: string;
  active: RuntimePluginRecord | null;
  previous: RuntimePluginRecord | null;
  transition: string | null;
  candidates: Map<string, RuntimePluginRecord>;
  history: RuntimePluginHistoryEntry[];
}

export interface RuntimePluginSlotStatus {
  id: string;
  transition: string | null;
  active: RuntimePluginPublicRevision | null;
  previous: RuntimePluginPublicRevision | null;
  candidates: RuntimePluginPublicRevision[];
  history: RuntimePluginHistoryEntry[];
}

export interface RuntimePluginRegistryStatus {
  apiVersion: string;
  generation: number;
  plugins: RuntimePluginSlotStatus[];
  reloadableSlots: string[];
  transition: string | null;
  active: RuntimePluginPublicRevision | null;
  previous: RuntimePluginPublicRevision | null;
  candidates: RuntimePluginPublicRevision[];
}

export interface RuntimePluginGlobalApi {
  stage(candidate: unknown): RuntimePluginPublicRevision;
  activate(id: string, revision: string): Promise<RuntimePluginPublicRevision>;
  rollback(id: string): Promise<RuntimePluginPublicRevision>;
  status(id?: string): RuntimePluginRegistryStatus | RuntimePluginSlotStatus;
  catalog(): RuntimePluginSlotStatus[];
}

export interface RuntimePluginPort extends RuntimePluginGlobalApi {}
