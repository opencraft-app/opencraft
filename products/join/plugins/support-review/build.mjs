import {build} from 'esbuild';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parseManifest} from '../../runtime-plugins/store.mjs';
const product=dirname(fileURLToPath(import.meta.url));
export async function buildSupportReviewPackage(output,sourceRevision) {
  if(!/^[a-f0-9]{40}$/u.test(sourceRevision??''))throw Error('Supply a fixed full source revision');
  await mkdir(output,{recursive:true});
  if((await readdir(output)).length)throw Error('Runtime plugin output directory must be empty');
  const files=[];
  for(const role of ['gateway','execution']) {
    const path=role+'.mjs',outfile=join(output,path);
    const result=await build({entryPoints:[join(product,'src',role+'-entry.ts')],outfile,bundle:true,
      platform:'node',format:'esm',target:'node26',metafile:true});
    if(Object.values(result.metafile.outputs).some(value=>value.imports.some(entry=>!entry.path.startsWith('node:'))))throw Error('Runtime plugin requires an undeclared dependency');
    const bytes=await readFile(outfile);files.push({path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  const manifest=parseManifest({schemaVersion:1,id:'join.support-review',version:'0.3.0',hostApi:1,nodeMajor:26,sourceRevision,
    roles:{gateway:{entry:'gateway.mjs',routes:[{path:'/__opencraft_enterprise_identity/support-reviews',methods:['GET','POST']}]},execution:{entry:'execution.mjs'}},files});
  await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const output=process.argv[2];if(!output)throw Error('Usage: build.mjs OUTPUT_DIRECTORY SOURCE_REVISION');
  console.log(JSON.stringify(await buildSupportReviewPackage(resolve(output),process.argv[3])));
}
