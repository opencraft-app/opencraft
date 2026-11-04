import {createHash} from 'node:crypto';
import {isAbsolute,join,resolve} from 'node:path';
/** Optional common root for disposable projections, isolated by stable Host
 * data root. Authoritative stores never consume this resolver. */
export function resolveCacheDataDirectory(dataDirectory:string,root=process.env.OPENCRAFT_CACHE_DIRECTORY):string {
  if(!root?.trim())return dataDirectory;
  if(!isAbsolute(root))throw new Error('OPENCRAFT_CACHE_DIRECTORY must be absolute');
  const scope=createHash('sha256').update(resolve(dataDirectory)).digest('hex');
  return join(root,scope);
}
