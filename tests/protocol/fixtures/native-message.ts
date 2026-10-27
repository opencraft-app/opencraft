import { MemoryTransport, type InMemoryAppServerPeer } from '@opencraft/appserver-transport-memory';
import { WebSocketTransport } from '@opencraft/appserver-transport-websocket';
import { DeferredDuplexTransport, type DuplexTransport } from '@opencraft/appserver-client/transport';
import { MessagePortAppHostClient } from '@opencraft/app-host-client';
import { StatusSocket } from './transport-status';
import { connectWebSocketAppHost } from '../../../apps/workbench-web/src/runtime/websocket-app-host';

export const messageAdapters = ['memory','websocket','deferred','apphost','browser'] as const;
export type MessageAdapter = typeof messageAdapters[number];
export const flushMessages = async () => { for (let i=0;i<64;i++) await Promise.resolve(); };

function rpcReply(frame:string):string|undefined {
  let request: {id?:unknown;method?:string;params?:unknown};
  try {request=JSON.parse(frame);}catch{return undefined;}
  if(request.id===undefined)return undefined;
  const result=request.method==='initialize'
    ? {codexHome:'/fixture',platformFamily:'unix',platformOs:'linux',userAgent:'native-message-fixture'}
    :request.method==='echo'?request.params:undefined;
  return result===undefined?undefined:JSON.stringify({id:request.id,result});
}

export function messageHostFixture() {
  let listener: ((event: MessageEvent<unknown>)=>void)|undefined, closed=false, generation=0;
  const grants=new Map<string,{leaseId:string;generation:number}>();
  const receive=(data:unknown)=>listener?.({data} as MessageEvent<unknown>);
  const client=new MessagePortAppHostClient({
    postMessage(message) {
      if (!('requestId' in message)) return;
      let result: unknown;
      if(message.type==='host/connect') {
        const grant={leaseId:message.leaseId,generation:++generation};grants.set(message.hostId,grant);
        result={hostId:message.hostId,generation:grant.generation};
      }
      queueMicrotask(()=>receive({type:'response',requestId:message.requestId,ok:true,result}));
      if(message.type==='host/send') {
        const reply=rpcReply(message.frame);
        if(reply)queueMicrotask(()=>receive({type:'host/frame',hostId:message.hostId,
          leaseId:message.leaseId,generation:message.generation,frame:reply}));
      }
    },
    addEventListener(_type,next){listener=next;}, removeEventListener(){listener=undefined;},
    start(){},close(){closed=true;},
  },'native-message-fixture');
  receive({type:'ready',protocolVersion:2,services:['appserver']});
  return {client,receive,get closed(){return closed;},
    grant(hostId:string){const grant=grants.get(hostId);if(!grant)throw Error('No Host grant');return grant;},
    frame(hostId:string,frame:string){receive({type:'host/frame',hostId,...this.grant(hostId),frame});},
    lost(hostId:string){receive({type:'host/status',hostId,generation:this.grant(hostId).generation,status:{state:'closed'}});},
  };
}

/** Real transports; only their declared socket, server schedule and MessagePort
 * boundaries are controlled. Publication runs at the actual provider callback. */
class MessageAppHostSocket extends StatusSocket {
  override send(data:string):void {
    super.send(data);const message=JSON.parse(data);
    if(!message.requestId)return;
    const result=message.type==='host/connect'?{hostId:message.hostId,generation:1}:undefined;
    queueMicrotask(()=>this.emitMessage(JSON.stringify({type:'response',requestId:message.requestId,ok:true,result})));
    if(message.type==='host/send') {
      const reply=rpcReply(message.frame);
      if(reply)queueMicrotask(()=>this.emitMessage(JSON.stringify({type:'host/frame',hostId:message.hostId,
        leaseId:message.leaseId,generation:message.generation,frame:reply})));
    }
  }
}

class MessageRpcSocket extends StatusSocket {
  override send(data:string):void {
    super.send(data);const reply=rpcReply(data);
    if(reply)queueMicrotask(()=>this.emitMessage(reply));
  }
}

export function nativeMessageFixture(kind: MessageAdapter) {
  let peer:InMemoryAppServerPeer|undefined;
  const queue:(()=>void)[]=[], sockets:StatusSocket[]=[],driverErrors:unknown[]=[];
  let host:ReturnType<typeof messageHostFixture>|undefined, memory:MemoryTransport|undefined;
  let transport:DuplexTransport, browser:ReturnType<typeof connectWebSocketAppHost>|undefined;
  let previousWindow:PropertyDescriptor|undefined;
  if(kind==='memory'||kind==='deferred') {
    memory=new MemoryTransport({server:{connected(next){peer=next;},receive(frame,current){const reply=rpcReply(frame);if(reply)current.send(reply);}},schedule:f=>queue.push(f)});
    transport=kind==='deferred'?new DeferredDuplexTransport(async()=>memory!):memory;
  } else if(kind==='websocket') {
    transport=new WebSocketTransport({url:'ws://fixture.invalid/rpc',closeTimeoutMs:20,
      createSocket(){const socket=new MessageRpcSocket();sockets.push(socket);return socket;}});
   } else if(kind==='browser') {
    previousWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
    Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{href:'https://fixture.invalid/chat'}}});
    browser=connectWebSocketAppHost(()=>{const socket=new MessageAppHostSocket();sockets.push(socket);return socket as unknown as WebSocket;},
      {recoveryEvents:{isVisible:()=>false,subscribe:()=>()=>{}},reportFailure:()=>{}});
    transport=browser.createTransport('message-host');
  } else {host=messageHostFixture();transport=host.client.createTransport('message-host');}
  const openBrowser=async()=>{await flushMessages();const socket=sockets.at(-1)!;socket.emitOpen();socket.emitMessage(JSON.stringify({type:'ready',protocolVersion:2,services:['appserver']}));};
  const drive=(operation:()=>void)=>{try{operation();}catch(error){driverErrors.push(error);}};
  return {transport,driverErrors,sockets,host,
    async connect(){const promise=transport.connect();void promise.catch(()=>{});if(browser)await openBrowser();else sockets.at(-1)?.emitOpen();await promise;},
    enqueue(frame:string){drive(()=>{if(memory)peer!.send(frame);else if(host)host.frame('message-host',frame);else if(browser){const socket=sockets.at(-1)!;const claim=socket.sent.map(value=>JSON.parse(value)).filter(message=>message.type==='host/connect').at(-1);if(!claim)throw Error('No browser Host grant');socket.emitMessage(JSON.stringify({type:'host/frame',hostId:'message-host',leaseId:claim.leaseId,generation:1,frame}));}else sockets.at(-1)!.emitMessage(frame);});},
    async flush(){await flushMessages();while(queue.length){for(const callback of queue.splice(0))drive(callback);await flushMessages();}},
    async publish(frame:string){this.enqueue(frame);await this.flush();},
    lose(){if(memory)peer!.close();else if(host)host.lost('message-host');else sockets.at(-1)!.emitClose();},
    beginRenew(){
      this.lose();const next=transport.connect();void next.catch(()=>{});return next;
    },
    async finishRenew(next:Promise<void>){if(browser)await openBrowser();else sockets.at(-1)?.emitOpen();await next;await this.flush();},
    async close(){try{browser?.close();await transport.close();}finally{host?.client.close();if(browser){if(previousWindow)Object.defineProperty(globalThis,'window',previousWindow);else delete(globalThis as {window?:unknown}).window;}}},
  };
}
