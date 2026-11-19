import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {createGroupSelection} from '../plugins/wecom/mirror/selection.mjs';
import {selectionPage} from '../plugins/wecom/mirror/selection-page.mjs';

test('recording directory preserves route aliases separately from stable binding IDs',async t=>{
 const id='opencraft-server',route='lightvela';let bound=false;
 const selection=createGroupSelection({enabled:true,corpId:'test',store:{selection:async()=>({source:'room',userId:'wei'}),snapshot:async()=>({count:1,dropped:0,binding:bound?{serverId:id}:null,channelId:'group:11111111-1111-1111-1111-111111111111',lastDeliveredAt:1}),recordingServers:async()=>[{id}]},transport:{resolveSender:async()=> 'wei'},authenticate:async()=>({origin:'http://join.woa.com',principal:{provider:'tencentoa',expiresAt:Date.now()+60000,attributes:{loginName:'wei'},aliases:['login:wei']}}),listServers:async()=>({servers:[{id,name:'LightVela',route}],pending:false})});
 const server=createServer((req,res)=>selection.ingress(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const get=()=>new Promise((resolve,reject)=>{request({host:'127.0.0.1',port:server.address().port,path:'/wecom/record/test?status',headers:{host:'join.woa.com'}},res=>{let b='';res.on('data',x=>b+=x);res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(b)}));}).on('error',reject).end();});
 let r=await get();assert.equal(r.status,200);assert.deepEqual(r.value.servers,[{id,name:'LightVela',route}]);bound=true;r=await get();assert.equal(r.value.binding.serverId,id);assert.equal(r.value.binding.route,route);
});

test('recording page uses supplied routes for proof and deep links, never stable IDs',()=>{
 const html=selectionPage({enabled:true,servers:[{id:'opencraft-server',name:'LightVela',route:'lightvela'}],queued:1,dropped:0,binding:null});
 assert.match(html,/request\(serverBase\(route\)\+'\/__opencraft_im'/);
 assert.match(html,/serverBase\(b.route\)\+'\/views\//);
 assert.doesNotMatch(html,/encodeURIComponent\((?:serverId|b.serverId)\)/);
 assert.match(html,/request\(location.pathname,\{serverId,code:proof.code\}\)/);
});
