/** A scheduled-JS delay probe, not network arrival or proof of a long task. */
export function observePendingRpcLoop(environment: {
  now(): number;
  isVisible(): boolean;
  schedule(run: () => void, delayMs: number): () => void;
  onDelay(delayMs: number, pending: number): void;
}) {
  let pending=0, disposed=false, expected: number | undefined, cancel: (()=>void) | undefined;
  const stop=()=>{cancel?.();cancel=undefined;expected=undefined;};
  const sample=()=>{
    if(expected === undefined || !environment.isVisible())return;
    const delay=Math.max(0,environment.now()-expected);
    if(delay>=250) {expected=undefined;try {environment.onDelay(delay,pending);} catch { /* Diagnostics cannot affect RPC settlement. */ }}
  };
  const schedule=()=>{
    if(disposed || cancel || pending<=0 || !environment.isVisible())return;
    expected=environment.now()+250;
    cancel=environment.schedule(()=>{cancel=undefined;sample();if(!environment.isVisible())expected=undefined;schedule();},250);
  };
  return {
    setPending(count: number) {
      if(disposed)return;
      // Sample before the last response cancels an overdue timer. A WebSocket
      // task may run before that timer when the browser resumes dispatching.
      sample();pending=count;
      if(pending<=0 || !environment.isVisible())stop();else schedule();
    },
    dispose(){disposed=true;stop();pending=0;},
  };
}
