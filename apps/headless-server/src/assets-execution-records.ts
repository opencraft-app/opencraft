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
};

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
      close: () => authority.close(),
    },
    // The pending Codex input lease and the Server owner's creation
    // reservation, with the current Actor epoch.
    environmentRecords: {
      codexTurn: (locator) => codexTurnAdmission(authority, locator),
      creation: (locator) => creationAdmission(authority, locator),
      actorEpoch: (actorId) => authority.actorEpoch(actorId),
    },
    ...(environmentAccounts ? { environmentAccounts } : {}),
  };
}
