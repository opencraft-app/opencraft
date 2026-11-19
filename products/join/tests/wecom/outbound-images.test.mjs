import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {join} from 'node:path';
import {createMirrorTarget} from '../../plugins/wecom/mirror/target.mjs';
import {stageGroupFile,stagedGroupFile} from '../../plugins/wecom/outbound-files.mjs';

test('generated PNG is sent as a native picture; oversized images retain file delivery',async t=>{
 const root=fs.mkdtempSync(join(os.tmpdir(),'wecom-pictures-')),saved={OPENCRAFT_DATA_DIR:process.env.OPENCRAFT_DATA_DIR,OPENCRAFT_WORKSPACE_DIR:process.env.OPENCRAFT_WORKSPACE_DIR};
 process.env.OPENCRAFT_DATA_DIR=root;process.env.OPENCRAFT_WORKSPACE_DIR=root+'-ws';
 t.after(()=>{for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;fs.rmSync(root,{recursive:true,force:true});});
 const calls=[];const target=await createMirrorTarget({relayOrigin:'https://relay.example/',serverId:'one',credential:'c'.repeat(43),corpId:'wxfixture'},
 {collaboration:{synchronizeChannels:async()=>[]}},async(url,init)=>{const action=new URL(url).pathname.split('/').at(-1);calls.push({action,body:JSON.parse(init.body)});return Response.json(action==='image-upload'?{mediaId:'picture'}:{status:'delivered'});});
 t.after(()=>target.close());
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQmcAAAAASUVORK5CYII=','base64');
 stageGroupFile('picture','chart.png',bytes);
 assert.equal(await target.send({source:'source',requestId:'picture',replyTo:'image-request'},new AbortController().signal),'delivered');
 assert.deepEqual(calls.map(c=>c.action),['image-upload','image-send']);assert.equal(calls[0].body.type,'image/png');assert.equal(calls[1].body.replyTo,'image-request');assert.equal(stagedGroupFile('picture'),null);
 calls.length=0;stageGroupFile('large','large.png',Buffer.concat([bytes,Buffer.alloc(2*1024*1024)]));
 assert.equal(await target.send({source:'source',requestId:'large'},new AbortController().signal),'delivered');assert.deepEqual(calls.map(c=>c.action),['file-send']);
});

test('explicit file preserves image bytes and animation; explicit image never silently becomes a file',async t=>{
 const root=fs.mkdtempSync(join(os.tmpdir(),'wecom-explicit-picture-')),old=process.env.OPENCRAFT_DATA_DIR,oldWs=process.env.OPENCRAFT_WORKSPACE_DIR;process.env.OPENCRAFT_DATA_DIR=root;process.env.OPENCRAFT_WORKSPACE_DIR=root+'-ws';t.after(()=>{if(oldWs===undefined)delete process.env.OPENCRAFT_WORKSPACE_DIR;else process.env.OPENCRAFT_WORKSPACE_DIR=oldWs;if(old===undefined)delete process.env.OPENCRAFT_DATA_DIR;else process.env.OPENCRAFT_DATA_DIR=old;fs.rmSync(root,{recursive:true,force:true});});
 const calls=[],target=await createMirrorTarget({relayOrigin:'https://relay.example/',serverId:'one',credential:'c'.repeat(43),corpId:'wxfixture'},{collaboration:{synchronizeChannels:async()=>[]}},async(url,init)=>{calls.push({action:new URL(url).pathname.split('/').at(-1),body:JSON.parse(init.body)});return Response.json({status:'delivered'});});t.after(()=>target.close());
 const bytes=Buffer.from('GIF89a original animation and metadata');stageGroupFile('original','animation.gif',bytes,{mode:'file'});assert.equal(await target.send({source:'source',requestId:'original',replyTo:'file-request'},AbortSignal.timeout(2000)),'delivered');assert.deepEqual(calls.map(c=>c.action),['file-send']);assert.deepEqual(Buffer.from(calls[0].body.bytes,'base64'),bytes);assert.equal(calls[0].body.replyTo,'file-request');
 calls.length=0;stageGroupFile('bad-image','note.txt',Buffer.from('not an image'),{mode:'image'});assert.equal(await target.send({source:'source',requestId:'bad-image',replyTo:'bad-request'},AbortSignal.timeout(2000)),'rejected');assert.deepEqual(calls.map(c=>c.action),['presentation-settle']);assert.equal(calls[0].body.replyTo,'bad-request');
});
