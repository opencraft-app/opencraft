import assert from 'node:assert/strict';
import {build} from 'vite';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,join,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const [pack,out]=process.argv.slice(2);if(!pack||!out)throw Error('pack and output required');
await mkdir(out,{recursive:true});
await build({configFile:false,root:join(root,'products/join/tests/workspace-plugins'),logLevel:'warn',resolve:{dedupe:['react','react-dom','react-intl']},build:{target:'esnext',outDir:join(out,'web'),emptyOutDir:true}});
const mime={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.html':'text/html'};
const server=createServer(async(req,res)=>{try{const pathname=decodeURIComponent(new URL(req.url,'http://test').pathname);let base=join(out,'web');if(pathname==='/plugins.json'){res.setHeader('content-type','application/json');res.end(await readFile(join(pack,'plugins.json')));return;}if(pathname.startsWith('/opencraft.tasks/')||pathname.startsWith('/join.proj-overview/'))base=join(pack,'public');const path=resolve(base,'.'+(pathname==='/'?'/index.html':pathname));if(!path.startsWith(resolve(base)+sep))throw Error('escape');res.setHeader('content-type',mime[extname(path)]??'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404);res.end();}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');
const browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']});
const failures=[];
try{
 for(const [width,colorScheme]of [[390,'light'],[1440,'dark']]){
  const page=await browser.newPage({viewport:{width,height:1000},isMobile:width===390,hasTouch:width===390,colorScheme});
  page.on('pageerror',e=>failures.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForSelector('body[data-ready="true"]');
  await page.getByRole('button',{name:'看板',exact:true}).click();
  await page.waitForFunction(()=>window.workspacePluginProbe.calls.includes('opencraft/tasks/list'));
  await page.getByRole('button',{name:'Proj Overview',exact:true}).click();
  await page.getByText('现有用户',{exact:true}).waitFor();
  assert.equal(await page.locator('nav button').count(),2);
  await page.screenshot({path:join(out,`plugins-${width}-${colorScheme}.png`),fullPage:true});
  await page.evaluate(()=>window.workspacePluginProbe.dispose());
  assert.equal(await page.locator('nav button').count(),0);
  await page.close();
 }
 assert.deepEqual(failures,[]);await writeFile(join(out,'acceptance.json'),JSON.stringify({ok:true,scope:'real trusted renderer and Views; synthetic RPC',widths:[390,1440],failures},null,2));
}finally{await browser.close();await new Promise(done=>server.close(done));}
