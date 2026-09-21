import { Service, type Context } from "@deepseek-ai/cordis";
import {
  asEngineKind,
  asProcessId,
  asRuntimeId,
  asThreadId,
  asViewId,
  type EngineKind,
  type ProcessId,
  type RuntimeId,
  type ThreadId,
  type ViewId,
} from "../types/domain.ts";

const NAMESPACE = "runtimeRegistry";
const KEY = "node";

export interface RuntimeRecord {
  runtimeId: RuntimeId;
  outerThreadId?: ThreadId;
  processId: ProcessId;
  realm?: string;
  viewId: ViewId;
  engineKind?: EngineKind;
  ownerUserId?: string;
  startedAtMs: number;
}

export interface RuntimeRecordInput {
  runtimeId: RuntimeId | string;
  outerThreadId?: ThreadId | string;
  processId: ProcessId | string;
  realm?: string;
  viewId: ViewId | string;
  engineKind?: EngineKind | string;
  ownerUserId?: string;
  startedAtMs?: number;
}

interface RuntimeSnapshotV1 {
  version: 1;
  records: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeRecord(input: unknown): RuntimeRecord | null {
  if (!isRecord(input)) return null;
  try {
    const record: RuntimeRecord = {
      runtimeId: asRuntimeId(input["runtimeId"]),
      processId: asProcessId(input["processId"]),
      viewId: asViewId(input["viewId"]),
      startedAtMs: Number(input["startedAtMs"]) || Date.now(),
    };
    if (input["outerThreadId"] != null) record.outerThreadId = asThreadId(input["outerThreadId"]);
    if (typeof input["realm"] === "string") record.realm = input["realm"];
    if (input["engineKind"] != null) record.engineKind = asEngineKind(input["engineKind"]);
    if (typeof input["ownerUserId"] === "string") record.ownerUserId = input["ownerUserId"];
    return record;
  } catch {
    return null;
  }
}

function parseSnapshot(encoded: string): RuntimeSnapshotV1 | null {
  const value: unknown = JSON.parse(encoded);
  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["records"])) return null;
  return { version: 1, records: value["records"] };
}

// Durable registry of execution processes that were actually started. Thread
// bindings and catalog history are deliberately not accepted as evidence that
// a runtime exists: after a restart they may outlive the process by months.
export class RuntimeRegistryService extends Service {
  readonly records = new Map<RuntimeId, RuntimeRecord>();

  constructor(ctx: Context) {
    super(ctx, "runtimeRegistry");
    const encoded = policyStore.get(NAMESPACE, KEY);
    if (encoded == null) return;
    const snapshot = parseSnapshot(encoded);
    if (!snapshot) return;
    for (const input of snapshot.records) {
      const record = normalizeRecord(input);
      if (record) this.records.set(record.runtimeId, record);
    }
  }

  persist(): void {
    policyStore.set(NAMESPACE, KEY, JSON.stringify({
      version: 1,
      records: [...this.records.values()],
    }));
  }

  register(input: RuntimeRecordInput): RuntimeRecord {
    const record = normalizeRecord(input);
    if (!record) throw new Error("invalid runtime registry record");
    this.records.set(record.runtimeId, record);
    this.persist();
    return { ...record };
  }

  unregister(runtimeIdInput: RuntimeId | string): boolean {
    const runtimeId = asRuntimeId(runtimeIdInput);
    if (!this.records.delete(runtimeId)) return false;
    this.persist();
    return true;
  }

  clearView(viewIdInput: ViewId | string): boolean {
    const viewId = asViewId(viewIdInput);
    let changed = false;
    for (const [runtimeId, record] of this.records) {
      if (record.viewId !== viewId) continue;
      this.records.delete(runtimeId);
      changed = true;
    }
    if (changed) this.persist();
    return changed;
  }

  snapshot(): RuntimeRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }
}
