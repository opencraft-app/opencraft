// The AccountCore Durable Object (docs/architecture/platform/cloudflare-deployment.md §5.6):
// one SQLite-backed object per deployment owns the model usage policy, model
// configuration and sealed model credentials, and the short-lived credential
// leases a forwarder redeems for one provider request.
//
// This is a composition root, not a second implementation: the object
// migrates its SQL with the policy's slim lifecycle and calls the same account
// module (`assembly/account.mjs`) the Node root calls, with runtime-neutral
// inputs in place of the Node ones:
//   policy database     the object's SQL (Node: model-usage-policy.sqlite through openManagedDatabase)
//   configuration       the object's state documents, `models/` (Node: $DATA/models/*.json, 0600)
//   credentials         sealed (AES-256-GCM) under a Secrets binding key, in the object's state
//                       (Node: the private credentials.json file)
//   route authority     asked of the InstallationCore object per request (Node: the installation's
//                       services in the same process), answered by the same function
//   account pool        the same AccountPool, renewal manager and renewal schedule as the Node
//                       Codex Core composes, over two further migration chains in the object's SQL
//                       (`schema_family_migrations`, `@opencraft/sql/families`), credential records sealed synchronously in the same SQL,
//                       renewals through the maintenance executor's fetch binding and the schedule
//                       on the object's alarm (Node: account-pool.sqlite, private files, a native
//                       codex maintenance process and runtime timeouts)
//   model gateway       the same store and route over a further named chain (`model-gateway`) of the
//                       object's SQL, contributions over the object's model configuration and sealed
//                       credentials, the route's authority asked of the InstallationCore object (Node:
//                       OPENCRAFT_MODEL_GATEWAY_DATABASE, the `models/` files, the installation's services)
//   personal            the Human's accounts in this object's account pool (Node: the Codex Core over its
//   subscriptions       control socket); device login and the subscription route are not assembled
// Not assembled here: speech, device login and the Codex selection egress (cloudflare-deployment §5.6 "仍缺").
import { createHash } from "node:crypto";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import { durableObjectStateDocumentStore } from "@opencraft/storage-cloudflare/state";
import { durableObjectSecretStore } from "@opencraft/storage-cloudflare/secrets";
import { importSecretSealingKey, sealedSecretStore } from "@opencraft/secret-storage/sealed";
import { recordSealer } from "@opencraft/secret-storage/sealed-records";
import { migrateModelPolicySqlDatabase } from "@opencraft/model-usage-policy/sql-owner";
import { MIGRATION_FAMILY_LEDGER_TABLE, applySqlMigrationFamilies, isMigrationLedgerObject } from "@opencraft/sql/families";
import { hashSqlMigrations } from "@opencraft/sql/migrations";
import { openAccountPoolSqlStorage, ownedByAccountPoolSchemas } from "@opencraft/account-pool-host/sql-owner";
import { AccountEnvironment } from "@opencraft/execution-environment/account-environment";
import {
  EMPLOYEE_GIT_VAULT_MIGRATIONS,
  EmployeeGitVault,
} from "@opencraft/execution-environment/employee-git-vault";
import { aes256GcmGitVaultCipher, deriveGitVaultKey } from "@opencraft/execution-environment/git-vault-cipher";
import { SandboxConfigurationError, SandboxConfigurations } from "@opencraft/plugin-assets/server/configurations";
import { createAssetsHttpExchange } from "@opencraft/plugin-assets/server/exchange";
import { GitConnections, describeGitProviders } from "@opencraft/plugin-assets/server/git-connections";
import { githubConnectionProvider } from "@opencraft/plugin-assets/server/github-provider";
import { ModelGatewayStore } from "@opencraft/account-pool-host/model-gateway";
import {
  accountPoolPersonalSubscriptions,
  type PersonalSubscriptionRoute,
} from "@opencraft/account-pool-host/personal-subscriptions";
import { assembleAccountPoolCore, type AccountPoolCore } from "@opencraft/account-pool-host/pool-core";
import { AccountPool } from "@opencraft/account-pool-host/account-pool";
import { fetchAccountRenewal } from "@opencraft/account-pool-host/renewal";
import { serveCredentialLeaseExchange } from "@opencraft/account-pool-host/credential-lease-exchange";
import { codexModelMetadata } from "@opencraft/account-pool-host/codex-model-catalog";
import type { ModelListResponse } from "@opencraft/appserver-protocol";
import { mergedOwnerWake, type OwnerWake } from "@opencraft/owner-wake";
import {
  fetchRequestView,
  fetchResponse,
  serveFetchHttpExchange,
  type FetchRequestView,
} from "@opencraft/http-exchange/fetch";
import type { HttpExchangeHandler } from "@opencraft/http-exchange";
import { assembleAccount, type AccountAssembly } from "../assembly/account.mjs";
import {
  ACCOUNT_AUTHORITY_PATH,
  WORKSPACE_ASSETS_ENVIRONMENT_PATH,
  WORKSPACE_CODEX_CATALOG_PATH,
  WORKSPACE_CODEX_MODEL_DIRECTORY_PATH,
  accountRoute,
  parseAccountAuthorityAnswer,
  type AccountAuthorityAnswer,
  type AccountAuthorityQuery,
  type AccountAuthorityScope,
} from "../account-routes.js";
import { parseCodexModelList } from "./codex-model-list.js";
import { MISSING, installationExchangeReply } from "../installation-routes.js";
import type { AccountCoreEnv, AccountCoreState } from "./bindings.js";
import { bootstrapAccountModels } from "./account-model-bootstrap.js";

