import { build } from 'esbuild';
import * as sass from 'sass';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const shared = new Set(['react','react/jsx-runtime','react-intl','@radix-ui/react-dialog','@radix-ui/react-popover',
  '@opencraft/appserver-protocol','@opencraft/extension-react','@opencraft/i18n/react','@opencraft/design-system-web/button',
  '@opencraft/design-system-web/modal-content','@opencraft/design-system-web/dropdown-menu',
  '@opencraft/design-system-web/action-icons','@opencraft/workbench-runtime','@opencraft/appserver-client/transport']);
/** Offline packaging only. Does not install, execute plugins, or touch task data. */
export async function packageVelaWorkspacePlugins({output, sourceRevision}) {
  if (!isAbsolute(output) || !/^[a-f0-9]{40}$/.test(sourceRevision)) throw Error('Absolute output and fixed source revision required');
  const root=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
  await mkdir(output,{recursive:false,mode:0o700});
  const plugins=[];
  for(const [id,entry,fn,args] of [
    ['opencraft.tasks','plugins/tasks/src/index.tsx','createTasksExtension','host.services.tasks'],
    ['join.proj-overview','products/join/plugins/proj-overview/src/index.ts','createProjectOverviewExtension','host.getClient'],
  ]) {
    const css=[];
    const result=await build({stdin:{contents:`import {${fn}} from ${JSON.stringify(join(root,entry))}; export default host=>{${id==='opencraft.tasks'?"if(!host.services?.tasks)throw Error('Workspace task ports unavailable');":''}return ${fn}(${args});};`,resolveDir:root,loader:'ts'},
      bundle:true,write:false,format:'iife',globalName:'__factory',target:'es2022',jsx:'automatic',minify:true,
      banner:{js:'function create(__host){'},footer:{js:'return __factory.default(__host);}'},
      plugins:[{name:'trusted-renderer-bridge',setup(b){
        b.onResolve({filter:/^(?:react(?:\/.*)?|react-intl|@radix-ui\/.*|@opencraft\/.*)$/},args=>{
          if(shared.has(args.path))return {path:args.path,namespace:'host'};
          throw Error('Unsupported external renderer dependency: '+args.path);
        });
        b.onLoad({filter:/.*/,namespace:'host'},args=>({loader:'js',contents:`module.exports=__host.modules[${JSON.stringify(args.path)}];`}));
        b.onLoad({filter:/\.scss$/},args=>{
          const compiled=sass.compile(args.path,{style:'compressed',loadPaths:[join(root,'node_modules')],importers:[{findFileUrl(url){return url.startsWith('@opencraft/design-system/')?pathToFileURL(join(root,'packages/design-system/src',url.slice('@opencraft/design-system/'.length)+'.scss')):null;}}]});
          if(/url\((?!['"]?(?:data:|#))/u.test(compiled.css))throw Error('Renderer has unpackaged CSS assets');
          css.push(compiled.css);return {loader:'js',contents:''};
        });
      }}]});
    const code=result.outputFiles[0].text+`\nexport default {hostApi:'trusted-react-v1',css:${JSON.stringify(css.join('\n'))},create};\n`;
    const bytes=Buffer.byteLength(code);if(bytes>512*1024 || css.join('\n').length>256*1024)throw Error('Renderer exceeds host budget');
    const platforms=id==='opencraft.tasks'?['web','electron']:['web'];
    const manifest={manifestVersion:1,id,name:id==='opencraft.tasks'?'Tasks':'Proj Overview',version:'0.1.0',apiVersion:1,trust:'trusted',platforms,activationEvents:['onStartupFinished']};
    const directory=join(output,'public',id);await mkdir(directory,{recursive:true});await writeFile(join(directory,'plugin.mjs'),code);
    plugins.push({manifest,entry:id+'/plugin.mjs',sha256:createHash('sha256').update(code).digest('hex'),renderer:'trusted-react-v1',replaces:[],configuration:{}});
  }
  await writeFile(join(output,'plugins.json'),JSON.stringify({schemaVersion:1,plugins},null,2)+'\n');
  const receipt={schemaVersion:1,sourceRevision,plugins:plugins.map(p=>({id:p.manifest.id,sha256:p.sha256})),excluded:['task database','credentials','MCP Apps']};
  await writeFile(join(output,'package-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  return receipt;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await packageVelaWorkspacePlugins({output:process.argv[2],sourceRevision:process.argv[3]})));
