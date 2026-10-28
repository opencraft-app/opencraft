import { DshConsumerReceipts } from './dsh-consumer-receipts.mjs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AcpHostHandoff } from '../../plugins/acp-engine/src/host-handoff.ts';

export class DshOwnerHandoff {
  constructor(directory, runtime, inspectOsWork) {
    this.authorityDirectory = join(directory,'owner-handoff');
    this.authority = new AcpHostHandoff(this.authorityDirectory, randomUUID());
    this.runtime = runtime; this.inspectOsWork = inspectOsWork;
    this.operation = Promise.resolve();
  }
  open = () => this.authority.snapshot().phase === 'open' && this.authority.snapshot().persistence === 'ready';
  run = (operation, reconciliation = false) => this.authority.run(operation,reconciliation);
  async load() { await this.authority.load();this.receipts = new DshConsumerReceipts(this.authorityDirectory); }
  beginReceipt = request => this.receipts.begin(request);
  acknowledgeReceipt = input => this.receipts.acknowledge(input);
  attach(host) { this.host = host; }
  async nativeLost() {
    const state = this.authority.snapshot();
    if (state.phase === 'open') await this.authority.fence({expectedOwner:state.owner,expectedEpoch:state.epoch,
      operationId:'native-loss-'+randomUUID(),fence:randomUUID()});
  }
  async inspect() {
    try {
      const native = await this.host.nativeOwner('inspect'), local = await this.host.handoffObservation(native.records);
      const os = this.inspectOsWork([this.host.engineProcessId]);
      const consumer = this.receipts.observation();
      const complete = this.authority.snapshot().persistence === 'ready' && native.pid === this.host.engineProcessId && typeof native.owner === 'string'
        && [native,local,os,consumer].every(row=>Number.isSafeInteger(row.activeCount) && row.activeCount >= 0) && consumer.coverage === 'complete' && native.coverage === 'complete' && local.coverage === 'complete' && os.coverage === 'complete';
      return {coverage:complete ? 'complete':'unknown',activeCount:complete ? native.activeCount + local.activeCount + os.activeCount + consumer.activeCount + this.authority.snapshot().activeCalls : null,native,local,os,consumer};
    } catch { return {coverage:'unknown',activeCount:null}; }
  }
  async coldProof() {
    const occupancy = await this.inspect();
    if (occupancy.coverage !== 'complete' || occupancy.activeCount !== 0) throw new Error('DSH cold authority incomplete');
    return {runtime:this.runtime,nativeIdentity:{owner:occupancy.native.owner,pid:occupancy.native.pid,configuration:occupancy.native.configuration},stores:await this.host.coldReadResources(),history:occupancy.native.records};
  }
  control(action,input) {
    const operation = this.operation.catch(()=>{}).then(async()=>{
      if (action === 'fence') {
        await this.authority.fence(input);
        await this.host.nativeOwner('fence');
      } else if (action === 'release') {
        // Close every native lane, including reads and cancellation, before the
        // final observation. Host authority seals synchronously before stop.
        await this.host.nativeOwner('seal-release');
        let stopping = false;
        try {
          const proof = await this.inspect();
          await this.authority.release(input,()=>proof,async()=>{
            stopping = true;
            await this.host.close();
            const os = this.inspectOsWork([]);
            if (os.coverage !== 'complete' || os.activeCount !== 0) throw new Error('DSH writer release unconfirmed');
            this.released = true;
          });
        } catch (error) {
          if (!stopping) await this.host.nativeOwner('abort-release');
          throw error;
        }
      } else if (action === 'cold-ready') await this.authority.coldReady(input,await this.coldProof());
      else if (action === 'resume') {
        await this.authority.resume(input,input.identity ?? '',await this.coldProof());
        await this.host.nativeOwner('resume');
        this.host.resumeBackground();
      } else if (action !== 'inspect') throw new Error('Invalid DSH handoff action');
      return {handoff:this.authority.snapshot(),...(this.released ? {released:true}:{occupancy:await this.inspect()})};
    });
    this.operation = operation; return operation;
  }
}
