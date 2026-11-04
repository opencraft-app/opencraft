import {readFile,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
const targets=new Set(['web','execution','core','native','ci','checks','browser','observe','build','dsh']);
const numbers=text=>Object.fromEntries(text.split('\n').flatMap(line=>{const [key,value]=line.trim().split(/\s+/u);return key&&Number.isFinite(Number(value))?[[key.replace(/:$/u,''),Number(value)]]:[];}));
const pressure=text=>Number(/\bsome avg10=([\d.]+)/u.exec(text)?.[1]);
/** Linux read-only, finite configured roles. No process command lines, payloads or DB access. */
export function createResourceSampler(config,{read=path=>readFile(path,'utf8'),list=readdir,info=stat,now=()=>performance.now()}={}) {
  if(!config||typeof config!=='object'||Object.keys(config).some(key=>!['host','cgroups'].includes(key))||config.host!==undefined&&typeof config.host!=='boolean'||!Array.isArray(config.cgroups??[])||(config.cgroups??[]).length>12)throw Error('Invalid resource sampling configuration');
  const roles=config.cgroups??[],seen=new Set();
  for(const role of roles){if(!targets.has(role.target)||seen.has(role.target)||!/^\/sys\/fs\/cgroup\/(?:[a-zA-Z0-9_.@:-]+\/)*[a-zA-Z0-9_.@:-]+$/u.test(role.path)||role.path.split('/').includes('..')||role.prefix!==undefined&&!/^[a-zA-Z0-9_.@-]{1,80}$/u.test(role.prefix)||Object.keys(role).some(key=>!['target','path','prefix'].includes(key)))throw Error('Invalid resource sampling role');seen.add(role.target);}
  const safe=async path=>{try{const value=await read(path);return value.length<=65536?value:'';}catch{return '';}};
  let previousHost,previousGroups=new Map();
  const group=async path=>{try{
    const [identity,cpuText,ioText,memory,cpuPressure,ioPressure]=await Promise.all([info(path),safe(join(path,'cpu.stat')),safe(join(path,'io.stat')),safe(join(path,'memory.current')),safe(join(path,'cpu.pressure')),safe(join(path,'io.pressure'))]);
    const cpu=numbers(cpuText);if(cpu.usage_usec===undefined)return;
    let readBytes=0,writeBytes=0;for(const line of ioText.split('\n'))for(const item of line.split(' ').slice(1)){const [key,value]=item.split('=');if(key==='rbytes')readBytes+=Number(value)||0;if(key==='wbytes')writeBytes+=Number(value)||0;}
    return {identity:String(identity.ino),cpu,readBytes:ioText.trim()?readBytes:undefined,writeBytes:ioText.trim()?writeBytes:undefined,memory:memory!==''&&Number.isFinite(Number(memory))?Number(memory):undefined,cpuPressure:pressure(cpuPressure),ioPressure:pressure(ioPressure)};
  }catch{return;}};
  return async()=>{
    const at=now(),events=[];
    if(config.host){
      const [cpuText,memoryText,cpuPressure,ioPressure]=await Promise.all([safe('/proc/stat'),safe('/proc/meminfo'),safe('/proc/pressure/cpu'),safe('/proc/pressure/io')]);
      const cpu=cpuText.split('\n')[0].trim().split(/\s+/u).slice(1,9).map(Number),memory=numbers(memoryText);
      if(cpu.length===8&&cpu.every(Number.isFinite)){
        const event={resourceScope:'host',resourceTarget:'host',resourceCoverage:previousHost&&memory.MemTotal!==undefined&&memory.MemAvailable!==undefined&&Number.isFinite(pressure(cpuPressure))&&Number.isFinite(pressure(ioPressure))?'complete':'partial',resourceSampleMs:previousHost?Math.max(0,at-previousHost.at):0};
        if(previousHost){const deltas=cpu.map((value,i)=>value-previousHost.cpu[i]),total=deltas.reduce((a,b)=>a+b,0);if(total>0&&deltas.every(v=>v>=0)){event.resourceCpuBusyPercent=100*(total-deltas[3]-deltas[4])/total;event.resourceIoWaitPercent=100*deltas[4]/total;}}
        if(memory.MemTotal!==undefined)event.resourceMemoryBytes=(memory.MemTotal-(memory.MemAvailable??memory.MemFree??0))*1024;
        if(memory.MemAvailable!==undefined)event.resourceMemoryAvailableBytes=memory.MemAvailable*1024;
        if(Number.isFinite(pressure(cpuPressure)))event.resourceCpuPressurePercent=pressure(cpuPressure);
        if(Number.isFinite(pressure(ioPressure)))event.resourceIoPressurePercent=pressure(ioPressure);
        events.push(event);previousHost={at,cpu};
      }
    }
    const next=new Map();
    for(const role of roles){
      let paths=[role.path],partial=false;
      if(role.prefix){try{const names=(await list(role.path)).filter(name=>name.startsWith(role.prefix)&&name.endsWith('.service')).sort();partial=names.length>32;paths=names.slice(0,32).map(name=>join(role.path,name));}catch{continue;}}
      if(role.prefix&&[...previousGroups.keys()].some(path=>path.startsWith(join(role.path,role.prefix))&&!paths.includes(path)))partial=true;
      const samples=await Promise.all(paths.map(async path=>({path,value:await group(path)})));
      let cpu=0,readBytes=0,writeBytes=0,throttled=0,memory=0,members=0,newMembers=0,maxCpuPressure=0,maxIoPressure=0,windowMs,hasMemory=true,hasIO=true,hasCpuPressure=true,hasIoPressure=true;
      for(const {path,value} of samples){
        if(!value){partial=true;continue;}members++;if(value.memory===undefined)hasMemory=false;else memory+=value.memory;if(!Number.isFinite(value.cpuPressure))hasCpuPressure=false;if(!Number.isFinite(value.ioPressure))hasIoPressure=false;maxCpuPressure=Math.max(maxCpuPressure,Number.isFinite(value.cpuPressure)?value.cpuPressure:0);maxIoPressure=Math.max(maxIoPressure,Number.isFinite(value.ioPressure)?value.ioPressure:0);
        next.set(path,{...value,at});const prior=previousGroups.get(path),elapsed=prior?at-prior.at:0;
        if(!prior||prior.identity!==value.identity||value.cpu.usage_usec<prior.cpu.usage_usec||elapsed<=0){newMembers++;continue;}
        const seconds=elapsed/1000;windowMs=elapsed;cpu+=(value.cpu.usage_usec-prior.cpu.usage_usec)/1e6/seconds;
        if(value.readBytes===undefined||prior.readBytes===undefined)hasIO=false;else{readBytes+=Math.max(0,value.readBytes-prior.readBytes);writeBytes+=Math.max(0,value.writeBytes-prior.writeBytes);}throttled+=Math.max(0,(value.cpu.throttled_usec??0)-(prior.cpu.throttled_usec??0))/1000;
      }
      if(!members){events.push({resourceScope:'cgroup',resourceTarget:role.target,resourceCoverage:'partial',resourceMembers:0,resourceNewMembers:0});continue;}
      events.push({resourceScope:'cgroup',resourceTarget:role.target,resourceMembers:members,resourceNewMembers:newMembers,resourceCoverage:partial||newMembers||!hasMemory||!hasIO||!hasCpuPressure||!hasIoPressure?'partial':'complete',...(hasMemory?{resourceMemoryBytes:memory}:{}),...(hasCpuPressure?{resourceCpuPressurePercent:maxCpuPressure}:{}),...(hasIoPressure?{resourceIoPressurePercent:maxIoPressure}:{}),
        ...(windowMs!==undefined?{resourceSampleMs:windowMs,resourceCpuCores:cpu,...(hasIO?{resourceReadBytes:readBytes,resourceWriteBytes:writeBytes}:{}),resourceCpuThrottledMs:throttled}: {})});
    }
    previousGroups=next;return events.map(event=>Object.fromEntries(Object.entries(event).map(([key,value])=>[key,typeof value==='number'&&!Number.isInteger(value)?Math.round(value*1000)/1000:value])));
  };
}
