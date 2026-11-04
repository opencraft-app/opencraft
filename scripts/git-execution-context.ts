import type { DatabaseSync } from 'node:sqlite';
import type { GitOriginLeaseReader, GitOriginLeaseResolution } from './git-identity-origin.js';

export const GIT_EXECUTION_ID = 'OPENCRAFT_EXECUTION_ID';
const SELECT = `SELECT l.*,s.principal_json,s.ownership,s.admission FROM execution_leases l
  JOIN execution_submissions s ON s.thread_id=l.thread_id AND s.input_id=l.input_id`;
const valid = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 512 && !/[\0\r\n]/u.test(s);

/** Read immutable attribution, not execution authority. Application suspension,
 * native completion and missing live history do not change who started a job.
 * The legacy port's "active" means a resolved binding here, never a running Turn. */
export class GitExecutionContextReader implements GitOriginLeaseReader {
  readonly originClock = 'boot-monotonic-v1' as const;
  constructor(private readonly db: DatabaseSync) {}
  resolveExecution(threadId: string, executionId: string): GitOriginLeaseResolution {
    if (!valid(threadId) || !valid(executionId)) return { status: 'unknown' };
    return this.attribution(this.db.prepare(`${SELECT} WHERE l.thread_id=? AND l.execution_id=?`).get(threadId, executionId));
  }
  private attribution(row: Record<string, unknown> | undefined): GitOriginLeaseResolution {
    if (!row || row.admission !== 'accepted' || row.state === 'rejected' || !valid(row.execution_id)) return { status: 'unknown' };
    const executionId = row.execution_id;
    if (row.ownership === 'unowned' && row.principal_json === null) return { status: 'unowned', lease: { executionId, principal: null } };
    if (row.ownership !== 'human' || typeof row.principal_json !== 'string') return { status: 'unknown' };
    const principal = JSON.parse(row.principal_json);
    if (!valid(principal?.provider) || !valid(principal?.subject)) return { status: 'unknown' };
    return { status: 'active', lease: { executionId, principal: { provider: principal.provider, subject: principal.subject } } };
  }
  /** Compatibility for older engines that only emit a Thread locator. The
   * command's original birth interval chooses its execution, never latest sender. */
  resolveJobOrigin(input: Parameters<GitOriginLeaseReader['resolveJobOrigin']>[0]): GitOriginLeaseResolution {
    const birth = input.startedAtBootMs, margin = input.uncertaintyMs + 10;
    if (!valid(input.threadId) || !valid(input.bootId) || !valid(input.engineIncarnation)
      || !Number.isFinite(birth) || birth! < 0 || !Number.isFinite(margin) || margin < 10 || margin > 1010) return { status: 'unknown' };
    const rows = this.db.prepare(`${SELECT} WHERE l.thread_id=? AND l.boot_id=? AND l.state!='rejected'
      AND l.admitted_at_boot_ms<=? AND (l.ended_at_boot_ms IS NULL OR l.ended_at_boot_ms>=?)`)
      .all(input.threadId, input.bootId, birth! + margin, birth! - margin);
    if (rows.length !== 1) return { status: 'unknown' };
    const row = rows[0]!;
    if (row.engine_incarnation !== input.engineIncarnation || Number(row.admitted_at_boot_ms) >= birth! - margin
      || row.ended_at_boot_ms !== null && Number(row.ended_at_boot_ms) <= birth! + margin
      || row.ended_at_ms !== null && row.ended_at_boot_ms === null) return { status: 'unknown' };
    return this.attribution(row);
  }
}
