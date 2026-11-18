import { Readable } from 'node:stream';
import { extname } from 'node:path';
import { ArtifactCatalog, artifactFileBody, type Artifact } from './catalog.js';

export interface GeneratedFileReader {
  (path: string, signal?: AbortSignal): Promise<{body:Readable;dispose():Promise<void>}>;
}
/** Native image events remain displayable. This independently commits their stable output slot. */
export async function captureGeneratedImage(catalog: ArtifactCatalog, scope: string, threadId: string,
  item: Record<string,unknown>, read: GeneratedFileReader = async path=>({body:artifactFileBody(path),dispose:async()=>{}}),
  signal?: AbortSignal): Promise<Artifact | null> {
  if (item.type !== 'imageGeneration' || typeof item.id !== 'string' || !item.id || !threadId
    || item.status && !['completed','complete','success'].includes(String(item.status))) return null;
  const key=JSON.stringify(['generation',threadId,item.id]);
  const owner=JSON.stringify(['thread',threadId]),slot=JSON.stringify(['output',item.id]);
  const existing=catalog.get(catalog.id({scope,key}));

  let mimeType='image/png',body:Readable,dispose=async()=>{};
  const result=typeof item.result==='string'?item.result:'';
  const data=/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(result);
  const encoded=data?.[2] ?? (result && !/^[a-z]+:/i.test(result)?result:'');
  if(encoded) {
    if(encoded.length>Math.ceil(32*1024*1024/3)*4 || encoded.length%4!==0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw Error('Generated image encoding exceeds its budget or is invalid');
    const bytes=Buffer.from(encoded,'base64');
    if(bytes.toString('base64')!==encoded)throw Error('Invalid generated image bytes');
    mimeType=data?.[1]??mimeType;body=Readable.from([bytes]);
  } else if(typeof item.savedPath==='string' && item.savedPath) {
    const file=await read(item.savedPath,signal);body=file.body;dispose=file.dispose;
    mimeType=({'.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'} as Record<string,string>)[extname(item.savedPath).toLowerCase()]??mimeType;
  } else { if(existing){catalog.retain(existing.id,owner,slot);return existing;} return null; } // External URL alone is not a durable artifact; no implicit network fetch.
  const extension=({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'} as Record<string,string>)[mimeType];
  try {
    return await catalog.ingest({scope,key},{name:`generated.${extension}`,mimeType,origin:'generation'},body,
      {maxBytes:1024**3,signal,reference:{owner,slot}});
  } finally {await dispose();}
}
