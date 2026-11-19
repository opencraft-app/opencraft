import type { IncomingMessage, ServerResponse } from 'node:http';
import { EmployeeGitVaultStore, GitVaultError, type GitVaultCredential } from '../../../../../scripts/employee-git-vault-store';
import { generateGitSigningKey } from '../../../../../scripts/git-identity-signer';
import { GIT_HOSTS, type EmployeeGitHost, type EmployeeGitInput } from './git-credentials-contract';
import { GONGFENG_MCP_SERVICE } from '../../../gongfeng-mcp';
import type { TencentOaIdentity } from './contract';

export class EmployeeGitCredentialsService {
  constructor(private readonly store: EmployeeGitVaultStore, private readonly fetcher: typeof fetch = fetch,
    private readonly isAllowed: (request: IncomingMessage) => boolean = () => true) {}
  private status(scope: string) {
    const mcp = this.store.readSecret(scope, GONGFENG_MCP_SERVICE);
    return { scope, gongfengMcp: { revision: mcp.revision, configured: mcp.secret !== null },
      hosts: Object.fromEntries(GIT_HOSTS.map(host => {
        const status = this.store.status(scope, host);
        return [host, host === 'git.woa.com' ? { ...status, configured: !!status.sshAuth, tokenConfigured: false } : status];
      })) };
  }
  async handle(request: IncomingMessage, response: ServerResponse, identity: TencentOaIdentity, current: () => boolean): Promise<void> {
    const reply = (status: number, body: unknown) => { if (!response.writableEnded) { response.statusCode = status; response.end(JSON.stringify(body)); } };
    const scope = `tencentoa:${identity.staffId}`;
    if (!this.isAllowed(request) || !current()) { reply(401, { error: 'unauthenticated' }); return; }
    if (request.headers['x-opencraft-account-scope'] !== scope) { reply(409, { error: 'account_changed' }); return; }
    if (request.method === 'GET') {
      try { reply(200, this.status(scope)); } catch { reply(503, { error: 'unavailable' }); } return;
    }
    if (request.method !== 'POST') { response.setHeader('allow', 'GET, POST'); reply(405, { error: 'method_not_allowed' }); return; }
    // A custom same-origin header plus JSON prevents form/opaque cross-origin writes.
    if (request.headers['content-type'] !== 'application/json') { reply(415, { error: 'json_required' }); return; }
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk);
        if (size > 16_384) { reply(413, { error: 'too_large' }); return; }
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      let input: EmployeeGitInput;
      try { input = JSON.parse(bytes.toString('utf8')); } finally { bytes.fill(0); for (const chunk of chunks) chunk.fill(0); }
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['host', 'revision', 'action', 'username', 'name', 'email', 'token'].includes(key))
        || !GIT_HOSTS.includes(input.host) || !['save', 'clear', 'register', 'save-mcp', 'clear-mcp', 'generate-ssh', 'delete-ssh'].includes(input.action)
        || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new GitVaultError('invalid');
      const check = () => { if (!current() || !this.isAllowed(request)) throw new AuthenticationChanged(); };
      check();
      if (input.action === 'save-mcp' || input.action === 'clear-mcp') {
        if (input.host !== 'git.woa.com' || Object.keys(input).some(key => !['host', 'revision', 'action', 'token'].includes(key))) throw new GitVaultError('invalid');
        const token = input.action === 'clear-mcp' ? null : typeof input.token === 'string' ? input.token.trim() : input.token;
        // Bearer tokens are opaque: separators and padding are valid too.
        if (token !== null && (typeof token !== 'string' || token.length > 4096 || !/^tai_[A-Za-z0-9._~+\/-]+=*$/u.test(token))) throw new CredentialInputError('taihu_token_invalid');
        check(); this.store.writeSecret(scope, GONGFENG_MCP_SERVICE, input.revision, token);
      }
      else if (input.action === 'generate-ssh' || input.action === 'delete-ssh') {
        if (input.host !== 'git.woa.com' || input.token !== undefined) throw new GitVaultError('invalid');
        const previous = this.store.read(scope, input.host);
        if (previous.revision !== input.revision) throw new GitVaultError('conflict', 409);
        if (input.action === 'delete-ssh') {
          if (!previous.credential?.sshAuth) throw new GitVaultError('invalid');
          // A key-only binding becomes unconfigured when its key is deleted.
          const credential = { ...previous.credential, token: '', sshAuth: null };
          check(); this.store.write(scope, input.host, input.revision, credential);
        } else {
          const identity = previous.credential?.identity ?? { username: input.username!, name: input.name!, email: input.email! };
          const { registration: _registration, ...sshAuth } = generateGitSigningKey();
          check(); this.store.write(scope, input.host, input.revision, { identity, token: '', signing: null, sshAuth });
        }
      }
      else if (input.action === 'clear') this.store.write(scope, input.host, input.revision, null);
      else if (input.action === 'register') await this.register(scope, input.host, input.revision, check);
      else {
        const previous = this.store.read(scope, input.host);
        if (previous.revision !== input.revision) throw new GitVaultError('conflict', 409);
        if (input.host === 'git.woa.com' && input.token !== undefined) throw new GitVaultError('invalid');
        const token = input.host === 'git.woa.com' ? '' : input.token || previous.credential?.token;
        if (typeof token !== 'string' || (!token && input.host !== 'git.woa.com') || token.length > 4096 || /[\r\n\0]/u.test(token)) throw new GitVaultError('invalid');
        const text = (value: unknown, maximum: number) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\r\n\0]/u.test(value);
        if (!text(input.username, 128)) throw new CredentialInputError('git_username_invalid');
        if (!text(input.name, 256)) throw new CredentialInputError('git_name_invalid');
        if (!text(input.email, 320) || !/^[^\s@]+@[^\s@]+$/u.test(input.email!)) throw new CredentialInputError('git_email_invalid');
        const credential: GitVaultCredential = { identity: { username: input.username!, name: input.name!, email: input.email! }, token, signing: null, ...(input.host === 'git.woa.com' ? { sshAuth: previous.credential?.sshAuth ?? null } : {}) };
        if (input.host === 'github.com') {
          const user = await this.github('/user', token);
          if (!user || typeof user.login !== 'string' || !Number.isSafeInteger(user.id) || user.login.toLowerCase() !== input.username!.toLowerCase()) throw new GitHubError('github_account_mismatch');
          const noreply = `${user.id}+${user.login}@users.noreply.github.com`;
          if (credential.identity.email.toLowerCase() !== noreply.toLowerCase()) {
            let emails;
            try { emails = await this.github('/user/emails', token); }
            catch (error) { if (error instanceof GitHubError && error.code === 'github_permission_required') throw new GitHubError('github_email_permission_required'); throw error; }
            if (!Array.isArray(emails) || !emails.some(email => email?.verified === true && typeof email.email === 'string' && email.email.toLowerCase() === credential.identity.email.toLowerCase())) throw new GitHubError('github_email_unverified');
          }
          credential.identity = { ...credential.identity, username: user.login, accountId: String(user.id) };
          credential.signing = previous.credential?.identity.accountId === String(user.id) && previous.credential.signing
            ? previous.credential.signing : generateGitSigningKey();
        }
        check(); // No SQLite transaction is held across network requests.
        const saved = this.store.write(scope, input.host, input.revision, credential);
        if (credential.signing) await this.register(scope, input.host, saved.revision, check);
      }
      check(); reply(200, this.status(scope));
    } catch (error) {
      if (error instanceof AuthenticationChanged) reply(401, { error: 'unauthenticated' });
      else if (error instanceof GitVaultError) reply(error.status, { error: error.code });
      else if (error instanceof CredentialInputError) reply(400, { error: error.code });
      else if (error instanceof GitHubError) reply(error.status, { error: error.code });
      else if (error instanceof SyntaxError) reply(400, { error: 'invalid' });
      else reply(503, { error: 'unavailable' });
    }
  }
  private async github(path: string, token: string, options?: { method: string; body: string }): Promise<any> {
    let response: Response;
    try { response = await this.fetcher(`https://api.github.com${path}`, { ...options,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(8_000) }); }
    catch { throw new GitHubError('github_unavailable', 503); }
    if (!response.ok) throw new GitHubError(response.status === 401 ? 'github_token_invalid' : response.status === 403 || response.status === 404 ? 'github_permission_required' : 'github_unavailable', response.status === 401 ? 400 : 503);
    try { return await response.json(); } catch { throw new GitHubError('github_unavailable', 503); }
  }
  private async register(scope: string, host: EmployeeGitHost, revision: number, check: () => void): Promise<void> {
    if (host !== 'github.com') throw new GitVaultError('invalid');
    const record = this.store.read(scope, host);
    if (record.revision !== revision) throw new GitVaultError('conflict', 409);
    const credential = record.credential, signing = credential?.signing;
    if (!credential || !signing) throw new GitVaultError('invalid');
    let registration = signing.registration, remoteKeyId = signing.remoteKeyId;
    try {
      // Always reconcile first: a previous POST may have succeeded before a timeout.
      let existing;
      for (let page = 1; page <= 10; page++) {
        const keys = await this.github(`/user/ssh_signing_keys?per_page=100&page=${page}`, credential.token);
        if (!Array.isArray(keys)) throw new GitHubError('github_unavailable', 503);
        existing = keys.find(key => key?.key === signing.publicKey);
        if (existing || keys.length < 100) break;
        if (page === 10) throw new GitHubError('github_unavailable', 503);
        check();
      }
      check();
      const latest = this.store.read(scope, host);
      if (latest.revision !== revision || latest.credential?.signing?.generation !== signing.generation) throw new GitVaultError('conflict', 409);
      const result = existing ?? await this.github('/user/ssh_signing_keys', credential.token, { method: 'POST', body: JSON.stringify({ title: `OpenCraft Git signing ${signing.generation}`, key: signing.publicKey }) });
      if (!Number.isSafeInteger(result?.id)) throw new GitHubError('github_unavailable', 503);
      registration = 'registered'; remoteKeyId = result.id;
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      registration = error.code === 'github_permission_required' ? 'manual_required' : 'pending';
      if (error.code === 'github_token_invalid') throw error;
    }
    check();
    // A rotated/removed generation wins. Never resurrect a stale registration.
    this.store.write(scope, host, revision, { ...credential, signing: { ...signing, registration, ...(remoteKeyId ? { remoteKeyId } : {}) } });
  }
}
class AuthenticationChanged extends Error {}
class CredentialInputError extends Error {
  constructor(readonly code: 'taihu_token_invalid' | 'git_username_invalid' | 'git_name_invalid' | 'git_email_invalid') { super(code); }
}
class GitHubError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }
