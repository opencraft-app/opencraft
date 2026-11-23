import {
  AccountEnvironment,
  EnvironmentError,
  type EnvironmentScope,
  type EnvironmentView,
} from "@opencraft/execution-environment/account-environment";
import type { EnvironmentAccountResolver } from "@opencraft/execution-environment/environment-account";
import { GitVaultError } from "@opencraft/execution-environment/employee-git-vault-store";
import type { GitConnectionsSnapshot } from "../git/contract.js";
import type { SandboxConfigurationsSnapshot } from "../contract.js";
import type { SandboxConfigurations } from "./configurations.js";
import { SandboxConfigurationError } from "./errors.js";
import type { GitConnections } from "./git-connections.js";
import type { PersonalMcpActors, PersonalMcpAdmission } from "./personal-mcp.js";
import type { AssetAdmission } from "./worker.js";

/** The original Human proof Main sends (`WorkspaceActorAdmission` from
 * `openActorAdmission`). It names an Actor and its revocable permits, never a
 * vault partition, an account or a right. */
export type AssetActorProof = PersonalMcpAdmission;
/** The Worker's read-only projection of the committed Actor and member records
 * (`createHeadlessExecutionRecords().actors`, or the default reader over the
 * data directory). The role decides role-dependent rules such as custom
 * endpoints and platform resources; it never admits by itself. */
export interface AssetActorAuthority extends PersonalMcpActors {
  /** The Actor's current role; call only after `current` returned true. */
  role(access: AssetActorProof): "admin" | "member" | null;
}
/** A remembered Project the personal ENV page may scope variables to. */
export interface AssetEnvironmentProject {
  readonly id: string;
  readonly name: string;
}
/** Settings methods of the vault Worker that take the original Human proof.
 * The Worker derives the `actor:<actorId>` partition and the role from that
 * proof and the committed records; a caller cannot select either. */
export interface AssetActorSettingsMethods {
  actorConfigurationsSnapshot(access: AssetActorProof): Promise<SandboxConfigurationsSnapshot>;
  actorConfigurationsUpdate(access: AssetActorProof, input: unknown): Promise<SandboxConfigurationsSnapshot>;
  actorGitSnapshot(access: AssetActorProof): Promise<GitConnectionsSnapshot>;
  actorGitUpdate(access: AssetActorProof, input: unknown): Promise<GitConnectionsSnapshot>;
}
/** Personal ENV settings, present where this Worker issues execution ENV. Secret
 * values are write-only: no method returns one. */
export interface AssetEnvironmentSettingsMethods {
  environmentList(access: AssetActorProof, scope: EnvironmentScope): Promise<EnvironmentView>;
  environmentReplace(
    access: AssetActorProof,
    scope: EnvironmentScope,
    revision: number,
    input: unknown,
  ): Promise<EnvironmentView>;
  environmentProjects(access: AssetActorProof): readonly AssetEnvironmentProject[];
}

const fail = (code: string, status: number): never => {
  throw new SandboxConfigurationError(code, status);
};
interface Admitted {
  readonly proof: AssetActorProof;
  /** The Main-free admission the existing configuration and Git owners take. */
  readonly asset: AssetAdmission;
  /** Rechecks the proof's permits, expiry, committed Actor/member records and role. */
  assertCurrent(): void;
}

/** Worker-side settings over the sole vault owner. Every call rechecks the
 * proof before domain IO, again at each owner's own commit boundary, and once
 * more before its answer leaves the Worker. */
