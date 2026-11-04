import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readPrivateJson, atomicJson } from '../full-upgrade/durable.mjs';

/** Custody for private aggregate submissions, not a second execution ledger.
 * A failed/uncertain HTTP send is reconciled by the provider's native receipt;
 * neither a reconnect nor a process restart repeats that send. */
export class PiRemoteInputs {
  constructor(directory, owners, admission) {
    this.path = join(directory, 'remote-input-leases.json'); this.owners = owners; this.admission = admission;
    this.leases = new Map(); this.failed = false; this.mutation = Promise.resolve();
  }
  async load() {
    try {
      const value = await readPrivateJson(this.path);
      if (value.schemaVersion !== 1 || !Array.isArray(value.leases)
        || value.leases.some(row => !row || ![row.threadId,row.inputId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 512))) throw new Error('Invalid aggregate input custody');
      for (const row of value.leases) this.leases.set(this.key(row.threadId,row.inputId), row);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  key(threadId,inputId) { return createHash('sha256').update(JSON.stringify([threadId,inputId])).digest('hex'); }
  serialize(run) { const next=this.mutation.catch(()=>{}).then(run);this.mutation=next;return next; }
  async save() {
    try { await atomicJson(this.path,{schemaVersion:1,leases:[...this.leases.values()]}); }
    catch(error) { this.failed=true;throw error; }
  }
  observation() { return { coverage:this.failed || this.leases.size ? 'unknown':'complete', activeCount:this.leases.size }; }
  owner(threadId) { const id=threadId.startsWith('dsh_acp_')?'dsh-acp':threadId.startsWith('claude_')?'claude-code':'acp';const owner=this.owners.get(id);if(!owner)throw new Error('Input engine unavailable');return owner; }
  async reconcile(threadId,inputId) {
    const receipt=await this.owner(threadId).receipt(threadId,inputId);
    if (receipt && ['delivered','discarded'].includes(receipt.state) && this.leases.delete(this.key(threadId,inputId))) await this.save();
    return receipt;
  }
  receipt(threadId,inputId) { return this.admission.run(()=>this.serialize(()=>this.reconcile(threadId,inputId)),true); }
  submit(threadId,inputId,text,admit) {
    return this.admission.run(()=>this.serialize(async()=>{
      if(this.failed)throw new Error('Aggregate input custody unknown');
      const owner=this.owner(threadId), key=this.key(threadId,inputId);
      if(this.leases.has(key)) return await this.reconcile(threadId,inputId) ?? {state:'unknown',turnId:null};
      // Persist intent before HTTP. A failed pre-send authorization produces a
      // definitive null; an exception may already have reached the provider.
      this.leases.set(key,{threadId,inputId});await this.save();
      const result=await owner.submit(threadId,inputId,text,()=>this.admission.open()&&admit());
      if(result===null || ['delivered','discarded'].includes(result?.state)) {this.leases.delete(key);await this.save();}
      return result;
    }));
  }
}
