import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { trackSocketHeartbeat } from '../../scripts/websocket-heartbeat.mjs';
function fixture() {
 let time = 0, callback, token;
 const events = [], socket = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0,
  ping(data, _mask, cb) { token = data; callback = cb; },
  terminate() { this.readyState = 3; this.emit('close'); },
 });
 const check = trackSocketHeartbeat(socket, { intervalMs: 100, now: () => time, diagnostic: (event, fields) => events.push({event,...fields}) });
 return {socket,check,events,at(value){time=value;},flush(){callback();},pong(){socket.emit('pong',Buffer.from(token));}};
}
test('queued Ping cannot be called a peer heartbeat timeout; its own full interval starts on flush',()=>{
 const f=fixture();f.socket.bufferedAmount=1000;f.check();f.at(100);f.check();f.at(200);f.check();
 assert.equal(f.socket.readyState,1);assert.equal(f.events[0].event,'heartbeat-write-pending');
 f.at(250);f.flush();f.at(300);f.check();assert.equal(f.socket.readyState,1);
 f.at(350);f.check();assert.equal(f.socket.readyState,3);
 assert.equal(f.events.at(-1).event,'heartbeat-timeout');assert.equal(f.events.at(-1).queuedMs,250);assert.equal(f.events.at(-1).sentAgeMs,100);
});
test('a drained Ping and matching Pong retire the probe; healthy checks stay quiet',()=>{
 const f=fixture();f.check();f.flush();f.at(50);f.pong();f.at(100);f.check();f.flush();f.pong();
 assert.equal(f.socket.readyState,1);assert.deepEqual(f.events,[]);
});
test('unsolicited Pong cannot acknowledge a different probe',()=>{
 const f=fixture();f.check();f.flush();f.socket.emit('pong',Buffer.from('old'));
 f.at(100);f.check();assert.equal(f.events.at(-1).event,'heartbeat-timeout');
});
test('progress extends the queued write deadline, but a stuck writer is bounded',()=>{
 const f=fixture();f.socket.bufferedAmount=1000;f.check();f.at(300);f.socket.bufferedAmount=900;f.check();
 f.at(600);f.check();assert.equal(f.socket.readyState,1);f.at(700);f.check();assert.equal(f.socket.readyState,3);
 assert.equal(f.events.at(-1).event,'heartbeat-write-stalled');
 f.flush();f.at(900);f.check();assert.equal(f.events.filter(x=>x.event==='heartbeat-write-stalled').length,1);
});
test('slow reader drains a real large frame and survives; the old interval policy kills the same queued probe',async context=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));
 let peer;server.on('connection',ws=>{peer=ws;});
 const client=new WebSocket(`ws://127.0.0.1:${server.address().port}`);client.on('error',()=>{});
 context.after(()=>{client.terminate();peer?.terminate();server.close();});
 await new Promise((r,j)=>{client.once('open',r);client.once('error',j);});client._socket.pause();
 let time=0;const events=[];
 const check=trackSocketHeartbeat(peer,{intervalMs:100,now:()=>time,diagnostic:(event,fields)=>events.push({event,...fields})});
 peer.send(Buffer.alloc(16*1024*1024));check();await new Promise(r=>setTimeout(r,30));
 assert.ok(peer.bufferedAmount>0,'large frame is actually queued');time=100;check();time=200;check();
 assert.equal(peer.readyState,WebSocket.OPEN,'missed global heartbeat ticks do not kill an unsent probe');
 const pong=new Promise(r=>peer.once('pong',r));client._socket.resume();
 await Promise.race([pong,new Promise((_,j)=>setTimeout(()=>j(Error('Pong did not arrive after drain')),2000).unref())]);
 time=250;check();assert.equal(peer.readyState,WebSocket.OPEN);assert.ok(events.some(e=>e.event==='heartbeat-recovered'));
});
