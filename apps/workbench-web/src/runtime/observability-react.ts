import { useEffect, useRef } from 'react';
import { beginObservedOperation, subscribeObservationEnabled } from './observability';

/** Observe the existing admission predicate; never enables submission itself. */
export function useObservedReadiness(scope: string | null, ready: boolean) {
  const state=useRef({ready,finish:undefined as ReturnType<typeof beginObservedOperation>|undefined});
  state.current.ready=ready;
  useEffect(()=>{
    if(scope===null)return;
    const stop=subscribeObservationEnabled(()=>{
      const finish=beginObservedOperation('submit_ready',{cache:'unknown'});
      state.current.finish=finish;
      if(state.current.ready)finish('ok');
    });
    return()=>{stop();state.current.finish?.('aborted');state.current.finish=undefined;};
  },[scope]);
  useEffect(()=>{if(ready)state.current.finish?.('ok');},[ready,scope]);
}
