import type {
  ReplicaCursor,
  ReplicaDeltaResponse,
  ReplicaEntry,
  ReplicaJsonValue,
  ReplicaSnapshotEntity,
  ReplicaSnapshotResponse,
  ReplicaSyncResponse,
} from "@opencraft/appserver-protocol";

import { ReplicaError } from "./errors";
import {
  REPLICA_STORAGE_SCHEMA_VERSION,
  type ReplicaAuthorityState,
  type ReplicaClientState,
} from "./storage";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Only deeply frozen, already-verified JSON can skip a later recursive walk.
// Mutable wire values are always validated again; freezing just the outer
// container cannot certify mutable descendants.
const immutableJson = new WeakSet<object>();
function isJsonValue(value: unknown): value is ReplicaJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || value === null) return false;
  if (immutableJson.has(value)) return true;
  if (!Array.isArray(value) && !isRecord(value)) return false;
  let immutable = Object.isFrozen(value)
    && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor);
  for (const entry of Object.values(value)) {
    if (!isJsonValue(entry)) return false;
    if (entry !== null && typeof entry === "object" && !immutableJson.has(entry)) immutable = false;
  }
  if (immutable) immutableJson.add(value);
  return true;
}

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ReplicaError("INVALID_STATE", message);
}

export function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

export function validateCursor(cursor: ReplicaCursor): void {
  invariant(cursor.epoch.length > 0, "Replica cursor epoch must not be empty");
  invariant(isSequence(cursor.nextSeq), "Replica cursor nextSeq must be a positive safe integer");
}

export function validateEntities<TValue extends ReplicaJsonValue>(
  entities: readonly ReplicaSnapshotEntity<TValue>[],
): void {
  const ids = new Set<string>();
  for (const entity of entities) {
    invariant(entity.entityId.length > 0, "Replica entity id must not be empty");
    invariant(!ids.has(entity.entityId), `Replica snapshot repeats entity ${entity.entityId}`);
    invariant(isJsonValue(entity.value), `Replica entity ${entity.entityId} is not JSON-safe`);
    ids.add(entity.entityId);
  }
}

export function validateEntry<TValue extends ReplicaJsonValue>(
  entry: ReplicaEntry<TValue>,
  scope: string,
  epoch: string,
): void {
  invariant(entry.scope === scope, `Replica entry belongs to unexpected scope ${entry.scope}`);
  invariant(entry.epoch === epoch, `Replica entry belongs to unexpected epoch ${entry.epoch}`);
  invariant(isSequence(entry.seq), "Replica entry seq must be a positive safe integer");
  invariant(entry.mutation.entityId.length > 0, "Replica mutation entity id must not be empty");
  if (entry.mutation.kind === "upsert") {
    invariant(isJsonValue(entry.mutation.value), "Replica mutation value is not JSON-safe");
  }
  invariant(
    entry.commandId === undefined || entry.commandId.length > 0,
    "Replica entry commandId must not be empty",
  );
}

/** Decode an untrusted wire notification without relying on a type assertion. */
export function parseEntry(value: unknown, scope: string): ReplicaEntry {
  invariant(isRecord(value), "Replica entry must be an object");
  invariant(typeof value.scope === "string", "Replica entry scope must be a string");
  invariant(typeof value.epoch === "string", "Replica entry epoch must be a string");
  invariant(isSequence(value.seq), "Replica entry seq must be a positive safe integer");
  invariant(isRecord(value.mutation), "Replica entry mutation must be an object");
  invariant(typeof value.mutation.entityId === "string", "Replica mutation entity id must be a string");
  let mutation: ReplicaEntry["mutation"];
  if (value.mutation.kind === "delete") {
    mutation = { kind: "delete", entityId: value.mutation.entityId };
  } else {
    invariant(value.mutation.kind === "upsert", "Replica mutation kind is invalid");
    invariant(isJsonValue(value.mutation.value), "Replica mutation value is not JSON-safe");
    mutation = { kind: "upsert", entityId: value.mutation.entityId, value: value.mutation.value };
  }
  invariant(
    value.commandId === undefined || typeof value.commandId === "string",
    "Replica entry commandId must be a string",
  );
  const entry: ReplicaEntry = {
    scope: value.scope,
    epoch: value.epoch,
    seq: value.seq,
    mutation,
    ...(value.commandId === undefined ? {} : { commandId: value.commandId }),
  };
  validateEntry(entry, scope, entry.epoch);
  return entry;
}

