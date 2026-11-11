/** AGY hook IPC and independently read native trace evidence. No prompt replay. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { AcpDialect } from './dialect';

export const AGY_PROBE = 'opencraft.agyHookTrace';
export function agyDialect(base: AcpDialect): AcpDialect {
  return { ...base, id: 'agy', nativeSteering: ({initialize}) => process.platform !== 'win32' && initialize._meta?.[AGY_PROBE] === true };
}
export interface AgyTrace { rows: { idx: number; text: string }[]; max: number }
export class AgyTraceReader {
  private worker: Worker;
  private next = 0;
  private closed = false;
  private pending = new Map<number, { resolve: (v: AgyTrace) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private readonly dir: string) {
    this.worker = new Worker(new URL('./agy-trace.worker.mjs', import.meta.url));
    this.worker.on('message', (m) => {
      const p = this.pending.get(m.id); if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error('AGY trace unconfirmed')); else p.resolve(m.value);
    });
    this.worker.on('error', () => this.fail());
    this.worker.on('exit', () => this.fail());
  }
  private fail(): void {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('AGY trace worker unconfirmed')); }
    this.pending.clear();
  }
  read(conversation?: string): Promise<AgyTrace> {
    if (this.closed) return Promise.reject(new Error('AGY trace worker unconfirmed'));
    return new Promise((resolve,reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('AGY trace read unconfirmed')); }, 2000);
      this.pending.set(id,{resolve,reject,timer}); this.worker.postMessage({id,dir:this.dir,conversation});
    });
  }
  async close(): Promise<void> { this.fail(); await this.worker.terminate(); }
}

function pluginList(command: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  return new Promise((resolve) => execFile(command, ['plugin','list','--json'], { env, timeout: 5000, maxBuffer: 256*1024 }, (e,out) => {
    try { resolve(e ? null : JSON.parse(out)); } catch { resolve(null); }
  }));
}
export async function agyPluginAvailable(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const plugins = await pluginList(command, env);
  if (!Array.isArray(plugins)) return false;
  const plugin = plugins.find(p => p?.name === 'agy-acp-steer' && p.enabled === true && p.hooks?.includes('agy-acp-steer'));
  if (typeof plugin?.path !== 'string') return false;
  try {
    const hooks = JSON.parse(await readFile(join(plugin.path,'hooks.json'),'utf8'))['agy-acp-steer'];
    // Both lifecycle phases must be installed, including their command implementation.
    const source = await readFile(join(plugin.path,'steer-hook.ts'),'utf8');
    return ['PreInvocation','PostInvocation'].every(k => Array.isArray(hooks?.[k]) && hooks[k].some((h: any) => h.type === 'command' && /steer-hook\.ts (pre|post)$/.test(h.command)))
      && ['AGY_ACP_STEER_IPC','AGY_ACP_STEER_OWNER','injectSteps'].every(s => source.includes(s));
  } catch { return false; }
}
interface Pending {
  text: string; floor?: number; baseline?: number;
  resolve: (proof: {nativeInputId: string; runId: string}) => void;
  reject: (e: Error) => void;
}
/** One channel per native ACP process, one immutable conversation binding per turn. */
export class AgyChannel {
  private server?: Server;
  private closing?: Promise<void>;
  private directory?: string;
  private reader: AgyTraceReader;
  private owner = randomUUID();
  private pending?: Pending;
  private conversation?: string;
  private session?: string;
  private active = false;
  private generation = 0;
  private seen = new Set<string>();
  private polling = false;
  private claiming = false;
  private timer?: NodeJS.Timeout;
  readonly env: Record<string,string> = {};
  ready = false;
  constructor(dir: string, private readonly trace: (method: string, params: Record<string,unknown>) => void = () => {}) { this.reader = new AgyTraceReader(dir); }
  static async create(command: string, env: NodeJS.ProcessEnv, trace?: (method: string, params: Record<string,unknown>) => void): Promise<AgyChannel> {
    const channel = new AgyChannel(env.AGENT_BRIDGE_AGY_CONVERSATIONS ?? join(homedir(),'.gemini','antigravity-cli','conversations'), trace);
    if (process.platform === 'win32') return channel;
    try {
      if (!await agyPluginAvailable(command,env)) return channel;
      await channel.reader.read();
      channel.directory = await mkdtemp(join(tmpdir(),'oc-agy-'));
      await chmod(channel.directory,0o700);
      const socket = join(channel.directory,'hook.sock');
      channel.server = createServer((req,res) => {
        void (async () => {
          if (req.method !== 'POST' || !/^\/claim\?event=(pre|post)$/.test(req.url ?? '') || req.headers['x-agy-acp-owner'] !== channel.owner) { res.writeHead(409).end(); return; }
          let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body)>16384) throw Error('oversize'); }
          const p = JSON.parse(body);
          const messages = await channel.claim(p);
          res.setHeader('content-type','application/json'); res.end(JSON.stringify({owner:channel.owner,messages}));
        })().catch(() => { if (!res.headersSent) res.writeHead(409); res.end(); });
      });
      await new Promise<void>((resolve,reject) => { channel.server!.once('error',reject); channel.server!.listen(socket,resolve); });
      channel.env.AGY_ACP_STEER_IPC = socket; channel.env.AGY_ACP_STEER_OWNER = channel.owner;
      channel.ready = true;
    } catch { channel.ready = false; }
    return channel;
  }
  begin(session: string, text: string): void {
    this.finish(); this.active = true; this.session = session; this.conversation = undefined; this.seen = new Set([text]);
  }
  async claim(p: unknown): Promise<{id:string;text:string}[]> {
    const payload = p as {conversationId?: unknown; initialNumSteps?: unknown};
    if (!this.active || !payload || typeof payload.conversationId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.conversationId)
      || !Number.isSafeInteger(payload.initialNumSteps) || (payload.initialNumSteps as number)<0) throw Error('invalid hook');
    if (this.conversation && this.conversation !== payload.conversationId) throw Error('stale conversation');
    // Native ACP uses its conversation id as session id. Never bind arbitrary hook ids.
    if (payload.conversationId !== this.session) throw Error('wrong session');
    this.conversation = payload.conversationId;
    this.trace("opencraft/agy/hook", { conversationId: this.conversation, floor: payload.initialNumSteps });
    const pending = this.pending;
    if (!pending || pending.floor !== undefined || this.claiming) return [];
    this.claiming = true;
    const generation = this.generation;
    let trace: AgyTrace;
    try { trace = await this.reader.read(this.conversation); }
    catch {
      this.trace("opencraft/agy/trace-unavailable", { conversationId: this.conversation });
      if (this.pending === pending) this.unknown();
      throw new Error("AGY trace unconfirmed");
    } finally { this.claiming = false; }
    if (!this.active || generation !== this.generation || this.pending !== pending) return [];
    if (trace.rows.some(r => r.text === pending.text)) { this.unknown(); return []; }
    pending.floor = Math.max(payload.initialNumSteps as number, 1);
    pending.baseline = trace.max;
    this.trace("opencraft/agy/claimed", { conversationId: this.conversation, floor: pending.floor, baseline: pending.baseline });
    this.timer = setInterval(() => { void this.poll(); }, 30);
    return [{id:randomUUID(),text:pending.text}];
  }
  inject(text: string): Promise<{nativeInputId:string;runId:string}> {
    if (!this.ready || !this.active || this.pending) return Promise.reject(new Error('AGY injection unconfirmed; do not replay'));
    if (this.seen.has(text)) return Promise.reject(new Error('AGY same-text identity unconfirmed; do not replay'));
    this.seen.add(text);
    this.trace("opencraft/agy/steer", { sessionId: this.session });
    return new Promise((resolve,reject) => { this.pending = {text,resolve,reject}; });
  }
  private async poll(): Promise<void> {
    if (this.polling || !this.pending || this.pending.floor === undefined || !this.conversation) return;
    this.polling = true;
    const pending = this.pending, generation = this.generation;
    try {
      const trace = await this.reader.read(this.conversation);
      if (!this.active || generation !== this.generation || pending !== this.pending) return;
      const matches = trace.rows.filter(r => r.text === pending.text);
      if (matches.length > 1) { this.unknown(); return; }
      const row = matches[0];
      if (row && row.idx >= pending.floor! && row.idx > pending.baseline!) {
        this.pending = undefined; clearInterval(this.timer);
        this.trace("opencraft/agy/raw-user", { conversationId: this.conversation, idx: row.idx, floor: pending.floor, baseline: pending.baseline });
        pending.resolve({ nativeInputId: String(row.idx), runId: this.conversation });
      }
    } catch { if (pending === this.pending) this.unknown(); }
    finally { this.polling = false; }
  }
  private unknown(): void {
    clearInterval(this.timer); const pending = this.pending; this.pending = undefined;
    pending?.reject(new Error('AGY raw user insertion unconfirmed; do not replay'));
  }
  finish(): void { this.active = false; this.generation++; this.unknown(); }
  close(): Promise<void> {
    return this.closing ??= this.dispose();
  }
  private async dispose(): Promise<void> {
    this.ready = false; this.finish();
    this.server?.closeAllConnections();
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    await this.reader.close();
    if (this.directory) await rm(this.directory,{recursive:true,force:true});
  }
}
