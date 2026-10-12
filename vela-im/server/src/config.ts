import {readFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse,config as dotenv} from 'dotenv';
const serviceRoot=fileURLToPath(new URL('../../',import.meta.url));
dotenv({path:resolve(serviceRoot,'.env'),quiet:true});
export function readSecret(path:string|undefined,key?:string):string {
 if(!path)return '';
 const text=readFileSync(path,'utf8').trim();
 return key ? (parse(text)[key] ?? text) : text;
}
export type LightVelaRegion='cn'|'intl';
/** Where newly created Agents run. `local` provisions a Hermes profile on this host; `none` only registers identities. */
export interface AgentHostConfig {
 mode:'none'|'local';
 hermesBin:string;
 /** HERMES_HOME of the default profile; Agent profiles are created under `<hermesHome>/profiles`. */
 hermesHome:string;
 /** Built hermes-plugin directory (includes vela_im/ and the worker bundle). */
 pluginDir:string;
 /** Identity service URL as seen from the Agent host. */
 apiUrl:string;
 nodeBin:string;
 /** Command that restarts the multiplexed Hermes gateway so it loads new profiles. */
 restartCommand:string;
}
export interface Config {
 appId:number;imSecret:string;admin:string;restHost:string;host:string;port:number;dataDir:string;
 ssoSecret:string;ssoIssuer:string;ssoAudience:string;allowedOrigins:string[];demoMode:boolean;webDir:string;
 demoPinned?:string[];demoFriendLimit?:number;demoRecentFriends?:number;
 /** LightVela API bases used to verify a LightVela session token (`GET /auth/profile`). */
 lightvelaApiBases?:Record<LightVelaRegion,string>;
 agentHost?:AgentHostConfig;
}
export function loadConfig():Config {
 const env=process.env;
 const dataDir=resolve(env.VELA_DATA_DIR??resolve(serviceRoot,'data'));mkdirSync(dataDir,{recursive:true,mode:0o700});
 const c:Config={appId:Number(env.VELA_SDK_APP_ID??1600166071),imSecret:readSecret(env.VELA_IM_SECRET_FILE,'VELA_IM_SECRET_KEY'),admin:env.VELA_IM_ADMIN??'administrator',restHost:env.VELA_IM_REST_HOST??'console.tim.qq.com',host:env.VELA_HOST??'127.0.0.1',port:Number(env.VELA_PORT??8787),dataDir,ssoSecret:readSecret(env.VELA_SSO_SECRET_FILE),ssoIssuer:env.VELA_SSO_ISSUER??'vela-login',ssoAudience:env.VELA_SSO_AUDIENCE??'vela-im',allowedOrigins:(env.VELA_ALLOWED_ORIGINS??'http://127.0.0.1:8787').split(',').map(x=>x.trim()),demoMode:env.VELA_DEMO_MODE==='true',webDir:resolve(env.VELA_WEB_DIR??resolve(serviceRoot,'web-dist')),
  demoPinned:(env.VELA_DEMO_PINNED??'').split(',').map(x=>x.trim()).filter(Boolean),demoFriendLimit:Number(env.VELA_DEMO_FRIEND_LIMIT??20),demoRecentFriends:Number(env.VELA_DEMO_RECENT_FRIENDS??5),
  lightvelaApiBases:{cn:env.VELA_LIGHTVELA_API_CN??'https://api.lightvela.com',intl:env.VELA_LIGHTVELA_API_INTL??'https://api.lightvela.ai'},
  agentHost:{mode:env.VELA_AGENT_HOST==='local'?'local':'none',hermesBin:env.VELA_HERMES_BIN??'hermes',hermesHome:env.VELA_HERMES_HOME??'',pluginDir:resolve(env.VELA_PLUGIN_DIR??resolve(serviceRoot,'hermes-plugin')),
   apiUrl:env.VELA_AGENT_API_URL??`http://127.0.0.1:${env.VELA_PORT??8787}`,nodeBin:env.VELA_NODE_BIN??'node',restartCommand:env.VELA_HERMES_RESTART_COMMAND??''}};
 if(c.demoMode && !['127.0.0.1','localhost','::1'].includes(c.host))throw new Error('演示 API 必须监听 loopback；公开 demo 使用 HTTPS 反向代理。');
 if(!Number.isSafeInteger(c.appId)||c.appId<=0)throw new Error('Invalid SDKAppID');
 if(c.agentHost?.mode==='local'&&!c.agentHost.hermesHome)throw new Error('VELA_AGENT_HOST=local requires VELA_HERMES_HOME');
 return c;
}
