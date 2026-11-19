import {readFileSync,realpathSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
/** Reused third-party dependencies are fine; workspace packages must resolve to this assembly. */
export function verifyWorkspaceBindings(root){
 const definitions=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).workspaces;
 for(const pattern of definitions){
  if(typeof pattern!=='string'||(pattern.includes('*')&&!pattern.endsWith('/*')))throw Error('Unsupported workspace pattern');
  const directories=pattern.endsWith('/*')?readdirSync(join(root,pattern.slice(0,-2)),{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>join(root,pattern.slice(0,-2),e.name)):[join(root,pattern)];
  for(const directory of directories){
   let name;try{name=JSON.parse(readFileSync(join(directory,'package.json'),'utf8')).name;}catch(error){if(error.code==='ENOENT')continue;throw error;}
   if(!name)continue;
   if(realpathSync(join(root,'node_modules',name))!==realpathSync(directory))throw Error('Workspace dependency points outside the selected source assembly: '+name+'; run bootstrap for this assembly');
  }
 }
}
