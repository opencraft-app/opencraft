import type { GitExecutionResolver } from "@opencraft/execution-environment/git-execution";
import { parseGitExecutionLocator } from "@opencraft/execution-environment/git-execution";
import type { EnvironmentLaunchRecordReaders } from "@opencraft/execution-environment/environment-launch-owner";
import {
  EnvironmentAccountPartitions,
  type EnvironmentAccountMapping,
  type EnvironmentAccountResolver,
} from "@opencraft/execution-environment/environment-account";
import { GitExecutionAuthority, executionScope, resolveExecutionAdmission } from "./git-execution-authority.js";
import { codexTurnAdmission, creationAdmission } from "./environment-launch-admission.js";
import { WorkspaceActorAuthority, workspaceAdmission } from "./workspaces/actor-authority.js";
import type {
  ExecutionSessionLocator,
  ExecutionSessionOwner,
  ExecutionSessionReader,
} from "@opencraft/plugin-assets/server/personal-mcp";
import type { AssetActorAuthority } from "@opencraft/plugin-assets/server/actor-settings";

export type { ExecutionSessionLocator, ExecutionSessionOwner } from "@opencraft/plugin-assets/server/personal-mcp";

/** Core's durable records for launches without an active native Turn, and the
 * current Actor epoch they are admitted under; the shape the Assets vault
 * owner accepts as `environmentRecords`. */
export type HeadlessEnvironmentRecords = Required<Pick<EnvironmentLaunchRecordReaders, "codexTurn" | "creation">> & {
  actorEpoch(actorId: string): { actorGeneration: number; membershipRevision: number } | null;
};

export type HeadlessExecutionRecords = {
  /** Git execution admission over core's execution leases and Actor store.
   * The vault owner closes it; that also closes the record readers below. */
  execution: Required<Pick<GitExecutionResolver, "reserve" | "actor">> & GitExecutionResolver;
  environmentRecords: HeadlessEnvironmentRecords;
  /** Present only when `environmentAccount` is given. */
  environmentAccounts?: EnvironmentAccountResolver;
  /** Which Human Actor owns a Codex/Server session in a phase, re-read with
   * the same lease, Actor and member checks as Git execution admission. */
  sessions: ExecutionSessionReader;
  /** Rechecks a Main Human proof (`WorkspaceActorAdmission`) against the
   * committed Actor and member records, and projects the Actor's committed
   * role (`admin`/`member`) for role-dependent rules such as custom endpoints,
   * so a composition never reads core's member tables itself. */
  actors: AssetActorAuthority;
};

const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 512 && !/[\x00-\x1f\x7f]/u.test(v);
/** Strict session locator: a Host, Thread and the original input or native
 * Turn, optionally pinned to one execution and engine incarnation. */
function sessionLocator(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) => !["hostId", "threadId", "inputId", "turnId", "executionId", "incarnation"].includes(k),
    ) ||
    (v.hostId !== "local-codex" && v.hostId !== "opencraft-server") ||
    !text(v.threadId) ||
    (v.inputId === undefined && v.turnId === undefined) ||
    ["inputId", "turnId", "executionId", "incarnation"].some((k) => v[k] !== undefined && !text(v[k]))
  )
    return null;
  return {
    hostId: v.hostId as ExecutionSessionLocator["hostId"],
    threadId: v.threadId as string,
    ...(v.inputId !== undefined ? { inputId: v.inputId as string } : {}),
    ...(v.turnId !== undefined ? { turnId: v.turnId as string } : {}),
    ...(v.executionId !== undefined ? { executionId: v.executionId as string } : {}),
    ...(v.incarnation !== undefined ? { incarnation: v.incarnation as string } : {}),
  };
}

/** Read-only execution records of a Headless data directory for the Worker that
 * owns the Assets vault: core's own assets Worker, or an identity composition
 * that runs its own vault Worker. Call it inside that Worker only; every read
 * is synchronous SQLite and must never run on a network thread. Nothing here
 * writes, migrates or opens a replacement store. */
export function createHeadlessExecutionRecords(options: {
  /** The Headless data directory whose execution leases, Server creation
   * reservations and Actor store are read. */
  directory: string;
  /** Compiled into the Worker entry by a trusted composition; never from
   * Worker data, a request or configuration. It maps a verified owner to the
   * vault partition its ENV is read from, among that Actor's verified bindings. */
  environmentAccount?: EnvironmentAccountMapping;
}): HeadlessExecutionRecords {
  const authority = new GitExecutionAuthority(options.directory, "actor");
  const actors = new WorkspaceActorAuthority(options.directory);
  const environmentAccounts =
    options.environmentAccount === undefined
      ? undefined
      : new EnvironmentAccountPartitions(
          {
            owner: (actorId) => authority.environmentAccountOwner(actorId),
            actorOf: (binding) => authority.environmentAccountActor(binding),
          },
          options.environmentAccount,
        );
  return {
    execution: {
      resolve: (raw) => resolveExecutionAdmission(authority, raw),
      reserve(raw) {
        const input = parseGitExecutionLocator(raw);
        if (input.hostId !== "local-codex" || !input.inputId || input.turnId) throw Error("git_execution_unavailable");
        const current = authority.reserve(input);
        if (!current) {
          if (authority.unowned(input, "pending")) return null;
          throw Error("git_execution_unavailable");
        }
        return { scope: executionScope(input, current), native: { incarnation: current.incarnation } };
      },
      actor: (account) => authority.actor(account),
      close: () => {
        try {
          authority.close();
        } finally {
          actors.close();
        }
      },
    },
    // The pending Codex input lease and the Server owner's creation
    // reservation, with the current Actor epoch.
    environmentRecords: {
      codexTurn: (locator) => codexTurnAdmission(authority, locator),
      creation: (locator) => creationAdmission(authority, locator),
      actorEpoch: (actorId) => authority.actorEpoch(actorId),
    },
    ...(environmentAccounts ? { environmentAccounts } : {}),
    sessions: {
      owner(raw, phase): ExecutionSessionOwner | null {
        if (phase !== "active" && phase !== "pending") return null;
        const locator = sessionLocator(raw);
        if (!locator) return null;
        const owner = authority.sessionOwner(locator, phase);
        return owner ? { hostId: locator.hostId, threadId: locator.threadId, ...owner } : null;
      },
    },
    actors: {
      admit: (raw) => workspaceAdmission(raw as never),
      current: (access, pending) => actors.current(access, pending),
      role: (access) => actors.role(access.actorId),
    },
  };
}
