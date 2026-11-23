// Server core domain stores over one owner's ServerDatabaseHandle, shared by
// the InstallationCore Durable Object prototype (installation-core-worker.ts,
// bundled for workerd) and the Node comparison in
// tests/storage/installation-core-workerd.test.ts. Every method takes and
// returns plain JSON-compatible data so the same call sequence can run on
// node:sqlite and inside workerd and be compared result for result.
import { ActorStore } from "@opencraft/access-control/actors";
import { InstanceAccess, MembershipStore, type MemberRole } from "@opencraft/access-control";
import { ThreadAccessStore, ThreadAccessError } from "@opencraft/access-control/thread-access";
import { parsePrincipal, type Principal } from "@opencraft/identity-core";
import type { ActorContext } from "@opencraft/identity-core/actors";
import type { ServerDatabaseHandle } from "@opencraft/storage-node/server-repository";

export interface PrincipalInput {
  readonly provider: string;
  readonly subject: string;
  readonly displayName: string;
  readonly expiresAt: number;
}
export type Outcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string; readonly code?: number };

function attempt<T>(action: () => T): Outcome<T> {
  try {
    return { ok: true, value: action() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      ...(error instanceof ThreadAccessError ? { code: error.code } : {}),
    };
  }
}

const HEADER = "x-installation-core-subject";

export class InstallationCoreDomain {
  readonly actors: ActorStore;
  readonly membership: MembershipStore;
  readonly threadAccess: ThreadAccessStore;
  readonly access: InstanceAccess;
  /** Verified principals by subject: a stand-in for a trusted identity provider. */
  readonly #verified = new Map<string, Principal>();

  constructor(readonly handle: ServerDatabaseHandle) {
    this.actors = new ActorStore(handle);
    this.membership = new MembershipStore(handle);
    this.threadAccess = new ThreadAccessStore(handle, this.actors, { permissionOwner: handle.database });
    const verified = this.#verified;
    this.access = new InstanceAccess(
      this.membership,
      [
        {
          authenticate: (request) => {
            const subject = request.headers[HEADER];
            return typeof subject === "string" ? (verified.get(subject) ?? null) : null;
          },
        },
      ],
      this.actors,
    );
  }

  outcome() {
    return { status: this.handle.outcome.status, appliedVersion: this.handle.outcome.appliedVersion };
  }
  ledger() {
    return this.handle.database
      .prepare("SELECT version,name,checksum,applied_at FROM schema_migrations ORDER BY version")
      .all();
  }
  /** Schema objects excluding SQLite and workerd internals, for Node/DO comparison. */
  schema() {
    return this.handle.database
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY type,name",
      )
      .all();
  }
  verify(input: PrincipalInput) {
    const principal = parsePrincipal(input);
    this.#verified.set(principal.subject, principal);
    return principal;
  }
  resolveHuman(input: PrincipalInput) {
    return attempt(() => this.actors.resolveHuman(this.verify(input)));
  }
  findHuman(provider: string, subject: string) {
    return attempt(() => this.actors.findHuman({ provider, subject }));
  }
  createSession(displayName: string, operator: string) {
    return attempt(() => this.actors.createSession(displayName, operator));
  }
  issueCredential(actorId: string, expiresAt: number, operator: string) {
    return attempt(() => this.actors.issueCredential(actorId, expiresAt, operator));
  }
  authenticateSession(token: string) {
    return attempt(() => this.actors.authenticateSession(token));
  }
  revokeCredential(credentialId: string, operator: string) {
    return attempt(() => this.actors.revokeCredential(credentialId, operator));
  }
  setActorEnabled(actorId: string, enabled: boolean, operator: string) {
    return attempt(() => this.actors.setEnabled(actorId, enabled, operator));
  }
  isCurrent(context: ActorContext) {
    return attempt(() => this.actors.isCurrent(context));
  }
  setMember(provider: string, subject: string, role: MemberRole, enabled: boolean, operator: string) {
    return attempt(() => this.membership.set({ provider, subject }, role, enabled, operator));
  }
  /** InstanceAccess over the trusted stand-in provider: authentication, role and admission. */
  authenticate(subject: string) {
    return attempt(() => {
      const request = { headers: { [HEADER]: subject } };
      const principal = this.access.authenticate(request);
      return {
        principal: principal && { provider: principal.provider, subject: principal.subject },
        role: principal ? this.access.role(principal) : null,
        admission: this.access.admissionStatus({ headers: { [HEADER]: subject } }),
      };
    });
  }
  revocationRevision(actorId: string, bindings: { provider: string; subject: string }[]) {
    return attempt(() => this.membership.revocationRevision(actorId, bindings));
  }
  members() {
    return attempt(() => ({ members: this.membership.list(), actors: this.membership.listActors() }));
  }
  threadCreated(serverId: string, threadId: string, context: ActorContext | null) {
    return attempt(() => this.threadAccess.created(serverId, threadId, context ?? undefined));
  }
  setThreadAccess(serverId: string, threadId: string, mode: string, expected: number, context: ActorContext | null) {
    return attempt(() => this.threadAccess.set(serverId, threadId, mode, expected, context ?? undefined));
  }
  threadAllows(serverId: string, threadId: string, context: ActorContext | null) {
    return attempt(() => this.threadAccess.allows(serverId, threadId, context ?? undefined));
  }
  threadAllowsActor(serverId: string, threadId: string, actorId: string) {
    return attempt(() => this.threadAccess.allowsActor(serverId, threadId, actorId));
  }
  threadPolicy(serverId: string, threadId: string) {
    return attempt(() => this.threadAccess.read(serverId, threadId));
  }
  close() {
    this.threadAccess.close();
    this.membership.close();
    this.actors.close();
  }
}

export type InstallationCoreMethod = Exclude<
  keyof InstallationCoreDomain,
  "actors" | "membership" | "threadAccess" | "access" | "handle" | "close"
>;
