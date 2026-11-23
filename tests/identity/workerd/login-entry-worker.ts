// Login entry prototype for the Cloudflare InstallationCore
// (docs/architecture/platform/gateway-split.md, "登录入口原型结果").
//
// One SQLite-backed Durable Object migrates the Server core with the slim
// lifecycle and runs the unchanged identity stack over it: ActorStore,
// HumanAccounts (browser logins), the bundled local-account plugin (Argon2id
// through the portable pure-JS hasher), MembershipStore, HumanAuth (login routes)
// and InstanceAccess (the authenticate/admission path). HumanAuth.handle is
// still written against node:http, so a fetch Request/Response is adapted to
// the narrow IncomingMessage/ServerResponse surface it actually touches; that
// surface is the proposed Request/Response port. Bundled with esbuild and
// driven through Miniflare by tests/identity/login-entry-workerd.test.ts.
// Test-only: no deployment assembly, rate-limit store, OIDC or setup page.
import { DurableObject } from "cloudflare:workers";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import type { DurableObjectStorage } from "@opencraft/storage-cloudflare/bindings";
import { migrateServerSqlDatabase } from "@opencraft/storage-node/server-sql";
import { ActorStore } from "@opencraft/access-control/actors";
import { HumanAccounts } from "@opencraft/access-control/human-accounts";
import { HumanAuth } from "@opencraft/access-control/human-auth";
import { InstanceAccess, MembershipStore, type MemberRole } from "@opencraft/access-control";
import type { LocalAccountRecord } from "@opencraft/identity-core/local-account";
import { LocalAccountServerPlugin } from "@opencraft/plugin-local-account/server";
import { createPortablePasswordHasher } from "@opencraft/plugin-local-account/password-hash-portable";
import { handleNodeStyle, identityRequest } from "./node-http-exchange.js";

interface Env {
  readonly ORIGIN: string;
  readonly CORE: {
    idFromName(name: string): unknown;
    get(id: unknown): LoginCore;
  };
}

const failure = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/** The identity graph the Node headless server assembles, over the object's own SQL database. */
export class LoginCore extends DurableObject<Env> {
  #skew = 0;
  #failure: unknown;
  #graph:
    | {
        actors: ActorStore;
        accounts: HumanAccounts;
        local: LocalAccountServerPlugin;
        members: MembershipStore;
        auth: HumanAuth;
        access: InstanceAccess;
      }
    | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      try {
        const handle = migrateServerSqlDatabase(durableObjectSqlDatabase(ctx.storage as unknown as DurableObjectStorage), {
          ownedByRuntime: (name) => name.startsWith("_cf_"),
        });
        const now = () => Date.now() + this.#skew;
        const actors = new ActorStore(handle, now);
        const accounts = new HumanAccounts(handle, actors, now);
        const local = new LocalAccountServerPlugin(accounts.localAccountRepository, createPortablePasswordHasher(), now);
        accounts.registerLocalAccounts(local);
        const members = new MembershipStore(handle);
        const auth = new HumanAuth(accounts, actors, { origin: env.ORIGIN, local: true, oidc: [] }, () => "<!doctype html>", () => null, now);
        const access = new InstanceAccess(members, [auth], actors);
        this.#graph = { actors, accounts, local, members, auth, access };
      } catch (error) {
        this.#failure = error;
      }
    });
  }

  #open() {
    if (!this.#graph) throw new Error(`LoginCore is unavailable: ${failure(this.#failure)}`);
    return this.#graph;
  }

  /** The public entry: HumanAuth routes, then one protected probe answered by InstanceAccess. */
  async fetch(request: Request): Promise<Response> {
    const { auth, access, actors } = this.#open();
    const url = new URL(request.url);
    if (url.pathname === "/api/me") {
      const identity = identityRequest(request);
      const status = access.admissionStatus(identity);
      const principal = access.authenticate(identity);
      const actor = principal ? actors.findHuman(principal) : null;
      return Response.json(
        status === 204 ? { actorId: actor?.id ?? null, provider: principal!.provider, subject: principal!.subject } : { error: status },
        { status: status === 204 ? 200 : status },
      );
    }
    const response = await handleNodeStyle(request, (req, res) => auth.handle(req, res));
    return response ?? Response.json({ error: "missing" }, { status: 404 });
  }

  // Test controls (RPC only; never routed from the public fetch entry).
  async createAccount(username: string, password: string): Promise<{ subject: string; ms: number }> {
    const started = performance.now();
    const principal = await this.#open().local.create(username, username, password);
    return { subject: principal.subject, ms: performance.now() - started };
  }
  insertAccount(record: LocalAccountRecord): void {
    this.#open().accounts.localAccountRepository.insert(record);
  }
  account(username: string): LocalAccountRecord | null {
    return this.#open().accounts.localAccountRepository.byUsername(username);
  }
  async verify(username: string, password: string): Promise<{ subject: string | null; ms: number }> {
    const started = performance.now();
    const principal = await this.#open().local.verify(username, password);
    return { subject: principal?.subject ?? null, ms: performance.now() - started };
  }
  async hashOnly(password: string): Promise<{ record: string; ms: number }> {
    const started = performance.now();
    const record = await this.#open().local.hasher.hash(password);
    return { record, ms: performance.now() - started };
  }
  setEnabled(username: string, enabled: boolean): void {
    this.#open().local.setEnabled(username, enabled);
  }
  grant(subject: string, role: MemberRole): void {
    const { actors, members } = this.#open();
    const actor = actors.findHuman({ provider: "local", subject });
    if (!actor) throw new Error("No human for that local account");
    members.setActor(actor.id, role, true, "local-operator");
  }
  advance(milliseconds: number): void {
    this.#skew += milliseconds;
  }
  loginRows(): number {
    this.#open();
    return Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM human_logins").one().n);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const object = request.headers.get("x-test-object") ?? "login";
    const stub = env.CORE.get(env.CORE.idFromName(object));
    if (url.pathname !== "/__test") return stub.fetch(request);
    const { method, args } = (await request.json()) as { method: string; args: unknown[] };
    try {
      const value = await (stub as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>)[method]!(...args);
      return Response.json({ ok: true, value: value ?? null });
    } catch (error) {
      return Response.json({ ok: false, error: failure(error) });
    }
  },
};