export function createActorSettings(options: {
  readonly actors: AssetActorAuthority;
  readonly configurations: SandboxConfigurations;
  readonly git: GitConnections;
  /** The vault partition mapping launches read ENV from (identity compositions). */
  readonly environment?: {
    readonly values: AccountEnvironment;
    projects(): readonly AssetEnvironmentProject[];
    readonly accounts?: EnvironmentAccountResolver;
  };
  closed(): boolean;
}) {
  const { actors, configurations, git, environment } = options;
  const mapped = (error: unknown): never => {
    if (error instanceof SandboxConfigurationError) throw error;
    if (error instanceof EnvironmentError) throw new SandboxConfigurationError(error.code, error.status);
    if (error instanceof GitVaultError && error.code === "conflict")
      throw new SandboxConfigurationError("conflict", 409);
    // SQLite paths, encrypted payloads and backend exceptions never cross RPC.
    throw new SandboxConfigurationError("unavailable", 503);
  };
  function capture(raw: unknown): Admitted {
    let proof: AssetActorProof;
    try {
      proof = actors.admit(raw);
    } catch {
      return fail("forbidden", 403);
    }
    const live = () => {
      if (options.closed() || !actors.current(proof, true)) fail("forbidden", 403);
    };
    live();
    const role = actors.role(proof);
    if (role !== "admin" && role !== "member") return fail("forbidden", 403);
    const admin = role === "admin";
    const asset: AssetAdmission = Object.freeze({
      scope: `actor:${proof.actorId}`,
      allowCustomEndpoints: admin,
      canManagePlatform: admin,
      expiresAt: proof.expiresAt,
      permit: proof.requestPermit,
    });
    const assertCurrent = () => {
      live();
      if (actors.role(proof) !== role) fail("forbidden", 403);
    };
    return { proof, asset, assertCurrent };
  }
  async function admitted<T>(raw: unknown, action: (access: Admitted) => T | Promise<T>): Promise<T> {
    try {
      const access = capture(raw);
      const value = await action(access);
      access.assertCurrent();
      return value;
    } catch (error) {
      return mapped(error);
    }
  }
  /** For the concurrent read lane, which must answer synchronously. */
  function admittedNow<T>(raw: unknown, action: (access: Admitted) => T): T {
    try {
      const access = capture(raw);
      const value = action(access);
      access.assertCurrent();
      return value;
    } catch (error) {
      return mapped(error);
    }
  }
  const settings: AssetActorSettingsMethods = {
    actorConfigurationsSnapshot: (raw) =>
      admitted(raw, ({ asset }) =>
        configurations.snapshot(asset.scope, asset.allowCustomEndpoints, asset.canManagePlatform),
      ),
    actorConfigurationsUpdate: (raw, input) =>
      admitted(raw, ({ asset }) =>
        configurations.update(asset.scope, input, asset.allowCustomEndpoints, asset.canManagePlatform),
      ),
    actorGitSnapshot: (raw) => admitted(raw, ({ asset }) => git.snapshot(asset.scope)),
    actorGitUpdate: (raw, input) =>
      admitted(raw, ({ asset, assertCurrent }) => git.update(asset.scope, input, assertCurrent)),
  };
  if (!environment) return { settings, environment: undefined };
  // The partition launches read: the canonical Actor partition, or the one the
  // composition's mapping selects among this Actor's verified bindings.
  const partition = (proof: AssetActorProof) =>
    environment.accounts
      ? environment.accounts.forActor(`actor:${proof.actorId}`, proof.generation)
      : { partition: `actor:${proof.actorId}`, current: () => true };
  const scoped = (scope: EnvironmentScope) => {
    if (!scope || typeof scope !== "object" || Array.isArray(scope) || Object.keys(scope).join() !== "projectId")
      return fail("invalid", 400);
    // Only a remembered Project, exactly as the HTTP route offers.
    if (scope.projectId !== null && !environment.projects().some((p) => p.id === scope.projectId))
      return fail("invalid", 400);
    return { projectId: scope.projectId };
  };
  const methods: AssetEnvironmentSettingsMethods = {
    environmentList: (raw, scope) =>
      admitted(raw, ({ proof, assertCurrent }) => {
        const selected = partition(proof),
          check = () => {
            assertCurrent();
            if (!selected.current()) fail("forbidden", 403);
          };
        return environment.values.list(selected.partition, scoped(scope), check);
      }),
    environmentReplace: (raw, scope, revision, input) =>
      admitted(raw, ({ proof, assertCurrent }) => {
        const selected = partition(proof),
          check = () => {
            assertCurrent();
            if (!selected.current()) fail("forbidden", 403);
          };
        return environment.values.replace(selected.partition, scoped(scope), revision, input, check);
      }),
    // Synchronous: served on the read lane, beside an unrelated pending write.
    environmentProjects: (raw) => admittedNow(raw, () => environment.projects().map(({ id, name }) => ({ id, name }))),
  };
  return { settings, environment: methods };
}
