import type { WorkspaceCatalog } from "@opencraft/appserver-protocol";
import type { ResolvedWorkspaceSelection } from "@opencraft/execution-environment/workspace-selection";
import type { WorkspaceBudgetPort } from "./workspace-budget.js";
import type {
  GitExecutionLocator,
  GitExecutionHandoff,
  GitExecutionReservation,
} from "@opencraft/execution-environment/git-execution";
import type { GitConnectionsSnapshot, GitProviderDescriptor } from "../git/contract.js";
import type {
  AnyEnvironmentLaunchContext,
  EnvironmentLaunchTarget,
} from "@opencraft/execution-environment/environment-delivery";
import type { EnvironmentLaunchReply } from "@opencraft/execution-environment/environment-launch-owner";
import type { EnvironmentLaunchLocator } from "@opencraft/execution-environment/environment-launch-receiver";
import type { EnvironmentCreationRequest } from "./storage.js";
import type { EnvironmentActorEpoch } from "@opencraft/execution-environment/git-execution";
import type {
  EnvironmentExecutionScope,
  EnvironmentMetadataPort,
  EnvironmentScopeRequest,
} from "@opencraft/execution-environment/environment-metadata";
import type { PersonalGitSealPort } from "@opencraft/execution-environment/personal-git-seal";
import type { GitGrantScope } from "@opencraft/execution-environment/personal-git-protocol";
import { WorkerOwner, ownerEntry } from "@opencraft/worker-owner";
import type { DatabaseOutcome } from "@opencraft/sqlite-node";
import type { SandboxConfigurationsSnapshot } from "../contract.js";
import { SandboxConfigurationError } from "./errors.js";
import type { AssetActorSettingsMethods, AssetEnvironmentSettingsMethods } from "./actor-settings.js";
export type {
  AssetActorAuthority,
  AssetActorProof,
  AssetActorSettingsMethods,
  AssetEnvironmentProject,
  AssetEnvironmentSettingsMethods,
} from "./actor-settings.js";
/** Worker-reported Bot backend IDs; malformed reports fail closed to none. */
function botBackends(ready: Ready): readonly string[] {
  const ids = ready.botExecution === true ? ready.botBackends : undefined;
  if (!Array.isArray(ids) || ids.length > 16 || ids.some((id) => typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,22}$/u.test(id)))
    return [];
  return Object.freeze([...new Set(ids)]);
}

/** A request-local revocable admission, not an identity supplied by HTTP input.
 * The authenticated owner invalidates permit[0] on account/role/session changes.
 * The Worker checks both permit and expiry immediately before domain IO. */
export interface AssetAdmission {
  readonly scope: string;
  readonly allowCustomEndpoints: boolean;
  readonly canManagePlatform: boolean;
  readonly expiresAt: number;
  readonly permit: Int32Array<SharedArrayBuffer>;
}
export interface AssetConfigurationPort {
  snapshot(access: AssetAdmission): Promise<SandboxConfigurationsSnapshot>;
  update(access: AssetAdmission, input: unknown): Promise<SandboxConfigurationsSnapshot>;
}
/** The non-secret record a creation reservation is written from. */
export interface EnvironmentCreationRecord {
  readonly hostId: "local-codex" | "opencraft-server";
  readonly operationId: string;
  readonly actorId: string;
  readonly actorGeneration: number;
  readonly membershipRevision: number;
  readonly source: string | null;
  readonly incarnation: string;
  readonly project: string | null;
}
export interface AssetStoragePort
  extends AssetConfigurationPort,
    WorkspaceBudgetPort,
    AssetActorSettingsMethods,
    AssetEnvironmentSettingsMethods {
  adoptWorkspaceInstallation(path: string): Promise<boolean>;
  workspaceCatalog(access: AssetAdmission): Promise<WorkspaceCatalog>;
  workspaceResolveEnvironment(
    access: AssetAdmission,
    target: unknown,
  ): Promise<ResolvedWorkspaceSelection["environment"]>;
  workspaceValidateEnvironment(
    access: AssetAdmission,
    environment: ResolvedWorkspaceSelection["environment"],
  ): Promise<boolean>;
  executionGitReservation(locator: GitExecutionLocator): Promise<GitExecutionReservation | null>;
  executionGitGrant(locator: GitExecutionLocator): Promise<GitExecutionHandoff | null>;
  executionEnvironmentLaunch(target: EnvironmentLaunchTarget, context: AnyEnvironmentLaunchContext): Promise<string>;
  executionEnvironmentActor(account: string): Promise<EnvironmentActorEpoch | null>;
  environmentLaunchRecord(target: EnvironmentLaunchTarget, locator: EnvironmentLaunchLocator): Promise<EnvironmentLaunchReply>;
  environmentCreationAdmission(request: EnvironmentCreationRequest): Promise<EnvironmentCreationRecord>;
  personalGitSeal(scope: GitGrantScope): Promise<string>;
  environmentMetadataAdmit(request: EnvironmentScopeRequest): Promise<EnvironmentExecutionScope>;
  environmentMetadataProject(hostId: string, threadId: string): Promise<string | null>;
  environmentMetadataBind(hostId: string, threadId: string, projectId: string | null): Promise<void>;
  environmentMetadataBindCreator(scope: EnvironmentExecutionScope, threadId: string): Promise<void>;
  environmentMetadataRememberProjects(hostId: string, projects: readonly { id: string; name: string }[]): Promise<void>;
  gitSnapshot(access: AssetAdmission): Promise<GitConnectionsSnapshot>;
  gitUpdate(access: AssetAdmission, input: unknown): Promise<GitConnectionsSnapshot>;
}
interface Ready {
  outcome: DatabaseOutcome;
  gitHosts: readonly string[];
  /** Non-secret provider metadata (host, auth kind, SSH host name) for settings. */
  gitProviders: readonly GitProviderDescriptor[];
  gitAuthority: string | null;
  environmentIssuer?: string | null;
  /** The issuer also admits Hands terminal launches (Actor epoch reader). */
  environmentTerminal?: boolean;
  /** Personal ENV settings (`environmentList/Replace/Projects`) are served. */
  environmentSettings?: boolean;
  workspaceExecution: boolean;
  botExecution?: boolean;
  botBackends?: readonly string[];
}
/** All vault opens, migrations, reads and writes belong to this FIFO Worker.
 * There is no local fallback, runtime-secret RPC or automatic mutation retry. */
