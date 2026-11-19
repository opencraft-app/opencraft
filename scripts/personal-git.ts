import { readyGitBroker, type GitGrantScope } from "./personal-git-protocol.js";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { Worker } from "node:worker_threads";
import type { EnvironmentExecutionScope } from "./execution-environment.js";

export interface PersonalGitScope extends EnvironmentExecutionScope {
  readonly inputId?: string;
  readonly executionId?: string;
  readonly leaseGeneration?: number;
}
export interface PersonalGitGrant {
  readonly ready: Promise<void>;
  readonly environment: Readonly<Record<string, string>>;
  bindThread(threadId: string): void;
  bindExecution(inputId: string, executionId: string): void;
}
/** Only the trusted execution owner creates grants. Task-provided account names
 * and thread locators cannot select credentials at the socket boundary. */
export class PersonalGitEnvironment {
  private readonly worker: Worker | undefined;
  private readonly socket: string;
  private readonly grants = new Map<string, PersonalGitGrant>();
  private unavailable = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly ready: Promise<void>;
  private rejectReady!: (error: Error) => void;
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(
    directory: string,
    private readonly runtime: string,
    private readonly workerFile: string,
    private readonly hosts: readonly string[],
    private readonly issuer?: { authority: string; seal(scope: GitGrantScope): string },
    private readonly mode: "execution" | "issuer" | "status" = issuer ? "execution" : "status",
  ) {
    if (
      ![directory, runtime, workerFile].every(isAbsolute) ||
      !hosts.length ||
      hosts.some((h) => !/^[a-z0-9.-]{1,253}$/u.test(h))
    )
      throw Error("Invalid personal Git deployment");
    const privateDirectory = join(runtime, "owner-" + randomBytes(6).toString("hex"));
    this.socket = join(privateDirectory, "broker.sock");
    if (mode === "issuer") {
      this.ready = Promise.resolve();
      this.rejectReady = () => {};
      return;
    }
    this.worker = new Worker(workerFile, {
      workerData: { directory, privateDirectory, hosts, serveExecution: mode === "execution" },
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.rejectReady = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => reject(Error("personal_git_bridge_start_timeout")), 10_000);
      timer.unref();
      this.worker!.on("message", (m) => {
        if (m.type === "ready" && m.protocol === 2 && (!issuer || m.authority === issuer.authority)) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    void this.ready.catch(() => {});
    this.worker.on("error", () => {
      this.unavailable = true;
      this.rejectReady(Error("personal_git_bridge_failed"));
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(Error("personal_git_bridge_unavailable"));
      }
      this.pending.clear();
    });
    this.worker.on("message", (message) => {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(Error("personal_git_execution_unavailable"));
      else entry.resolve(message.result);
    });
    this.worker.on("exit", () => {
      this.unavailable = true;
      this.rejectReady(Error("personal_git_bridge_exited"));
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(Error("personal_git_bridge_unavailable"));
      }
      this.pending.clear();
      void rm(privateDirectory, { recursive: true, force: true }).catch(() => {});
    });
    this.worker.unref();
  }
  grant(scope: PersonalGitScope, _options?: { creation?: boolean }): PersonalGitGrant | undefined {
    if (!scope.account || !scope.threadId || !scope.inputId || !scope.executionId) return undefined;
    if (!this.issuer) throw Error("personal_git_issuer_unavailable");
    if (this.unavailable || this.closed) throw Error("personal_git_bridge_unavailable");
    const id =
      scope.threadId && scope.inputId
        ? JSON.stringify([
            scope.account,
            scope.hostId,
            scope.threadId,
            scope.inputId,
            scope.executionId,
            scope.leaseGeneration,
          ])
        : null;
    if (id && this.grants.has(id)) return this.grants.get(id)!;
    const capability = this.issuer.seal(scope as GitGrantScope);
    let current = { ...scope };
    // Sealed evidence is recoverable by another ready replica; no mutable grant map.
    const root = dirname(dirname(String(this.workerFile)));
    const readiness = () =>
      this.mode === "issuer"
        ? readyGitBroker(
            this.runtime,
            this.issuer!.authority,
            process.getuid!(),
            this.socket,
            Date.now() + 10_000,
          ).then(() => {})
        : this.ready;
    const grant: PersonalGitGrant = {
      get ready() {
        return readiness();
      },
      environment: Object.freeze({
        PATH: join(root, "bin") + ":" + (process.env.PATH || "/usr/bin:/bin"),
        BASH_ENV: join(root, "runtime/git-identity-shell-env.sh"),
        OPENCRAFT_GIT_BIN: join(root, "bin"),
        OPENCRAFT_GIT_NATIVE: "/usr/bin/git",
        OPENCRAFT_GIT_BROKER_SOCKET: this.socket,
        OPENCRAFT_GIT_BROKER_DIRECTORY: this.runtime,
        OPENCRAFT_GIT_BROKER_AUTHORITY: this.issuer.authority,
        OPENCRAFT_GIT_BROKER_UID: String(process.getuid?.()),
        OPENCRAFT_GIT_HOSTS: this.hosts.join(","),
        OPENCRAFT_GIT_MANAGED: "1",
        OPENCRAFT_GIT_REQUIRED: "1",
        OPENCRAFT_GIT_CAPABILITY: capability,
        OPENCRAFT_GIT_KNOWN_HOSTS: join(this.runtime, "known_hosts"),
      }),
      bindThread: (threadId) => {
        if (current.threadId && current.threadId !== threadId) throw Error("personal_git_scope_mismatch");
        current = { ...current, threadId };
      },
      bindExecution: (inputId, executionId) => {
        if (
          (current.inputId && current.inputId !== inputId) ||
          (current.executionId && current.executionId !== executionId)
        )
          throw Error("personal_git_scope_mismatch");
        current = { ...current, inputId, executionId };
      },
    };
    if (id) this.grants.set(id, grant);
    if (this.grants.size > 2048) this.grants.delete(this.grants.keys().next().value!);
    return grant;
  }
  status(scope: {
    hostId: string;
    threadId: string;
    inputId?: string;
    executionId?: string;
    turnId?: string;
    incarnation?: string;
  }): Promise<unknown> {
    if (this.unavailable || this.closed || !this.worker)
      return Promise.reject(Error("personal_git_bridge_unavailable"));
    const id = randomBytes(16).toString("hex");
    return this.ready.then(
      () =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(Error("personal_git_bridge_unavailable"));
          }, 5000);
          this.pending.set(id, { resolve, reject, timer });
          this.worker!.postMessage({ type: "status", id, scope });
        }),
    );
  }
  static fromEnvironment(
    directory: string,
    issuer?: { authority: string; seal(scope: GitGrantScope): string },
    mode?: "execution" | "issuer" | "status",
  ): PersonalGitEnvironment | undefined {
    const runtime = process.env.OPENCRAFT_GIT_RUNTIME_DIRECTORY;
    if (!runtime) return undefined;
    const workerFile =
      process.env.OPENCRAFT_GIT_WORKER_FILE || join(dirname(process.argv[1]!), "personal-git-worker.mjs");
    const hosts = (process.env.OPENCRAFT_GIT_HOSTS || "github.com").split(",");
    return new PersonalGitEnvironment(directory, runtime, workerFile, hosts, issuer, mode);
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.grants.clear();
    this.closePromise =
      this.unavailable || !this.worker
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              void this.worker!.terminate().then(() => resolve());
            }, 5000);
            timer.unref();
            this.worker!.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
            this.worker!.postMessage({ type: "close" });
          });
    return this.closePromise;
  }
}
