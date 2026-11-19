import { readFile, writeFile, mkdir, cp, stat } from 'node:fs/promises';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import * as sass from 'sass';

/** Offline operator tool. Consumes preserved product source, never business data,
 * never imports the input package, and never runs its services/worker. */
export async function packageVelaInstance({ source, output, sourceRevision, configuration = {} }) {
  if (!isAbsolute(source) || !isAbsolute(output) || !/^[a-f0-9]{40}$/.test(sourceRevision)) throw Error('Absolute paths and full source revision required');
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) throw Error('Invalid public presentation configuration');
  await mkdir(output, { recursive:false, mode:0o700 });
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
  const directory=join(output,'user-plugins'), publicRoot=join(directory,'public');
  await mkdir(publicRoot,{recursive:true,mode:0o700});
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const plugins=[], receipt={schemaVersion:1,sourceRevision,hostApi:'trusted-react-v1',packages:[],adaptations:[],excluded:['MCP Apps','backend worker execution','credentials','business ledgers']};
  const manifest=(id,name)=>({manifestVersion:1,id,name,version:'0.1.0',apiVersion:1,trust:'trusted',platforms:['web'],activationEvents:['onStartupFinished']});
  async function emit(id,m,code,extra={}) {
    const p=join(publicRoot,id);await mkdir(p,{recursive:true});await writeFile(join(p,'plugin.mjs'),code);
    plugins.push({manifest:m,entry:id+'/plugin.mjs',sha256:hash(code),replaces:[],...extra});
    receipt.packages.push({id,bytes:Buffer.byteLength(code),sha256:hash(code)});
    if(Buffer.byteLength(code)>512*1024)throw Error('Plugin exceeds host budget');
    return p;
  }
  const originalBrand=JSON.parse(await readFile(join(source,'plugins/join/branding.json'),'utf8'));
  const brand=JSON.parse(JSON.stringify(originalBrand).replaceAll('/plugin-assets/join/','/__opencraft_plugins/join.server/'));
  const brandPath=join(publicRoot,'join.server');
  // The retained source has the original mascot image, not the separately generated share-thumbnail-v2.
  if(brand.share?.imageUrl.endsWith('/join-share-thumbnail-v2.jpg')) {
    brand.share.imageUrl='/__opencraft_plugins/join.server/joinvela-mascot-share-512.jpg';
    receipt.adaptations.push('share thumbnail uses preserved original mascot image');
  }
  const bm=manifest('join.server','Vela 品牌');
  await emit('join.server',bm,`export default {manifest:${JSON.stringify(bm)},activate(api){api.internal.register('applicationBranding',${JSON.stringify(brand)});}};`,{branding:{name:brand.name,markUrl:brand.markUrl,faviconUrl:brand.faviconUrl,appleTouchIconUrl:brand.appleTouchIconUrl}});
  const { readdir }=await import('node:fs/promises');
  for(const item of await readdir(join(source,'plugins/join/public'),{withFileTypes:true})) {
    if(!item.isFile() || !/\.(?:png|jpg|webmanifest)$/.test(item.name))continue;
    await cp(join(source,'plugins/join/public',item.name),join(brandPath,item.name));
  }
  const allowed=new Set(['react','react/jsx-runtime','@opencraft/extension-react','@opencraft/design-system-web/action-icons','@opencraft/appserver-client/transport','@opencraft/workbench-runtime']);
  for(const [folder,id,factory,args]of [
    ['support-review','join.support-review','createSupportReviewExtension','host.fetcher,host.getClient'],
    ['lightvela-test-environments','join.lightvela-test-environments','createLightVelaTestEnvironmentsExtension','host.fetcher'],
  ]) {
    const css=[];
    const result=await build({stdin:{contents:`import {${factory}} from ${JSON.stringify(join(source,'plugins',folder,'src/index.ts'))};export default host=>${factory}(${args});`,resolveDir:root,loader:'ts'},
      write:false,bundle:true,format:'iife',globalName:'__velaFactory',target:'es2022',jsx:'automatic',minify:true,
      banner:{js:'export default function(__host) {'},footer:{js:'return __velaFactory.default(__host);}'},
      plugins:[{name:'fixed-renderer-bridge',setup(b){
        b.onResolve({filter:/^(?:react(?:\/.*)?|@opencraft\/.*)$/},args=>{
          if(!allowed.has(args.path))throw Error('Unsupported renderer import: '+args.path);
          return {path:args.path,namespace:'host'};
        });
        b.onLoad({filter:/.*/,namespace:'host'},args=>({contents:`module.exports=__host.modules[${JSON.stringify(args.path)}];`,loader:'js'}));
        b.onLoad({filter:/\.scss$/},async args=>{
          const result=sass.compile(args.path,{loadPaths:[join(root,'node_modules')],style:'compressed',importers:[{findFileUrl(url){return url.startsWith('@opencraft/design-system/')?pathToFileURL(join(root,'packages/design-system/src',url.slice('@opencraft/design-system/'.length)+'.scss')):null;}}]});css.push(result.css);return {contents:'',loader:'js'};
        });
        b.onLoad({filter:/pending-count\.ts$/},async args=>{
          const text=await readFile(args.path,'utf8');
          if(!text.includes("'/__opencraft_enterprise_identity/support-reviews/count'"))throw Error('Unrecognized pending-count source');
          receipt.adaptations.push('pending badge uses the approved review GET endpoint, not a missing /count route');
          return {contents:text.replace("'/__opencraft_enterprise_identity/support-reviews/count'","'/__opencraft_enterprise_identity/support-reviews'"),loader:'ts'};
        });
      }}]});
    const code=result.outputFiles[0].text.replace(/^export default function\(__host\) \{/, 'function create(__host) {')+
      `\nexport default {hostApi:'trusted-react-v1',css:${JSON.stringify(css.join('\n'))},create};`;
    const m=manifest(id,id==='join.support-review'?'任务审核':'LightVela 测试环境');
    // Description is part of the factory's declared identity.
    if(id==='join.lightvela-test-environments')m.description='通过当前企业身份进入已授权的 LightVela 测试环境。';
    await emit(id,m,code,{renderer:'trusted-react-v1',configuration:configuration[id]??{}});
  }
  await writeFile(join(directory,'plugins.json'),JSON.stringify({schemaVersion:1,plugins},null,2)+'\n');
  await writeFile(join(output,'package-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  return receipt;
}