/** The deployment's single object name. */
export const ACCOUNT_CORE_OBJECT = "account";
/** The installation's object, as the account addresses it (installation-core.ts INSTALLATION_CORE_OBJECT). */
const INSTALLATION_OBJECT = "installation";

/** What the object serves once it opened. */
export interface AccountCoreServices {
  readonly account: AccountAssembly;
  /** The account pool: selection, affinity and renewal; this object is their only writer. */
  readonly pool: AccountPoolCore;
  /** One Human's accounts (`ownerActor`) in the same pool storage; personal subscriptions read them. */
  personalPool(actor: string): AccountPool;
  /** The model gateway's store: admission, limits, contributions and metering; this object is its only writer. */
  readonly gateway: ModelGatewayStore;
  /** The credential lease exchange for bound callers; resolves null for any other path. */
  readonly leaseExchange: (request: Request) => Promise<Response | null>;
  readonly http: HttpExchangeHandler<FetchRequestView>;
  readonly assetsHttp: HttpExchangeHandler<unknown>;
  readonly accountEnvironment: AccountEnvironment;
  /** Asks the installation about one request; resolves its answer or the installation's own refusal. */
  ask(scope: AccountAuthorityScope, request: FetchRequestView): Promise<AccountAuthorityAnswer | Response>;
}

