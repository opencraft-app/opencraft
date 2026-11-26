import {
  EmployeeGitVault,
  GitVaultError,
  type GitVaultCredential,
} from "@opencraft/execution-environment/employee-git-vault";
import { generateGitSigningKey } from "@opencraft/execution-environment/git-keys";
import { SandboxConfigurationError } from "./errors.js";
import type { GitConnectionsSnapshot, GitConnectionStatus, GitProviderDescriptor } from "../git/contract.js";
export const GIT_CONNECTIONS_PATH = "/__opencraft_assets/git-connections";
/** A provider that verifies an account token with its remote service. */
export interface TokenGitConnectionProvider {
  readonly host: string;
  readonly auth: "token";
  save(
    input: { username: string; name: string; email: string; token: string },
    previous: GitVaultCredential | null,
    check: () => void,
  ): Promise<GitVaultCredential>;
  register?(credential: GitVaultCredential, check: () => void): Promise<GitVaultCredential>;
  project?(status: GitConnectionStatus): GitConnectionStatus;
}
/** A Git host that authenticates with a key generated here. The private key stays
 * in the vault; the user registers the public key on the host. This is plain
 * configuration: a deployment supplies `{ host, auth: "ssh", name }`. */
export interface SshGitConnectionProvider {
  readonly host: string;
  readonly auth: "ssh";
  /** Product name of the host, shown in settings. */
  readonly name: string;
}
export type GitConnectionProvider = TokenGitConnectionProvider | SshGitConnectionProvider;
/** Non-secret metadata of compiled providers; never carries a function or secret. */
export function describeGitProviders(providers: readonly GitConnectionProvider[]): GitProviderDescriptor[] {
  return providers.map((p) =>
    p.auth === "ssh" ? { host: p.host, auth: "ssh", name: p.name } : { host: p.host, auth: "token" },
  );
}
const ACTIONS = {
  token: ["save", "clear", "register"],
  ssh: ["save", "clear", "generate-ssh", "delete-ssh"],
} as const;
function fail(code = "invalid", status = 400): never {
  throw new SandboxConfigurationError(code, status);
}
/** Only compiled providers can select a remote service. A browser cannot supply a
 * provider URL, credential namespace, account owner, or decrypted read operation. */
export class GitConnections {
  private readonly providers: ReadonlyMap<string, GitConnectionProvider>;
  constructor(
    private readonly vault: Pick<EmployeeGitVault, "read" | "write" | "status">,
    providers: readonly GitConnectionProvider[],
  ) {
    if (
      new Set(providers.map((p) => p.host)).size !== providers.length ||
      providers.some(
        (p) =>
          !/^[a-z0-9.-]{1,253}$/u.test(p.host) ||
          (p.auth !== "token" && p.auth !== "ssh") ||
          (p.auth === "ssh" &&
            (typeof p.name !== "string" || !p.name.trim() || p.name.length > 64 || /[\x00-\x1f\x7f]/u.test(p.name))),
      )
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
          // An SSH binding is usable only with its key; identity alone is a draft.
          if (p.auth === "ssh") return [host, { ...row, configured: !!row.sshAuth, tokenConfigured: false }];
          return [host, p.project?.(row) ?? row];
        }),
      ),
    };
  }
  async update(scope: string, raw: unknown, check: () => void): Promise<GitConnectionsSnapshot> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
    const input = raw as Record<string, unknown>,
      provider = typeof input.host === "string" ? this.providers.get(input.host) : undefined;
    const fields =
      input.action === "save"
        ? provider?.auth === "ssh"
          ? ["username", "name", "email"]
          : ["username", "name", "email", "token"]
        : input.action === "generate-ssh"
          ? ["username", "name", "email"]
          : [];
    if (
      !provider ||
      !(ACTIONS[provider.auth] as readonly string[]).includes(String(input.action)) ||
      !Number.isSafeInteger(input.revision) ||
      Number(input.revision) < 0 ||
      Object.keys(input).some((k) => !["host", "action", "revision", ...fields].includes(k))
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
      const text = (v: unknown, max: number, code: string) => {
        if (typeof v !== "string" || !v.trim() || v.length > max || /[\x00-\x1f\x7f]/u.test(v)) return fail(code);
        return v.trim();
      };
      const identityOf = () => {
        const username = text(input.username, 128, "git_username_invalid"),
          name = text(input.name, 256, "git_name_invalid"),
          email = text(input.email, 320, "git_email_invalid");
        if (!/^[^\s@]+@[^\s@]+$/u.test(email)) fail("git_email_invalid");
        return { username, name, email };
      };
      if (provider.auth === "ssh") {
        const previous = before.credential;
        let next: GitVaultCredential;
        if (input.action === "save") {
          // Identity only; an existing key is kept. Token and signing never apply.
          next = { identity: identityOf(), token: "", signing: null, sshAuth: previous?.sshAuth ?? null };
        } else if (input.action === "generate-ssh") {
          const supplied = ["username", "name", "email"].some((k) => input[k] !== undefined);
          const identity = supplied ? identityOf() : previous?.identity;
          if (!identity) fail("git_username_invalid");
          // Only the generation, public key and fingerprint ever leave the vault.
          const { registration: _registration, remoteKeyId: _remote, ...sshAuth } = generateGitSigningKey();
          next = { identity: identity!, token: "", signing: null, sshAuth };
        } else {
          if (!previous?.sshAuth) fail();
          next = { ...previous!, token: "", signing: null, sshAuth: null };
        }
        check();
        this.vault.write(scope, host, revision, next);
        check();
        return this.snapshot(scope);
      }
      let credential: GitVaultCredential;
      if (input.action === "save") {
        const { username, name, email } = identityOf();
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
