import type { GitVaultCredential } from "@opencraft/execution-environment/employee-git-vault-store";
import { generateGitSigningKey } from "@opencraft/execution-environment/git-keys";
import { SandboxConfigurationError } from "./errors.js";
import type { GitConnectionProvider } from "./git-connections.js";
function fail(code: string, status = 400): never {
  throw new SandboxConfigurationError(code, status);
}
/** Official GitHub adapter. The endpoint is compiled and fixed; redirects cannot
 * forward an account token. Only metadata and public signing keys are projected. */
export function githubConnectionProvider(fetcher: typeof fetch = fetch): GitConnectionProvider {
  async function request(
    path: string,
    token: string,
    check: () => void,
    options?: { method: string; body: string },
  ): Promise<unknown> {
    check();
    let response: Response;
    try {
      response = await fetcher("https://api.github.com" + path, {
        ...options,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2026-03-10",
          "content-type": "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      check();
      return fail("github_unavailable", 503);
    }
    check();
    if (!response.ok)
      fail(
        response.status === 401
          ? "github_token_invalid"
          : response.status === 403 || response.status === 404
            ? "github_permission_required"
            : "github_unavailable",
        response.status === 401 ? 400 : 503,
      );
    try {
      const body = await response.json();
      check();
      return body;
    } catch (error) {
      check();
      if (error instanceof SandboxConfigurationError) throw error;
      return fail("github_unavailable", 503);
    }
  }
  return {
    host: "github.com",
    auth: "token",
    async save(input, previous, check) {
      const raw = await request("/user", input.token, check),
        user = raw as { login?: unknown; id?: unknown };
      if (
        !user ||
        typeof user.login !== "string" ||
        !Number.isSafeInteger(user.id) ||
        user.login.toLowerCase() !== input.username.toLowerCase()
      )
        fail("github_account_mismatch");
      const login = user.login as string,
        id = String(user.id),
        noreply = `${id}+${login}@users.noreply.github.com`;
      if (input.email.toLowerCase() !== noreply.toLowerCase()) {
        let verified = false;
        for (let page = 1; page <= 10; page++) {
          let emails: unknown;
          try {
            emails = await request(`/user/emails?per_page=100&page=${page}`, input.token, check);
          } catch (error) {
            if (error instanceof SandboxConfigurationError && error.code === "github_permission_required")
              fail("github_email_permission_required");
            throw error;
          }
          if (!Array.isArray(emails)) fail("github_unavailable", 503);
          const list = emails as { verified?: unknown; email?: unknown }[];
          verified = list.some(
            (e) =>
              e?.verified === true &&
              typeof e.email === "string" &&
              e.email.toLowerCase() === input.email.toLowerCase(),
          );
          if (verified || list.length < 100) break;
        }
        if (!verified) fail("github_email_unverified");
      }
      check();
      return {
        identity: { username: login, name: input.name, email: input.email, accountId: id },
        token: input.token,
        signing: previous?.identity.accountId === id && previous.signing ? previous.signing : generateGitSigningKey(),
      };
    },
    async register(credential, check) {
      const signing = credential.signing;
      if (!signing) fail("invalid");
      let registration = "pending" as NonNullable<GitVaultCredential["signing"]>["registration"],
        remoteKeyId = signing!.remoteKeyId;
      try {
        let existing: { id?: unknown; key?: unknown } | undefined;
        for (let page = 1; page <= 10; page++) {
          const keys = await request(`/user/ssh_signing_keys?per_page=100&page=${page}`, credential.token, check);
          if (!Array.isArray(keys)) fail("github_unavailable", 503);
          existing = (keys as { id?: unknown; key?: unknown }[]).find((k) => k?.key === signing!.publicKey);
          if (existing || keys.length < 100) break;
          if (page === 10) fail("github_unavailable", 503);
        }
        check();
        const created =
          existing ??
          (await request("/user/ssh_signing_keys", credential.token, check, {
            method: "POST",
            body: JSON.stringify({ title: `OpenCraft Git signing ${signing!.generation}`, key: signing!.publicKey }),
          }));
        const id = (created as { id?: unknown })?.id;
        if (!Number.isSafeInteger(id)) fail("github_unavailable", 503);
        registration = "registered";
        remoteKeyId = Number(id);
      } catch (error) {
        if (
          !(error instanceof SandboxConfigurationError) ||
          !["github_permission_required", "github_unavailable"].includes(error.code)
        )
          throw error;
        registration = error.code === "github_permission_required" ? "manual_required" : "pending";
      }
      check();
      return { ...credential, signing: { ...signing!, registration, ...(remoteKeyId ? { remoteKeyId } : {}) } };
    },
  };
}
