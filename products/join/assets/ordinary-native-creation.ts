import type { TransportSubmissionContext } from '@opencraft/appserver-client/transport';
import type { WorkspaceExecutionSelection } from '@opencraft/sandbox-node/workspace-execution-channel';
import type { CodexNativeRequestAdmission } from '../../../apps/opencraft-daemon/src/codex-engine-adapter';
import type { InstalledOrdinaryConversationRuntime, OrdinaryRuntimeAdmission } from './ordinary-conversation-runtime';

type Start = Parameters<InstalledOrdinaryConversationRuntime['start']>[0];
type Receipt = Awaited<ReturnType<InstalledOrdinaryConversationRuntime['start']>>;
export type OrdinaryNativePreparation = { kind: 'dispatch'; resolve(): Promise<WorkspaceExecutionSelection> }
  | { kind: 'existing'; receipt: Receipt };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a,b) => { resolve=a; reject=b; });
  // The Native reply can fail while another phase still awaits admission.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
type Attempt = {
  context: TransportSubmissionContext; live: boolean; failure?: Error; replied: boolean;
  ready: ReturnType<typeof deferred<OrdinaryNativePreparation>>;
  native: ReturnType<typeof deferred<unknown>>; completion: Promise<Receipt>;
};

/** Per physical adapter attachment, not a second durable placement owner.
 * prepare supplies a private execution selection before Native dispatch; finalize
 * gives the raw receipt to the existing owner and waits for its durable outcome.
 * It never waits for the public RPC response held by the adapter's finalizer.
 * The transport must abort on send failure, cancellation and attachment loss.
 * Business admission/source resolution remain supplied by the deployment. */
