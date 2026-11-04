import {randomUUID} from 'node:crypto';

const MAX_BYTES=32*1024*1024;
const error=(message,status=502)=>Object.assign(new Error(message),{code:'image_generation_failed',status});
async function bytes(response){const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>MAX_BYTES)throw error('图像服务结果超过大小限制');chunks.push(chunk);}return Buffer.concat(chunks);}
function reference(image){
  const url=image?.image_url;
  if(typeof url!=='string'||!/^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/u.test(url)||url.length>MAX_BYTES)throw error('当前图像服务仅支持内联 PNG、JPEG 或 WebP 参考图',400);
  return{type:'image_url',image_url:{url}};
}

/** Dedicated Hunyuan protocol adapter. No conversation history or text credentials. */
export async function generateCustomImage(incoming,selected,{signal,fetchImpl=fetch}={}){
  if(typeof incoming.prompt!=='string'||!incoming.prompt.trim()||incoming.prompt.length>32000)throw error('图像提示词无效',400);
  if(incoming.background==='transparent')throw error('此图像服务尚未验证透明背景能力，请使用普通背景',422);
  if(incoming.size&&incoming.size!=='auto'||incoming.quality&&incoming.quality!=='auto'||incoming.n&&incoming.n!==1)throw error('此图像服务暂不支持指定尺寸、质量或多张输出',422);
  const images=incoming.images??[];if(!Array.isArray(images)||images.length>1)throw error('此图像服务目前仅验证了单张参考图',422);
  const endpoint=new URL(selected.provider.baseUrl);
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw error('图像服务地址无效',400);
  const response=await fetchImpl(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+selected.apiKey},
    body:JSON.stringify({model:selected.model.id,session:'opencraft-image-'+randomUUID(),messages:[{role:'user',content:[{type:'text',text:incoming.prompt},...images.map(reference)]}]}),signal,redirect:'manual'});
  if(!response.ok)throw error(`图像服务拒绝请求（HTTP ${response.status}）`,response.status>=400?response.status:502);
  let doc;try{doc=JSON.parse((await bytes(response)).toString())}catch{throw error('图像服务没有返回有效 JSON 图片结果');}
  if(doc.status!=='succeeded')throw error('图像服务未完成生成，请稍后重试');
  const url=doc.choices?.find(choice=>choice.delta?.type==='image')?.delta?.image?.url;
  if(typeof url!=='string')throw error('图像服务未返回图片地址');
  let download;try{download=new URL(url)}catch{throw error('图像服务返回了无效图片地址');}
  // This protocol currently returns Tencent COS artifacts; never fetch arbitrary upstream URLs.
  if(download.protocol!=='https:'||download.username||download.password||!download.hostname.endsWith('.myqcloud.com'))throw error('图像服务返回了不受支持的图片来源');
  const image=await fetchImpl(download,{signal,redirect:'manual'});
  if(!image.ok)throw error(`生成成功，但图片下载失败（HTTP ${image.status}）`);
  const content=await bytes(image);
  if(!content.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw error('图像服务返回的图片不是支持的 PNG 格式');
  return{created:Math.floor(Date.now()/1000),background:'opaque',data:[{b64_json:content.toString('base64')} ]};
}
