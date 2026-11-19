import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zipSync, strToU8 } from 'fflate/browser';
import { MirrorService } from '../../plugins/wecom/mirror/service.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { inboundFileId, inboundFileLine, storeInboundFile, materializeInboundFiles, readGroupFile as readOwnedGroupFile } from '../../plugins/wecom/inbound-files.mjs';

function makePdf(lines) {
  const content = `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => (i ? '0 -16 Td ' : '') + `(${l}) Tj`).join(' ')} ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const off = [];
  objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

test('all document types remain byte-identical originals, with metadata only and no automatic text injection',async t=>{
 const dir=fs.mkdtempSync(join(os.tmpdir(),'agent-originals-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const root=join(dir,'files'),originals=join(dir,'originals'),folder=join(dir,'materials'),body='DOCUMENT_CONTENT_MUST_NOT_ENTER_CONTEXT';
 const files=[['report.pdf',makePdf([body])],['report.docx',zipSync({'word/document.xml':strToU8('<w:p><w:t>'+body+'</w:t></w:p>')})],['report.pptx',zipSync({'ppt/slides/slide1.xml':strToU8('<a:p><a:t>'+body+'</a:t></a:p>')})],...['xls','XLSX','xlsm','xlsb','xltx','zip','txt','md','csv','tsv','json','xml','html','js','py','unknown'].map(ext=>['report.'+ext,Buffer.from(body)]),['gbk.txt',Buffer.from([0xc4,0xe3,0xba,0xc3])],['empty.txt',Buffer.alloc(0)]];
 for(const [name,bytes]of files){
  const id=inboundFileId('secret',source,name),meta=await storeInboundFile(id,name,async()=>bytes,{source,root,originals});
  assert.equal(meta.status,'original_only');assert.equal(meta.parts,0);assert.deepEqual(fs.readFileSync(meta.original),Buffer.from(bytes));
  await materializeInboundFiles(inboundFileLine('[文件] '+name,id),folder,{source,root,waitMs:0});
  const result=readGroupFile(folder,id);assert.equal(result.parts,0);assert.equal(result.next,null);assert.equal(result.original,meta.original);assert.equal(result.bytes,bytes.length);
  assert.match(result.overview,/由 agent/u);assert.ok(!JSON.stringify(result).includes(body));assert.equal(fs.readdirSync(join(root,id)).some(n=>/^part\d+\.txt$/u.test(n)),false);assert.equal(fs.readdirSync(join(folder,id)).some(n=>/^part\d+\.txt$/u.test(n)),false);
  assert.throws(()=>readGroupFile(folder,id,'1'),/共 0 段/u);
 }
});
test('legacy text caches for every format are inaccessible even before migration; originals remain available',async t=>{
 const dir=fs.mkdtempSync(join(os.tmpdir(),'agent-legacy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const root=join(dir,'files'),originals=join(dir,'originals'),folder=join(dir,'materials');fs.mkdirSync(originals,{recursive:true});
 for(const ext of ['txt','pdf','docx','xlsx','pptx']){
  const name='old.'+ext,id=inboundFileId('secret',source,name),original=join(originals,name),bytes=Buffer.from('ORIGINAL '+ext);fs.writeFileSync(original,bytes);
  const legacy={name,original,status:'ready',parts:1,chars:123};fs.mkdirSync(join(root,id),{recursive:true});fs.writeFileSync(join(root,id,'meta.json'),JSON.stringify(legacy));fs.writeFileSync(join(root,id,'part1.txt'),'OLD EXTRACTED CONTENT');
  fs.mkdirSync(join(folder,id),{recursive:true});fs.writeFileSync(join(folder,id,'source.json'),JSON.stringify({source,revision:JSON.stringify(legacy)}));fs.writeFileSync(join(folder,id,'README.md'),'OLD EXTRACTED CONTENT');fs.writeFileSync(join(folder,id,'part1.txt'),'OLD EXTRACTED CONTENT');
  assert.ok(!JSON.stringify(readGroupFile(folder,id)).includes('OLD EXTRACTED CONTENT'));assert.throws(()=>readGroupFile(folder,id,'1'),/共 0 段/u);
  const meta=await storeInboundFile(id,name,()=>{throw Error('must not redownload existing originals');},{source,root,originals});assert.equal(meta.status,'original_only');
  await materializeInboundFiles('资料编号 '+id,folder,{source,root,waitMs:0});assert.equal(fs.existsSync(join(folder,id,'part1.txt')),false);assert.deepEqual(fs.readFileSync(original),bytes);assert.equal(readGroupFile(folder,id).original,original);
  fs.rmSync(join(root,id),{recursive:true});fs.writeFileSync(join(folder,id,'part1.txt'),'STALE EXTRACTION');await materializeInboundFiles('资料编号 '+id,folder,{source,root,waitMs:0});assert.equal(fs.existsSync(join(folder,id,'part1.txt')),false);assert.equal(readGroupFile(folder,id).original,original);
 }
});
test('broken or unknown formats are still agent inputs; only the transport byte limit rejects data',async t=>{
 const dir=fs.mkdtempSync(join(os.tmpdir(),'agent-limits-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const root=join(dir,'files'),originals=join(dir,'originals');
 for(const [index,name]of ['broken.pdf','unknown.weird'].entries()){
  const meta=await storeInboundFile(inboundFileId('secret',source,String(index)),name,async()=>Buffer.from('not a valid document'),{source,root,originals});assert.equal(meta.status,'original_only');assert.equal(fs.readFileSync(meta.original,'utf8'),'not a valid document');
 }
 const meta=await storeInboundFile(inboundFileId('secret',source,'huge'),'huge.txt',async()=>Buffer.alloc(20*1024*1024+1),{source,root,originals});assert.equal(meta.status,'too_large');assert.equal(meta.original,undefined);
});

const source = JSON.stringify(['wecom-customer-service', 'wxfixture', 'fwfixture', 'room']);
const readGroupFile=(folder,id,cursor)=>readOwnedGroupFile(folder,id,cursor,{source});
test('the Relay passes a sent file through as a reference, and serves it to the bound server', async () => {
  const ingested = [];
  const store = { snapshot: async () => ({ binding: null }), ingest: async e => { ingested.push(e); return 'stored'; } };
  const svc = new MirrorService({ store, transport: { subscribe: () => () => {} }, servers: [], corpId: 'wxfixture' });
  await svc.ingest({ source, id: 'F1', author: 'T1A', text: '[文件] 清单.pdf', at: 1, mentioned: false, file: { mediaId: 'm1', name: '清单.pdf' } });
  assert.deepEqual(ingested[0].file, { mediaId: 'm1', name: '清单.pdf' });
  assert.equal(ingested[0].text, '[文件] 清单.pdf');
});

test('large text is preserved without decoding, truncation or segmentation, with stable private references',async t=>{
 const dir=fs.mkdtempSync(join(os.tmpdir(),'agent-large-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const root=join(dir,'files'),originals=join(dir,'originals'),folder=join(dir,'materials'),id=inboundFileId('secret',source,'large');
 const bytes=Buffer.from('字'.repeat(1000000));let downloads=0;
 const meta=await storeInboundFile(id,'long.txt',async()=>{downloads++;return bytes;},{source,root,originals});await storeInboundFile(id,'long.txt',()=>{throw Error('cached original should be reused');},{source,root,originals});assert.equal(downloads,1);assert.deepEqual(fs.readFileSync(meta.original),bytes);
 await materializeInboundFiles('资料编号 '+id,folder,{source,root});assert.equal(readGroupFile(folder,id).parts,0);assert.equal(readGroupFile(folder,id).bytes,bytes.length);assert.ok(JSON.stringify(readGroupFile(folder,id)).length<2000);
 assert.throws(()=>readGroupFile(folder,inboundFileId('secret',source,'other')),/不属于本群/u);assert.throws(()=>readGroupFile(folder,'../etc'),/不属于本群/u);
});

test('the gateway tags a sent file with its id, acknowledges first, then fetches and stores it', async () => {
  const { createMirrorTarget } = await import('../../plugins/wecom/mirror/target.mjs');
  const data = fs.mkdtempSync(join(os.tmpdir(), 'gw-')); process.env.OPENCRAFT_DATA_DIR = data; process.env.OPENCRAFT_WORKSPACE_DIR = data + '-ws';
  const order = []; let polled = false;
  const event = { source, id: 'F9', author: 'T1A', text: '[文件] 方案.md', at: 1, mentioned: false, file: { mediaId: 'm9', name: '方案.md' } };
  const fetcher = async (url, options) => {
    const action = String(url).split('/').pop(), body = JSON.parse(options.body);
    order.push(action);
    if (action === 'poll') { const d = polled ? [] : [{ binding: { serverId: 'one', source }, event, token: 't' }]; polled = true; return Response.json({ deliveries: d }); }
    if (action === 'file') { assert.deepEqual(body, { source, mediaId: 'm9' }); return new Response('# 方案\n分三步上线'); }
    return Response.json(action === 'link-poll' ? { links: [] } : {});
  };
  const collaboration = { synchronizeChannels: async () => [] };
  const credential = 'c'.repeat(43);
  const target = await createMirrorTarget({ relayOrigin: 'https://relay.example/', serverId: 'one', credential, corpId: 'wxfixture' }, { collaboration }, fetcher);
  const seen = [];
  target.subscribe(async e => { seen.push(e); return { messageId: 'native-1' }; });
  const id = inboundFileId(credential, source, 'F9');
  const meta = join(data, 'join-wecom-inbound-files', id, 'meta.json');
  for (let i = 0; i < 100 && !fs.existsSync(meta); i++) await new Promise(r => setTimeout(r, 30));
  await target.close();
  assert.equal(seen[0].text, `[文件] 方案.md（资料编号 ${id}）`);
  assert.equal('file' in seen[0], false);
  assert.ok(order.indexOf('ack') < order.indexOf('file'), 'the timeline is never held up by the download');
  const facts=JSON.parse(fs.readFileSync(meta,'utf8'));assert.equal(facts.status,'original_only');assert.equal(fs.readFileSync(facts.original,'utf8'),'# 方案\n分三步上线');assert.equal(fs.existsSync(join(data,'join-wecom-inbound-files',id,'part1.txt')),false);
});

test('a group assistant hands heavy work to its owner\'s own OpenCraft through the platform thread command', async t => {
  const { createWecomAssistantRuntime } = await import('../../plugins/wecom/assistant-runtime.mjs');
  const directory = fs.mkdtempSync(join(os.tmpdir(), 'grp-')), calls = [];
  const scope = 'a'.repeat(64);
  const request = async (method, params) => {
    calls.push([method, params]);
    if (method.endsWith('/scopes')) return [{ scope, channelId: 'ch1' }];
    if (method.endsWith('/messages')) return [];
    if (method === 'opencraft/personal-assistant/threads/command') return { reference: 'ref-1', state: 'submitted' };
    return {};
  };
  let port;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)');
  const start = async options => { port = options.port; return { uow:{db}, dispatch:async()=>({}),close:async()=>{} }; };
  const runtime = createWecomAssistantRuntime({ directory, taskExportRoot:join(directory,'exports'), profileOptions: {}, request, start, onError: () => {} });
  let closed=false;const close=async()=>{if(closed)return;closed=true;await runtime.close();db.close();fs.rmSync(directory,{recursive:true,force:true});};t.after(close);
  await runtime.poll(); await runtime.settle();
  const argv = ['thread', 'start', '--profile', 'default', '--prompt', '读 /x/original.pdf', '--idempotency-key', 'k1'];
  const receipt=await port.request(undefined, 'opencraft/personal-assistant/threads/command', { argv });
  assert.deepEqual({reference:receipt.reference,state:receipt.state},{reference:'ref-1',state:'submitted'});assert.match(receipt.taskKey,/^join:wecom:task-return:[a-f0-9]{64}$/u);
  assert.match(calls.find(([m]) => m.endsWith('threads/command'))[1].argv.join(' '), /读 \/x\/original.pdf.*交付约定/su);
  assert.equal(db.prepare("SELECT count(*) n FROM meta WHERE key LIKE 'join:wecom:task-return:%'").get().n,1);
  await close();
  await assert.rejects(port.request(undefined, 'opencraft/personal-assistant/conversations/list', {}), /Group context denied|Private/u);
});
