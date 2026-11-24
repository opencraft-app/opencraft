// The InstallationCore Durable Object (docs/architecture/platform/cloudflare-deployment.md §5):
// one SQLite-backed object per deployment owns the Server core SQL and serves
// the installation's identity and admission over the HTTP exchange port.
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
// composition and login admission (downstream products), and the
// collaboration and deployment-level services (follow-up steps).
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import { durableObjectStateDocumentStore } from "@opencraft/storage-cloudflare/state";
import { migrateServerSqlDatabase } from "@opencraft/storage-node/server-sql";
import { sameThreadCommitFence } from "@opencraft/access-control/commit-fence";
import { stateLoginAttemptLimiter } from "@opencraft/identity-core/login-attempts";
import { createPortablePasswordHasher } from "@opencraft/plugin-local-account/password-hash-portable";
import { serveFetchHttpExchange, fetchResponse, type FetchRequestView } from "@opencraft/http-exchange/fetch";
import type { HttpExchangeRequest, HttpExchangeResponse } from "@opencraft/http-exchange";
import { mergedOwnerWake, type OwnerWake } from "@opencraft/owner-wake";
import { assembleInstallation, type InstallationAssembly } from "../assembly/installation.mjs";
import { documentRootInputs } from "../assembly/root-inputs.js";
import { sameThreadServerCore, type SameThreadServerCore } from "../assembly/server-core-same-thread.js";
import {
  INSTANCE_ACCESS_PREFIX,
  MISSING,
  installationExchangeReply,
  installationGate,
  isHealthPath,
  serveInstallationRoute,
} from "../installation-routes.js";
import type { InstallationCoreEnv, InstallationCoreState } from "./bindings.js";

type Admission = Awaited<ReturnType<InstallationAssembly["openAdmission"]>>;
type IdentityRequestView = Parameters<NonNullable<Admission["instanceAccess"]>["authenticate"]>[0];

/** What the object serves once it opened. */
export interface InstallationCoreServices {
  readonly installation: InstallationAssembly;
  readonly core: SameThreadServerCore;
  readonly admission: Admission;
  readonly instanceAccess: NonNullable<Admission["instanceAccess"]>;
  readonly actorAccess: ReturnType<InstallationAssembly["openActorAccess"]>;
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
    const rootInputs = documentRootInputs({
      documents: durableObjectStateDocumentStore(storage, { prefix: "installation/" }),
      humanAuthConfiguration: configuration("Human login", env.OPENCRAFT_HUMAN_AUTH),
      machine: {
        ...(env.OPENCRAFT_MACHINE_NAME === undefined ? {} : { name: env.OPENCRAFT_MACHINE_NAME }),
        defaultName: "OpenCraft",
        platform: "linux",
      },
    });
    const fence = sameThreadCommitFence();
    const core = sameThreadServerCore(handle, { identityFence: fence });
    const installation = assembleInstallation({
      serverStorage: core,
      identityFence: fence,
      // No identity composition qualifies external principals here.
      isHuman: () => undefined,
      ownerWake: mergedOwnerWake(this.#alarmWake()),
    });
    // The named disposers in the Node root's shutdown order (step 11), then the core owner.
    this.#disposers = [
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
    await installation.openIdentity({
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
    return { installation, core, admission, instanceAccess: admission.instanceAccess, actorAccess };
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
  }

  /** The installation's front door: its HTTP routes and admission gate, as the Node gateway serves them. */
  async fetch(request: Request): Promise<Response> {
    if (!this.#services)
      return fetchResponse(
        installationExchangeReply({ kind: "json", status: 503, value: { error: "installation_unavailable" } }),
      );
    const services = this.#services;
    // The deployment's edge sets CF-Connecting-IP; the composition, not the adapter, chooses to trust it.
    const response = await serveFetchHttpExchange(request, (exchange) => this.#route(services, exchange), {
      clientAddress: request.headers.get("cf-connecting-ip"),
    });
    return response ?? fetchResponse(installationExchangeReply(MISSING));
  }

  async #route(
    { admission, instanceAccess, actorAccess }: InstallationCoreServices,
    exchange: HttpExchangeRequest<FetchRequestView>,
  ): Promise<HttpExchangeResponse | null> {
    const pathname = new URL(exchange.path, "http://installation.invalid").pathname;
    const request = exchange.identity as unknown as IdentityRequestView;
    const auth = admission.humanAuth;
    if (!isHealthPath(pathname)) await instanceAccess.prepare(request);
    const identityExchange = exchange as unknown as HttpExchangeRequest<IdentityRequestView>;
    const routed = await serveInstallationRoute<IdentityRequestView>(
      {
        account: admission.accountApplication && ((value) => admission.accountApplication!.handle(value)),
        auth: auth && ((value) => auth.handle(value)),
        actors: (value) => actorAccess.handle(value),
      },
      identityExchange,
      pathname,
    );
    if (routed) return routed;
    const refusal = installationGate(request, pathname, exchange.headers.accept, {
      sessionRequest: (value) => actorAccess.isSessionRequest(value),
      admission: (value) => (auth?.invalidSession(value) ? 401 : instanceAccess.admissionStatus(value)),
      legacyAdmission: (value) => actorAccess.legacyAdmissionStatus(value),
      login: !!auth,
    });
    if (refusal) return installationExchangeReply(refusal);
    if (pathname.startsWith(INSTANCE_ACCESS_PREFIX)) return instanceAccess.handle(identityExchange);
    return null;
  }
}
