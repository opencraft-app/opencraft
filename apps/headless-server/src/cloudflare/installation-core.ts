// The InstallationCore Durable Object (docs/architecture/platform/cloudflare-deployment.md §5):
// one SQLite-backed object per deployment owns the Server core SQL and serves
// the installation's identity, admission and server information over the HTTP exchange port.
//
// This is a composition root, not a second implementation: the object
// migrates its SQL with the slim Server lifecycle and calls the same
// installation module (`assembly/installation.mjs`) the Node root calls,
// step by step, with runtime-neutral inputs in place of the Node ones:
//   core SQL owner   same-thread owner over the object's SQL (server-core-same-thread.ts)
//   commit fence     sameThreadCommitFence (the owner and the authorizer share this thread)
//   root inputs      documentRootInputs over the object's state documents; configuration from bindings
//   password hasher  the portable Argon2id hasher (Node: node:crypto.argon2), records interoperate
//   setup proof      a secret binding (Node: a private file), same validation
//   login attempts   one durable ledger in the object's state (Node: process memory)
//   access watches   the object's single alarm, merged (Node: runtime timeouts)
// Not assembled here: Hub and relay (Node-only or RelayHub), the identity
// composition and login admission (downstream products), and the workspace
// execution and project automation ports used by extended collaboration.
import type { StateDocumentStore } from "@opencraft/document-storage/state";
import { isTerminalResourceScopeId, threadCatalogEntry, type ThreadListResponse } from "@opencraft/appserver-protocol";
import { isWorkspaceId } from "@opencraft/sandbox/uri";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import { durableObjectStateDocumentStore } from "@opencraft/storage-cloudflare/state";
import { migrateServerSqlDatabase } from "@opencraft/storage-node/server-sql";
import type { ActorContext } from "@opencraft/identity-core/actors";
import { sameThreadCommitFence } from "@opencraft/access-control/commit-fence";
import { stateLoginAttemptLimiter } from "@opencraft/identity-core/login-attempts";
import { createPortablePasswordHasher } from "@opencraft/plugin-local-account/password-hash-portable";
import { serveFetchHttpExchange, fetchHttpExchange, fetchRequestView, fetchResponse, type FetchRequestView } from "@opencraft/http-exchange/fetch";
import type { HttpExchangeRequest, HttpExchangeResponse } from "@opencraft/http-exchange";
import { mergedOwnerWake, type OwnerWake } from "@opencraft/owner-wake";
import { assembleInstallation, type InstallationAssembly, type InstallationPersonalAccountServices } from "../assembly/installation.mjs";
import { documentRootInputs } from "../assembly/root-inputs.js";
import { sameThreadServerCore, type SameThreadServerCore } from "../assembly/server-core-same-thread.js";
import { ConversationResourceLifecycle } from "../conversation-resource-lifecycle.mjs";
import type { ConversationResourceRow } from "@opencraft/storage-node/server-conversation-resources";
import {
  INSTANCE_ACCESS_PREFIX,
  MISSING,
  installationExchangeReply,
  installationGate,
  isHealthPath,
  serveInstallationRoute,
} from "../installation-routes.js";
import {
  ACCOUNT_AUTHORITY_PATH,
  accountAuthorityRequestView,
  installationAccountAuthorities,
  parseAccountAuthorityQuery,
  type AccountAuthorityAnswer,
} from "../account-routes.js";
import {
  WORKSPACE_CODEX_START_OPERATION,
  WORKSPACE_CODEX_MODEL_LIST_OPERATION,
  WORKSPACE_CODEX_THREAD_LIST_OPERATION,
  WORKSPACE_HOST_HEADER,
  WORKSPACE_HOST_OBJECT_PREFIX,
  WORKSPACE_TERMINAL_RELEASE_OPERATION,
  workspaceHostObjectName,
} from "../workspace-host-routes.js";
import type { InstallationCoreEnv, InstallationCoreState, WorkspaceHostNamespace } from "./bindings.js";
import {
  APP_HOST_PATH,
  CLIENT_ADMISSION_PATH,
  CLIENT_CURRENT_PATH,
  clientAttachmentRefusal,
  clientInstanceId,
  parseClientAttachment,
  type ClientAttachment,
} from "./client-attachment.js";
import { CODEX_TURN_AUTHORITY_PATH } from "./codex-turn.js";
import { parseThreadResourceObservation, TERMINAL_AUTHORITY_PATH, WORKSPACE_THREAD_RESOURCES_PATH } from "./terminal-authority.js";
import { CODEX_THREAD_LOOKUP_PATH, parseCodexThreadRead } from "./codex-thread-read.js";
import { CODEX_THREAD_LIST_PATH, codexThreadCursorSealer, openCodexThreadCursor, parseCodexThreadList, parseCodexThreadPage } from "./codex-thread-list.js";
import { CODEX_WORKBENCH_HOST_ID, codexWorkspaceTarget, isCodexActorWorkspace, type CodexWorkspaceTarget } from "./codex-workspace.js";
import { CodexDraftScopes } from "./codex-draft-scopes.js";
import { CODEX_MODEL_LIST_PATH, isCodexModelList, parseCodexModelList } from "./codex-model-list.js";
import {
  CODEX_START_SPACE,
  CODEX_THREAD_START_AUTHORITY_PATH,
  CODEX_THREAD_START_BODY_BYTES,
  CODEX_THREAD_START_PATH,
  codexStartOperation,
  createdCodexThreadId,
  matchesCodexStartPin,
  codexStartPin,
  type CodexForkSource,
  parseCodexStartAuthority,
  parseCodexStartRequest,
} from "./codex-thread-start.js";
import {
  THREAD_PLACEMENT_LOOKUP_PATH,
  THREAD_PLACEMENT_PUBLISH_PATH,
  ThreadPlacementProjection,
  parseThreadPlacementKey,
  parseThreadPlacementReceipt,
  sameThreadPlacement,
  type ThreadPlacementAuthority,
  type ThreadPlacementKey,
} from "./thread-placement.js";

type Admission = Awaited<ReturnType<InstallationAssembly["openAdmission"]>>;
type IdentityRequestView = Parameters<NonNullable<Admission["instanceAccess"]>["authenticate"]>[0];

