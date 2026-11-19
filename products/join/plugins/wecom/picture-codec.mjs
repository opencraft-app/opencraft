import {createRequire as createPictureRequire} from 'node:module';
import {channelImageType} from '@opencraft/appserver-protocol';
const pictureRequire=createPictureRequire(import.meta.url);
let codec;
function sharp() {
  if(codec)return codec;
  try{codec=pictureRequire('sharp');}catch{codec=createPictureRequire(new URL('./dsh/package.json',import.meta.url))('sharp');}
  return codec;
}
/** Decode only bounded raster formats. The original bytes are never overwritten. */
export async function nativePicture(bytes,{force=false}={}) {
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>20*1024*1024)return null;
  const b=Buffer.from(bytes);
  const raster=b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||b[0]===255&&b[1]===216&&b[2]===255||['GIF87a','GIF89a'].includes(b.subarray(0,6).toString())||b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP'||['II*\0','MM\0*'].includes(b.subarray(0,4).toString())||b.subarray(4,8).toString()==='ftyp'&&/avif|avis|heic|heix|mif1/u.test(b.subarray(8,32).toString());
  if(!raster)return null;
  const type=channelImageType(bytes);
  if(type&&!force)return {bytes:Buffer.from(bytes),type};
  try {
    const decode=()=>sharp()(bytes,{limitInputPixels:24000000,animated:false,failOn:'warning'}).timeout({seconds:8});
    const meta=await decode().metadata();
    if(!['png','jpeg','webp','gif','tiff','avif','heif'].includes(meta.format)||!meta.width||!meta.height||meta.width*meta.height>24000000)return null;
    for(const [width,quality] of [[2048,85],[1600,75],[1280,65]]) {
      const out=await decode().rotate().resize({width,height:width,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality,mozjpeg:false}).toBuffer();
      if(channelImageType(out))return {bytes:out,type:'image/jpeg'};
    }
  }catch{ /* Unsupported/corrupt/oversized decode keeps the normal file fallback. */ }
  return null;
}
