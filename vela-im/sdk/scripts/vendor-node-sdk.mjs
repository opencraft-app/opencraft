// Copies Tencent's official lite-chat Node build into dist/vendor with the minimum changes needed
// for rich-media upload under Node. Each patch must match exactly once, so an SDK upgrade fails the build
// instead of silently shipping a half-patched SDK.
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const VERSION='4.4.7';
const here=dirname(fileURLToPath(import.meta.url));
const require=createRequire(import.meta.url);
const pkgDir=dirname(require.resolve('@tencentcloud/lite-chat'));
const pkg=JSON.parse(readFileSync(join(pkgDir,'package.json'),'utf8'));
if(pkg.version!==VERSION)throw new Error(`lite-chat ${pkg.version} found; patches are written for ${VERSION}`);

const patches=[
 // Image type check reads File.name only in browsers.
 ['t.IN_BROWSER&&(n=e.name.slice(','(t.IN_BROWSER||t.IN_NODE)&&(n=e.name.slice('],
 // Audio: Node has File and URL.createObjectURL, so the web File path applies.
 ['return s?this._processMiniFile(e):n?this._processWebFile(e):void 0','return s?this._processMiniFile(e):n||this._core.utils.IN_NODE?this._processWebFile(e):void 0'],
 // Video: same web File path.
 ['r.type=a.type),i){const e=zr.extractFileFromInput(r)','r.type=a.type),i||this._core.utils.IN_NODE){const e=zr.extractFileFromInput(r)'],
 ['url:window.URL.createObjectURL(e),name:t,size:s,second:n,type:i}','url:URL.createObjectURL(e),name:t,size:s,second:n,type:i}'],
 // HTMLInputElement does not exist outside browsers.
 [':e instanceof HTMLInputElement&&',':"undefined"!=typeof HTMLInputElement&&e instanceof HTMLInputElement&&'],
 // Dimension probing needs an <img>; Tencent computes image/snapshot sizes server-side.
 ['n?this._probeImageDimensionsWeb(e):s?this._probeImageDimensionsMiniApp(e):void 0','n?this._probeImageDimensionsWeb(e):s?this._probeImageDimensionsMiniApp(e):{width:0,height:0}'],
];
let source=readFileSync(join(pkgDir,'node.es.js'),'utf8');
for(const [from,to] of patches) {
 const count=source.split(from).length-1;
 if(count!==1)throw new Error(`lite-chat patch matched ${count} times: ${from}`);
 source=source.replace(from,to);
}
const out=join(here,'..','dist','vendor');
mkdirSync(out,{recursive:true});
writeFileSync(join(out,'lite-chat-node.mjs'),`/* @tencentcloud/lite-chat ${VERSION} node build (ISC), patched by @vela/im-client for Node media upload */\n${source}`);
copyFileSync(join(here,'..','src','vendor','lite-chat-node.d.mts'),join(out,'lite-chat-node.d.mts'));
console.log(`vendored lite-chat ${VERSION} node build with ${patches.length} patches`);
