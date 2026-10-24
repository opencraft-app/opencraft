import { nativeLiveAcceptedInputFact } from "./token-usage-native-facts.js";
import { randomUUID } from "node:crypto";
import { stat, realpath } from "node:fs/promises";
import { OpenCraftTokenUsageLedger, normalizeUsageCounts, type UsageSource, type UsageSubmission, type UsageTurnKey, type UsageExecutionState } from "./token-usage-ledger.js";
import { replayRolloutUsage, readTurnIdentity, type RolloutTurnIdentity } from "./token-usage-rollout.js";

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }

/** Native Turn.id is UUIDv7. Use its millisecond precision rather than rounding
 * a native startedAt second down across the first-enable boundary. */
export function nativeTurnStartedAt(turnId: string, startedAt?: unknown): number | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(turnId)) return null;
  const ms = Number.parseInt(turnId.replaceAll("-", "").slice(0, 12), 16);
  if (startedAt != null && (typeof startedAt !== "number" || Math.floor(ms / 1000) !== startedAt)) return null;
  return ms;
}

type CounterWork={key:UsageTurnKey}&({kind:"start"}|{kind:"release"}|{kind:"usage";counts:UsageSource["counts"]}|{kind:"terminal";state:UsageExecutionState});
/** Physical Host collector. There is no Renderer subscription or model request
 * here. Native metadata and bounded disk replay run after forwarding returns. */
export class CodexTokenUsageRuntime {
  private projectionScheduled:ReturnType<typeof setImmediate>|null=null;
  private nativeHome: string | null = null;
  private readonly counterEpoch=randomUUID();
  private readonly ephemeral=new Set<string>();
  private readonly counterWork:CounterWork[]=[];
  private counterScheduled:ReturnType<typeof setImmediate>|null=null;
  /** Physical thread/start only; a fork/resume is never a zero baseline. */
  threadStarted(value:unknown):void {
    const thread=record(record(value).thread),threadId=text(thread.id);
    if(!this.enabled()||!threadId||thread.ephemeral!==true||thread.path!=null||!Array.isArray(thread.turns)||thread.turns.length!==0)return;
    if(this.ephemeral.size>=2048){this.missing(threadId,"unreplayable");return;}
    if(this.port.derived){this.ephemeral.add(threadId);this.missing(threadId,"unreplayable");return;}
    try{if(this.ledger.registerNativeCounter(threadId,this.counterEpoch))this.ephemeral.add(threadId);}
    catch{this.missing(threadId,"storage-write");}
  }
  /** Only an owned one-shot native job calls this after unsubscribe ACK. */
  releaseEphemeral(threadId:string):void {
    if(this.port.derived){this.ephemeral.delete(threadId);return;}
    if(this.ephemeral.has(threadId))this.enqueueCounter({kind:"release",key:{threadId,turnId:""}});
  }
  private counterMissing(threadId:string):void {
    try{this.ledger.breakNativeCounter(threadId);}catch{}
    this.missing(threadId,"unreplayable");
  }
  private enqueueCounter(work:CounterWork):void {
    if(this.counterWork.length>=2048){this.counterMissing(work.key.threadId);return;}
    this.counterWork.push(work);
    if(this.counterScheduled)return;
    this.counterScheduled=setImmediate(()=>{this.counterScheduled=null;this.flushCounters();if(this.counterWork.length)this.scheduleCounters();});
  }
  private scheduleCounters():void {
    if(this.counterScheduled||this.abort.signal.aborted)return;
    this.counterScheduled=setImmediate(()=>{this.counterScheduled=null;this.flushCounters();if(this.counterWork.length)this.scheduleCounters();});
  }
  private flushCounters():void {
    const started=performance.now();
    for(let i=0;i<32&&this.counterWork.length&&(i===0||performance.now()-started<8);i++){
      const work=this.counterWork.shift()!;
      try{
        if(work.kind==="release"){this.ephemeral.delete(work.key.threadId);}
        else if(work.kind==="start"){
          const at=nativeTurnStartedAt(work.key.turnId);if(at===null)throw new Error("Invalid native time");
          this.ledger.startNativeCounterTurn(work.key,at,this.counterEpoch);
        }else if(work.kind==="usage")this.ledger.recordNativeCounter(work.key,this.counterEpoch,work.counts);
        else this.ledger.completeNativeCounterTurn(work.key,this.counterEpoch,work.state);
      }catch{this.counterMissing(work.key.threadId);}
    }
  }
  private readonly pending = new Set<string>();
  private readonly active = new Set<string>();
  private readonly gaps = new Map<string, string>();
  private readonly identities = new Map<string, RolloutTurnIdentity>();
  private gapRetryAfter = "";
  private readonly settling = new Map<string,number>();
  private readonly receiptAfter=new Map<string,string>();
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setInterval> | null = null;
  private scheduled: ReturnType<typeof setImmediate> | null = null;
  private draining = false;
  /** Includes faults which an unwritable store could not persist. */
  liveGapCount(): number { return this.gaps.size; }
  private enabled(): boolean {
    try { return this.ledger.coverage().enabled; }
    catch { try { this.port.diagnostic("storage-read"); } catch {} return false; }
  }
  constructor(readonly ledger: OpenCraftTokenUsageLedger, private readonly port: {
    readonly request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    readonly submission?: (threadId: string, inputId: string) => UsageSubmission | null;
    readonly diagnostic: (category: string) => void;
    readonly derived?: { invalidate(threadId:string,path?:string):void };
  }) {}

