import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { WeComPlugin } from '../../plugins/wecom/src/server';
import type { ImMessage } from '../../plugins/im/src/server';

async function fixture(t:any, receive?: (message: ImMessage) => Promise<void>) {
  const server=new WebSocketServer({port:0,host:'127.0.0.1'}); await once(server,'listening');
  const frames:any[]=[], messages:ImMessage[]=[], errors:string[]=[]; let peer:WebSocket;
  server.on('connection',socket => { peer=socket; socket.on('message',raw => {const frame=JSON.parse(raw.toString()); frames.push(frame); socket.send(JSON.stringify({headers:frame.headers,errcode:0}));}); });
  const address=server.address() as {port:number};
  const plugin=new WeComPlugin({botId:'fixture-bot',secret:'fixture-secret',receive:async m => {messages.push(m); await receive?.(m);},onError:code=>errors.push(code)},() => new WebSocket(`ws://127.0.0.1:${address.port}`));
  t.after(async () => { plugin.close(); for(const socket of server.clients) socket.terminate(); await new Promise<void>(r=>server.close(()=>r())); });
  const until=async (check:()=>boolean) => {for(let n=0;n<100 && !check();n++) await delay(10); assert.ok(check());};
  plugin.start(); await until(()=>plugin.state==='ready');
  const callback=(req:string,body:unknown) => peer.send(JSON.stringify({cmd:'aibot_msg_callback',headers:{req_id:req},body}));
  return {plugin,frames,messages,errors,until,callback,disconnect:()=>peer.terminate()};
}
const body={msgid:'m1',aibotid:'fixture-bot',chattype:'group',chatid:'chat',from:{userid:'external'},msgtype:'text',text:{content:'hello'}};

test('diagnostics distinguish no callback, ignored callback and completed handoff without exposing input', async t => {
  const f = await fixture(t);
  const empty = f.plugin.diagnostics;
  assert.equal(empty.callbacks, 0);
  assert.equal(empty.lastCallbackAt, null);
  assert.ok(empty.lastAcknowledgementAt! >= empty.since);
  f.callback('foreign', {...body, aibotid:'another-bot'});
  await f.until(() => f.plugin.diagnostics.ignored === 1);
  assert.equal(f.plugin.diagnostics.lastIgnoredReason, 'bot_mismatch');
  f.callback('compat', {...body, compat_info:{source:'ai_assistant'}});
  await f.until(() => f.plugin.diagnostics.ignored === 2);
  assert.equal(f.plugin.diagnostics.lastIgnoredReason, 'compatibility_callback');
  f.callback('image', {...body, msgtype:'image'});
  await f.until(() => f.plugin.diagnostics.ignored === 3);
  assert.equal(f.plugin.diagnostics.lastIgnoredReason, 'unsupported_content');
  f.callback('accepted-private-req', {...body,text:{content:'private-message-body'}});
  await f.until(() => f.plugin.diagnostics.completed === 1);
  assert.equal(f.plugin.diagnostics.callbacks, 4);
  assert.equal(f.plugin.diagnostics.forwarded, 1);
  assert.equal(f.plugin.diagnostics.failed, 0);
  assert.equal(empty.callbacks, 0, 'earlier snapshots remain immutable');
  const summary = JSON.stringify(f.plugin.diagnostics);
  for (const value of ['fixture-secret','fixture-bot','external','private-message-body','accepted-private-req']) assert.equal(summary.includes(value), false);
});

test('diagnostics retain a safe admission failure category without logging arbitrary errors', async t => {
  let failure: Error = Object.assign(new Error('private-token-in-error'), {code:'denied'});
  const f = await fixture(t, async () => { throw failure; });
  f.callback('denied',body);
  await f.until(() => f.plugin.diagnostics.failed === 1);
  assert.equal(f.plugin.diagnostics.lastFailure,'denied');
  failure = Object.assign(new Error('private-message-in-error'), {code:'untrusted-arbitrary-code'});
  f.callback('other',body);
  await f.until(() => f.plugin.diagnostics.failed === 2);
  assert.equal(f.plugin.diagnostics.lastFailure,'other');
  assert.equal(f.plugin.diagnostics.completed,0);
  assert.deepEqual(f.errors,['message','message']);
  const summary = JSON.stringify(f.plugin.diagnostics);
  for (const value of ['private-token-in-error','private-message-in-error','untrusted-arbitrary-code']) assert.equal(summary.includes(value),false);
});