class OrdinaryNativeHandoff {
  private readonly attempts = new Map<string, Attempt>();
  private stopped = false;
  private closing?: Promise<void>;
  constructor(private readonly method:'thread/start'|'thread/resume',
    private readonly execute:(context:TransportSubmissionContext,params:Readonly<Record<string,unknown>>,
      protect:(admission:OrdinaryRuntimeAdmission)=>OrdinaryRuntimeAdmission,nativeStart:Start['nativeStart'])=>Promise<Receipt>,
    private readonly limit=64){
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024) throw Error('Invalid workspace admission limit');
  }
  private key(id: string | number) { return JSON.stringify([typeof id, id]); }
  prepare(id: string | number, request: CodexNativeRequestAdmission, params: Readonly<Record<string, unknown>>): Promise<OrdinaryNativePreparation> {
    const key = this.key(id);
    if (this.stopped || this.attempts.has(key) || this.attempts.size >= this.limit || request.method !== this.method)
      return Promise.reject(Error('Ordinary workspace admission unavailable'));
    const context = request.context(), snapshot = structuredClone(params);
    const ready = deferred<OrdinaryNativePreparation>(), native = deferred<unknown>();
    const attempt: Attempt = { context, live: true, replied: false, ready, native, completion: undefined! };
    this.attempts.set(key, attempt);
    let published = false;
    const check = () => { if (!attempt.live || (!published && this.stopped)) throw attempt.failure ?? Error('Ordinary workspace request cancelled'); };
    let dispatched = false;
    attempt.completion = this.execute(context,snapshot,admission=>{
      check();request.context();
      return {...admission,authorize:async()=>{check();await admission.authorize();check();}};
    },async(_fields,binding)=>{
      check();request.context();
      if(!binding.executionSelection)throw Error('Private workspace selection unavailable');
      dispatched=true;
      ready.resolve({kind:'dispatch',resolve:async()=>{
        check();request.context();const selection=await binding.executionSelection!();
        check();request.context();return selection;
      }});
      return native.promise;
    });
    void attempt.completion.then(receipt => {
      published = true;
      if (!dispatched) ready.resolve({ kind: 'existing', receipt });
      if (this.attempts.get(key) === attempt) this.attempts.delete(key);
    }, error => {
      ready.reject(error);
      if (this.attempts.get(key) === attempt) this.attempts.delete(key);
    });
    return ready.promise;
  }
  async finalize(input: { requestId: string | number; context: TransportSubmissionContext; result?: unknown; error?: unknown }) {
    const attempt = this.attempts.get(this.key(input.requestId));
    if (!attempt || attempt.replied) throw Error('Ordinary workspace receipt unavailable');
    if (attempt.context !== input.context) {
      await this.abort(input.requestId);
      throw Error('Ordinary workspace receipt authority mismatch');
    }
    attempt.replied = true;
    // Do not recheck a now-expired request before recording positive Native
    // evidence. The durable owner records the ID, then rechecks its authority.
    if (Object.hasOwn(input, 'error')) {
      const rejected = new Error('Native workspace request rejected');
      attempt.native.reject(rejected);
      try { await attempt.completion; throw Error('Unexpected workspace completion'); }
      catch (error) { if (error !== rejected) throw error; }
      return;
    }
    attempt.native.resolve(input.result);
    await attempt.completion;
  }
  async abort(id: string | number) {
    const attempt = this.attempts.get(this.key(id));
    if (!attempt) return;
    attempt.live = false;
    const failure = attempt.failure ??= new Error('Ordinary workspace request cancelled');
    attempt.native.reject(failure); attempt.ready.reject(failure);
    try { await attempt.completion; }
    catch (error) { if (error !== failure) throw error; }
  }
  /** Physical reconnect aborts only the old in-flight attempts. The decorator
   * survives Core reconnect, so a transient loss must not disable future requests. */
  async interrupt() {
    const results = await Promise.allSettled([...this.attempts.keys()].map(key => {
      const [,id] = JSON.parse(key) as [string,string|number]; return this.abort(id);
    }));
    const errors = results.flatMap(r => r.status === 'rejected' ? [r.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Ordinary workspace cleanup unconfirmed');
  }
  /** Published workspaces remain with the shared runtime owner. */
  close() { return this.closing ??= (async () => { this.stopped = true; await this.interrupt(); })(); }
}


/** Creation and restoration share receipt/cancellation ownership, not their
 * durable journal operations or Native methods. */
export class OrdinaryNativeCreation extends OrdinaryNativeHandoff {
 constructor(runtime:Pick<InstalledOrdinaryConversationRuntime,'start'>,
  admit:(context:TransportSubmissionContext,params:Readonly<Record<string,unknown>>)=>Promise<Omit<Start,'nativeStart'>>,limit=64){
  super('thread/start',async(context,params,protect,nativeStart)=>{
   const input=await admit(context,params);
   return runtime.start({...input,admission:protect(input.admission),nativeStart});
  },limit);
 }
}
type Restore=Parameters<InstalledOrdinaryConversationRuntime['restore']>[0];
export class OrdinaryNativeRestoration extends OrdinaryNativeHandoff {
 constructor(runtime:Pick<InstalledOrdinaryConversationRuntime,'restore'|'bindingFor'>,
  admit:(context:TransportSubmissionContext,params:Readonly<Record<string,unknown>>)=>Promise<Omit<Restore,'nativeResume'>>,limit=64){
  super('thread/resume',async(context,params,protect,nativeStart)=>{
   const input=await admit(context,params),admission=protect(input.admission);
   let dispatched=false;
   const receipt=await runtime.restore({...input,admission,nativeResume:async(_id,fields,binding)=>{
    dispatched=true;return nativeStart(fields,binding);
   }});
   if(!dispatched){
    // An already live workspace still needs a real Native resume for this client.
    // Failure of that resume does NOT destroy the separately published binding.
    const binding=await runtime.bindingFor(admission,input.threadId);
    const response=await nativeStart(await binding.executionFields(),binding);
    if((response as {thread?:{id?:unknown}}|null)?.thread?.id!==input.threadId)throw Error('Native resume receipt conflict');
    await admission.authorize();
   }
   return receipt;
  },limit);
 }
}
