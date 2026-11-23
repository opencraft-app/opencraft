import {
  EnvironmentLaunchReceiver,
  canonicalEnvironmentLaunchAdmission,
  environmentLaunchAdmission,
  environmentLaunchContextV2,
  environmentLaunchKinds,
  type AnyEnvironmentLaunchContext,
  type EnvironmentCreationAdmission,
  type EnvironmentLaunchAdmission,
  type EnvironmentLaunchKind,
  type EnvironmentLaunchPurpose,
  type EnvironmentLaunchTarget,
  type EnvironmentTerminalAdmission,
  type EnvironmentTurnAdmission,
} from "./environment-delivery.js";
import { ExecutionEnvironmentSnapshot } from "./execution-snapshot.js";

type HostId = EnvironmentLaunchAdmission["hostId"];
/** What the execution owner names when it asks for a launch. It identifies the
 * owner's own durable record; it never carries an account or a Project. */
export type EnvironmentLaunchLocator =
  | { readonly kind: "turn"; readonly hostId: HostId; readonly threadId: string; readonly inputId: string }
  | { readonly kind: "creation"; readonly hostId: HostId; readonly operationId: string }
  | { readonly kind: "terminal"; readonly hostId: HostId; readonly resource: string; readonly operation: string };

/** The execution owner's own durable admission per kind. `null` means the
 * record exists without a Human owner; a reader must throw when the record is
 * missing, not admissible any more, or names another process incarnation. */
export interface EnvironmentLaunchAdmissionReaders {
  turn?(locator: Extract<EnvironmentLaunchLocator, { kind: "turn" }>): Promise<EnvironmentTurnAdmission | null>;
  creation?(
    locator: Extract<EnvironmentLaunchLocator, { kind: "creation" }>,
  ): Promise<EnvironmentCreationAdmission | null>;
  terminal?(
    locator: Extract<EnvironmentLaunchLocator, { kind: "terminal" }>,
  ): Promise<EnvironmentTerminalAdmission | null>;
}
export interface EnvironmentLaunchAdmissionReceiver {
  readonly target: EnvironmentLaunchTarget;
  /** The kinds this owner can admit: allowed for its purpose AND backed by a reader. */
  readonly kinds: readonly EnvironmentLaunchKind[];
  /** Opens a relayed reply `{context: null}` or `{context, capsule}` against the
   * owner's own durable admission for `locator`. */
  open(locator: EnvironmentLaunchLocator, reply: unknown): Promise<ExecutionEnvironmentSnapshot>;
  close(): void;
}

const unavailable = (): never => {
  throw Error("environment_launch_unavailable");
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 1024 && !/[\x00-\x1f\x7f]/u.test(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));

/** Validates a locator: exactly the keys of its kind, never an account or Project. */
export function environmentLaunchLocator(value: unknown): EnvironmentLaunchLocator {
  if (!record(value) || !(value.hostId === "local-codex" || value.hostId === "opencraft-server")) return unavailable();
  const hostId = value.hostId;
  if (
    value.kind === "turn" &&
    exact(value, ["kind", "hostId", "threadId", "inputId"]) &&
    text(value.threadId) &&
    text(value.inputId)
  )
    return { kind: "turn", hostId, threadId: value.threadId, inputId: value.inputId };
  if (value.kind === "creation" && exact(value, ["kind", "hostId", "operationId"]) && text(value.operationId))
    return { kind: "creation", hostId, operationId: value.operationId };
  if (
    value.kind === "terminal" &&
    exact(value, ["kind", "hostId", "resource", "operation"]) &&
    text(value.resource) &&
    text(value.operation)
  )
    return { kind: "terminal", hostId, resource: value.resource, operation: value.operation };
  return unavailable();
}
const locatorOf = (a: EnvironmentLaunchAdmission): EnvironmentLaunchLocator =>
  a.kind === "turn"
    ? { kind: "turn", hostId: a.hostId, threadId: a.threadId, inputId: a.inputId }
    : a.kind === "creation"
      ? { kind: "creation", hostId: a.hostId, operationId: a.operationId }
      : { kind: "terminal", hostId: a.hostId, resource: a.resource, operation: a.operation };
/** The admission really is the record the locator names. */
const names = (a: EnvironmentLaunchAdmission, l: EnvironmentLaunchLocator) =>
  JSON.stringify(locatorOf(a)) === JSON.stringify(l);

/** Execution-owner side of v2 delivery (launches with or without a native Turn).
 * Construct INSIDE the process that launches. Each kind is admitted only by the
 * owner's own durable record (Decision 1); a kind its purpose does not accept,
 * or without a reader, is refused before any request. The relayed context is
 * only compared with that record, and the capsule is opened against the record. */
export function createEnvironmentLaunchAdmissionReceiver(options: {
  purpose: EnvironmentLaunchPurpose;
  /** The authenticated attachment of this owner. */
  instance: string;
  /** Issuer key pinned through trusted composition. */
  issuer: string;
  admission: EnvironmentLaunchAdmissionReaders;
}): EnvironmentLaunchAdmissionReceiver {
  const readers = Object.freeze({ ...options.admission });
  const kinds = Object.freeze(environmentLaunchKinds(options.purpose).filter((kind) => !!readers[kind]));
  let closed = false;
  const read = async (locator: EnvironmentLaunchLocator): Promise<EnvironmentLaunchAdmission | null> => {
    if (closed || !kinds.includes(locator.kind)) return unavailable();
    const value =
      locator.kind === "turn"
        ? await readers.turn!(locator)
        : locator.kind === "creation"
          ? await readers.creation!(locator)
          : await readers.terminal!(locator);
    if (closed) return unavailable();
    if (value === null) return null;
    const admission = environmentLaunchAdmission(value);
    if (!names(admission, locator)) return unavailable();
    return admission;
  };
  const receiver = new EnvironmentLaunchReceiver({
    purpose: options.purpose,
    instance: options.instance,
    issuer: options.issuer,
    // Reread the durable record before and after decryption; any change
    // (record consumed, Actor or lease replaced, owner restarted) refuses.
    authorize: async (expected: AnyEnvironmentLaunchContext) => {
      const own = environmentLaunchContextV2(expected).admission;
      const current = await read(locatorOf(own));
      if (!current || canonicalEnvironmentLaunchAdmission(current) !== canonicalEnvironmentLaunchAdmission(own))
        unavailable();
    },
  });
  return {
    target: receiver.target,
    kinds,
    async open(raw, reply) {
      try {
        const locator = environmentLaunchLocator(raw);
        const owned = await read(locator);
        if (!record(reply) || Object.keys(reply).some((k) => !["context", "capsule"].includes(k))) return unavailable();
        if (reply.context === null) {
          // Neither side holds a Human admission: an empty launch, never another
          // Human's values. A capsule without context is malformed.
          if (reply.capsule !== undefined || owned !== null) return unavailable();
          return new ExecutionEnvironmentSnapshot(
            {
              account: null,
              hostId: locator.hostId,
              threadId: locator.kind === "turn" ? locator.threadId : null,
              projectId: null,
            },
            {},
          );
        }
        if (owned === null || typeof reply.capsule !== "string") return unavailable();
        const relayed = environmentLaunchContextV2(reply.context).admission;
        if (canonicalEnvironmentLaunchAdmission(relayed) !== canonicalEnvironmentLaunchAdmission(owned))
          return unavailable();
        const snapshot = await receiver.open(reply.capsule, { version: 2, admission: owned });
        if (closed) return unavailable();
        return snapshot;
      } catch {
        return unavailable();
      }
    },
    close() {
      closed = true;
      receiver.close();
    },
  };
}
