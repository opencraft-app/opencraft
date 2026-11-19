import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AuthenticatedMcpProvider, type McpCredential } from '../../packages/session-capabilities/src/authenticated-mcp';
import type { CapabilitySession } from '../../packages/session-capabilities/src/index';
import type { EmployeeGitVaultStore } from '../../scripts/employee-git-vault-store';

export const GONGFENG_MCP_SERVICE = 'gongfeng-mcp';
export const GONGFENG_MCP_URL = 'https://mcpgw.knot.woa.com/gongfeng';
/** Existing owners write execution provenance. Read-only queries never migrate
 * their stores. Pending inputs can list declarations, but cannot invoke tools. */
export class GongfengExecutionCredentials {
  constructor(private readonly directory: string, private readonly machineId: string,
    private readonly vault: EmployeeGitVaultStore, private readonly admitted: (principal: { provider: string; subject: string }) => boolean) {}
  resolve(session: CapabilitySession, invocation: boolean): McpCredential | null {
    const kind = session.serverId === `server:${this.machineId}:codex` ? 'codex'
      : session.serverId === `server:${this.machineId}:dsh` || session.serverId === `server:${this.machineId}:pi` ? 'local' : null;
    const context = session.execution;
    if (!kind || !context || !context.inputId && !context.turnId) return null;
    const root = kind === 'codex' ? join(this.directory, 'codex') : join(this.directory, 'thread-identities', 'opencraft-server');
    const current = join(root, kind === 'codex' ? 'opencraft-host-state.sqlite' : 'thread-identity.sqlite');
    const legacy = join(root, 'codex-host-queue.sqlite');
    const path = kind === 'codex' && !existsSync(current) ? legacy : current;
    if (kind === 'codex' && existsSync(current) && existsSync(legacy)) return null;
    if (!existsSync(path)) return null;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
      const row = db.prepare(`SELECT s.principal_json,s.ownership,s.admission,s.input_kind,
        l.execution_id,l.state,l.turn_id,l.engine_incarnation FROM execution_submissions s
        LEFT JOIN execution_leases l ON l.thread_id=s.thread_id AND l.input_id=s.input_id
        WHERE s.thread_id=? AND ${context.inputId ? 's.input_id=?' : 'l.turn_id=?'}
        ORDER BY l.generation DESC LIMIT 1`).get(session.threadId, context.inputId ?? context.turnId!);
      if (!row || row.ownership !== 'human' || row.admission !== 'accepted' || row.input_kind === 'steer'
        || invocation && (row.state !== 'active' || !row.turn_id || !row.engine_incarnation)
        || context.executionId && context.executionId !== row.execution_id
        || context.turnId && context.turnId !== row.turn_id
        || context.incarnation && context.incarnation !== row.engine_incarnation) return null;
      const principal = JSON.parse(String(row.principal_json)) as { provider: string; subject: string };
      if (principal.provider !== 'tencentoa' || !/^[1-9]\d*$/u.test(principal.subject) || !this.admitted(principal)) return null;
      const account = `tencentoa:${principal.subject}`, record = this.vault.readSecret(account, GONGFENG_MCP_SERVICE);
      if (!record.secret?.startsWith('tai_')) return null;
      return { account, revision: record.revision, token: record.secret,
        ...(row.execution_id ? { executionId: String(row.execution_id) } : {}) };
    } catch { return null; } finally { db.close(); }
  }
}
export function gongfengMcpProvider(credentials: GongfengExecutionCredentials) {
  return new AuthenticatedMcpProvider({ id: 'gongfeng', prefix: 'gongfeng_', endpoint: GONGFENG_MCP_URL,
    resolve: (session, invocation) => credentials.resolve(session, invocation) });
}
