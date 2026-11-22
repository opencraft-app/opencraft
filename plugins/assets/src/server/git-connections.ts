import {
  EmployeeGitVaultStore,
  GitVaultError,
  type GitVaultCredential,
} from "@opencraft/execution-environment/employee-git-vault-store";
import { SandboxConfigurationError } from "./errors.js";
import type { GitConnectionsSnapshot, GitConnectionStatus } from "../git/contract.js";
export const GIT_CONNECTIONS_PATH = "/__opencraft_assets/git-connections";
export interface GitConnectionProvider {
  readonly host: string;
  save(
    input: { username: string; name: string; email: string; token: string },
    previous: GitVaultCredential | null,
    check: () => void,
  ): Promise<GitVaultCredential>;
  register?(credential: GitVaultCredential, check: () => void): Promise<GitVaultCredential>;
  project?(status: GitConnectionStatus): GitConnectionStatus;
}
function fail(code = "invalid", status = 400): never {
  throw new SandboxConfigurationError(code, status);
}
/** Only compiled providers can select a remote service. A browser cannot supply a
 * provider URL, credential namespace, account owner, or decrypted read operation. */
export class GitConnections {
  private readonly providers: ReadonlyMap<string, GitConnectionProvider>;
  constructor(
    private readonly vault: Pick<EmployeeGitVaultStore, "read" | "write" | "status">,
    providers: readonly GitConnectionProvider[],
  ) {
    if (
      new Set(providers.map((p) => p.host)).size !== providers.length ||
      providers.some((p) => !/^[a-z0-9.-]{1,253}$/u.test(p.host))
    )
      fail();
    this.providers = new Map(providers.map((p) => [p.host, p]));
  }
  snapshot(scope: string): GitConnectionsSnapshot {
    return {
      scope,
      hosts: Object.fromEntries(
        [...this.providers].map(([host, p]) => {
          const row = this.vault.status(scope, host);
          return [host, p.project?.(row) ?? row];
        }),
      ),
    };
  }
  async update(scope: string, raw: unknown, check: () => void): Promise<GitConnectionsSnapshot> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
    const input = raw as Record<string, unknown>,
      provider = typeof input.host === "string" ? this.providers.get(input.host) : undefined;
    if (
      !provider ||
      !["save", "clear", "register"].includes(String(input.action)) ||
      !Number.isSafeInteger(input.revision) ||
      Number(input.revision) < 0 ||
      Object.keys(input).some(
        (k) =>
          ![
            "host",
            "action",
            "revision",
            ...(input.action === "save" ? ["username", "name", "email", "token"] : []),
          ].includes(k),
      )
    )
      fail();
    const host = provider.host,
      revision = Number(input.revision);
    check();
    try {
      const before = this.vault.read(scope, host);
      if (before.revision !== revision) fail("conflict", 409);
      const guard = (expected: number, generation?: string) => () => {
        check();
        const latest = this.vault.read(scope, host);
        if (
          latest.revision !== expected ||
          (generation !== undefined && latest.credential?.signing?.generation !== generation)
        )
          fail("conflict", 409);
      };
      if (input.action === "clear") {
        check();
        this.vault.write(scope, host, revision, null);
        return this.snapshot(scope);
      }
      let credential: GitVaultCredential;
      if (input.action === "save") {
        const text = (v: unknown, max: number, code: string) => {
          if (typeof v !== "string" || !v.trim() || v.length > max || /[\x00-\x1f\x7f]/u.test(v)) return fail(code);
          return v.trim();
        };
        const username = text(input.username, 128, "git_username_invalid"),
          name = text(input.name, 256, "git_name_invalid"),
          email = text(input.email, 320, "git_email_invalid");
        if (!/^[^\s@]+@[^\s@]+$/u.test(email)) fail("git_email_invalid");
        const token = input.token === undefined || input.token === "" ? before.credential?.token : input.token;
        if (typeof token !== "string" || !token || token.length > 4096 || /[\x00-\x20\x7f]/u.test(token)) fail();
        credential = await provider.save(
          { username, name, email, token: token as string },
          before.credential,
          guard(revision),
        );
        check();
        this.vault.write(scope, host, revision, credential);
        if (provider.register && credential.signing) {
          const savedRevision = revision + 1;
          credential = await provider.register(credential, guard(savedRevision, credential.signing?.generation));
          check();
          this.vault.write(scope, host, savedRevision, credential);
        }
      } else {
        if (!provider.register || !before.credential?.signing) fail();
        credential = await provider.register!(
          before.credential!,
          guard(revision, before.credential!.signing!.generation),
        );
        check();
        this.vault.write(scope, host, revision, credential);
      }
      check();
      return this.snapshot(scope);
    } catch (error) {
      if (error instanceof GitVaultError) fail(error.code, error.status);
      throw error;
    }
  }
}
