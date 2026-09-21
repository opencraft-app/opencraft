declare const hypernodeBrand: unique symbol;

export type Brand<Value, Name extends string> = Value & {
  readonly [hypernodeBrand]: Name;
};

export type ThreadId = Brand<string, "ThreadId">;
export type TurnId = Brand<string, "TurnId">;
export type ItemId = Brand<string, "ItemId">;
export type ViewId = Brand<string, "ViewId">;
export type RuntimeId = Brand<string, "RuntimeId">;
export type ProcessId = Brand<string, "ProcessId">;
export type OperationId = Brand<string, "OperationId">;
export type CheckpointId = Brand<string, "CheckpointId">;

export type EngineKind = "codex" | "dsh";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function asJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(asJsonValue);
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) result[key] = asJsonValue(entry);
    return result;
  }
  throw new Error(`value is not JSON serializable: ${String(value)}`);
}

export function parseJsonValue(encoded: string): JsonValue {
  return asJsonValue(JSON.parse(encoded));
}

function requiredId<Name extends string>(value: unknown, name: Name): Brand<string, Name> {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value as Brand<string, Name>;
}

export const asThreadId = (value: unknown): ThreadId => requiredId(value, "ThreadId");
export const asTurnId = (value: unknown): TurnId => requiredId(value, "TurnId");
export const asItemId = (value: unknown): ItemId => requiredId(value, "ItemId");
export const asViewId = (value: unknown): ViewId => requiredId(value, "ViewId");
export const asRuntimeId = (value: unknown): RuntimeId => requiredId(value, "RuntimeId");
export const asProcessId = (value: unknown): ProcessId => requiredId(value, "ProcessId");
export const asOperationId = (value: unknown): OperationId => requiredId(value, "OperationId");
export const asCheckpointId = (value: unknown): CheckpointId => requiredId(value, "CheckpointId");

export function asEngineKind(value: unknown): EngineKind {
  if (value !== "codex" && value !== "dsh") {
    throw new Error(`unsupported execution engine ${JSON.stringify(value)}`);
  }
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}
