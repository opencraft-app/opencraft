import { validateEnvironmentName } from "@opencraft/execution-environment/account-environment";
import {
  environmentLaunchAdmission,
  type EnvironmentTerminalAdmission,
} from "@opencraft/execution-environment/environment-delivery";
import { createEnvironmentLaunchAdmissionReceiver } from "@opencraft/execution-environment/environment-launch-receiver";
import type { PreparedProcessIdentity } from "./process-identity.js";
import type { TerminalLaunchAdmission } from "./terminal-admission-store.js";

/** The terminal owner's journal, as its admission Worker serves it. */
export interface TerminalLaunchJournal {
  reserve(kind: "local", quotaOwner: string, resource: string, operation: string, launch: unknown): Promise<string>;
  held(resource: string, operation: string): Promise<{ quotaOwner: string; launch: TerminalLaunchAdmission } | null>;
  launch(resource: string, operation: string, quotaOwner: string): Promise<string>;
  abandon(resource: string, operation: string): Promise<boolean>;
}
/** A held reservation that is never launched is released after this long; a
 * capsule lives at most 60 s. */
export const TERMINAL_LAUNCH_HOLD_MS = 90_000;
const unavailable = (): never => {
  throw Error("environment_launch_unavailable");
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const handleOf = (params: unknown) => {
  const handle = record(params) ? params.processHandle : undefined;
  if (typeof handle !== "string" || !handle.length || handle.length > 256) return unavailable();
  return handle;
};
const admissionOf = (launch: TerminalLaunchAdmission, operation: string): EnvironmentTerminalAdmission =>
  environmentLaunchAdmission({
    kind: "terminal",
    account: launch.account,
    actorGeneration: launch.actorGeneration,
    membershipRevision: launch.membershipRevision,
    hostId: launch.hostId,
    threadId: launch.threadId,
    resource: launch.incarnation,
    operation,
    incarnation: launch.incarnation,
  }) as EnvironmentTerminalAdmission;

/** Delivered ENV for one authenticated Host attachment of the terminal owner.
 * The receiver is pinned to the issuer that attachment declared from its own
 * trusted composition, and it admits only this owner's own durable reservation:
 * held, of this incarnation, and not launched. Values exist only here and in
 * the spawned process. */
export function createTerminalEnvironmentLaunch(options: {
  journal: TerminalLaunchJournal;
  /** This owner process incarnation; the `resource` of its local reservations. */
  incarnation: string;
  issuer: string;
  instance: string;
  holdMs?: number;
}) {
  const { journal, incarnation } = options;
  const receiver = createEnvironmentLaunchAdmissionReceiver({
    purpose: "terminal",
    instance: options.instance,
    issuer: options.issuer,
    admission: {
      terminal: async (locator) => {
        if (locator.resource !== incarnation) return unavailable();
        const row = await journal.held(locator.resource, locator.operation);
        if (!row || row.launch.hostId !== locator.hostId) return unavailable();
        return admissionOf(row.launch, locator.operation);
      },
    },
  });
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;
  const abandon = async (operation: string) => {
    clearTimeout(timers.get(operation));
    timers.delete(operation);
    await journal.abandon(incarnation, operation);
  };
  return {
    target: receiver.target,
    /** Writes the reservation before anything is sealed, with the Actor epoch
     * the Host admitted it under. Capacity limits apply here. */
    async reserve(identity: PreparedProcessIdentity, params: unknown) {
      if (closed || timers.size >= 256) return unavailable();
      const handle = handleOf(params),
        claim = record(params) ? params.admission : undefined,
        scope = identity.scope;
      if (
        !record(claim) ||
        !scope ||
        claim.account !== scope.account ||
        claim.hostId !== scope.hostId ||
        claim.threadId !== (scope.threadId ?? null)
      )
        return unavailable();
      // Validated twice: as a v2 terminal admission here, and by the journal.
      const launch = {
        account: claim.account,
        actorGeneration: claim.actorGeneration,
        membershipRevision: claim.membershipRevision,
        hostId: claim.hostId,
        threadId: claim.threadId,
        incarnation,
      } as TerminalLaunchAdmission;
      const admission = admissionOf(launch, handle);
      await journal.reserve("local", identity.quotaOwner, incarnation, handle, launch);
      if (closed) {
        await journal.abandon(incarnation, handle);
        return unavailable();
      }
      const timer = setTimeout(() => void abandon(handle).catch(() => {}), options.holdMs ?? TERMINAL_LAUNCH_HOLD_MS);
      timer.unref?.();
      timers.set(handle, timer);
      return { admission, target: receiver.target };
    },
    abandon: async (params: unknown) => abandon(handleOf(params)),
    /** Opens the relayed capsule against the held reservation and merges the
     * requested variables, refusing any that would override a delivered name. */
    async open(identity: PreparedProcessIdentity, params: unknown) {
      const handle = handleOf(params),
        scope = identity.scope;
      if (closed || !scope) return unavailable();
      const row = await journal.held(incarnation, handle);
      if (
        !row ||
        row.quotaOwner !== identity.quotaOwner ||
        row.launch.account !== scope.account ||
        row.launch.hostId !== scope.hostId ||
        row.launch.threadId !== (scope.threadId ?? null)
      )
        return unavailable();
      const snapshot = await receiver.open(
        { kind: "terminal", hostId: row.launch.hostId, resource: incarnation, operation: handle },
        identity.launch,
      );
      const env: Record<string, string> = { ...snapshot.overlay() };
      const requested = identity.env ?? {};
      if (!record(requested)) return unavailable();
      for (const [name, value] of Object.entries(requested)) {
        validateEnvironmentName(name);
        if (Object.hasOwn(env, name)) throw Error("Managed terminal environment cannot be overridden");
        if (typeof value !== "string") return unavailable();
        env[name] = value;
      }
      const { launch: _, ...rest } = identity;
      return { ...rest, env };
    },
    /** The one-shot fence, written before spawn; returns the quota receipt. */
    async launched(params: unknown, quotaOwner: string) {
      const handle = handleOf(params);
      if (closed) return unavailable();
      const token = await journal.launch(incarnation, handle, quotaOwner);
      clearTimeout(timers.get(handle));
      timers.delete(handle);
      return token;
    },
    /** Retires the receiver and releases every reservation still held. */
    async close() {
      closed = true;
      receiver.close();
      await Promise.allSettled([...timers.keys()].map((operation) => abandon(operation)));
    },
  };
}
export type TerminalEnvironmentLaunch = ReturnType<typeof createTerminalEnvironmentLaunch>;
