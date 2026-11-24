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
// Not assembled here: the model gateway and the account pool (each needs a
// second SQL ledger in this object), speech, personal subscriptions and OAuth
// refresh (cloudflare-deployment §5.6 "仍缺").
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import { durableObjectStateDocumentStore } from "@opencraft/storage-cloudflare/state";
import { durableObjectSecretStore } from "@opencraft/storage-cloudflare/secrets";
import { importSecretSealingKey, sealedSecretStore } from "@opencraft/secret-storage/sealed";
import { migrateModelPolicySqlDatabase } from "@opencraft/model-usage-policy/sql-owner";
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
  accountRoute,
  parseAccountAuthorityAnswer,
  type AccountAuthorityAnswer,
  type AccountAuthorityQuery,
  type AccountAuthorityScope,
} from "../account-routes.js";
import { MISSING, installationExchangeReply } from "../installation-routes.js";
import type { AccountCoreEnv, AccountCoreState } from "./bindings.js";

/** The deployment's single object name. */
export const ACCOUNT_CORE_OBJECT = "account";
/** The installation's object, as the account addresses it (installation-core.ts INSTALLATION_CORE_OBJECT). */
const INSTALLATION_OBJECT = "installation";

/** What the object serves once it opened. */
export interface AccountCoreServices {
  readonly account: AccountAssembly;
  readonly http: HttpExchangeHandler<FetchRequestView>;
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

  async #open(env: AccountCoreEnv): Promise<AccountCoreServices> {
    const storage = this.ctx.storage;
    // Credentials are never stored unsealed: no key, no object.
    const sealing = await importSecretSealingKey(env.OPENCRAFT_ACCOUNT_SEALING_KEY);
    const policy = migrateModelPolicySqlDatabase(durableObjectSqlDatabase(storage), {
      // workerd's own tables in the object's SQL are not policy schema.
      ownedByRuntime: (name) => name.startsWith("_cf_"),
    });
    const account = assembleAccount({
      openModelPolicy: () => policy,
      modelDocuments: durableObjectStateDocumentStore(storage, { prefix: "models/" }),
      modelSecrets: sealedSecretStore(durableObjectSecretStore(storage), sealing),
    });
    this.#disposers = [() => account.close()];
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
      // The model gateway is not assembled in this object; its route answers `missing`.
      gateway: () => null,
    });
    return { account, http, ask };
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
    const pathname = new URL(request.url).pathname;
    if (!accountRoute(pathname)) return fetchResponse(installationExchangeReply(MISSING));
    const gate = await services.ask("gate", fetchRequestView(request));
    if (gate instanceof Response) return gate;
    if (gate.scope === "gate" && gate.refusal) return fetchResponse(installationExchangeReply(gate.refusal));
    const response = await serveFetchHttpExchange(request, services.http, {
      clientAddress: request.headers.get("cf-connecting-ip"),
    });
    return response ?? fetchResponse(installationExchangeReply(MISSING));
  }
}