export function validateSnapshot<TValue extends ReplicaJsonValue>(
  response: ReplicaSnapshotResponse<TValue>,
  scope: string,
): void {
  invariant(response.scope === scope, `Replica snapshot belongs to unexpected scope ${response.scope}`);
  invariant(response.epoch.length > 0, "Replica snapshot epoch must not be empty");
  invariant(isSequence(response.bounds.nextSeq), "Replica snapshot nextSeq must be positive");
  invariant(isSequence(response.bounds.journalStartSeq), "Replica journalStartSeq must be positive");
  invariant(
    response.bounds.journalStartSeq <= response.bounds.nextSeq,
    "Replica journalStartSeq cannot exceed nextSeq",
  );
  validateEntities(response.entities);
}

/** Decode an untrusted snapshot notification into the canonical protocol type. */
export function parseSnapshot(value: unknown, scope: string): ReplicaSnapshotResponse {
  invariant(isRecord(value), "Replica snapshot must be an object");
  invariant(value.kind === "snapshot", "Replica snapshot kind is invalid");
  invariant(typeof value.scope === "string", "Replica snapshot scope must be a string");
  invariant(typeof value.epoch === "string", "Replica snapshot epoch must be a string");
  invariant(isRecord(value.bounds), "Replica snapshot bounds must be an object");
  invariant(isSequence(value.bounds.journalStartSeq), "Replica journalStartSeq must be positive");
  invariant(isSequence(value.bounds.nextSeq), "Replica snapshot nextSeq must be positive");
  invariant(Array.isArray(value.entities), "Replica snapshot entities must be an array");
  const entities = value.entities.map((entity): ReplicaSnapshotEntity => {
    invariant(isRecord(entity), "Replica snapshot entity must be an object");
    invariant(typeof entity.entityId === "string", "Replica snapshot entity id must be a string");
    invariant(isJsonValue(entity.value), "Replica snapshot entity value is not JSON-safe");
    return { entityId: entity.entityId, value: entity.value };
  });
  const reasons = new Set(["initial", "epoch_changed", "journal_compacted", "rewind", "forced"]);
  invariant(typeof value.reason === "string" && reasons.has(value.reason), "Replica snapshot reason is invalid");
  const reason = value.reason === "initial"
    || value.reason === "epoch_changed"
    || value.reason === "journal_compacted"
    || value.reason === "rewind"
    ? value.reason
    : "forced";
  const snapshot: ReplicaSnapshotResponse = {
    kind: "snapshot",
    scope: value.scope,
    epoch: value.epoch,
    bounds: {
      journalStartSeq: value.bounds.journalStartSeq,
      nextSeq: value.bounds.nextSeq,
    },
    entities,
    reason,
  };
  validateSnapshot(snapshot, scope);
  return snapshot;
}

export function validateDelta<TValue extends ReplicaJsonValue>(
  response: ReplicaDeltaResponse<TValue>,
  scope: string,
): void {
  invariant(response.scope === scope, `Replica delta belongs to unexpected scope ${response.scope}`);
  invariant(response.epoch.length > 0, "Replica delta epoch must not be empty");
  invariant(isSequence(response.fromNextSeq), "Replica delta fromNextSeq must be positive");
  invariant(isSequence(response.bounds.nextSeq), "Replica delta nextSeq must be positive");
  invariant(isSequence(response.bounds.journalStartSeq), "Replica delta journalStartSeq must be positive");
  invariant(response.bounds.journalStartSeq <= response.bounds.nextSeq, "Invalid Replica bounds");
  let expectedSeq = response.fromNextSeq;
  for (const entry of response.entries) {
    validateEntry(entry, scope, response.epoch);
    invariant(entry.seq === expectedSeq, `Replica delta gap: expected ${expectedSeq}, received ${entry.seq}`);
    expectedSeq += 1;
  }
  invariant(expectedSeq <= response.bounds.nextSeq, "Replica delta advances beyond authority nextSeq");
  if (response.hasMore) invariant(response.entries.length > 0, "Replica delta hasMore without progress");
  else invariant(expectedSeq === response.bounds.nextSeq, "Final Replica delta does not reach nextSeq");
}

