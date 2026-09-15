import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  TransparentEngineSwitch,
  TransparentEngineSwitchPort,
  TransparentEngineSwitchStart,
} from "../types/transparent-handoff.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { RuntimeExecutionHint } from "./execution-profile.ts";
import {
  resumeRouteOverride,
  threadResumeSettingsFromTurn,
} from "./transparent-thread-routing.ts";

type Dependencies =
  | "runtimeWorkspace"
  | "threadArtifactStore"
  | "threadExecution"
  | "threadManager"
  | "transparentBackendLifecycle"
  | "transparentBackendRpc"
  | "transparentRuntimeAccess"
  | "transparentRuntimeRetirement"
  | "transparentThreadBinding"
  | "userDirectory";

const RUNTIME_USER_ROOT = "/run/hypernode-users/";
const PUBLIC_CODEX_SESSIONS_ROOT = "/workspace/.codex/sessions/";
const CODEX_SESSIONS_MARKER = "/.codex/sessions/";

function hostLegacyRolloutPath(
  path: string | null | undefined,
  user: { homePath?: string | null } | null | undefined,
  innerThreadId: string,
): string | null {
  if (typeof path !== "string" || path.length === 0) return null;
  if (!path.startsWith(RUNTIME_USER_ROOT) && !path.startsWith(PUBLIC_CODEX_SESSIONS_ROOT)) {
    return path;
  }
  if (typeof user?.homePath !== "string" || !user.homePath.startsWith("/")) return null;
  const suffix = path.startsWith(PUBLIC_CODEX_SESSIONS_ROOT)
    ? `/.codex/sessions/${path.slice(PUBLIC_CODEX_SESSIONS_ROOT.length)}`
    : path.slice(path.indexOf(CODEX_SESSIONS_MARKER));
  if (!suffix.startsWith(CODEX_SESSIONS_MARKER)) return null;
  if (suffix.includes("\0") || suffix.split("/").includes("..") ||
      !suffix.endsWith(`-${innerThreadId}.jsonl`)) return null;
  return `${user.homePath.replace(/\/+$/, "")}${suffix}`;
}

/**
 * Coordinates an immutable execution-engine generation switch for one Thread.
 *
 * This service owns sequencing only. Durable rollout artifacts remain the
 * source of migration truth; AppServer projections are never used as input.
 */