const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export class AccountCore {
  protected readonly ctx: AccountCoreState;
  #services: AccountCoreServices | undefined;
  #failure: unknown;
  #closing: Promise<void> | undefined;
  #disposers: (() => unknown)[] = [];
  #wake: (() => void) | null = null;

  constructor(ctx: AccountCoreState, env: AccountCoreEnv) {
    this.ctx = ctx;
    // Migration and assembly finish before any request is delivered. A refused
    // open (a missing or malformed sealing key, a foreign or changed policy
    // history) keeps the object closed: every request answers 503.
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

  async #open(env: AccountCoreEnv): Promise<AccountCoreServices> {
    const storage = this.ctx.storage;
    // Credentials are never stored unsealed: no key, no object.
    const sealing = await importSecretSealingKey(env.OPENCRAFT_ACCOUNT_SEALING_KEY);
    const records = recordSealer(env.OPENCRAFT_ACCOUNT_SEALING_KEY);
    const database = durableObjectSqlDatabase(storage);
    // The policy keeps its main ledger. The account pool, sealed records and
    // model gateway use families in schema_family_migrations.
    const policy = migrateModelPolicySqlDatabase(database, {
      // workerd's own tables and the other chains' objects are not policy schema.
      ownedByRuntime: (name) =>
        name.startsWith("_cf_") ||
        isMigrationLedgerObject(name) ||
        ownedByAccountPoolSchemas(name) ||
        name === "schema_assets_migrations" ||
        name === "employee_git_credentials",
    });
    const poolStorage = openAccountPoolSqlStorage(database, records);
    applySqlMigrationFamilies(
      database,
      [{
        id: "employee-git-vault",
        migrations: hashSqlMigrations(EMPLOYEE_GIT_VAULT_MIGRATIONS, (sql) => createHash("sha256").update(sql).digest("hex")),
        owns: (name) => name === "employee_git_credentials",
      }],
      { table: "schema_assets_migrations", composition: "beside-main" },
    );
    const vaultCipher = aes256GcmGitVaultCipher(deriveGitVaultKey(env.OPENCRAFT_ACCOUNT_SEALING_KEY!));
    const vault = new EmployeeGitVault(database, vaultCipher);
    const assetConfigurations = new SandboxConfigurations(vault);
    const githubProvider = githubConnectionProvider();
    const assetGit = new GitConnections(vault, [githubProvider]);
    const accountEnvironment = new AccountEnvironment(vault);
    const gateway = new ModelGatewayStore(poolStorage.gateway);
    // A Human's pool is a view of the same storage (rows owned by that Human), built per use so it never holds
    // state the installation pool changed; it leaves affinity to the installation pool.
    const personalPool = (actor: string) =>
      new AccountPool(poolStorage, { ownerActor: actor, now: () => wake.now(), preserveAffinity: true });
    const route = this.personalSubscriptionRoute(env);
    const modelDocuments = durableObjectStateDocumentStore(storage, { prefix: "models/" });
    const account = assembleAccount({
      openModelPolicy: () => policy,
      modelDocuments,
      modelSecrets: sealedSecretStore(durableObjectSecretStore(storage), sealing),
      modelGateway: () => ({
        // The object owns its SQL; the account closing the store releases nothing.
        store: { store: () => gateway, close: () => gateway.close() },
        // Offered only where a route serves them; without one the route reports none, as Node without a Core.
        subscriptions: route ? accountPoolPersonalSubscriptions({ pool: personalPool, route }) : null,
      }),
    });
    this.#disposers = [() => vault.close(), () => account.close()];
    if (env.OPENCRAFT_ACCOUNT_MODEL_BOOTSTRAP !== undefined)
      await bootstrapAccountModels(env.OPENCRAFT_ACCOUNT_MODEL_BOOTSTRAP, modelDocuments, account);
    const maintenance = env.ACCOUNT_MAINTENANCE;
    const wake = mergedOwnerWake(this.#alarmWake());
    const pool = assembleAccountPoolCore({
      pool: new AccountPool(poolStorage, { now: () => wake.now() }),
      renew: maintenance
        ? fetchAccountRenewal(maintenance)
        : () => Promise.reject(new Error("Account maintenance executor is not configured")),
      wake,
    });
    // Renewals settle before the policy writer closes.
    this.#disposers.unshift(() => pool.close());
    const installationId = env.INSTALLATION_CORE.idFromName(INSTALLATION_OBJECT);
    const ask = async (scope: AccountAuthorityScope, request: FetchRequestView) => {
      const query: AccountAuthorityQuery = {
        scope,
        method: request.method,
        path: request.url,
        headers: Object.fromEntries(
          Object.entries(request.headers).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
      };
      // A stub per question: a stub to an object that was reset (evicted with an error, redeployed) stays broken.
      const response = await env.INSTALLATION_CORE.get(installationId).fetch(
        new Request(`https://installation.internal${ACCOUNT_AUTHORITY_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(query),
        }),
      );
      // The installation's own refusal (for example 503 while it is closed) is the answer.
      if (response.status !== 200) return response;
      return parseAccountAuthorityAnswer(scope, await response.json());
    };
    const http = account.createAccountHttpService<FetchRequestView>({
      // An installation that cannot answer grants nothing: the handler refuses as it does without authority.
      async policy(request) {
        const answer = await ask("policy", request);
        return !(answer instanceof Response) && answer.scope === "policy" ? answer.authority : null;
      },
      // The same question for the gateway, at each point the route asks it (before, after the body, during writes).
      async gateway(request) {
        const answer = await ask("gateway", request);
        return !(answer instanceof Response) && answer.scope === "gateway" ? answer.authority : null;
      },
    });
    const assetsHttp = createAssetsHttpExchange({
      async resolveIdentity(request) {
        const view = request.identity as FetchRequestView;
        const answer = await ask("gateway", view);
        if (answer instanceof Response || answer.scope !== "gateway" || !answer.authority) return null;
        const { actor, administrator, origin } = answer.authority;
        const resolvedOrigin = origin ?? (view.headers.host ? `https://${view.headers.host}` : "");
        return {
          scope: `actor:${actor}`,
          origin: resolvedOrigin,
          allowCustomEndpoints: administrator,
          canManagePlatform: administrator,
          current: () => true,
        };
      },
      gitHosts: [githubProvider.host],
      gitProviders: describeGitProviders([githubProvider]),
      environment: true,
      configurationsSnapshot: (id) =>
        Promise.resolve(assetConfigurations.snapshot(id.scope, id.allowCustomEndpoints, id.canManagePlatform)),
      configurationsUpdate: (id, input) =>
        Promise.resolve(assetConfigurations.update(id.scope, input, id.allowCustomEndpoints, id.canManagePlatform)),
      gitSnapshot: (id) => Promise.resolve(assetGit.snapshot(id.scope)),
      gitUpdate: (id, input) =>
        assetGit.update(id.scope, input, () => {
          if (!id.current()) throw new SandboxConfigurationError("forbidden", 403);
        }),
      environmentList: (id, scope, assertCurrent) =>
        Promise.resolve(accountEnvironment.list(id.scope, scope, assertCurrent)),
      environmentReplace: (id, scope, revision, input, assertCurrent) =>
        Promise.resolve(accountEnvironment.replace(id.scope, scope, revision, input, assertCurrent)),
      environmentProjects: async () => [],
    });
    return {
      account,
      pool,
      personalPool,
      gateway,
      http,
      assetsHttp,
      accountEnvironment,
      ask,
      leaseExchange: serveCredentialLeaseExchange(account.credentialLeases),
    };
  }

  /**
   * Where a Human's completed subscription sends its requests and reads its
   * models. The Codex selection egress does not exist yet (§5.6 "仍缺"), so a
   * deployment has none and completed subscriptions answer unavailable.
   */
  protected personalSubscriptionRoute(_env: AccountCoreEnv): PersonalSubscriptionRoute | null {
    return null;
  }

  async #configuredCodexCatalog(account: AccountAssembly, providerId: string) {
    const { revision, providers, defaultModel } = await account.modelConfiguration.read();
    const provider = providers.find((item) => item.id === providerId && item.enabled && item.protocol === "openai-responses");
    if (!provider) return null;
    const models = provider.models.filter((model) => model.enabled && model.type !== "asr").map((model) => {
      const isDefault = defaultModel?.providerId === providerId && defaultModel.modelId === model.id;
      return { ...codexModelMetadata(model.id, provider, model, isDefault ? defaultModel.reasoningEffort : undefined),
        priority: isDefault ? 0 : 1000 };
    });
    return { revision, models };
  }

  async #workspaceCodexCatalog(account: AccountAssembly, request: Request, url: URL) {
    const unavailable = () => fetchResponse(installationExchangeReply(MISSING));
    const token = /^Bearer (\S+)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
    const providerId = url.searchParams.get("provider");
    if (request.method !== "GET" || !token || !providerId) return unavailable();
    try {
      const { holder } = await account.credentialLeases.redeem(token, providerId);
      if (holder.engine !== "codex") return unavailable();
      const catalog = await this.#configuredCodexCatalog(account, providerId);
      return catalog ? Response.json({ models: catalog.models }, { headers: { "cache-control": "no-store" } }) : unavailable();
    } catch {
      return unavailable();
    }
  }

  /** Read-only binding route. WorkspaceHost admits the public caller before this projection. */
  async #workspaceCodexModelDirectory(account: AccountAssembly, request: Request, url: URL) {
    const provider = url.searchParams.get("provider");
    const missing = () => fetchResponse(installationExchangeReply(MISSING));
    if (!provider) return missing();
    if (request.method === "HEAD") {
      const model = url.searchParams.get("model");
      if (!model || model.length > 512) return missing();
      const catalog = await this.#configuredCodexCatalog(account, provider);
      return new Response(null, { status: catalog?.models.some(entry => entry.slug === model) ? 204 : 404,
        headers: { "cache-control": "no-store" } });
    }
    if (request.method !== "POST") return missing();
    const params = parseCodexModelList(await request.json().catch(() => null));
    const invalid = () => Response.json({ error: "invalid_model_list" }, { status: 400 });
    if (!params) return invalid();
    const catalog = await this.#configuredCodexCatalog(account, provider);
    if (!catalog) return missing();
    const { revision, models } = catalog;
    const prefix = `models/${revision}/${encodeURIComponent(provider)}/`;
    const cursor = params.cursor?.startsWith(prefix) ? params.cursor.slice(prefix.length) : "";
    const offset = params.cursor == null ? 0 : /^\d+$/u.test(cursor) ? Number(cursor) : NaN;
    if (!Number.isSafeInteger(offset) || (params.cursor != null && offset >= models.length)) return invalid();
    const limit = params.limit ?? 30;
    const ordered = [...models].sort((a, b) => a.priority - b.priority);
    const data: ModelListResponse["data"] = ordered.slice(offset, offset + limit).map((model) => ({
      id: model.slug, model: model.slug, displayName: model.display_name, description: model.description,
      supportedReasoningEfforts: model.supported_reasoning_levels.map(({ effort, description }) => ({ reasoningEffort: effort, description })),
      defaultReasoningEffort: model.default_reasoning_level, inputModalities: [...model.input_modalities],
      isDefault: model.priority === 0, hidden: false, supportsPersonality: false, multiAgentVersion: null,
      upgrade: null, upgradeInfo: null, availabilityNux: null, modelSpecialty: null,
      additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null, availableAccessPrograms: null,
    }));
    const nextCursor = offset + limit < ordered.length ? prefix + (offset + limit) : null;
    return Response.json({ data, nextCursor } satisfies ModelListResponse, { headers: { "cache-control": "no-store" } });
  }

  async #workspaceAssetsEnvironment(environment: AccountEnvironment, request: Request): Promise<Response> {
    if (request.method !== "POST") return fetchResponse(installationExchangeReply(MISSING));
    const body = (await request.json().catch(() => null)) as { actorId?: unknown; projectId?: unknown } | null;
    if (
      !body ||
      typeof body.actorId !== "string" ||
      !body.actorId.startsWith("human://") ||
      (body.projectId !== undefined && body.projectId !== null && typeof body.projectId !== "string")
    ) {
      return Response.json({ error: "invalid_assets_environment_request" }, { status: 400 });
    }
    try {
      const env = environment.launchEnvironment(
        `actor:${body.actorId}`,
        { projectId: body.projectId ?? null },
        {},
      );
      return Response.json({ env }, { headers: { "cache-control": "no-store" } });
    } catch {
      return Response.json({ env: {} }, { headers: { "cache-control": "no-store" } });
    }
  }

  /** The object's alarm: wakes whichever owner work is due (account renewals); each re-derives from state. */
  async alarm(): Promise<void> {
    this.#wake?.();
  }

  /** The opened services; throws when the open failed. */
  protected services(): AccountCoreServices {
    if (!this.#services) throw new Error(`AccountCore is unavailable: ${describe(this.#failure)}`);
    return this.#services;
  }

  /** Runs the disposers once, settling every one; on a failed open and when the object retires itself. */
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
      if (failures.length) throw new AggregateError(failures, "AccountCore close failed");
    })());
  }

  /**
   * The account's front door: an account route reaches its service only after
   * the installation's admission gate admitted the request, as on the Node
   * gateway; refusals are the installation's, byte for byte.
   */
  async fetch(request: Request): Promise<Response> {
    if (!this.#services)
      return fetchResponse(
        installationExchangeReply({ kind: "json", status: 503, value: { error: "account_unavailable" } }),
      );
    const services = this.#services;
    // Internal: the lease exchange for bound callers (WorkspaceHost grants, the egress redeems); the entry Worker
    // never forwards `/__opencraft_internal/`.
    const leaseReply = await services.leaseExchange(request);
    if (leaseReply) return leaseReply;
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname === WORKSPACE_CODEX_CATALOG_PATH) return this.#workspaceCodexCatalog(services.account, request, url);
    if (pathname === WORKSPACE_CODEX_MODEL_DIRECTORY_PATH) return this.#workspaceCodexModelDirectory(services.account, request, url);
    if (pathname === WORKSPACE_ASSETS_ENVIRONMENT_PATH) return this.#workspaceAssetsEnvironment(services.accountEnvironment, request);
    const route = accountRoute(pathname);
    if (!route) return fetchResponse(installationExchangeReply(MISSING));
    const gate = await services.ask("gate", fetchRequestView(request));
    if (gate instanceof Response) return gate;
    if (gate.scope === "gate" && gate.refusal) return fetchResponse(installationExchangeReply(gate.refusal));
    const handler = route === "assets" ? services.assetsHttp : services.http;
    const response = await serveFetchHttpExchange(request, handler as HttpExchangeHandler<FetchRequestView>, {
      clientAddress: request.headers.get("cf-connecting-ip"),
    });
    return response ?? fetchResponse(installationExchangeReply(MISSING));
  }
}
