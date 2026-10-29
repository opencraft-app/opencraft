import { createHash } from 'node:crypto';
import type { EmployeeGitVaultStore } from './employee-git-vault-store.js';
import type { EnvironmentVariableView, EnvironmentScope, EnvironmentView } from '../packages/workbench-runtime/src/account-environment.js';
export type { EnvironmentVariableView, EnvironmentScope, EnvironmentView } from '../packages/workbench-runtime/src/account-environment.js';

export interface EnvironmentVariable { name: string; value: string; secret: boolean }
export class EnvironmentError extends Error {
  constructor(readonly code: 'invalid' | 'reserved' | 'conflict' | 'unavailable', readonly status = 400) { super(code); }
}
const RESERVED = /^(?:OPENCRAFT_|CODEX_|DSH_|PI_|ACP_|BB_|ELECTRON_|NODE_|NPM_|GIT_|SSH_|LD_|DYLD_|XDG_|BASH_FUNC_)/iu;
const RESERVED_NAMES = new Set([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'PWD', 'OLDPWD', 'TMPDIR', 'TMP', 'TEMP', 'TERM',
  'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'CDPATH', 'IFS', 'ZDOTDIR', 'PROMPT_COMMAND',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'AUTH_TOKEN', 'AUTHORIZATION', 'ACCESS_TOKEN', 'SESSION_TOKEN', 'SSLKEYLOGFILE',
]);
export function validateEnvironmentName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value)) throw new EnvironmentError('invalid');
  if (RESERVED.test(value) || RESERVED_NAMES.has(value.toUpperCase())) throw new EnvironmentError('reserved');
}
function scopeKey(scope: EnvironmentScope): string {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)
    || scope.projectId !== null && (typeof scope.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(scope.projectId))) throw new EnvironmentError('invalid');
  return 'document-env-' + createHash('sha256').update(JSON.stringify([1, scope.projectId])).digest('hex');
}
function variables(value: unknown): EnvironmentVariable[] {
  if (!Array.isArray(value) || value.length > 100) throw new EnvironmentError('invalid');
  const names = new Set<string>();
  let size = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['name', 'value', 'secret'].includes(key))) throw new EnvironmentError('invalid');
    validateEnvironmentName(item.name);
    if (names.has(item.name) || typeof item.secret !== 'boolean' || typeof item.value !== 'string'
      || item.value.includes('\0') || Buffer.byteLength(item.value) > 16_384) throw new EnvironmentError('invalid');
    names.add(item.name); size += Buffer.byteLength(item.value);
  }
  if (size > 65_536) throw new EnvironmentError('invalid');
  return value as EnvironmentVariable[];
}
const projectScope = (projectId: string | null): EnvironmentScope => ({ projectId });
const view = (items: EnvironmentVariable[]): EnvironmentVariableView[] => items.map(item => ({ ...item, value: item.secret ? null : item.value }));

/** The verified account is supplied by ingress/launch authority, never a form.
 * Reuses the credential vault's encryption, AAD, key and CAS; no second store. */
export class AccountEnvironment {
  constructor(private readonly vault: Pick<EmployeeGitVaultStore, 'readDocument' | 'writeDocument'>) {}
  private read(account: string, scope: EnvironmentScope) {
    const { revision, document } = this.vault.readDocument(account, scopeKey(scope));
    if (document === null) return { revision, variables: [] as EnvironmentVariable[] };
    try { return { revision, variables: variables(document) }; }
    catch { throw new EnvironmentError('unavailable', 503); }
  }
  list(account: string, scope: EnvironmentScope): EnvironmentView {
    const own = this.read(account, scope);
    return { projectId: scope.projectId, revision: own.revision, variables: view(own.variables),
      inherited: scope.projectId === null ? [] : view(this.read(account, projectScope(null)).variables) };
  }
  /** null means retain a saved secret. Downgrading it requires a replacement. */
  replace(account: string, scope: EnvironmentScope, revision: number, input: unknown): EnvironmentView {
    if (!Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(input)) throw new EnvironmentError('invalid');
    const previous = this.read(account, scope);
    if (previous.revision !== revision) throw new EnvironmentError('conflict', 409);
    const next = variables(input.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new EnvironmentError('invalid');
      if (item.value !== null) return item;
      const saved = previous.variables.find(v => v.name === item.name);
      if (!saved?.secret || item.secret !== true) throw new EnvironmentError('invalid');
      return { ...item, value: saved.value };
    }));
    this.vault.writeDocument(account, scopeKey(scope), revision, next);
    return this.list(account, scope);
  }
  /** Internal launch port: called only after account/project execution admission.
   * Never serialize its return value into a client response or thread config. */
  launchEnvironment(account: string, scope: EnvironmentScope, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const global = this.read(account, projectScope(null));
    const own = scope.projectId === null ? [] : this.read(account, scope).variables;
    const result = { ...base };
    for (const item of [...global.variables, ...own]) {
      validateEnvironmentName(item.name);
      // Platform values already present at launch are retained, even when a
      // future platform introduces a name the static reserved set did not know.
      if (Object.hasOwn(base, item.name) && base[item.name] !== undefined) throw new EnvironmentError('reserved');
      Object.defineProperty(result, item.name, { value: item.value, enumerable: true, configurable: true, writable: true });
    }
    return result;
  }
}
