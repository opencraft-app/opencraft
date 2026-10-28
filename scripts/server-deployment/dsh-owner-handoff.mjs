import { DshConsumerReceipts } from './dsh-consumer-receipts.mjs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, lstatSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync } from 'node:fs';
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
    this.rememberCarried();
    if (state.phase === 'open') await this.authority.fence({expectedOwner:state.owner,expectedEpoch:state.epoch,
      operationId:'native-loss-'+randomUUID(),fence:randomUUID()});
  }
  unknownList(native) { return native.records.flatMap(row=>row.transferableUnknown ?? []); }
  carriedReceipt() {
    const path=join(this.authorityDirectory,'carried-unknown.json');
    try {
      const stat=lstatSync(path);
      if(!stat.isFile() || stat.uid!==process.getuid() || stat.mode & 0o077) throw new Error('Private DSH carried unknown receipt required');
      const receipt=JSON.parse(readFileSync(path,'utf8'));
      if(receipt.schemaVersion!==1 || !Array.isArray(receipt.carriedUnknown)) throw new Error('Invalid DSH carried unknown receipt');
      return receipt;
    } catch(error) { if(error.code==='ENOENT')return null;throw error; }
  }
  receiptMatches(receipt, list) {
    const state=this.authority.snapshot();
    return receipt && ['epoch','operationId','fence','sourceOwner'].every(key=>receipt[key]===state[key])
      && JSON.stringify(receipt.carriedUnknown)===JSON.stringify(list);
  }
  rememberCarried() {
    if (this.authority.snapshot().phase !== 'open') return;
    this.acceptedCarried=undefined;
    try {
      const receipt=this.carriedReceipt();
      if (receipt && this.receiptMatches(receipt,receipt.carriedUnknown)) this.acceptedCarried=receipt;
    } catch { /* Corrupt receipt still yields unknown occupancy; never prevent fencing. */ }
  }
  retainedByFencedWriter(receipt,list) {
    const state=this.authority.snapshot();
    return state.phase === 'fenced' && state.sourceOwner === this.authority.owner && this.acceptedCarried
      && JSON.stringify(receipt) === JSON.stringify(this.acceptedCarried)
      && JSON.stringify(this.acceptedCarried.carriedUnknown) === JSON.stringify(list);
  }
  sealUnknown(list) {
    const state=this.authority.snapshot();
    const receipt={schemaVersion:1,epoch:state.epoch,operationId:state.operationId,fence:state.fence,sourceOwner:state.sourceOwner,carriedUnknown:list};
    const path=join(this.authorityDirectory,'carried-unknown.json'),temporary=path+'.'+randomUUID()+'.tmp';
    writeFileSync(temporary,JSON.stringify(receipt),{flag:'wx',mode:0o600});
    const fd=openSync(temporary,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temporary,path);const directory=openSync(this.authorityDirectory,'r');try{fsyncSync(directory);}finally{closeSync(directory);}
    return receipt;
  }
  async inspect(sealing = false) {
    try {
      const native = await this.host.nativeOwner('inspect'), local = await this.host.handoffObservation(native.records);
      const os = this.inspectOsWork([this.host.engineProcessId]);
      const consumer = this.receipts.observation();
      const complete = this.authority.snapshot().persistence === 'ready' && native.pid === this.host.engineProcessId && typeof native.owner === 'string'
        && [native,local,os,consumer].every(row=>Number.isSafeInteger(row.activeCount) && row.activeCount >= 0) && consumer.coverage === 'complete' && native.coverage === 'complete' && local.coverage === 'complete' && os.coverage === 'complete';
      const list=this.unknownList(native),receipt=this.carriedReceipt();
      const carriedUnknown=sealing || this.receiptMatches(receipt,list) || this.retainedByFencedWriter(receipt,list) ? list : [];
      return {coverage:complete ? 'complete':'unknown',activeCount:complete ? native.activeCount - carriedUnknown.length + local.activeCount + os.activeCount + consumer.activeCount + this.authority.snapshot().activeCalls : null,native,local,os,consumer,carriedUnknown};
    } catch { return {coverage:'unknown',activeCount:null}; }
  }
  async coldProof() {
    const occupancy = await this.inspect();
    if (occupancy.coverage !== 'complete' || occupancy.activeCount !== 0) throw new Error('DSH cold authority incomplete');
    const list=this.unknownList(occupancy.native),receipt=this.carriedReceipt();
    if ((list.length || receipt) && !this.receiptMatches(receipt,list)) throw new Error('DSH carried unknown receipt changed');
    return {carriedUnknown:occupancy.carriedUnknown,runtime:this.runtime,nativeIdentity:{owner:occupancy.native.owner,pid:occupancy.native.pid,configuration:occupancy.native.configuration},stores:await this.host.coldReadResources(),history:occupancy.native.records};
  }
  control(action,input) {
    const operation = this.operation.catch(()=>{}).then(async()=>{
      if (action === 'fence') {
        this.rememberCarried();
        await this.authority.fence(input);
        await this.host.nativeOwner('fence');
      } else if (action === 'release') {
        // Close every native lane, including reads and cancellation, before the
        // final observation. Host authority seals synchronously before stop.
        let stopping = false;
        try {
          await this.host.nativeOwner('seal-release');
          const proof = await this.inspect(true);
          await this.authority.release(input,()=>proof,async()=>{
            stopping = true;
            await this.host.close();
            const os = this.inspectOsWork([]);
            if (os.coverage !== 'complete' || os.activeCount !== 0) throw new Error('DSH writer release unconfirmed');
            this.sealUnknown(proof.carriedUnknown);
            this.released = true;
          });
        } catch (error) {
          if (!stopping) await this.host.nativeOwner('abort-release').catch(()=>{});
          throw error;
        }
      } else if (action === 'cold-ready') await this.authority.coldReady(input,await this.coldProof());
      else if (action === 'resume') {
        await this.authority.resume(input,input.identity ?? '',await this.coldProof());
        await this.host.nativeOwner('resume');
        this.host.resumeBackground();
      } else if (action !== 'inspect') throw new Error('Invalid DSH handoff action');
      return {handoff:this.authority.snapshot(),...(this.released ? {released:true,carriedUnknown:this.carriedReceipt()?.carriedUnknown ?? []}:{occupancy:await this.inspect()})};
    });
    this.operation = operation; return operation;
  }
}
