/** Server-owned automation semantics. Persistence and execution are asynchronous ports. */
export type AutomationSchedule = { kind: 'once'; at: number } | { kind: 'cron'; expression: string; timezone: string };
export type AutomationTarget =
  | { kind: 'once'; sourceThreadId: string; driver: string; model: string; reasoning?: string; environment: string; prompt: string }
  | { kind: 'cron'; threadId: string; environment: string; prompt: string }
  | { kind: 'script'; hostId: string; environment: string; cwd: string; argv: string[] };
export interface Automation {
  id: string; projectId: string; creatorActorId: string; revision: number; enabled: boolean;
  schedule: AutomationSchedule; target: AutomationTarget; permissionProfile: string; grantId: string;
  concurrencyPolicy: 'skip'; failurePolicy: { consecutiveFailures: 3 }; createdAt: number;
}
export type AutomationRunState = 'planned' | 'admitted' | 'running' | 'completed' | 'failed' | 'unknown' | 'skipped';
export interface AutomationRun {
  key: string; automationId: string; revision: number; occurrenceId: string; state: AutomationRunState;
  at: number; result?: unknown;
}
export class AutomationError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export function automationText(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/u.test(value)) throw new AutomationError('invalid_automation_field');
  return value;
}
export function automationRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AutomationError('invalid_automation_object');
  return value as Record<string, unknown>;
}
export function automationFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new AutomationError('unexpected_automation_field');
}
const limits = [[0,59],[0,23],[1,31],[1,12],[0,6]] as const;
/** Five-field cron, numeric lists/ranges/steps. Sunday=0; DOM and DOW use cron OR semantics. */
export function cronFields(expression: string): Set<number>[] {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) throw new AutomationError('invalid_cron');
  return fields.map((field, index) => {
    const [min,max] = limits[index]!, values = new Set<number>();
    for (const part of field.split(',')) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/u.exec(part);
      if (!match) throw new AutomationError('invalid_cron');
      const step = Number(match[2] ?? 1), range = match[1] === '*' ? [min,max] : match[1]!.split('-').map(Number);
      const start = range[0]!, end = range[1] ?? (match[2] ? max : start);
      if (!Number.isInteger(step) || step < 1 || step > max-min+1 || start < min || end > max || start > end) throw new AutomationError('invalid_cron');
      for (let n=start;n<=end;n+=step) values.add(n);
    }
    return values;
  });
}
const formatters = new Map<string,Intl.DateTimeFormat>();
function localMinute(at: number, timezone: string): { key: string; fields: number[] } {
  let formatter=formatters.get(timezone);
  if(!formatter){formatter=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short'});if(formatters.size>=128)formatters.clear();formatters.set(timezone,formatter);}
  const parts=formatter.formatToParts(at);
  const value = (key: string) => parts.find(part=>part.type===key)!.value;
  return { key: `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`,
    fields: [+value('minute'),+value('hour'),+value('day'),+value('month'),['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(value('weekday'))] };
}
export function parseAutomationSchedule(value: unknown): AutomationSchedule {
  const body = automationRecord(value);
  if (body.kind === 'once') {
    automationFields(body,['kind','at']);
    if (!Number.isSafeInteger(body.at) || Number(body.at) < 0) throw new AutomationError('invalid_once_time');
    return {kind:'once',at:Number(body.at)};
  }
  automationFields(body,['kind','expression','timezone']);
  if (body.kind !== 'cron') throw new AutomationError('invalid_schedule_kind');
  const expression=automationText(body.expression,128),timezone=automationText(body.timezone,128);
  cronFields(expression);
  try { localMinute(0,timezone); } catch { throw new AutomationError('invalid_timezone'); }
  return {kind:'cron',expression,timezone};
}
/** Only the current minute is eligible. No historic catch-up. Fold selects the earliest UTC instant. */
export function automationOccurrence(schedule: AutomationSchedule, now: number): string | null {
  if (schedule.kind === 'once') return now >= schedule.at && now < schedule.at + 60_000 ? `utc-${schedule.at}` : null;
  const instant = Math.floor(now/60_000)*60_000, local = localMinute(instant,schedule.timezone), sets = cronFields(schedule.expression);
  const raw=schedule.expression.trim().split(/\s+/u);
  const match = sets.map((set,index)=>set.has(local.fields[index]!));
  const day = raw[2]==='*' ? match[4] : raw[4]==='*' ? match[2] : match[2] || match[4];
  if (!match[0] || !match[1] || !match[3] || !day) return null;
  // IANA offset folds can exceed an hour (e.g. Antarctica). Search the preceding
  // 26 hours at minute resolution rather than assuming a one-hour DST change.
  for (let previous=instant-60_000;previous>=instant-26*3_600_000;previous-=60_000)
    if (localMinute(previous,schedule.timezone).key === local.key) return null;
  return `utc-${instant}`;
}
export function parseAutomationTarget(value: unknown): AutomationTarget {
  const body=automationRecord(value),kind=body.kind;
  if (kind==='script') {
    automationFields(body,['kind','hostId','environment','cwd','argv']);
    if (!Array.isArray(body.argv) || body.argv.length<1 || body.argv.length>64 || JSON.stringify(body).length>16_384) throw new AutomationError('invalid_script_argv');
    if(typeof body.cwd!=='string'||!body.cwd.startsWith('/'))throw new AutomationError('absolute_script_cwd_required');
    return {kind,hostId:automationText(body.hostId),environment:automationText(body.environment),cwd:automationText(body.cwd,4096),argv:body.argv.map(arg=>automationText(arg,4096))};
  }
  if(kind==='cron') {
    automationFields(body,['kind','threadId','environment','prompt']);
    return {kind,threadId:automationText(body.threadId),environment:automationText(body.environment),prompt:automationText(body.prompt,16384)};
  }
  automationFields(body,['kind','sourceThreadId','driver','model','reasoning','environment','prompt']);
  if(kind!=='once')throw new AutomationError('invalid_target_kind');
  return {kind,sourceThreadId:automationText(body.sourceThreadId),driver:automationText(body.driver),model:automationText(body.model),environment:automationText(body.environment),prompt:automationText(body.prompt,16384),...(body.reasoning===undefined?{}:{reasoning:automationText(body.reasoning)})};
}
export function automationRunKey(id: string, revision: number, occurrenceId: string): string {
  if(id.includes(':') || occurrenceId.includes(':') || !Number.isSafeInteger(revision) || revision<1)throw new AutomationError('invalid_run_identity');
  const key=`${automationText(id)}:${revision}:${automationText(occurrenceId,64)}`;
  if(key.length>128)throw new AutomationError('automation_run_key_too_long');
  return key;
}