  initialize(value: unknown): void {
    const home = text(record(value).codexHome);
    if (!home || this.nativeHome || this.abort.signal.aborted) return;
    this.nativeHome = home;
    this.seedGaps();
    this.timer = setInterval(() => { this.scheduleProjection(); for (const thread of new Set([...this.active,...this.settling.keys()])) this.schedule(thread); this.retryGaps(); }, 2000);
    this.timer.unref();
    this.scheduleProjection();
    void this.restore().catch(() => { if (!this.abort.signal.aborted) { try { this.port.diagnostic("recovery-read"); } catch {} } });
  }
  private seedGaps(): void {
    try {
      for (const gap of this.ledger.openGapThreads(256)) {
        if (!this.gaps.has(gap.threadId)) this.gaps.set(gap.threadId, gap.id);
      }
    } catch {
      try { this.port.diagnostic("recovery-read"); } catch {}
    }
  }
  private scheduleProjection():void {
    if(this.port.derived)return;
    if(this.abort.signal.aborted||this.projectionScheduled)return;
    this.projectionScheduled=setImmediate(()=>{
      this.projectionScheduled=null;
      if(this.abort.signal.aborted)return;
      try{if(!this.ledger.backfillProjectionBatch(32))this.scheduleProjection();}
      catch{try{this.port.diagnostic("projection-rebuild");}catch{}}
    });
  }
  attempt(attemptId:string,threadId:string,inputId:string,mode:UsageSubmission["mode"],identity?:UsageSubmission):void {
    if(!this.enabled())return;
    try{
      const trusted=identity??this.port.submission?.(threadId,inputId)??this.ledger.storedSubmission(threadId,inputId);
      this.ledger.recordAttempt(attemptId,{...(trusted??{threadId,inputId,actorId:null,actorKind:"unknown",sourceKind:"unknown",submittedAt:Date.now()}),mode});
    }catch{this.missing(threadId,"storage-write");}
  }
  attemptOutcome(attemptId:string,outcome:"accepted"|"rejected"|"unknown",turnId:string|null=null):void {
    try{const threadId=this.ledger.recordAttemptOutcome(attemptId,outcome,turnId);if(threadId&&outcome==="unknown")this.missing(threadId,"source-offline");}
    catch{try{this.port.diagnostic("attempt-outcome");}catch{}}
  }
  submission(value: UsageSubmission): void {
    if (!this.enabled()) return;
    try { this.ledger.recordSubmission(value); } catch { this.missing(value.threadId, "storage-write"); }
  }
  admission(key: UsageTurnKey, inputId: string): void {
    if (!inputId || !this.enabled()) return;
    try {
      const at=nativeTurnStartedAt(key.turnId);
      if (at!==null) this.ledger.startTurn(key,at,"unknown");
      const trusted = this.port.submission?.(key.threadId, inputId);
      if (trusted) this.ledger.recoverSubmission(trusted);
      this.ledger.recordAdmission(key, inputId);
      this.port.derived?.invalidate(key.threadId);
    } catch { this.missing(key.threadId, "storage-write"); }
    this.schedule(key.threadId);
  }
  notification(method: string, params: Record<string, unknown>): void {
    const threadId = text(params.threadId);
    if (!threadId) return;
    if(this.ephemeral.has(threadId)&&!this.enabled()){if(this.port.derived)this.missing(threadId,"unreplayable");else this.counterMissing(threadId);return;}
    const accepted=nativeLiveAcceptedInputFact(method,params);
    if(accepted)this.admission(accepted,accepted.inputId);
    if(this.port.derived){
      this.port.derived.invalidate(threadId);
      if(this.ephemeral.has(threadId))return;
    }
    if(this.ephemeral.has(threadId)){
      const turn=record(params.turn),turnId=text(params.turnId)||text(turn.id),key={threadId,turnId};
      if(method==="turn/started"&&turnId)this.enqueueCounter({kind:"start",key});
      if(method==="thread/tokenUsage/updated"&&turnId){
        try{const counts=normalizeUsageCounts(record(record(params.tokenUsage).total) as UsageSource["counts"]);this.enqueueCounter({kind:"usage",key,counts:{...counts,totalTokens:counts.totalTokens!}});}
        catch{this.counterMissing(threadId);}
      }
      if(method==="turn/completed"&&turnId){
        if(["completed","failed","interrupted"].includes(String(turn.status)))this.enqueueCounter({kind:"terminal",key,state:turn.status as UsageExecutionState});
        else this.counterMissing(threadId);
      }
      return;
    }
    if (method === "turn/started" && this.active.size < 256) this.active.add(threadId);
    if (method === "turn/completed") this.active.delete(threadId);
    if (["turn/started", "turn/completed", "thread/tokenUsage/updated", "rawResponse/completed"].includes(method)) this.schedule(threadId);
  }
  private missing(threadId: string, reason: "storage-write" | "queue-full" | "source-offline" | "source-replaced" | "invalid-source" | "unreplayable" | "oversized-line"): void {
    try { this.port.diagnostic(reason); } catch { /* failure reporting never changes execution */ }
    if (this.gaps.has(threadId) || this.gaps.size >= 256) return;
    const id = randomUUID(); this.gaps.set(threadId, id);
    try { this.ledger.noteGap({ id, threadId, reason }); } catch { /* an unwritable store cannot persist its own fault */ }
  }
  private retryGaps(): void {
    const keys = [...this.gaps.keys()];
    if (!keys.length) return;
    const first = (keys.indexOf(this.gapRetryAfter) + 1) % keys.length;
    // A completed thread can still regain a durable source after an outage.
    // Keep the retry rate bounded and rotate rather than forgetting its gap.
    for (let i = 0; i < Math.min(8, keys.length); i++) {
      const key = keys[(first + i) % keys.length]!;
      this.schedule(key); this.gapRetryAfter = key;
    }
  }
  private schedule(threadId: string): void {
    if (this.abort.signal.aborted || this.ephemeral.has(threadId) || !this.nativeHome || !this.enabled()) return;
    if (this.pending.size >= 256 && !this.pending.has(threadId)) { this.missing(threadId, "queue-full"); return; }
    this.pending.add(threadId);
    if (this.draining || this.scheduled) return;
    this.scheduled = setImmediate(() => { this.scheduled = null; void this.drain(); });
  }
  private async restore(): Promise<void> {
    let after = "";
    while (!this.abort.signal.aborted) {
      const rows = this.ledger.rollouts(after);
      if (!rows.length) break;
      for (const row of rows) {
        while (this.pending.size > 128 && !this.abort.signal.aborted) await new Promise(resolve => setTimeout(resolve, 25));
        if (this.abort.signal.aborted) return;
        this.schedule(row.threadId); after = row.threadId;
      }
      await new Promise(resolve => setImmediate(resolve));
    }
    after="";
    while (!this.abort.signal.aborted) {
      const threads=this.ledger.missingRolloutThreads(after);
      if(!threads.length) break;
      for(const thread of threads){
        while(this.pending.size>128&&!this.abort.signal.aborted) await new Promise(resolve=>setTimeout(resolve,25));
        if(this.abort.signal.aborted) return;
        this.schedule(thread);after=thread;
      }
      await new Promise(resolve=>setImmediate(resolve));
    }
  }
  private async drain(): Promise<void> {
    this.draining = true;
    try {
      const threadId = this.pending.values().next().value as string | undefined;
      if (!threadId || this.abort.signal.aborted) return;
      this.pending.delete(threadId);
      try { await this.collect(threadId); }
      catch { if (!this.abort.signal.aborted) this.missing(threadId, "source-offline"); }
    } finally {
      this.draining = false;
      const next = this.pending.values().next().value;
      if (next && !this.abort.signal.aborted) this.schedule(next);
    }
  }
  private async collect(threadId: string): Promise<void> {
    const signal = this.abort.signal;
    let sliceStarted=performance.now();
    const yieldIfNeeded=async()=>{if(performance.now()-sliceStarted<8)return;await new Promise<void>(resolve=>setImmediate(resolve));signal.throwIfAborted();sliceStarted=performance.now();};
    if(this.port.submission){
      const inputs=this.ledger.unresolvedInputIds(threadId,this.receiptAfter.get(threadId)??"");
      for(const inputId of inputs){const trusted=this.port.submission(threadId,inputId);if(trusted)this.ledger.recoverSubmission(trusted);await yieldIfNeeded();}
      if(inputs.length===32){this.receiptAfter.set(threadId,inputs.at(-1)!);this.schedule(threadId);}else this.receiptAfter.delete(threadId);
    }
    const thread = record(record(await this.port.request("thread/read", {threadId,includeTurns:false})).thread);
    signal.throwIfAborted();
    const path = text(thread.path);
    if (!path) { this.missing(threadId, "unreplayable"); return; }
    let canonical: string;
    try { canonical = await realpath(path); }
    catch { this.missing(threadId, "source-replaced"); return; }
    const storedBefore = this.ledger.rollout(threadId);
    if (storedBefore && storedBefore.path !== canonical) {
      let previousCanonical: string | null = null;
      try { previousCanonical = await realpath(storedBefore.path); } catch { /* deleted */ }
      if (previousCanonical !== canonical) { this.missing(threadId, "source-replaced"); return; }
      this.ledger.repairRolloutPath(threadId, storedBefore.path, canonical);
    }
    this.ledger.rememberRollout(threadId, canonical);
    const stored = this.ledger.rollout(threadId)!;
    const replayCursor=this.port.derived?(this.ledger.participationCursor(threadId,canonical)??Number(stored.cursor)):Number(stored.cursor);
    // The native paged API explicitly omits message/tool bodies.
    const metadataCursor=this.ledger.metadataCursor(threadId);
    let turns:Record<string,unknown>;
    try{turns=record(await this.port.request("thread/turns/list", {threadId,limit:100,itemsView:"notLoaded",sortDirection:"desc",...(metadataCursor?{cursor:metadataCursor}:{})}));}
    catch(error){if(metadataCursor)this.ledger.advanceMetadataCursor(threadId,null);throw error;}
    if(!Array.isArray(turns.data)||turns.data.length>100)throw new Error("Invalid native metadata page");
    signal.throwIfAborted();
    const metadata = new Map<string, Record<string, unknown>>((Array.isArray(turns.data) ? turns.data : []).map(value => {const turn=record(value);return [text(turn.id),turn];}));
    const excluded = new Set<string>();
    const ensure = (turnId: string): boolean => {
      const key = {threadId,turnId};
      const existing = this.ledger.readTurn(key);
      if (existing) return !existing.frozen;
      const at = nativeTurnStartedAt(turnId, metadata.get(turnId)?.startedAt);
      if (at === null || !this.ledger.startTurn(key, at, "unknown")) { excluded.add(turnId); return false; }
      return true;
    };
    if(this.port.derived)for(const turnId of metadata.keys())ensure(turnId);
    let identity = this.identities.get(threadId);
    if (!identity&&!this.port.derived) {
      identity = await readTurnIdentity(canonical, replayCursor) ?? undefined;
      if (identity) this.identities.set(threadId, identity);
    }
    const replay = await replayRolloutUsage({ path: canonical, nativeHome:this.nativeHome!,threadId,ledger:this.ledger,cursor:replayCursor,maxFacts:32,excludedTurnIds:excluded,signal,
      identity,counts:!this.port.derived,
      onAdmission: fact => {
        if (!ensure(fact.turnId)) return;
        const trusted = this.port.submission?.(threadId,fact.inputId);
        if (trusted) this.ledger.recoverSubmission(trusted);
        this.ledger.recordAdmission(fact,fact.inputId);
      },
      onSourceTurn: key => ensure(key.turnId),
      onTerminal: turnId => { if (this.ledger.readTurn({threadId,turnId})) this.ledger.recordNativeTerminal({threadId,turnId}); },
      onCommitCursor: cursor => {if(this.port.derived)this.ledger.advanceParticipationCursor(threadId,canonical,cursor);else this.ledger.advanceRollout(threadId,canonical,String(cursor));},
      onOversizedLine: (mayContainFact: boolean) => {
        try { this.port.diagnostic(mayContainFact ? "oversized-usage-line" : "oversized-line-skipped"); } catch {}
      },
    });
    signal.throwIfAborted();
    if (replay.blockedTurnId) ensure(replay.blockedTurnId);
    if (replay.oversizedFact) this.missing(threadId,"oversized-line");
    else if (replay.missing) this.missing(threadId,"invalid-source");
    if (replay.more && replay.cursor > replayCursor && (await stat(canonical)).size > replay.cursor) { this.schedule(threadId); return; }
    if (!replay.missing && !replay.oversizedFact) { this.ledger.resolveReplayGaps(threadId); this.gaps.delete(threadId); }
    let incompleteTerminal=false;
    for (const [turnId, turn] of metadata) {
      const key = {threadId,turnId}, known = this.ledger.readTurn(key);
      if (!known || known.frozen) continue;
      const status = turn.status === "inProgress" ? "running" : turn.status;
      if (!["running","completed","failed","interrupted"].includes(String(status))) continue;
      const completion = this.port.derived?this.ledger.recordedSettlement(key):this.ledger.nativeSettlement(key);
      this.ledger.reconcile(key,{executionState:status as UsageExecutionState,participantsComplete:true,...completion});
      await yieldIfNeeded();
      if (status === "running" && this.active.size<256) this.active.add(threadId);
      else if (!this.port.derived && status!=="running" && !completion.usageComplete) incompleteTerminal=true;
    }
    const nextCursor=text(turns.nextCursor);
    if(nextCursor&&nextCursor===metadataCursor)throw new Error("Native metadata cursor did not advance");
    if(nextCursor&&this.ledger.hasRunningTurnsOutside(threadId,[...metadata.keys()])){
      this.ledger.advanceMetadataCursor(threadId,nextCursor);this.schedule(threadId);
    }else this.ledger.advanceMetadataCursor(threadId,null);
    if (incompleteTerminal) {
      const attempts=(this.settling.get(threadId)??0)+1;
      if(attempts<=5 && this.settling.size<256) this.settling.set(threadId,attempts);
      else {this.settling.delete(threadId);this.missing(threadId,"unreplayable");}
    } else this.settling.delete(threadId);
    this.port.derived?.invalidate(threadId,canonical);
  }
  close(): void {
    this.abort.abort();
    if(this.projectionScheduled)clearImmediate(this.projectionScheduled);
    if(this.counterScheduled)clearImmediate(this.counterScheduled);
    this.flushCounters();
    for(const threadId of new Set(this.counterWork.map(work=>work.key.threadId)))this.counterMissing(threadId);
    this.counterWork.length=0;this.ephemeral.clear();
    if (this.timer) clearInterval(this.timer);
    if (this.scheduled) clearImmediate(this.scheduled);
    this.pending.clear(); this.active.clear(); this.gaps.clear(); this.identities.clear(); this.gapRetryAfter=""; this.settling.clear();this.receiptAfter.clear();
  }
}