export function validateSyncResponse<TValue extends ReplicaJsonValue>(
  response: ReplicaSyncResponse<TValue>,
  scope: string,
): void {
  if (response.kind === "snapshot") validateSnapshot(response, scope);
  else validateDelta(response, scope);
}

export function validateAuthorityState<TValue extends ReplicaJsonValue>(
  state: ReplicaAuthorityState<TValue>,
  scope: string,
): void {
  invariant(state.schemaVersion === REPLICA_STORAGE_SCHEMA_VERSION, "Unsupported Replica authority schema");
  invariant(state.scope === scope, "Replica authority storage returned the wrong scope");
  validateCursor({ epoch: state.epoch, nextSeq: state.nextSeq });
  invariant(isSequence(state.journalStartSeq), "Replica authority journalStartSeq must be positive");
  invariant(state.journalStartSeq <= state.nextSeq, "Replica authority bounds are inverted");
  validateEntities(state.entities);
  let expected = state.journalStartSeq;
  for (const entry of state.journal) {
    validateEntry(entry, scope, state.epoch);
    invariant(entry.seq === expected, `Persisted Replica journal gap at ${expected}`);
    expected += 1;
  }
  invariant(expected === state.nextSeq, "Persisted Replica journal does not end at nextSeq");
  const commandIds = new Set<string>();
  for (const receipt of state.receipts) {
    invariant(receipt.commandId.length > 0, "Replica receipt commandId must not be empty");
    invariant(!commandIds.has(receipt.commandId), `Replica receipts repeat command ${receipt.commandId}`);
    invariant(receipt.fingerprint.length > 0, `Replica receipt ${receipt.commandId} has no fingerprint`);
    invariant(receipt.response.scope === scope, `Replica receipt ${receipt.commandId} belongs to another scope`);
    invariant(receipt.response.epoch === state.epoch, `Replica receipt ${receipt.commandId} belongs to another epoch`);
    invariant(isSequence(receipt.response.nextSeq), `Replica receipt ${receipt.commandId} has invalid nextSeq`);
    invariant(
      receipt.response.nextSeq <= state.nextSeq,
      `Replica receipt ${receipt.commandId} advances beyond authority nextSeq`,
    );
    invariant(receipt.response.replayed === false, `Replica receipt ${receipt.commandId} stored a replay result`);
    if (receipt.response.firstSeq !== null) {
      invariant(isSequence(receipt.response.firstSeq), `Replica receipt ${receipt.commandId} has invalid firstSeq`);
      invariant(
        receipt.response.firstSeq < receipt.response.nextSeq,
        `Replica receipt ${receipt.commandId} has inverted sequence bounds`,
      );
    }
    commandIds.add(receipt.commandId);
  }
}

export function validateClientState<TValue extends ReplicaJsonValue>(
  state: ReplicaClientState<TValue>,
  storageKey: string,
  scope: string,
): void {
  invariant(state.schemaVersion === REPLICA_STORAGE_SCHEMA_VERSION, "Unsupported Replica client schema");
  invariant(state.storageKey === storageKey, "Replica client storage returned the wrong key");
  invariant(state.scope === scope, "Replica client storage returned the wrong scope");
  validateCursor({ epoch: state.epoch, nextSeq: state.nextSeq });
  invariant(isSequence(state.journalStartSeq), "Replica client journalStartSeq must be positive");
  invariant(state.journalStartSeq <= state.nextSeq, "Replica client bounds are inverted");
  validateEntities(state.entities);
}
