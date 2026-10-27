import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { downloadCandidate, npmTransport } from '../../scripts/full-release/download.mjs';

test('npm-authenticated HTTPS stream binds the URL, rejects redirects and bounds bytes before tar parsing', async t => {
  const root=await mkdtemp(join(tmpdir(),'join-stream-download-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const key=join(root,'key'),cert=join(root,'cert');
  await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost']);
  const payload=Buffer.from('opaque archive bytes; this downloader never parses tar'), integrity='sha512-'+createHash('sha512').update(payload).digest('base64');
  const requests=[];let sawCredential=false;let uploaded;let uploadCredential;
  const server=createServer({key:await readFile(key),cert:await readFile(cert)},(request,response)=>{
    requests.push(request.url);sawCredential ||= request.headers.authorization==='Bearer fixture-download-credential';
    if(request.method==='PUT'){
      uploadCredential=request.headers.authorization;
      const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{uploaded=Buffer.concat(chunks);response.writeHead(201);response.end('{}');});return;
    }
    if(request.url==='/npm/redirect'){response.writeHead(302,{location:'/npm/never'});response.end();return;}
    if(request.url==='/npm/oversize'){response.write(Buffer.alloc(payload.length+1));response.end();return;}
    response.setHeader('content-length',payload.length);response.end(payload);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const registry='https://127.0.0.1:'+server.address().port+'/npm/', userconfig=join(root,'npmrc');
  await writeFile(userconfig,'strict-ssl=false\n//127.0.0.1:'+server.address().port+'/:_authToken=fixture-download-credential\n',{mode:0o600});
  const npmCli=await realpath((await promisify(execFile)('which',['npm'])).stdout.trim());
  const spec={url:registry+'payload',registry,userconfig,npmCli,compressedBytes:payload.length,integrity,destination:join(root,'archive.tgz')};
  assert.equal((await downloadCandidate(spec,await npmTransport(spec))).status,'downloaded');assert.ok(sawCredential);
  assert.deepEqual(await readFile(spec.destination),payload);await rm(spec.destination);
  await assert.rejects(downloadCandidate({...spec,url:registry+'redirect'},await npmTransport(spec)),/redirect/);
  assert.ok(!requests.includes('/npm/never'));
  await assert.rejects(downloadCandidate({...spec,url:registry+'oversize'},await npmTransport(spec)),/budget/);
  await assert.rejects(stat(spec.destination),{code:'ENOENT'});
  await assert.rejects(downloadCandidate({...spec,integrity:'sha512-'+Buffer.alloc(64).toString('base64')},await npmTransport(spec)),/bytes mismatch/);
  await assert.rejects(stat(spec.destination),{code:'ENOENT'});
  let consumed=0;
  async function* chunks(){for(let i=0;i<100;i++){consumed++;yield Buffer.alloc(32);}}
  await assert.rejects(downloadCandidate(spec,async url=>({status:200,url,headers:new Headers(),body:chunks()})),/budget/);
  assert.equal(consumed,2);await assert.rejects(stat(spec.destination),{code:'ENOENT'});
  const transport=await npmTransport(spec);
  const {Readable}=await import('node:stream');
  const written=await transport(registry+'publish',{method:'PUT',headers:{'content-type':'application/json','content-length':'7','Authorization':'untrusted-override'},body:Readable.from(['{"a":1}'])});
  assert.equal(written.status,201);await written.text();assert.equal(uploaded.toString(),'{"a":1}');
  assert.equal(uploadCredential,'Bearer fixture-download-credential');
  assert.throws(()=>transport('https://unverified.invalid/'),/origin/);
});