test('a callback immediately following the subscription ACK in one receive batch is admitted',async t => {
  const frames:any[]=[], messages:ImMessage[]=[];
  class Socket extends EventEmitter {
    readyState=WebSocket.OPEN;
    send(frame:string,callback?:(error?:Error)=>void) {frames.push(JSON.parse(frame)); callback?.();}
    terminate() {this.emit('close');}
  }
  const socket=new Socket();
  const plugin=new WeComPlugin({botId:'fixture-bot',secret:'fixture-secret',receive:async message=>{messages.push(message);}},()=>socket as unknown as WebSocket);
  t.after(()=>plugin.close()); plugin.start(); socket.emit('open');
  socket.emit('message',Buffer.from(JSON.stringify({headers:frames[0].headers,errcode:0})));
  socket.emit('message',Buffer.from(JSON.stringify({cmd:'aibot_msg_callback',headers:{req_id:'immediate'},body})));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(plugin.state,'ready'); assert.equal(messages.length,1); assert.equal(messages[0].id,'m1');
});

test('WeCom connects, subscribes, normalizes text and awaits ACKs on the original reply request',async t => {
  const f=await fixture(t); assert.equal(f.frames[0].cmd,'aibot_subscribe');
  assert.deepEqual(f.frames[0].body,{bot_id:'fixture-bot',secret:'fixture-secret'});
  f.callback('callback-1',body); await f.until(()=>f.messages.length===1);
  assert.deepEqual(f.messages[0].source,{chatId:'chat',chatType:'group',senderId:'external'});
  await f.messages[0].accepted!(); await f.messages[0].reply('answer');
  const replies=f.frames.filter(frame=>frame.cmd==='aibot_respond_msg');
  assert.equal(replies.length,2); assert.ok(replies.every(frame=>frame.headers.req_id==='callback-1'));
  assert.equal(replies[0].body.stream.finish,false); assert.equal(replies[1].body.stream.finish,true);
  assert.equal(replies[0].body.stream.id,replies[1].body.stream.id);
  await assert.rejects(f.messages[0].reply('duplicate'));
});

test('old callback closures cannot send on a replacement connection; stop prevents reconnect',async t => {
  const f=await fixture(t); f.callback('old',body); await f.until(()=>f.messages.length===1);
  f.disconnect(); await f.until(()=>f.plugin.state==='disconnected');
  await assert.rejects(f.messages[0].reply('late'));
  f.plugin.close(); await delay(1100); assert.equal(f.frames.filter(frame=>frame.cmd==='aibot_subscribe').length,1);
});

test('mixed and direct callbacks retain the external sender, unsupported content is ignored',async t => {
  const f=await fixture(t);
  f.callback('mixed',{...body,chattype:'single',chatid:undefined,msgtype:'mixed',mixed:{msg_item:[{msgtype:'text',text:{content:'one'}},{msgtype:'image'},{msgtype:'text',text:{content:'two'}}]}});
  f.callback('image',{...body,msgtype:'image'}); await f.until(()=>f.messages.length===1);
  assert.equal(f.messages[0].text,'one\ntwo'); assert.deepEqual(f.messages[0].source,{chatId:'external',chatType:'direct',senderId:'external'});
});

test('group bot mentions permit binding commands while ordinary text and direct mentions remain intact',async t => {
  const f=await fixture(t);
  f.callback('new',{...body,msgid:'new',text:{content:'@RobotA /new'}});
  f.callback('switch',{...body,msgid:'switch',text:{content:'@RobotA /switch opencraft://conversation/v1/server/thread'}});
  f.callback('prose',{...body,msgid:'prose',text:{content:'  @RobotA explain this  '}});
  f.callback('direct',{...body,msgid:'direct',chattype:'single',text:{content:'@RobotA /new'}});
  await f.until(()=>f.messages.length===4);
  assert.deepEqual(f.messages.map(message=>message.text),['/new','/switch opencraft://conversation/v1/server/thread','  @RobotA explain this  ','@RobotA /new']);
});


test('empty compatibility metadata retains canonical human identity; declared and malformed sources stay excluded', async t => {
  const f = await fixture(t);
  f.callback('null-compat', {...body, msgid:'null', compat_info:null});
  f.callback('empty-compat', {...body, msgid:'empty', compat_info:{}});
  await f.until(() => f.plugin.diagnostics.completed === 2);
  assert.equal(f.plugin.diagnostics.lastCompatibilitySource, 'empty');
  assert.deepEqual(f.messages.map(m => m.source.senderId), ['external','external']);
  for (const [index, compat_info] of [{source:'ai_assistant'}, {source:'channel'}, {source:'private-unknown-source'}, {unrecognized:'private-value'}, [], '', false].entries()) {
    f.callback('excluded-' + index, {...body, compat_info});
    await f.until(() => f.plugin.diagnostics.ignored === index + 1);
    assert.equal(f.plugin.diagnostics.lastCompatibilitySource, index === 0 ? 'ai_assistant' : index === 1 ? 'channel' : 'other');
  }
  assert.equal(f.messages.length, 2);
  assert.equal(f.plugin.diagnostics.lastIgnoredReason, 'compatibility_callback');
  const summary = JSON.stringify(f.plugin.diagnostics);
  assert.equal(summary.includes('private-unknown-source'), false);
  assert.equal(summary.includes('private-value'), false);
});
