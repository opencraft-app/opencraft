/** Private assistant/conversation-bound agent launcher. No provider credentials. */
export async function scopedWecomCli(argv,connectionFile) {
  const fs=await import('node:fs/promises'),{basename}=await import('node:path');
  const stdin=async()=>{let body='';for await(const c of process.stdin){body+=c;if(Buffer.byteLength(body)>32000)throw Error('Input exceeds 32 KiB');}return body;};
  const invoke=async args=>{
    const {createConnection}=await import('node:net');
    const stat=await fs.lstat(connectionFile);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||stat.uid!==process.getuid()||stat.size>4096)throw Error('Invalid private CLI binding');
    const config=JSON.parse(await fs.readFile(connectionFile,'utf8'));
    if(typeof config.socket!=='string'||!config.socket.startsWith('/')||Buffer.byteLength(config.socket)>100||typeof config.token!=='string')throw Error('Invalid private CLI binding');
    return new Promise((resolve,reject)=>{
      let body='',done=false;const socket=createConnection(config.socket),finish=(error,result)=>{if(done)return;done=true;socket.destroy();error?reject(error):resolve(result);};
      socket.setEncoding('utf8');socket.setTimeout(30000,()=>finish(Error('wecom_outcome_unknown_reuse_same_key')));
      socket.once('error',()=>finish(Error('wecom_cli_unavailable')));
      socket.once('connect',()=>socket.write(JSON.stringify({token:config.token,argv:args})+'\n'));
      socket.on('data',chunk=>{body+=chunk;if(Buffer.byteLength(body)>4*1024*1024)return finish(Error('CLI response too large'));if(body.includes('\n')){try{const r=JSON.parse(body.slice(0,body.indexOf('\n')));r.error?finish(Object.assign(Error(r.error),{correlationId:typeof r.correlationId==='string'&&/^[a-f0-9]{32}$/u.test(r.correlationId)?r.correlationId:undefined})):finish(null,r.result);}catch{finish(Error('wecom_outcome_unknown_reuse_same_key'));}}});
      socket.once('end',()=>{if(!done)finish(Error('wecom_outcome_unknown_reuse_same_key'));});
    });
  };
  if(argv[0]==='sync'&&argv.includes('--help')) {process.stdout.write('Connection maintenance (native owner only): sync status | refresh | configure JSON | request JSON | cancel OPID --group ID --idempotency-key KEY\nOrdinary group edits use chat rename/add/remove. See GROUP-SYNC.md for policy and diagnostics.\n');return;}
  if(!argv.length||argv.includes('--help')||argv[0]==='help') {
    process.stdout.write('wecom capabilities | groups\nwecom chat get|live|members|quit --group ID [--idempotency-key KEY]\nwecom chat create TITLE USER... | rename NAME | add USER... | remove USER... --group ID --idempotency-key KEY\nwecom history | search QUERY | file info REFERENCE | image get MESSAGEID | status RECEIPT --group ID\nwecom send text|md CONTENT | image|file PATH | rich JSON --group ID --idempotency-key KEY\nwecom card notice|news|buttons|vote|select JSON --group ID --idempotency-key KEY\nwecom task list [--before OFFSET] [--limit N] | get TASKKEY (current group runtime only)\nwecom shortcuts [JSON] | task stop|rerun TASKKEY | daily pause --group ID --idempotency-key KEY\nwecom watch add NAME JSON | list | remove NAME --idempotency-key KEY (current group runtime only)\nwecom collection list | get TASKID [--before OFFSET] | close|export|cancel TASKID --idempotency-key KEY\nJSON: literal, file path, @path, or stdin (-). Managed OpenCraft card schema; see capabilities.\nReturns JSON receipts; status accepts messageId or receiptId. Group edits: local.applied is local success, only wecom.confirmed verifies WeCom completion. USER is RTX. Do not repeat an uncertain edit with a new key. Identity and scope come from this private assistant binding.\n');return;
  }
  argv=[...argv];
  if(argv[0]==='send'&&['image','file'].includes(argv[1])) {
    const name=argv[2];if(!name||name.startsWith('--'))throw Error('File path required');
    const fd=await fs.open(name,'r');let bytes;
    try{const s=await fd.stat();if(!s.isFile()||s.size<1||s.size>20*1024*1024)throw Error('Expected a nonempty file <=20 MiB');bytes=Buffer.alloc(s.size);let offset=0;while(offset<bytes.length){const {bytesRead}=await fd.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw Error('File changed');offset+=bytesRead;}const a=await fd.stat();if(a.size!==s.size||a.mtimeMs!==s.mtimeMs)throw Error('File changed');}finally{await fd.close();}
    let result;for(let offset=0;offset<bytes.length;offset+=40*1024)result=await invoke(['upload',JSON.stringify({name:basename(name),mode:argv[1],offset,size:bytes.length,data:bytes.subarray(offset,offset+40*1024).toString('base64')}),...argv.slice(3)]);
    process.stdout.write(JSON.stringify(result)+'\n');return;
  }
  const json=argv[0]==='card'||argv[0]==='send'&&argv[1]==='rich'||argv[0]==='shortcuts'||argv[0]==='watch'&&argv[1]==='add'||argv[0]==='sync'&&['configure','request'].includes(argv[1]),index=argv[0]==='shortcuts'?1:argv[0]==='watch'?3:2;
  if(json&&argv[index]&&!argv[index].startsWith('--')) {
    const v=argv[index];argv[index]=v==='-'?await stdin():v.trimStart().startsWith('{')?v:await fs.readFile(v.startsWith('@')?v.slice(1):v,'utf8');
    if(Buffer.byteLength(argv[index])>32000)throw Error('JSON exceeds 32 KiB');JSON.parse(argv[index]);
  }
  if(argv[0]==='send'&&['text','md'].includes(argv[1])&&argv[2]==='-')argv[2]=await stdin();
  process.stdout.write(JSON.stringify(await invoke(argv))+'\n');
}
