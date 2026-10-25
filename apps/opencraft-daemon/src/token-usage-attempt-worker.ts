import { parentPort, workerData } from "node:worker_threads";
import { TokenUsageStateDatabase } from "./token-usage-state-database.js";
import { OpenCraftTokenUsageLedger } from "./token-usage-ledger.js";

import type { UsageWrite } from "./token-usage-attempt-writer.js";

export function runTokenUsageAttemptWorker(): void {
  // The Host already migrated and recovered this store. Opening another
  // connection must not classify this same owner's in-flight attempts as lost.
  const state = new TokenUsageStateDatabase(workerData.directory);
  const ledger = new OpenCraftTokenUsageLedger(state, workerData.serverId, Date.now, undefined, { recoverPendingAttempts: false,projectLegacy:workerData.projectLegacy });
  const queue: Array<{ id: number; operation: UsageWrite;deadline:number }> = [];
  let working = false;
  async function drain() {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const message = queue.shift()!, until = message.deadline;
        let error = false,result:string|null=null;
        for (;;) {
          if(Date.now()>=until){error=true;break;}
          try {
            const work=message.operation;
            if(work.kind==="attempt")ledger.recordAttempt(work.attemptId,work.input);
            else if(work.kind==="outcome")result=ledger.recordAttemptOutcome(work.attemptId,work.outcome,work.turnId);
            else if(work.kind==="submission")ledger.recordSubmission(work.input);
            else ledger.commitReplayBatch(()=>{
              if(work.startedAt!==null)ledger.startTurn(work.key,work.startedAt,"unknown");
              if(work.trusted)ledger.recoverSubmission(work.trusted);
              ledger.recordAdmission(work.key,work.inputId);
            });
            break;
          }
          catch (failure) {
            const code = (failure as { errcode?: number }).errcode;
            if ((code !== 5 && code !== 6) || Date.now() >= until) { error = true; break; }
            await new Promise(resolve => setTimeout(resolve, 5));
          }
        }
        parentPort!.postMessage({ id: message.id, error, result });
      }
    } finally { working = false; }
  }
  parentPort!.on("message", message => { queue.push(message); void drain(); });
  parentPort!.on("close", () => state.close());
}
