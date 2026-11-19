/** Only the provider's documented CDN. No credentials, custom ports or redirects. */
export function emotionURL(value) {
  if(typeof value!=='string'||value.length>2048)throw Error('Invalid emotion URL');
  const u=new URL(value);
  if(!['http:','https:'].includes(u.protocol)||!['p.qpic.cn','wework.qpic.cn'].includes(u.hostname)||u.port||u.username||u.password||u.hash)throw Error('Untrusted emotion URL');
  u.protocol='https:';return u.href;
}
export async function downloadEmotion(url,signal,fetcher=fetch) {
  const response=await fetcher(emotionURL(url),{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(8000)])});
  const limit=8*1024*1024;
  if(!response.ok||!response.body||Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw Error('Emotion unavailable');}
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw Error('Emotion too large');chunks.push(chunk);}
  return Buffer.concat(chunks,size);
}
