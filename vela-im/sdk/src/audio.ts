/** Read audio duration from WAV, MP3 and Ogg (Opus/Vorbis) headers; other formats need payload.second. */
export function audioSeconds(bytes:Uint8Array):number|undefined {
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 const tag=(at:number,text:string)=>text.split('').every((c,i)=>bytes[at+i]===c.charCodeAt(0));
 if(tag(0,'RIFF')&&tag(8,'WAVE')) {
  let byteRate=0;
  for(let at=12;at+8<=bytes.length;) {
   const size=view.getUint32(at+4,true);
   if(tag(at,'fmt '))byteRate=view.getUint32(at+16,true);
   if(tag(at,'data')&&byteRate)return Math.max(1,Math.round(Math.min(size,bytes.length-at-8)/byteRate));
   at+=8+size+(size%2);
  }
  return undefined;
 }
 if(tag(0,'OggS')) {
  const rate=tag(28,'OpusHead')?48000:tag(29,'vorbis')?view.getUint32(40,true):0;
  for(let at=bytes.length-14;rate&&at>=0;at--)if(tag(at,'OggS'))return Math.max(1,Math.round(Number(view.getBigUint64(at+6,true))/rate));
  return undefined;
 }
 let at=tag(0,'ID3')?10+((bytes[6]&127)<<21|(bytes[7]&127)<<14|(bytes[8]&127)<<7|(bytes[9]&127)):0;
 for(;at+4<bytes.length&&!(bytes[at]===0xff&&(bytes[at+1]&0xe0)===0xe0);at++);
 if(at+4>=bytes.length)return undefined;
 const version=(bytes[at+1]>>3)&3,layer=(bytes[at+1]>>1)&3,bitIndex=bytes[at+2]>>4,rateIndex=(bytes[at+2]>>2)&3;
 if(layer!==1||bitIndex===0||bitIndex===15||rateIndex===3)return undefined; // MPEG layer III only
 const mpeg1=version===3;
 const bitrate=(mpeg1?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bitIndex]*1000;
 const sampleRate=[44100,48000,32000][rateIndex]/(mpeg1?1:version===2?2:4);
 const samples=mpeg1?1152:576;
 const mono=(bytes[at+3]>>6)===3;
 const xing=at+4+(mpeg1?(mono?17:32):(mono?9:17));
 if((tag(xing,'Xing')||tag(xing,'Info'))&&(bytes[xing+7]&1))return Math.max(1,Math.round(view.getUint32(xing+8)*samples/sampleRate));
 return Math.max(1,Math.round((bytes.length-at)*8/bitrate));
}