export async function openAssetConfigurations(
  directory: string,
  options: {
    entry?: URL;
    installationFile?: string;
    workspaceMachineId?: string;
    terminalOwner?: { directory: string; endpoint: string; tokenFile: string };
    /** This Worker also issues opaque execution ENV capsules (core vault owner). */
    environmentLaunch?: boolean;
    /** Publication path and rotation generation of its sealed issuer key. */
    environmentIssuer?: { publish?: string; generation?: string };
  } = {},
) {
  const { owner, ready } = await WorkerOwner.open<AssetStoragePort, Ready>(
    options.entry ?? ownerEntry(import.meta.url, "assets-configuration"),
    {
      name: "Asset configuration storage",
      workerData: {
        directory,
        ...(options.terminalOwner === undefined ? {} : { terminalOwner: options.terminalOwner }),
        ...(options.workspaceMachineId === undefined ? {} : { workspaceMachineId: options.workspaceMachineId }),
        ...(options.environmentLaunch ? { environmentLaunch: true } : {}),
        ...(options.environmentLaunch && options.environmentIssuer
          ? { environmentIssuer: { ...options.environmentIssuer } }
          : {}),
      },
      errors: [SandboxConfigurationError],
      maxPending: 128,
    },
  );
  if (
    options.installationFile !== undefined ||
    options.workspaceMachineId !== undefined ||
    options.terminalOwner !== undefined ||
    options.environmentLaunch
  ) {
    try {
      // A requested issuer that the Worker did not start is a startup failure.
      if (
        options.environmentLaunch &&
        (typeof ready.environmentIssuer !== "string" || typeof ready.gitAuthority !== "string")
      )
        throw new SandboxConfigurationError("unavailable", 503);
      if (
        (options.workspaceMachineId !== undefined || options.terminalOwner !== undefined) &&
        ready.workspaceExecution !== true
      )
        throw new SandboxConfigurationError("unavailable", 503);
      if (options.installationFile !== undefined) await owner.call.adoptWorkspaceInstallation(options.installationFile);
    } catch (cause) {
      try {
        await owner.close();
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], "Assets bootstrap cleanup unconfirmed");
      }
      throw cause;
    }
  }
  return {
    store: owner.call,
    outcome: ready.outcome,
    gitHosts: ready.gitHosts,
    gitProviders: ready.gitProviders,
    gitAuthority: ready.gitAuthority,
    workspaceExecution: ready.workspaceExecution === true,
    botExecution: ready.botExecution === true,
    /** This owner serves personal ENV settings for an original Human proof. */
    environmentSettings: ready.environmentSettings === true,
    botBackends: botBackends(ready),
    /** Vault-owner port for `/host-environment`: only routing metadata goes in
     * and only an opaque capsule comes back to this thread. */
    environmentLaunch:
      typeof ready.environmentIssuer === "string"
        ? Object.freeze({
            issuer: ready.environmentIssuer,
            seal: (target: EnvironmentLaunchTarget, context: AnyEnvironmentLaunchContext) =>
              owner.call.executionEnvironmentLaunch(target, context),
            /** Seals for the durable record `locator` names (read by the owner). */
            launch: (target: EnvironmentLaunchTarget, locator: EnvironmentLaunchLocator) =>
              owner.call.environmentLaunchRecord(target, locator),
            /** Admits a creation: the Actor's current epoch and its Project. */
            admitCreation: (request: EnvironmentCreationRequest) => owner.call.environmentCreationAdmission(request),
            // Terminal admission: the Actor epoch a reservation is written under.
            ...(ready.environmentTerminal === true
              ? { terminalActor: (account: string) => owner.call.executionEnvironmentActor(account) }
              : {}),
          })
        : undefined,
    /** The same owner signs personal Git grants: only a grant scope goes in and
     * only the opaque grant comes back. Present exactly when ENV delivery is. */
    personalGitSeal:
      typeof ready.environmentIssuer === "string" && typeof ready.gitAuthority === "string"
        ? Object.freeze<PersonalGitSealPort>({
            authority: ready.gitAuthority,
            seal: (scope) => owner.call.personalGitSeal(scope),
          })
        : undefined,
    /** The same owner's FIFO port for non-secret ENV metadata. Main awaits it;
     * there is no synchronous vault read to fall back to. */
    environmentMetadata:
      typeof ready.environmentIssuer === "string"
        ? Object.freeze<EnvironmentMetadataPort>({
            admit: (request) => owner.call.environmentMetadataAdmit(request),
            project: (hostId, threadId) => owner.call.environmentMetadataProject(hostId, threadId),
            bind: (hostId, threadId, projectId) => owner.call.environmentMetadataBind(hostId, threadId, projectId),
            bindCreator: (scope, threadId) => owner.call.environmentMetadataBindCreator(scope, threadId),
            rememberProjects: (hostId, projects) => owner.call.environmentMetadataRememberProjects(hostId, projects),
          })
        : undefined,
    close: () => owner.close(),
  };
}
