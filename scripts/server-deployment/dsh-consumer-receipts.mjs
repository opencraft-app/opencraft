import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,lstatSync,writeFileSync,openSync,closeSync,fsyncSync,renameSync} from 'node:fs';
import {join} from 'node:path';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Provider-side leases for the actual Pi/gateway consumer. Socket delivery is
 * not application acceptance. Only the exact returned proof retires a lease. */
export class DshConsumerReceipts {
  constructor(directory) {
    this.directory=directory;this.path=join(directory,'consumer-receipts.json');this.failed=false;this.rows=Object.create(null);
    try {
      const info=lstatSync(this.path);
      if(!info.isFile()||info.uid!==process.getuid()||info.mode&0o077)throw Error('Private DSH consumer receipts required');
      const saved=JSON.parse(readFileSync(this.path,'utf8'));
      if(saved.schemaVersion!==1||!saved.rows||typeof saved.rows!=='object'||Array.isArray(saved.rows)
        ||Object.values(saved.rows).some(row=>!row||typeof row.request!=='string'||!['unknown','receipt'].includes(row.state)||row.state==='receipt'&&typeof row.receipt!=='string'))throw Error('Invalid DSH consumer receipts');
      this.rows=Object.assign(Object.create(null),saved.rows);
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  save() {
    const temporary=this.path+'.'+randomUUID()+'.tmp';
    try {
      writeFileSync(temporary,JSON.stringify({schemaVersion:1,rows:this.rows}),{mode:0o600,flag:'wx'});
      const fd=openSync(temporary,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
      renameSync(temporary,this.path);const root=openSync(this.directory,'r');try{fsyncSync(root);}finally{closeSync(root);}
    }catch(error){this.failed=true;throw error;}
  }
  begin(request) {
    if(this.failed)throw Error('DSH consumer custody unknown');
    const id=randomUUID();this.rows[id]={request:hash(request),state:'unknown'};this.save();
    return packet=>{
      if(this.failed)throw Error('DSH consumer custody unknown');
      const receipt=hash({id,request:this.rows[id].request,packet});
      this.rows[id]={...this.rows[id],state:'receipt',receipt};this.save();return{id,receipt};
    };
  }
  acknowledge(input) {
    if(this.failed||!input||typeof input.id!=='string'||typeof input.receipt!=='string')throw Error('Invalid consumer receipt');
    const row=this.rows[input.id];
    if(!row||row.state!=='receipt'||row.receipt!==input.receipt)throw Error('Exact consumer receipt required');
    delete this.rows[input.id];this.save();
  }
  observation(){return{coverage:this.failed?'unknown':'complete',activeCount:this.failed?null:Object.keys(this.rows).length};}
}
