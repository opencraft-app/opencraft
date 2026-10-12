import {execFile} from 'node:child_process';
import {cp,readFile,writeFile,rm,mkdir,chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {parse,stringify} from 'yaml';
import type {AgentHostConfig} from './config.js';

const run=promisify(execFile);
export interface AgentProvisionInput {identityId:string;name:string;ownerName:string;token:string;
 /** The owner's human identity: the Agent's home channel (cron results, notices) is their DM. */
 ownerHumanId?:string}
export interface AgentHost {readonly name:string;provision(input:AgentProvisionInput):Promise<{profile:string}>}

/** Registers identities only; the Agent runtime is configured elsewhere (e.g. an operator installs the plugin). */
export const noAgentHost:AgentHost={name:'none',provision:async()=>{throw new Error('此环境未配置 Agent 主机')}};

/** Hermes profile name for an Agent identity: stable, filesystem-safe, unique per identity. */
export const profileName=(identityId:string)=>`vela-${identityId.replace(/^a_/,'').slice(0,24)}`;

async function mergeEnv(path:string,values:Record<string,string>) {
 let text=existsSync(path)?await readFile(path,'utf8'):'';
 for(const [key,value] of Object.entries(values))text=text.replace(new RegExp(`^${key}=.*\\n?`,'gm'),'').replace(/\n*$/,'\n')+`${key}=${value}\n`;
 await writeFile(path,text.replace(/^\n/,''),{mode:0o600});await chmod(path,0o600);
}

/**
 * One Hermes installation on this machine runs every Agent as its own profile under one multiplexed gateway.
 * Each profile loads the vela-im plugin, whose adapter starts that Agent's Node IM worker.
 */
export class LocalHermesHost implements AgentHost {
 readonly name='local';
 private queue:Promise<unknown>=Promise.resolve();
 private pending=0;
 private restart:Promise<void>|null=null;
 constructor(private c:AgentHostConfig,private exec=run,private restartDelayMs=3000) {}
 async provision(input:AgentProvisionInput) {
  this.pending++;
  const next=this.queue.catch(()=>{}).then(()=>this.provisionNow(input)).finally(()=>{this.pending--});
  this.queue=next;
  const result=await next;
  await this.restartGateway();
  return result;
 }
 /**
  * Agents created close together share one restart, issued once no profile is being written and the queue has been
  * quiet for a moment; back-to-back restarts can corrupt profile session databases.
  */
 private restartGateway():Promise<void> {
  if(!this.c.restartCommand)return Promise.resolve();
  this.restart??=new Promise<void>((resolve,reject)=>{
   const fire=()=>{
    if(this.pending>0){setTimeout(fire,this.restartDelayMs);return}
    this.restart=null;
    const done=this.queue.catch(()=>{}).then(()=>this.exec('sh',['-c',this.c.restartCommand],{timeout:120000}));
    this.queue=done;
    done.then(()=>resolve(),reject);
   };
   setTimeout(fire,this.restartDelayMs);
  });
  return this.restart;
 }
 private hermes(args:string[]) {
  const env:NodeJS.ProcessEnv={...process.env,HERMES_HOME:this.c.hermesHome};delete env.HERMES_PROFILE;
  return this.exec(this.c.hermesBin,args,{env,timeout:180000});
 }
 private async provisionNow(input:AgentProvisionInput) {
  const profile=profileName(input.identityId);
  const dir=join(this.c.hermesHome,'profiles',profile);
  if(!existsSync(dir))await this.hermes(['profile','create',profile,'--clone','--clone-from','default','--no-alias']);
  if(!existsSync(dir))throw new Error(`Hermes 没有创建 profile ${profile}`);
  const plugin=join(dir,'plugins','vela-im');
  await rm(plugin,{recursive:true,force:true});await mkdir(join(dir,'plugins'),{recursive:true});
  await cp(this.c.pluginDir,plugin,{recursive:true,filter:src=>!/__pycache__|[\\/]tests([\\/]|$)/.test(src)});
  const media=join(dir,'plugin-data','vela-media');await mkdir(media,{recursive:true,mode:0o700});
  await mergeEnv(join(dir,'.env'),{VELA_API_URL:this.c.apiUrl,VELA_IDENTITY_TOKEN:input.token,VELA_ALLOW_ALL_USERS:'true',
   VELA_GROUP_REPLY_MODE:'mention',VELA_MAX_AGENT_HOPS:'4',VELA_FILE_ROOT:media,VELA_NODE_BIN:this.c.nodeBin,
   ...(input.ownerHumanId?{VELA_HOME_CHANNEL:`C2C${input.ownerHumanId}`}:{})});
  const configPath=join(dir,'config.yaml');
  const config=(existsSync(configPath)?parse(await readFile(configPath,'utf8')):null)??{};
  config.plugins={...(config.plugins??{}),enabled:['vela-im']};
  config.platforms={vela_im:{enabled:true}};
  config.platform_toolsets={vela_im:['vela_im']};
  config.display={...(config.display??{}),platforms:{...(config.display?.platforms??{}),vela_im:{show_reasoning:false}}};
  await writeFile(configPath,stringify(config),{mode:0o600});
  await writeFile(join(dir,'SOUL.md'),`你是 ${input.name}，Vela IM 里的一个 Agent，属于 ${input.ownerName}。你有自己的 IM 身份，和人类、其他 Agent 平等交流：可以单聊、在群里被 @ 后回答、加好友、建群、拉人和踢人。收到当前消息时正常回复即可，回答会自动发回当前会话；只有给其他人发消息或发送特殊消息时才使用 vela 工具。不要汇报工具状态或内部 ID。\n`);
  await this.ensureMultiplex();
  return {profile};
 }
 /** The default profile hosts the gateway; secondary profiles only run when multiplexing is on. */
 private async ensureMultiplex() {
  const path=join(this.c.hermesHome,'config.yaml');
  const config=(existsSync(path)?parse(await readFile(path,'utf8')):null)??{};
  if(config.gateway?.multiplex_profiles===true)return;
  config.gateway={...(config.gateway??{}),multiplex_profiles:true};
  await writeFile(path,stringify(config),{mode:0o600});
 }
}

export const createAgentHost=(c?:AgentHostConfig):AgentHost=>c?.mode==='local'?new LocalHermesHost(c):noAgentHost;
