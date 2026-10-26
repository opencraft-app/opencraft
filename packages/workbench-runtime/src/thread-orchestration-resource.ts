import { parseThreadOrchestrationView, type ThreadOrchestrationView } from "@opencraft/appserver-protocol/collaboration";

type Call = {readonly turnId:string;readonly itemId:string};
type Watch = {calls:readonly Call[];listener:()=>void};
/** Display-only cache. Reads the Hub ledger; it never resumes or sends to a Thread. */
export class ThreadOrchestrationResource {
  private readonly values = new Map<string,ThreadOrchestrationView>();
  private readonly watches = new Map<string,Set<Watch>>();
  private readonly timers = new Map<string,ReturnType<typeof setTimeout>>();
  private readonly pending = new Map<string,Promise<void>>();
  private generation = 0;
  constructor(private readonly client: {supported():boolean;read(threadId:string,calls:readonly Call[]):Promise<unknown>}) {}
  getSnapshot = (threadId:string):ThreadOrchestrationView|null => this.values.get(threadId) ?? null;
  subscribe(threadId:string,calls:readonly Call[],listener:()=>void):()=>void {
    const watch = {calls,listener}, set = this.watches.get(threadId) ?? new Set<Watch>();
    set.add(watch); this.watches.set(threadId,set);
    void this.refresh(threadId);
    return () => {
      set.delete(watch);
      if (!set.size) {this.watches.delete(threadId);clearTimeout(this.timers.get(threadId));this.timers.delete(threadId);}
    };
  }
  refresh(threadId:string):Promise<void> {
    if (this.pending.has(threadId)) return this.pending.get(threadId)!;
    const generation = this.generation;
    const calls = [...new Map([...(this.watches.get(threadId) ?? [])].flatMap(watch => watch.calls)
      .map(call => [JSON.stringify(call),call])).values()];
    if (!calls.length || !this.client.supported()) {this.schedule(threadId);return Promise.resolve();}
    const work = (async () => {
      try {
        const pages = await Promise.all(Array.from({length:Math.ceil(calls.length/100)},(_,page) =>
          this.client.read(threadId,calls.slice(page*100,page*100+100)).then(parseThreadOrchestrationView)));
        if (generation !== this.generation || pages.some(view => !view || view.threadId !== threadId)) return;
        this.values.set(threadId,{threadId,calls:pages.flatMap(view => view!.calls)});
        for (const watch of this.watches.get(threadId) ?? []) watch.listener();
      } catch { /* Preserve the last confirmed display during a temporary read failure. */ }
    })().finally(() => {
      if (this.pending.get(threadId) === work) this.pending.delete(threadId);
      if (generation === this.generation) this.schedule(threadId);
    });
    this.pending.set(threadId,work);return work;
  }
  private schedule(threadId:string):void {
    clearTimeout(this.timers.get(threadId));this.timers.delete(threadId);
    if (this.watches.has(threadId)) this.timers.set(threadId,setTimeout(() => void this.refresh(threadId),2000));
  }
  reset():void {
    this.generation++; this.values.clear();this.pending.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const [id,watches] of this.watches) {
      for (const watch of watches) watch.listener();
      this.schedule(id);
    }
  }
  dispose():void {this.watches.clear();this.reset();}
}