export class TransparentEngineSwitchService extends Service
  implements TransparentEngineSwitchPort {
  static inject = [
    "runtimeWorkspace",
    "threadArtifactStore",
    "threadExecution",
    "threadManager",
    "transparentBackendLifecycle",
    "transparentBackendRpc",
    "transparentRuntimeAccess",
    "transparentRuntimeRetirement",
    "transparentThreadBinding",
    "userDirectory",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  private sequence = 0;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentEngineSwitch");
  }

  begin(input: TransparentEngineSwitchStart): void {
    const binding = this.ctx.transparentThreadBinding.bindings.get(input.outerThreadId) ?? null;
    if (!binding) {
      input.reject(
        "Transparent thread has no execution binding; the execution-engine switch cannot be completed safely.",
      );
      return;
    }
    const runtimeHint: RuntimeExecutionHint =
      this.ctx.transparentThreadBinding.runtimeHintFor(input.outerThreadId) ?? {};
    const authority = this.ctx.threadExecution.table.get(input.outerThreadId) ?? null;
    const oldState = this.ctx.transparentRuntimeAccess.stateForOuter(input.outerThreadId);

    if (!binding.rolloutPath || binding.rolloutPath.startsWith(RUNTIME_USER_ROOT) ||
        binding.rolloutPath.startsWith(PUBLIC_CODEX_SESSIONS_ROOT)) {
      const backendUser = this.ctx.userDirectory.find(input.backendUserId);
      const discovered = this.ctx.threadArtifactStore.findLegacySource(
        backendUser,
        binding.innerThreadId,
      );
      // Codex reports paths from inside its runtime namespace. The artifact
      // store runs on the host and must never send that /run path through the
      // workspace filesystem, whose paths are owned by outer Thread ids. The
      // indexed lookup is authoritative; the deterministic mapping is a
      // recovery path for a stale or not-yet-indexed legacy binding.
      const hostPath = hostLegacyRolloutPath(
        discovered ?? binding.rolloutPath,
        backendUser,
        binding.innerThreadId,
      );
      if (hostPath && hostPath !== binding.rolloutPath) {
        binding.rolloutPath = hostPath;
        this.ctx.transparentThreadBinding.persist();
      }
    }
    if (!authority) {
      input.reject(
        "Transparent thread has no active execution authority; the execution-engine switch cannot be completed safely.",
      );
      return;
    }
    if (!this.ctx.runtimeWorkspace.enabled) {
      input.reject(
        "Transparent thread execution-engine switching requires the persistent workspace artifact store.",
      );
      return;
    }
    if (!binding.rolloutPath) {
      input.reject(
        "Transparent thread has no captured rollout artifact; the execution-engine switch cannot be completed safely.",
      );
      return;
    }

    const handoff: TransparentEngineSwitch = {
      connection: input.connection,
      outerThreadId: input.outerThreadId,
      message: input.message,
      actorCredential: input.actorCredential,
      executionProfile: input.executionProfile,
      authority,
      binding: { ...binding },
      runtimeHint: { ...runtimeHint },
      oldState,
      reject: input.reject,
      phase: "quiescing",
      reidentify: false,
    };
    console.info(
      `[transparent-codex] engine switch begin outer=${input.outerThreadId} ` +
      `epoch=${authority.epoch} ` +
      `from=${oldState?.executionProfile?.fingerprint ?? runtimeHint.accountIdentity ?? input.backendUserId} ` +
      `to=${input.executionProfile?.fingerprint ?? input.actorCredential.accountIdentity}`,
    );

    if (oldState) {
      if (oldState.isolatedOuterThreadId === input.outerThreadId) {
        try {
          this.ctx.transparentRuntimeRetirement.retireIsolatedBackend(
            oldState,
            input.outerThreadId,
            true,
          );
          handoff.oldState = null;
        } catch (error) {
          input.reject(
            `Could not stop the previous thread runtime: ${errorMessage(error)}`,
            -32070,
          );
          return;
        }
      } else if (oldState.opened.has(input.outerThreadId)) {
        handoff.reidentify = true;
      }
    }
    this.continue(handoff);
  }

  continue(handoff: TransparentEngineSwitch): void {
    if (handoff.phase !== "quiescing") return;
    handoff.phase = "snapshotting";
    const {
      outerThreadId,
      actorCredential,
      executionProfile,
      authority,
      binding,
      connection,
      message,
    } = handoff;

    let artifact;
    const snapshotStartedAtMs = Date.now();
    try {
      if (!this.ctx.runtimeWorkspace.enabled || !binding.rolloutPath) {
        throw new Error("the persistent rollout artifact store is unavailable");
      }
      artifact = this.ctx.threadArtifactStore.prepare(
        outerThreadId,
        binding.rolloutPath,
        authority.epoch,
        binding.innerThreadId,
        {
          reidentify: handoff.reidentify,
          modelProvider: actorCredential.providerId ?? "openai",
        },
      );
      if (!("resumeHistory" in artifact)) {
        artifact.resumeHistory = this.ctx.threadArtifactStore.resumeHistory(artifact.path);
      }
      artifact.resumeMode = artifact.resumeHistory ? "history" : "path";
      artifact.persistent = true;
      console.info(
        `[transparent-codex] handoff snapshot ready outer=${outerThreadId} ` +
        `duration_ms=${Date.now() - snapshotStartedAtMs} ` +
        `reidentified=${handoff.reidentify} resume=${artifact.resumeMode}`,
      );
    } catch (error) {
      handoff.reject(`Could not snapshot the thread rollout: ${errorMessage(error)}`, -32071);
      return;
    }

    const filesystem = this.ctx.transparentRuntimeAccess.filesystemForRealm(binding.realm);
    const backendKey = this.ctx.transparentRuntimeAccess.threadBackendKey(
      actorCredential.userId,
      filesystem,
      binding.viewId,
      outerThreadId,
      executionProfile,
    );
    const state = this.ctx.transparentBackendLifecycle.ensure({
      connection,
      ownerUserId: actorCredential.userId,
      filesystem,
      viewId: binding.viewId,
      initialCwd: this.ctx.threadManager.get(outerThreadId).cwd,
      defaultBackendKey: this.ctx.transparentRuntimeAccess.backendKey(
        actorCredential.userId,
        filesystem,
        binding.viewId,
      ),
      workspaceRealm: this.ctx.transparentRuntimeAccess.isWorkspaceFilesystem(filesystem),
      options: {
        backendKey,
        isolatedOuterThreadId: outerThreadId,
        accountIdentity: actorCredential.accountIdentity,
        providerId: actorCredential.providerId ?? null,
        executionProfile,
      },
    });
    const resumeRoute = resumeRouteOverride(
      message.params,
      handoff.runtimeHint,
      actorCredential.providerId,
    );
    handoff.artifact = artifact;
    handoff.resumeRoute = resumeRoute;
    handoff.phase = "resuming";

    const id = `hypernode:transparent:handoff-resume:${++this.sequence}`;
    this.ctx.transparentBackendRpc.trackInternal(state, id, {
      outerThreadId: handoff.outerThreadId,
      method: "thread/resume",
      handoff,
    });
    state.opening.add(outerThreadId);
    const resumeSource = artifact.resumeMode === "history"
      ? { history: artifact.resumeHistory }
      : { path: this.ctx.threadArtifactStore.runtimePath(artifact.path, state.realm) };
    const resumeIdentity = { threadId: artifact.innerThreadId };
    const cwd = this.ctx.threadManager.get(outerThreadId).cwd;
    const resumeMessage = {
      id,
      method: "thread/resume",
      params: {
        ...threadResumeSettingsFromTurn(message.params ?? {}),
        ...resumeRoute,
        ...resumeIdentity,
        ...resumeSource,
        cwd: this.ctx.transparentRuntimeAccess.toPhysical(cwd, state),
      },
    };
    if (state.phase === "ready") {
      this.ctx.transparentRuntimeAccess.filesystem(state).send(state.processId, resumeMessage);
    } else {
      state.pendingBackendMessages.push(resumeMessage);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