/** What the object serves once it opened. */
export interface InstallationCoreServices {
  readonly installation: InstallationAssembly;
  readonly core: SameThreadServerCore;
  readonly admission: Admission;
  readonly instanceAccess: NonNullable<Admission["instanceAccess"]>;
  readonly actorAccess: ReturnType<InstallationAssembly["openActorAccess"]>;
  readonly serverInformationService: ReturnType<InstallationAssembly["openServerInformation"]>["serverInformationService"];
  readonly personalServices: InstallationPersonalAccountServices;
  readonly actorCollaborationApi: Awaited<ReturnType<InstallationAssembly["openCollaboration"]>>["actorCollaborationApi"];
  readonly threadPlacements: ThreadPlacementProjection | null;
  readonly codexServerId: string;
  readonly codexTurns: boolean;
  readonly codexResources: ConversationResourceLifecycle | null;
  readonly codexCreation: {
    workspace: string;
    machine: string;
    isolateActors: boolean;
    projects: boolean;
    hosts: WorkspaceHostNamespace;
    operations: StateDocumentStore;
    directory: StateDocumentStore;
    draftScopes: CodexDraftScopes;
  } | null;
  readonly spaces: Awaited<ReturnType<InstallationAssembly["openSpaces"]>> | null;
  readonly actorStore: Awaited<ReturnType<InstallationAssembly["openIdentity"]>>["actorStore"];
}

/** The deployment's single object name. */
export const INSTALLATION_CORE_OBJECT = "installation";

