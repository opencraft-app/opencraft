import { createHash } from "node:crypto";
import type { TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import type { EmployeeGitVaultStore } from "./employee-git-vault-store.js";
import { EnvironmentError } from "./account-environment.js";
import { GitVaultError } from "./git-vault-error.js";
import type { EnvironmentAccountResolver } from "./environment-account.js";

export interface EnvironmentExecutionScope {
  readonly account: string | null;
  readonly hostId: string;
  readonly threadId: string | null;
  readonly projectId: string | null;
  readonly inputId?: string;
  readonly executionId?: string;
  readonly leaseGeneration?: number;
}
/** What an authenticated submission claims before the vault owner admits it:
 * the account comes from the submission's principal, never from params. A
 * requested Project that is not a string is carried as `""`, which never equals
 * a bound Project and is never selected. */
export interface EnvironmentScopeRequest {
  readonly account: string | null;
  readonly hostId: string;
  readonly threadId: string | null;
  readonly projectId: string | null;
}
/** Asynchronous port of the vault owner for non-secret ENV metadata: Thread ->
 * Project bindings, creator provenance and the Project catalog. Nothing it
 * returns contains variable values. */
export interface EnvironmentMetadataPort {
  admit(request: EnvironmentScopeRequest): Promise<EnvironmentExecutionScope>;
  project(hostId: string, threadId: string): Promise<string | null>;
  bind(hostId: string, threadId: string, projectId: string | null): Promise<void>;
  bindCreator(scope: EnvironmentExecutionScope, threadId: string): Promise<void>;
  rememberProjects(hostId: string, projects: readonly { id: string; name: string }[]): Promise<void>;
}

const PLATFORM = "platform:environment";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const environmentProjectId = (hostId: string, projectId: string) => "project-" + digest([hostId, projectId]);
const namespace = (kind: string, hostId: string, id = "") => `document-env-${kind}-${digest([hostId, id])}`;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value);
type MetadataVault = Pick<EmployeeGitVaultStore, "readDocument" | "writeDocument">;

/** The Thread's durable Project binding, as the Gateway recorded it from the
 * Host's own thread metadata. This, not a request or handoff, selects Project ENV. */
export function environmentThreadProject(
  vault: Pick<EmployeeGitVaultStore, "readDocument">,
  hostId: string,
  threadId: string,
): string | null {
  const value = vault.readDocument(PLATFORM, namespace("thread", hostId, threadId)).document as {
    projectId?: unknown;
  } | null;
  return value && text(value.projectId) ? value.projectId : null;
}

/** The submission half of scope admission. It only checks the authenticated
 * context and reads params; the vault half runs in `EnvironmentMetadata.admit`. */
export function environmentScopeRequest(
  context: TransportSubmissionContext,
  hostId: string,
  params: Record<string, unknown>,
): EnvironmentScopeRequest {
  context.resourceOwner?.assertCurrent();
  const principal = context.executionPrincipal;
  if (
    principal &&
    (!text(principal.provider) ||
      !text(principal.subject) ||
      !Number.isFinite(context.validUntil) ||
      context.validUntil! <= Date.now())
  )
    throw new EnvironmentError("unavailable", 401);
  return Object.freeze({
    account: principal ? `${principal.provider}:${principal.subject}` : null,
    hostId,
    threadId: text(params.threadId) ? params.threadId : null,
    projectId: params.projectId == null ? null : typeof params.projectId === "string" ? params.projectId : "",
  });
}

/** Non-secret ENV metadata stored in the vault. Its owner runs it: the
 * synchronous runtime in its own process, or the vault-owner Worker behind
 * `EnvironmentMetadataPort`. */
