import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const bundle = await build({stdin:{contents:"export {bindWebRTCInput} from './packages/remote-interaction/src/webrtc';",resolveDir:process.cwd()},
  bundle:true,write:false,format:'iife',globalName:'interaction',platform:'browser'});
const server = createServer((_request,response)=>response.end('<script>'+bundle.outputFiles[0].text+'</script>'));
server.listen(0,'127.0.0.1');await once(server,'listening');
const browser=await chromium.launch({executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,headless:true,args:process.getuid?.()===0?['--no-sandbox']:[]});
try {
  const page=await browser.newPage();
  await page.addInitScript(() => { (window as any).__name = (value: unknown) => value; });
  await page.goto('http://127.0.0.1:'+(server.address() as any).port);
  const evidence=await page.evaluate(async()=>{
    const a=new RTCPeerConnection({iceServers:[]}), b=new RTCPeerConnection({iceServers:[]});
    try {
      const messages:string[]=[];
      const incoming=new Promise<RTCDataChannel>(resolve=>b.ondatachannel=e=>{e.channel.onmessage=m=>messages.push(m.data);resolve(e.channel);});
      const channel=a.createDataChannel('remote-input',{ordered:true});
      const transport=(window as any).interaction.bindWebRTCInput({resourceId:'test-existing',incarnation:'native-1',connectionEpoch:'rtc-1'},channel);
      const before=transport.sendInput('closed-before-open');
      const gather=async(peer:RTCPeerConnection)=>{if(peer.iceGatheringState==='complete')return;await new Promise<void>(resolve=>peer.addEventListener('icegatheringstatechange',()=>{if(peer.iceGatheringState==='complete')resolve();}));};
      await a.setLocalDescription(await a.createOffer());await gather(a);
      await b.setRemoteDescription(a.localDescription!);await b.setLocalDescription(await b.createAnswer());await gather(b);
      await a.setRemoteDescription(b.localDescription!);await incoming;
      if(channel.readyState!=='open')await new Promise<void>(resolve=>channel.addEventListener('open',()=>resolve(),{once:true}));
      const sent=[transport.sendInput('wheel-1'),transport.sendInput('key-up-2')];
      await new Promise<void>((resolve,reject)=>{const end=Date.now()+5000,t=setInterval(()=>{if(messages.length===2){clearInterval(t);resolve();}else if(Date.now()>end){clearInterval(t);reject(Error('RTC delivery timeout'));}},20);});
      return {before,sent,messages,kind:transport.kind,ordered:channel.ordered,maxRetransmits:channel.maxRetransmits,maxPacketLifeTime:channel.maxPacketLifeTime};
    } finally {a.close();b.close();}
  });
  assert.equal(evidence.before,'closed');assert.deepEqual(evidence.sent,['sent','sent']);
  assert.deepEqual(evidence.messages,['wheel-1','key-up-2']);console.log(JSON.stringify({ok:true,...evidence}));
} finally {await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