const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/** Parses a JSON configuration binding; a malformed one fails the open, as a malformed file fails Node startup. */
function configuration(name: string, text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid ${name} configuration`);
  }
}

export class InstallationCore {
  protected readonly ctx: InstallationCoreState;
  #services: InstallationCoreServices | undefined;
  #failure: unknown;
  #wake: (() => void) | null = null;
  #closing: Promise<void> | undefined;
  #disposers: (() => unknown)[] = [];

  constructor(ctx: InstallationCoreState, env: InstallationCoreEnv) {
    this.ctx = ctx;
    // Migrations and every open step finish before any request is delivered. A
    // refused or failed open keeps the object closed: every request answers
    // 503 and none reads state an incomplete open left behind.
    void ctx.blockConcurrencyWhile(async () => {
      try {
        this.#services = await this.#open(env);
      } catch (error) {
        this.#failure = error;
        await this.close().catch(() => undefined);
      }
    });
  }

  protected threadPlacementAuthority(
    env: InstallationCoreEnv,
    allows: ThreadPlacementAuthority["allows"],
  ): ThreadPlacementAuthority | null {
    const hosts = env.WORKSPACE_HOST;
    if (!hosts) return null;
    return {
      allows,
      workspace(workspaceId) {
        return {
          async readCommitted(thread) {
            const host = hosts.get(hosts.idFromName(workspaceHostObjectName(workspaceId)));
            const response = await host.fetch(
              new Request(`https://workspace.invalid${WORKSPACE_HOST_OBJECT_PREFIX}thread-placement`, {
                method: "POST",
                headers: { "content-type": "application/json", [WORKSPACE_HOST_HEADER]: workspaceId },
                body: JSON.stringify(thread),
              }),
            );
            if (response.status === 404 || response.status === 409) return null;
            if (!response.ok) throw new Error("Workspace Thread placement unavailable");
            return parseThreadPlacementReceipt(await response.json());
          },
        };
      },
    };
  }

  /** The object's single alarm as the owner wake-up port; `at` is wall-clock time, as an alarm's is. */
  #alarmWake(): OwnerWake {
    const storage = this.ctx.storage;
    return {
      now: () => Date.now(),
      timer: (wake) => {
        this.#wake = wake;
        return {
          arm: (at) => void storage.setAlarm(at).catch(() => undefined),
          cancel: () => void storage.deleteAlarm().catch(() => undefined),
        };
      },
    };
  }

  async #open(env: InstallationCoreEnv): Promise<InstallationCoreServices> {
    const storage = this.ctx.storage;
    const handle = migrateServerSqlDatabase(durableObjectSqlDatabase(storage), {
      // workerd's own tables in the object's SQL are not Server schema.
      ownedByRuntime: (name) => name.startsWith("_cf_"),
    });
    const documents = durableObjectStateDocumentStore(storage, { prefix: "installation/" });
    const rootInputs = documentRootInputs({
      documents,
      humanAuthConfiguration: configuration("Human login", env.OPENCRAFT_HUMAN_AUTH),
      machine: {
        ...(env.OPENCRAFT_MACHINE_NAME === undefined ? {} : { name: env.OPENCRAFT_MACHINE_NAME }),
        defaultName: "OpenCraft",
        platform: "linux",
      },
    });
    const fence = sameThreadCommitFence();
    const core = sameThreadServerCore(handle, { identityFence: fence });
    const ownerWake = mergedOwnerWake(this.#alarmWake());
    const installation = assembleInstallation({
      serverStorage: core,
      identityFence: fence,
      // No identity composition qualifies external principals here.
      isHuman: () => undefined,
      ownerWake,
    });
    // The named disposers in the Node root's shutdown order (step 11), then the core owner.
    this.#disposers = [
      installation.closeCollaboration,
      installation.closeThreadAccess,
      installation.closeServerSpaces,
      installation.closeOrchestrationStorage,
      installation.closeIdentityExecutionEnvironment,
      installation.closeIdentity,
      installation.closeLoginAdmission,
      installation.closeAccountApplication,
      installation.closeAccountManagement,
      installation.closeHumanAuth,
      installation.closeHumanAccounts,
      installation.closeIdentityWrites,
      installation.closeActorStore,
      installation.closeMembership,
      () => core.close(),
    ];
    installation.openOrchestrationStorage();
    // The steps in the Node root's order, each at its original moment.
    const relayConfiguration = await rootInputs.relayConnection();
    const humanConfiguration = await rootInputs.humanAuthConfiguration();
    // A public deployment always admits through instance membership.
    installation.openMembership({
      hub: null,
      accessControl: true,
      accessMemberProviders: [],
      humanConfiguration,
      relayConfiguration,
    });
    const machineIdentity = await rootInputs.machineIdentity();
    const codexWorkspace = env.OPENCRAFT_WORKSPACE_CODEX_DEFAULT;
    const isolateActors = env.OPENCRAFT_WORKSPACE_CODEX_ISOLATE_ACTORS;
    if ((codexWorkspace !== undefined && (!isWorkspaceId(codexWorkspace) || isCodexActorWorkspace(codexWorkspace) || !env.WORKSPACE_HOST)) ||
      (isolateActors !== undefined && isolateActors !== "false" && (isolateActors !== "true" || !codexWorkspace)))
      throw new Error("Invalid default Codex workspace");
    const codexCreation = codexWorkspace && env.WORKSPACE_HOST
      ? {
          workspace: codexWorkspace,
          machine: machineIdentity.machineId,
          isolateActors: isolateActors === "true",
          projects: isolateActors === "true" && env.OPENCRAFT_WORKSPACE_CODEX_TURNS === "true" &&
            env.OPENCRAFT_WORKSPACE_CODEX_FILES === "true" && env.OPENCRAFT_WORKSPACE_CODEX_PROJECTS === "true",
          hosts: env.WORKSPACE_HOST,
          operations: durableObjectStateDocumentStore(storage, { prefix: "codex-start-routing/" }),
          directory: durableObjectStateDocumentStore(storage, { prefix: "codex-thread-directory/" }),
          draftScopes: new CodexDraftScopes(storage),
        }
      : null;
    const { actorStore } = await installation.openIdentity({
      createIdentity: undefined,
      hub: null,
      machineIdentity,
      relayConfiguration,
      workspaceExecution: undefined,
      sshIngressEnabled: false,
      environmentDelivery: undefined,
      environmentIssuer: undefined,
      engineHostDescriptor: undefined,
      capabilities: {
        register: () => {
          throw new Error("InstallationCore has no capability providers");
        },
      },
    });
    const setupToken = env.OPENCRAFT_SETUP_TOKEN;
    const admission = await installation.openAdmission({
      hub: null,
      relayConfiguration,
      humanConfiguration,
      accessMemberProviders: [],
      createPasswordHasher: createPortablePasswordHasher,
      readSetupToken: setupToken === undefined ? undefined : async () => ({ token: setupToken }),
      openLoginAdmission: undefined,
      // Attempts are counted before any derivation, durably, across requests, restarts and isolates.
      loginAttempts: stateLoginAttemptLimiter(durableObjectStateDocumentStore(storage, { prefix: "login-attempts/" })),
    });
    const actorAccess = installation.openActorAccess();
    if (!admission.instanceAccess) throw new Error("InstallationCore requires instance access");
    const spaces = env.WORKSPACE_HOST ? await installation.openSpaces() : null;
    const { actorCollaborationApi } = await installation.openCollaboration();
    const { serverInformationService } = installation.openServerInformation(documents);
    const personalServices = await installation.openPersonalServices({});
    const placementAuthority = this.threadPlacementAuthority(
      env,
      (context, { serverId, threadId }) =>
        !!spaces?.serverSpaces.initialized &&
        (spaces.threadAccess.readablePolicy(serverId, threadId, context)?.revision ?? 0) > 0,
    );
    const threadPlacements = placementAuthority && new ThreadPlacementProjection(
      durableObjectStateDocumentStore(storage, { prefix: "thread-placement/" }),
      placementAuthority,
    );
    const codexServerId = `server:${machineIdentity.machineId}:codex`;
    const codexResources = codexCreation && threadPlacements ? await ConversationResourceLifecycle.open(core, {
      terminal: async (row: ConversationResourceRow) => {
        if (row.hostId !== CODEX_WORKBENCH_HOST_ID) throw Error("Unknown resource Host");
        const placement = await threadPlacements.lookup({ serverId: codexServerId, threadId: row.threadId });
        if (!placement || !isCodexActorWorkspace(placement.workspaceId)) throw Error("Terminal workspace unavailable");
        const draftScopeId = await codexCreation.draftScopes.draftForThread(placement.workspaceId, row.threadId);
        const { hosts } = codexCreation;
        const host = hosts.get(hosts.idFromName(workspaceHostObjectName(placement.workspaceId)));
        const response = await host.fetch(new Request(
          `https://workspace.invalid${WORKSPACE_HOST_OBJECT_PREFIX}${WORKSPACE_TERMINAL_RELEASE_OPERATION}`,
          {
            method: "POST",
            headers: { "content-type": "application/json", [WORKSPACE_HOST_HEADER]: placement.workspaceId },
            body: JSON.stringify({ placement, activate: row.state === "active", draftScopeId }),
          },
        ));
        await response.body?.cancel();
        if (response.status !== 204) throw Error("Terminal cleanup unavailable");
      },
    }, {
      wake: ownerWake,
      diagnose: () => console.warn("OpenCraft conversation resource cleanup pending"),
    }) : null;
    if (codexResources) this.#disposers.unshift(() => codexResources.close());
    return {
      installation, core, admission, instanceAccess: admission.instanceAccess,
      actorAccess, actorStore, serverInformationService, personalServices, actorCollaborationApi, threadPlacements, spaces,
      codexServerId, codexResources,
      codexTurns: env.OPENCRAFT_WORKSPACE_CODEX_TURNS === "true",
      codexCreation,
    };
  }

  /** The opened services; throws when the open failed. */
  protected services(): InstallationCoreServices {
    if (!this.#services) throw new Error(`InstallationCore is unavailable: ${describe(this.#failure)}`);
    return this.#services;
  }

  /**
   * Runs the named disposers once, in order, settling every one. The platform
   * drops an evicted object's memory without an event; durable state is
   * already committed per transaction, so this runs when an open fails and
   * when the object retires itself.
   */
  close(): Promise<void> {
    return (this.#closing ??= (async () => {
      const failures: unknown[] = [];
      for (const dispose of this.#disposers.splice(0)) {
        try {
          await dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      this.#services = undefined;
      if (failures.length) throw new AggregateError(failures, "InstallationCore close failed");
    })());
  }

  /** The object's alarm: wakes whichever owner work is due (access watches); each re-derives from state. */
  async alarm(): Promise<void> {
    this.#wake?.();
    await this.#services?.codexResources?.settleCurrentCleanup();
  }

  /** The installation's front door: its HTTP routes and admission gate, as the Node gateway serves them. */
  async fetch(request: Request): Promise<Response> {
    if (!this.#services)
      return fetchResponse(
        installationExchangeReply({ kind: "json", status: 503, value: { error: "installation_unavailable" } }),
      );
    const services = this.#services;
    const url = new URL(request.url);
    // Private binding calls. The public edge never forwards these paths.
    if (url.pathname === ACCOUNT_AUTHORITY_PATH && request.method === "POST")
      return this.#accountAuthority(services, request);
    if (url.pathname === CLIENT_ADMISSION_PATH && request.method === "GET")
      return this.#clientAdmission(services, request, url);
    if (url.pathname === CLIENT_CURRENT_PATH && request.method === "POST")
      return this.#currentClient(services, request);
    if (url.pathname === CODEX_TURN_AUTHORITY_PATH && request.method === "POST")
      return this.#authorizeCodexTurn(services, request);
    if (url.pathname === TERMINAL_AUTHORITY_PATH && request.method === "POST")
      return this.#authorizeTerminal(services, request);
    if (url.pathname === WORKSPACE_THREAD_RESOURCES_PATH && request.method === "POST")
      return this.#observeCodexResources(services, request);
    if (url.pathname === CODEX_THREAD_START_PATH && request.method === "POST")
      return this.#startCodexThread(services, request);
    if (url.pathname === CODEX_MODEL_LIST_PATH && request.method === "POST")
      return this.#codexModelList(services, request);
    if (url.pathname === CODEX_THREAD_LIST_PATH && request.method === "POST")
      return this.#codexThreadList(services, request);
    if (url.pathname === CODEX_THREAD_START_AUTHORITY_PATH && request.method === "POST")
      return this.#authorizeCodexStart(services, request);
    if (url.pathname === THREAD_PLACEMENT_PUBLISH_PATH && request.method === "POST")
      return services.threadPlacements
        ? this.#publishThreadPlacement(services.threadPlacements, request)
        : fetchResponse(installationExchangeReply(MISSING));
    if (url.pathname === CODEX_THREAD_LOOKUP_PATH && request.method === "POST") {
      if (!services.threadPlacements) return fetchResponse(installationExchangeReply(MISSING));
      const body = await this.#privateJson(request, 8192) as { threadId?: unknown; attachment?: unknown; archiveState?: unknown } | null;
      const read = parseCodexThreadRead({ threadId: body?.threadId });
      const attachment = parseClientAttachment(body?.attachment);
      if (!read || !attachment || (body?.archiveState !== undefined && body.archiveState !== true))
        return clientAttachmentRefusal(400, "invalid_thread_placement_lookup");
      return this.#authorizedThreadPlacement(
        services,
        services.threadPlacements,
        { serverId: services.codexServerId, threadId: read.threadId },
        attachment,
        body?.archiveState === true,
      );
    }
    if (url.pathname === THREAD_PLACEMENT_LOOKUP_PATH && request.method === "POST")
      return services.threadPlacements
        ? this.#lookupThreadPlacement(services, services.threadPlacements, request)
        : fetchResponse(installationExchangeReply(MISSING));
    // The deployment's edge sets CF-Connecting-IP; the composition, not the adapter, chooses to trust it.
    const response = await serveFetchHttpExchange(request, (exchange) => this.#route(services, exchange), {
      clientAddress: request.headers.get("cf-connecting-ip"),
    });
    return response ?? fetchResponse(installationExchangeReply(MISSING));
  }

  /** The installation's admission gate over its services, for every front door it decides for. */
  #gate({ admission, instanceAccess, actorAccess }: InstallationCoreServices) {
    const auth = admission.humanAuth;
    return {
      sessionRequest: (value: IdentityRequestView) => actorAccess.isSessionRequest(value),
      admission: (value: IdentityRequestView) =>
        auth?.invalidSession(value) ? (401 as const) : instanceAccess.admissionStatus(value),
      legacyAdmission: (value: IdentityRequestView) => actorAccess.legacyAdmissionStatus(value),
      login: !!auth,
    };
  }

  async #clientAdmission(services: InstallationCoreServices, request: Request, url: URL): Promise<Response> {
    const id = clientInstanceId(url);
    if (!id) return clientAttachmentRefusal(400, "invalid_client_instance");
    const auth = services.admission.humanAuth;
    if (!auth || url.origin !== auth.configuration.origin || request.headers.get("origin") !== url.origin)
      return clientAttachmentRefusal(403, "origin_required");

    const identity = fetchRequestView(request) as IdentityRequestView;
    await services.instanceAccess.prepare(identity);
    const refusal = installationGate(identity, APP_HOST_PATH, undefined, this.#gate(services));
    if (refusal) return fetchResponse(installationExchangeReply(refusal));
    const login = auth.currentLogin(identity);
    if (!login) return clientAttachmentRefusal(401, "authentication_required");

    const attachment: ClientAttachment = {
      clientInstanceId: id,
      actorId: login.context.actorId,
      actorGeneration: login.context.generation,
      expiresAt: login.context.expiresAt,
      loginDigest: login.digest,
    };
    return Response.json(attachment, { headers: { "cache-control": "no-store" } });
  }

  async #privateJson(request: Request, limit: number): Promise<unknown> {
    try {
      const bytes = await fetchHttpExchange(request).readBody(limit);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }

  #clientContext(services: InstallationCoreServices, attachment: ClientAttachment): ActorContext | Response {
    const login = services.admission.humanAccounts?.byDigest(attachment.loginDigest);
    if (!login) return clientAttachmentRefusal(401, "authentication_required");
    if (
      login.context.actorId !== attachment.actorId ||
      login.context.generation !== attachment.actorGeneration ||
      login.context.expiresAt !== attachment.expiresAt ||
      !services.instanceAccess.role(login.principal)
    ) return clientAttachmentRefusal(403, "instance_access_denied");
    return login.context;
  }

  async #currentClient(services: InstallationCoreServices, request: Request): Promise<Response> {
    const attachment = parseClientAttachment(await this.#privateJson(request, 2048));
    if (!attachment) return clientAttachmentRefusal(400, "invalid_client_attachment");
    const caller = this.#clientContext(services, attachment);
    return caller instanceof Response ? caller : new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  async #authorizeCodexTurn(services: InstallationCoreServices, request: Request): Promise<Response> {
    const { threadPlacements, codexServerId, codexCreation, spaces } = services;
    const missing = () => fetchResponse(installationExchangeReply(MISSING));
    if (!services.codexTurns || !threadPlacements || !codexCreation || !spaces) return missing();
    const body = await this.#privateJson(request, 8192) as { attachment?: unknown; threadId?: unknown } | null;
    const attachment = parseClientAttachment(body?.attachment);
    const thread = parseThreadPlacementKey({ serverId: codexServerId, threadId: body?.threadId });
    if (!attachment || !thread) return missing();

    // Read permission is only a prerequisite. A Turn needs the current
    // human creator's execution standing in the committed workspace.
    const allowed = () => {
      const context = this.#clientContext(services, attachment);
      if (context instanceof Response || !services.actorStore.allows(context, "execution.delegate")) return null;
      const policy = spaces.threadAccess.readablePolicy(thread.serverId, thread.threadId, context);
      return policy && policy.revision > 0 && policy.creatorActorId === context.actorId ? context : null;
    };
    try {
      if (!allowed()) return missing();
      const placement = await threadPlacements.lookup(thread);
      if (!placement || !(await codexWorkspaceTarget(codexCreation, attachment.actorId, placement.workspaceId))) return missing();
      const context = allowed();
      const login = context && services.admission.humanAccounts?.byDigest(attachment.loginDigest);
      if (!context || !login) return missing();
      return Response.json({
        placement,
        principal: {
          provider: login.principal.provider,
          subject: login.principal.subject,
          actorId: context.actorId,
          actorGeneration: context.generation,
        },
      }, { headers: { "cache-control": "no-store" } });
    } catch {
      return clientAttachmentRefusal(503, "turn_authorization_unavailable");
    }
  }

  #canStartCodex(services: InstallationCoreServices, attachment: ClientAttachment): ActorContext | null {
    const context = this.#clientContext(services, attachment);
    if (context instanceof Response || !services.spaces?.serverSpaces.hasMember(context.actorId, CODEX_START_SPACE))
      return null;
    return context;
  }

  async #authorizeTerminal(services: InstallationCoreServices, request: Request): Promise<Response> {
    const { codexCreation, codexServerId, threadPlacements } = services;
    const missing = () => fetchResponse(installationExchangeReply(MISSING));
    if (!services.codexTurns || !codexCreation?.isolateActors || !threadPlacements) return missing();
    const body = await this.#privateJson(request, 8192) as {
      attachment?: unknown; workspace?: unknown; threadId?: unknown; draftScopeId?: unknown;
    } | null;
    const attachment = parseClientAttachment(body?.attachment);
    if (!attachment) return missing();
    const explicit = body?.threadId == null ? null : parseThreadPlacementKey({
      serverId: codexServerId, threadId: body.threadId,
    });
    const draftScopeId = body?.draftScopeId;
    if ((body?.threadId != null && (!explicit || typeof body.workspace !== "string")) ||
      (draftScopeId != null && (!isTerminalResourceScopeId(draftScopeId) || explicit || typeof body?.workspace !== "string")))
      return missing();
    const allowed = (threadId?: string | null) => {
      const context = this.#canStartCodex(services, attachment);
      return !!context && services.actorStore.allows(context, "execution.delegate") &&
        (!threadId || !!this.#codexThreadExecutionPolicy(services, attachment, threadId));
    };
    try {
      const context = this.#clientContext(services, attachment);
      if (context instanceof Response) return missing();
      if (body?.workspace === undefined) await this.#bootstrapCodexSpace(services, attachment, context);
      if (!allowed()) return missing();
      const target = await codexWorkspaceTarget(codexCreation, context.actorId);
      if (!target?.ownerActorId || !allowed()) return missing();
      if (body?.workspace === undefined) {
        if (!(await this.#openCodexWorkspace(codexCreation, target)) || !allowed()) return missing();
        return Response.json({ workspace: target.workspace }, { headers: { "cache-control": "no-store" } });
      }
      if (body.workspace !== target.workspace) return missing();
      const threadId = explicit?.threadId ?? (draftScopeId == null ? null :
        await codexCreation.draftScopes.threadForDraft(target.workspace, draftScopeId));
      if (!allowed(threadId)) return missing();
      if (threadId !== null &&
        (await threadPlacements.lookup({ serverId: codexServerId, threadId }))?.workspaceId !== target.workspace) return missing();
      if (!allowed(threadId)) return missing();
      const reply = (status: number) => Response.json({ threadId }, { status, headers: { "cache-control": "no-store" } });
      if (threadId !== null) {
        try { services.codexResources?.assertActive(CODEX_WORKBENCH_HOST_ID, threadId); }
        catch { return reply(409); }
      }
      return reply(200);
    } catch {
      return clientAttachmentRefusal(503, "terminal_authorization_unavailable");
    }
  }

  async #observeCodexResources(services: InstallationCoreServices, request: Request): Promise<Response> {
    const missing = () => fetchResponse(installationExchangeReply(MISSING));
    const { codexResources, threadPlacements, codexServerId } = services;
    if (!codexResources || !threadPlacements) return missing();
    const observation = parseThreadResourceObservation(await this.#privateJson(request, 8192));
    if (!observation || observation.placement.serverId !== codexServerId ||
      !isCodexActorWorkspace(observation.placement.workspaceId)) return missing();
    const { placement: receipt, state } = observation;
    try {
      const committed = await threadPlacements.lookup(receipt);
      if (!committed || !sameThreadPlacement(committed, receipt)) return missing();
      await codexResources.observe(CODEX_WORKBENCH_HOST_ID, receipt.threadId, state);
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    } catch {
      return clientAttachmentRefusal(503, "thread_resources_unavailable");
    }
  }

  #codexThreadExecutionPolicy(services: InstallationCoreServices, attachment: ClientAttachment, threadId: string) {
    const { spaces, codexServerId } = services;
    if (!services.codexTurns || !spaces) return null;
    const context = this.#clientContext(services, attachment);
    if (context instanceof Response || !services.actorStore.allows(context, "execution.delegate")) return null;
    const policy = spaces.threadAccess.readablePolicy(codexServerId, threadId, context);
    if (!policy?.revision || policy.creatorActorId !== context.actorId) return null;
    return { context, policyRevision: policy.revision, accessMode: policy.accessMode,
      spaceId: spaces.serverSpaces.spaceFor(codexServerId, threadId) };
  }

  #currentCodexCreation(services: InstallationCoreServices, attachment: ClientAttachment, source?: CodexForkSource) {
    if (!source) return this.#canStartCodex(services, attachment);
    if (source.placement.serverId !== services.codexServerId) return null;
    const policy = this.#codexThreadExecutionPolicy(services, attachment, source.placement.threadId);
    return policy?.policyRevision === source.policyRevision && policy.spaceId === source.spaceId &&
      policy.accessMode === source.accessMode ? policy.context : null;
  }

  async #authorizeCodexStart(services: InstallationCoreServices, request: Request): Promise<Response> {
    const creation = services.codexCreation;
    const call = parseCodexStartAuthority(await this.#privateJson(request, CODEX_THREAD_START_BODY_BYTES));
    const target = creation && call && await codexWorkspaceTarget(creation, call.attachment.actorId, call.source?.placement.workspaceId);
    if (
      !creation || !call ||
      target?.workspace !== call.workspace ||
      (call.options.projectId !== undefined && (!creation.projects || !target.ownerActorId)) ||
      (call.options.draftScopeId !== undefined && !target.ownerActorId) ||
      await codexStartOperation(call.attachment, call.requestId, call.options) !== call.operation ||
      !matchesCodexStartPin(await creation.operations.read(call.operation), call.workspace, call.options, call.source) ||
      (call.source && !(await services.threadPlacements?.matchesPublished(call.source.placement))) ||
      !this.#currentCodexCreation(services, call.attachment, call.source)
    ) return fetchResponse(installationExchangeReply(MISSING));
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  async #bootstrapCodexSpace(services: InstallationCoreServices, attachment: ClientAttachment, context: ActorContext) {
    const spaces = services.spaces?.serverSpaces;
    if (!spaces || spaces.initialized) return;
    const login = services.admission.humanAccounts?.byDigest(attachment.loginDigest);
    // Match the Node session's installer-owned bootstrap of the default Space.
    if (login && services.instanceAccess.role(login.principal) === "admin") await spaces.bootstrap(context.actorId);
  }

  async #openCodexWorkspace(creation: NonNullable<InstallationCoreServices["codexCreation"]>, target: CodexWorkspaceTarget) {
    const { machine, hosts } = creation;
    const { workspace } = target;
    const host = hosts.get(hosts.idFromName(workspaceHostObjectName(workspace)));
    const send = (path: string, body: unknown) => host.fetch(new Request(
      `https://workspace.invalid${WORKSPACE_HOST_OBJECT_PREFIX}${path}`,
      { method: "POST", headers: { "content-type": "application/json", [WORKSPACE_HOST_HEADER]: workspace }, body: JSON.stringify(body) },
    ));
    const opened = await send("open", { ...target, machine });
    await opened.body?.cancel();
    return opened.ok ? send : null;
  }

  async #codexModelList(services: InstallationCoreServices, request: Request): Promise<Response> {
    const missing = () => fetchResponse(installationExchangeReply(MISSING));
    const creation = services.codexCreation;
    if (!creation || !services.codexTurns) return missing();
    const value = await this.#privateJson(request, 8192) as { attachment?: unknown; params?: unknown } | null;
    const attachment = parseClientAttachment(value?.attachment);
    const params = parseCodexModelList(value?.params);
    if (!attachment || !params) return clientAttachmentRefusal(400, "invalid_model_list");
    const context = this.#clientContext(services, attachment);
    if (context instanceof Response) return context;
    try {
      await this.#bootstrapCodexSpace(services, attachment, context);
      if (!this.#canStartCodex(services, attachment)) return missing();
      const target = await codexWorkspaceTarget(creation, context.actorId);
      if (!target) return missing();
      const host = await this.#openCodexWorkspace(creation, target);
      if (!host) return clientAttachmentRefusal(503, "workspace_unavailable");
      if (!this.#canStartCodex(services, attachment)) return missing();
      const response = await host(WORKSPACE_CODEX_MODEL_LIST_OPERATION, params);
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 400) return clientAttachmentRefusal(400, "invalid_model_list");
        throw new Error("Workspace model catalog unavailable");
      }
      const result: unknown = await response.json();
      if (!isCodexModelList(result)) throw new Error("Invalid model catalog");
      if (!this.#canStartCodex(services, attachment)) return missing();
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    } catch {
      return clientAttachmentRefusal(503, "model_list_unavailable");
    }
  }

  async #codexThreadList(services: InstallationCoreServices, request: Request): Promise<Response> {
    const { codexCreation: creation, threadPlacements: placements, codexServerId, spaces } = services;
    if (!creation || !placements || !spaces) return fetchResponse(installationExchangeReply(MISSING));
    const body = await this.#privateJson(request, 8192) as { attachment?: unknown; params?: unknown } | null;
    const attachment = parseClientAttachment(body?.attachment);
    const params = parseCodexThreadList(body?.params);
    const invalid = () => clientAttachmentRefusal(400, "invalid_thread_list");
    if (!attachment || !params) return invalid();
    const caller = this.#clientContext(services, attachment);
    if (caller instanceof Response) return caller;
    const reply = (page: ThreadListResponse) => Response.json(page, { headers: { "cache-control": "no-store" } });
    try {
      if (!spaces.serverSpaces.initialized || (creation.isolateActors && !this.#canStartCodex(services, attachment)))
        return reply({ data: [], nextCursor: null, backwardsCursor: null });
      const target = await codexWorkspaceTarget(creation, caller.actorId);
      if (!target) return fetchResponse(installationExchangeReply(MISSING));
      const { workspace } = target;
      const sealer = await codexThreadCursorSealer(creation.directory);
      const scope = (direction: "asc" | "desc") => JSON.stringify([
        "codex-thread-list", codexServerId, workspace, attachment.loginDigest, attachment.actorId, attachment.actorGeneration,
        params.sortKey, direction, params.archived, params.searchTerm, params.useStateDbOnly,
      ]);
      let cursor = params.cursor === null ? null : openCodexThreadCursor(params.cursor, sealer, scope(params.sortDirection));
      if (params.cursor !== null && cursor === null) return invalid();
      const host = await this.#openCodexWorkspace(creation, target);
      if (!host) throw new Error("Workspace Thread directory unavailable");
      const data: ThreadListResponse["data"] = [];
      let backwards: string | null = null;
      const seenCursors = new Set(cursor === null ? [] : [cursor]);
      for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
        const viewer = this.#clientContext(services, attachment);
        if (viewer instanceof Response) return viewer;
        const limit = params.limit - data.length;
        const response = await host(WORKSPACE_CODEX_THREAD_LIST_OPERATION, { ...params, cursor, limit });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 400) return invalid();
          throw new Error("Workspace Thread directory unavailable");
        }
        const page = parseCodexThreadPage(await response.json());
        if (!page || page.data.length > limit) throw new Error("Invalid workspace Thread directory");
        const visible = await Promise.all(page.data.map(async value => {
          const entry = value as { thread?: unknown; placement?: unknown } | null;
          const thread = threadCatalogEntry(entry?.thread);
          const placement = parseThreadPlacementReceipt(entry?.placement);
          if (!thread || placement?.workspaceId !== workspace || placement.serverId !== codexServerId ||
            placement.threadId !== thread.id) throw new Error("Invalid directory placement");
          if (!placements.authority.allows(viewer, placement) || !(await placements.matchesPublished(placement))) return null;
          return thread;
        }));
        const rows = visible.filter(thread => thread !== null);
        if (data.length === 0 && rows.length > 0) backwards = page.backwardsCursor;
        data.push(...rows);
        cursor = page.nextCursor;
        if (cursor === null) break;
        if (seenCursors.has(cursor)) throw new Error("Native Thread cursor did not advance");
        if (data.length >= params.limit) break;
        seenCursors.add(cursor);
      }
      const opposite = params.sortDirection === "asc" ? "desc" : "asc";
      const latest = this.#clientContext(services, attachment);
      if (latest instanceof Response) return latest;
      const readable = data.filter(thread => placements.authority.allows(latest, { serverId: codexServerId, threadId: thread.id }));
      return reply({
        data: readable, nextCursor: cursor ? sealer.seal(scope(params.sortDirection), cursor) : null,
        backwardsCursor: backwards && readable.length > 0 ? sealer.seal(scope(opposite), backwards) : null,
      });
    } catch {
      return clientAttachmentRefusal(503, "thread_list_unavailable");
    }
  }

  async #startCodexThread(services: InstallationCoreServices, request: Request): Promise<Response> {
    const { codexCreation: creation, threadPlacements, spaces } = services;
    if (!creation || !threadPlacements || !spaces) return fetchResponse(installationExchangeReply(MISSING));
    const call = parseCodexStartRequest(await this.#privateJson(request, CODEX_THREAD_START_BODY_BYTES));
    if (!call) return clientAttachmentRefusal(400, "invalid_thread_start");
    const context = this.#clientContext(services, call.attachment);
    if (context instanceof Response) return context;
    try {
      let source: CodexForkSource | undefined;
      if (call.options.fork) {
        const { threadId } = call.options.fork;
        const policy = this.#codexThreadExecutionPolicy(services, call.attachment, threadId);
        if (!policy) return fetchResponse(installationExchangeReply(MISSING));
        const placement = await threadPlacements.lookup({ serverId: services.codexServerId, threadId });
        if (!placement) return fetchResponse(installationExchangeReply(MISSING));
        const { policyRevision, accessMode, spaceId } = policy;
        source = { placement, policyRevision, accessMode, spaceId };
      } else await this.#bootstrapCodexSpace(services, call.attachment, context);

      const target = await codexWorkspaceTarget(creation, context.actorId, source?.placement.workspaceId);
      if (!target || (call.options.draftScopeId !== undefined && !target.ownerActorId) ||
        (call.options.projectId !== undefined && (!creation.projects || !target.ownerActorId)))
        return fetchResponse(installationExchangeReply(MISSING));
      const { workspace } = target;
      const current = () => this.#currentCodexCreation(services, call.attachment, source);
      if (!current()) return fetchResponse(installationExchangeReply(MISSING));
      const operation = await codexStartOperation(call.attachment, call.requestId, call.options);
      // Pin this exact browser request across retries and configuration changes.
      const pinned = await creation.operations.update(operation, (previous) => previous === null
        ? { result: true, next: codexStartPin(workspace, call.options, source) }
        : { result: matchesCodexStartPin(previous, workspace, call.options, source) });
      if (!pinned) return clientAttachmentRefusal(409, "thread_start_outcome_unknown");
      if (!current()) return fetchResponse(installationExchangeReply(MISSING));

      const host = await this.#openCodexWorkspace(creation, target);
      if (!host) return clientAttachmentRefusal(503, "workspace_unavailable");
      const started = await host(WORKSPACE_CODEX_START_OPERATION, { ...call, operation, workspace, source });
      if (!started.ok) return started;
      const receipt = await started.json() as { result?: unknown; placement?: unknown } | null;
      const result = receipt?.result;
      const placement = parseThreadPlacementReceipt(receipt?.placement);
      const threadId = createdCodexThreadId(result, call.options.fork?.threadId);
      if (!threadId || placement?.state !== "placed" || placement.threadId !== threadId ||
        placement.serverId !== services.codexServerId || placement.workspaceId !== workspace)
        return clientAttachmentRefusal(409, "thread_start_outcome_unknown");
      const { serverId } = placement;
      const published = await threadPlacements.publish(placement);
      if (published !== "applied" && published !== "unchanged")
        return clientAttachmentRefusal(409, "thread_start_outcome_unknown");

      const authorized = current();
      if (!authorized) return fetchResponse(installationExchangeReply(MISSING));
      const spacesRuntime = spaces.serverSpaces;
      const spaceId = source?.spaceId ?? CODEX_START_SPACE;
      const assigned = spacesRuntime.hasAssignment(serverId, threadId);
      if (assigned && spacesRuntime.spaceFor(serverId, threadId) !== spaceId)
        return clientAttachmentRefusal(409, "thread_start_outcome_unknown");
      const policy = spaces.threadAccess.read(serverId, threadId);
      // Commit private custody before Space membership can make the child readable.
      if (policy.revision === 0) spaces.threadAccess.created(serverId, threadId, authorized, source?.accessMode);
      else if (policy.creatorActorId !== authorized.actorId || (source && policy.accessMode !== source.accessMode))
        return clientAttachmentRefusal(409, "thread_start_outcome_unknown");
      if (!assigned) await spacesRuntime.assign(authorized, serverId, threadId, spaceId);
      const latest = current();
      if (!latest) return fetchResponse(installationExchangeReply(MISSING));
      const readable = spaces.threadAccess.readablePolicy(serverId, threadId, latest);
      if (!readable?.revision || readable.creatorActorId !== latest.actorId)
        return clientAttachmentRefusal(409, "thread_start_outcome_unknown");
      if (call.options.draftScopeId !== undefined)
        await creation.draftScopes.bind(workspace, call.options.draftScopeId, threadId);
      await this.ctx.storage.sync();
      if (!current()) return fetchResponse(installationExchangeReply(MISSING));
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    } catch {
      return clientAttachmentRefusal(409, "thread_start_outcome_unknown");
    }
  }

  async #publishThreadPlacement(projection: ThreadPlacementProjection, request: Request): Promise<Response> {
    const receipt = parseThreadPlacementReceipt(await this.#privateJson(request, 65_536));
    if (!receipt) return clientAttachmentRefusal(400, "invalid_thread_placement");
    try {
      const result = await projection.publish(receipt);
      if (result === "unconfirmed") return clientAttachmentRefusal(409, "placement_not_confirmed");
      if (result === "conflict") return clientAttachmentRefusal(409, "placement_conflict");
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    } catch {
      return clientAttachmentRefusal(503, "placement_unavailable");
    }
  }

  async #lookupThreadPlacement(
    services: InstallationCoreServices,
    projection: ThreadPlacementProjection,
    request: Request,
  ): Promise<Response> {
    const query = await this.#privateJson(request, 65_536) as { thread?: unknown; attachment?: unknown } | null;
    const thread = parseThreadPlacementKey(query?.thread);
    const attachment = parseClientAttachment(query?.attachment);
    if (!thread || !attachment) return clientAttachmentRefusal(400, "invalid_thread_placement_lookup");
    return this.#authorizedThreadPlacement(services, projection, thread, attachment);
  }

  async #authorizedThreadPlacement(
    services: InstallationCoreServices,
    projection: ThreadPlacementProjection,
    thread: ThreadPlacementKey,
    attachment: ClientAttachment,
    archiveState = false,
  ): Promise<Response> {
    const caller = this.#clientContext(services, attachment);
    if (caller instanceof Response) return caller;
    try {
      if (!projection.authority.allows(caller, thread)) return fetchResponse(installationExchangeReply(MISSING));
      const placement = await projection.lookup(thread);
      if (!placement) return fetchResponse(installationExchangeReply(MISSING));
      // A WorkspaceHost RPC may yield across logout or membership revocation.
      const current = this.#clientContext(services, attachment);
      if (current instanceof Response) return current;
      if (!projection.authority.allows(current, thread)) return fetchResponse(installationExchangeReply(MISSING));
      let archived: boolean | undefined;
      if (archiveState && services.codexResources && isCodexActorWorkspace(placement.workspaceId)) {
        // This workspace routes lifecycle writes through the journal. A
        // placed Thread with no archive observation has its initial state.
        const state = services.codexResources.observedState(CODEX_WORKBENCH_HOST_ID, thread.threadId);
        if (state === "deleted") return fetchResponse(installationExchangeReply(MISSING));
        archived = state === "archived";
      }
      return Response.json(archived === undefined ? placement : { ...placement, archived }, { headers: { "cache-control": "no-store" } });
    } catch {
      return clientAttachmentRefusal(503, "placement_unavailable");
    }
  }

  /**
   * The account authority exchange (account-routes.ts): the installation's
   * gate, or the account authority, for a request the account's object is
   * serving, decided by the same functions the Node gateway calls beside its services.
   */
  async #accountAuthority(services: InstallationCoreServices, request: Request): Promise<Response> {
    let query;
    try {
      query = parseAccountAuthorityQuery(await request.json());
    } catch {
      return Response.json({ error: "invalid_account_authority_query" }, { status: 400 });
    }
    const view = accountAuthorityRequestView(query) as unknown as IdentityRequestView;
    let answer: AccountAuthorityAnswer;
    if (query.scope === "gate") {
      const pathname = new URL(query.path, "http://installation.invalid").pathname;
      if (!isHealthPath(pathname)) await services.instanceAccess.prepare(view);
      answer = { scope: "gate", refusal: installationGate(view, pathname, query.headers.accept, this.#gate(services)) };
    } else {
      const authorities = installationAccountAuthorities<IdentityRequestView>({
        actorAccess: services.actorAccess,
        actorStore: services.actorStore,
        instanceAccess: services.instanceAccess,
      });
      answer = { scope: query.scope, authority: authorities[query.scope](view) };
    }
    return Response.json(answer, { headers: { "cache-control": "no-store" } });
  }

  async #route(
    services: InstallationCoreServices,
    exchange: HttpExchangeRequest<FetchRequestView>,
  ): Promise<HttpExchangeResponse | null> {
    const { admission, instanceAccess, actorAccess } = services;
    const pathname = new URL(exchange.path, "http://installation.invalid").pathname;
    const request = exchange.identity as unknown as IdentityRequestView;
    const auth = admission.humanAuth;
    if (!isHealthPath(pathname)) await instanceAccess.prepare(request);
    const identityExchange = exchange as unknown as HttpExchangeRequest<IdentityRequestView>;
    const routed = await serveInstallationRoute<IdentityRequestView>(
      {
        account: admission.accountApplication && ((value) => admission.accountApplication!.handle(value)),
        auth: auth && ((value) => auth.handle(value)),
        actorCollaboration: (value) => services.actorCollaborationApi.handle(value),
        actors: (value) => actorAccess.handle(value),
        serverInformation: services.serverInformationService,
        modelDefaults: services.personalServices.accountModelDefaultsService,
        threadReads: services.personalServices.threadReadReceiptsService,
      },
      identityExchange,
      pathname,
    );
    if (routed) return routed;
    const refusal = installationGate(request, pathname, exchange.headers.accept, this.#gate(services));
    if (refusal) return installationExchangeReply(refusal);
    if (pathname.startsWith(INSTANCE_ACCESS_PREFIX)) return instanceAccess.handle(identityExchange);
    return null;
  }
}