export class EnvironmentMetadata {
  constructor(
    private readonly vault: MetadataVault,
    /** Trusted composition only, the same resolver as the vault owner's issuer:
     * an admitted scope, and so the creator recorded for a new Thread, names
     * the partition its values are read from. Without it the account is the
     * submission's login account, unchanged. */
    private readonly accounts?: Pick<EnvironmentAccountResolver, "forLogin">,
  ) {}
  project(hostId: string, threadId: string): string | null {
    return environmentThreadProject(this.vault, hostId, threadId);
  }
  bind(hostId: string, threadId: string, projectId: string | null) {
    if (!text(hostId) || !text(threadId) || (projectId !== null && !text(projectId)))
      throw new EnvironmentError("invalid");
    const key = namespace("thread", hostId, threadId),
      current = this.vault.readDocument(PLATFORM, key);
    if ((current.document as { projectId?: unknown } | null)?.projectId === projectId) return;
    try {
      this.vault.writeDocument(PLATFORM, key, current.revision, { projectId });
    } catch (error) {
      if (!(error instanceof GitVaultError) || error.code !== "conflict") throw error;
    }
  }
  rememberCreation(scope: EnvironmentExecutionScope, threadId: string) {
    if (
      !text(threadId) ||
      !text(scope.hostId) ||
      (scope.account !== null && !text(scope.account)) ||
      (scope.projectId !== null && !text(scope.projectId))
    )
      throw new EnvironmentError("invalid");
    const key = namespace("origin", scope.hostId, threadId),
      prior = this.vault.readDocument(PLATFORM, key);
    if (prior.document !== null) throw new EnvironmentError("conflict", 409);
    this.vault.writeDocument(PLATFORM, key, prior.revision, { ...scope, threadId });
    this.bindCreator(scope, threadId);
  }
  creation(hostId: string, threadId: string): EnvironmentExecutionScope | null {
    const value = this.vault.readDocument(PLATFORM, namespace("origin", hostId, threadId))
      .document as EnvironmentExecutionScope | null;
    if (!value) return null;
    if (
      value.hostId !== hostId ||
      value.threadId !== threadId ||
      (value.account !== null && !text(value.account)) ||
      (value.projectId !== null && !text(value.projectId))
    )
      throw new EnvironmentError("unavailable");
    return Object.freeze({ ...value });
  }
  /** Immutable credential identity, established only by a successful creation.
   * Reads/resumes and later submissions must never claim an existing thread. */
  bindCreator(scope: EnvironmentExecutionScope, threadId: string): void {
    if (!text(threadId) || !text(scope.hostId) || (scope.account !== null && !text(scope.account)))
      throw new EnvironmentError("invalid");
    const key = namespace("credential-owner", scope.hostId, threadId);
    const current = this.vault.readDocument(PLATFORM, key);
    if (current.document !== null) {
      if (this.creator(scope.hostId, threadId)?.account !== scope.account) throw new EnvironmentError("conflict", 409);
      return;
    }
    this.vault.writeDocument(PLATFORM, key, current.revision, { account: scope.account });
  }
  creator(hostId: string, threadId: string): { account: string | null } | null {
    const { document } = this.vault.readDocument(PLATFORM, namespace("credential-owner", hostId, threadId));
    if (document === null) return null;
    const account = (document as { account?: unknown }).account;
    if (account !== null && !text(account)) throw new EnvironmentError("unavailable", 503);
    return { account };
  }
  admitted(scope: EnvironmentExecutionScope): EnvironmentExecutionScope {
    const creator = scope.threadId ? this.creator(scope.hostId, scope.threadId) : null;
    // Legacy threads retain their admitted execution provenance; a read or
    // continuation is never evidence of who originally created them.
    if (!creator) return scope;
    // Creation provenance is immutable metadata, not a participant grant or
    // permission to borrow the creator's credentials. Ingress/ThreadAccess
    // authorize participation; each admitted input retains its own account.
    if (scope.account === null && creator.account !== null) throw new EnvironmentError("unavailable", 403);
    return Object.freeze({ ...scope });
  }
  /** The vault half of scope admission: the Thread's bound Project wins, a
   * different requested Project is refused, and creator provenance applies. */
  admit(request: EnvironmentScopeRequest): EnvironmentExecutionScope {
    if (
      !request ||
      typeof request !== "object" ||
      (request.account !== null && (typeof request.account !== "string" || !request.account)) ||
      !text(request.hostId) ||
      (request.threadId !== null && !text(request.threadId)) ||
      (request.projectId !== null && typeof request.projectId !== "string")
    )
      throw new EnvironmentError("invalid");
    const { hostId, threadId, projectId } = request;
    let selection;
    try {
      selection = this.accounts && request.account !== null ? this.accounts.forLogin(request.account) : undefined;
    } catch {
      throw new EnvironmentError("unavailable", 403);
    }
    const account = selection ? selection.partition : request.account;
    const bound = threadId ? this.project(hostId, threadId) : null;
    if (threadId && projectId !== null && bound !== null && projectId !== bound) throw new EnvironmentError("invalid");
    const scope = this.admitted(
      Object.freeze({
        account,
        hostId,
        threadId,
        projectId: threadId ? bound : text(projectId) ? projectId : null,
      }),
    );
    if (selection && !selection.current()) throw new EnvironmentError("unavailable", 403);
    return scope;
  }
  rememberProjects(hostId: string, projects: readonly { id: string; name: string }[]) {
    if (
      !text(hostId) ||
      !Array.isArray(projects) ||
      projects.length > 1000 ||
      projects.some((p) => !p || !text(p.id) || !text(p.name))
    )
      throw new EnvironmentError("invalid");
    const key = namespace("catalog", hostId),
      current = this.vault.readDocument(PLATFORM, key);
    const prior = Array.isArray(current.document) ? (current.document as { id: string; name: string }[]) : [];
    const merged = [...new Map([...prior, ...projects].map((p) => [p.id, { id: p.id, name: p.name }])).values()].slice(
      -1000,
    );
    if (JSON.stringify(prior) !== JSON.stringify(merged)) {
      try {
        this.vault.writeDocument(PLATFORM, key, current.revision, merged);
      } catch (error) {
        if (!(error instanceof GitVaultError) || error.code !== "conflict") throw error;
      }
    }
  }
  projects(hostIds = ["local-codex", "opencraft-server"]): { id: string; name: string }[] {
    return hostIds.flatMap((hostId) => {
      const value = this.vault.readDocument(PLATFORM, namespace("catalog", hostId)).document;
      return Array.isArray(value) ? value.map((p) => ({ id: environmentProjectId(hostId, p.id), name: p.name })) : [];
    });
  }
}
