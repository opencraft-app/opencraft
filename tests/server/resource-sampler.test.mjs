import test from 'node:test';import assert from 'node:assert/strict';
import {createResourceSampler} from '../../apps/observability-service/resource-sampler.mjs';
import {sanitizeEvent} from '../../packages/observability-contract/index.mjs';
test('host and cgroup deltas include short-lived descendants, skip replacement counters and never export paths',async()=>{
 let at=0,cpu=1000000,inode=1,host=100;const root='/sys/fs/cgroup/system.slice/fixture.service';
 const read=async path=>{
  if(path==='/proc/stat')return `cpu ${host} 0 100 800 0 0 0 0\n`;
  if(path==='/proc/meminfo')return 'MemTotal: 1000 kB\nMemAvailable: 600 kB\n';
  if(path.includes('pressure'))return 'some avg10=12.50 avg60=1.00 avg300=1.00 total=1';
  if(path===root+'/cpu.stat')return `usage_usec ${cpu}\nthrottled_usec 2000\n`;
  if(path===root+'/io.stat')return `8:0 rbytes=${cpu} wbytes=${cpu*2}`;
  if(path===root+'/memory.current')return '4096';throw Error('missing');
 };
 const sample=createResourceSampler({host:true,cgroups:[{target:'execution',path:root}]},{read,info:async()=>({ino:inode}),now:()=>at});
 let events=await sample();assert.equal(events[0].resourceMemoryAvailableBytes,600*1024);assert.equal(events[1].resourceNewMembers,1);assert(!('resourceCpuCores'in events[1]));
 at=10000;cpu=6000000;host=200;events=await sample();assert.equal(events[0].resourceCpuBusyPercent,100);assert.equal(events[1].resourceCpuCores,0.5);assert.equal(events[1].resourceReadBytes,5000000);assert.equal(events[1].resourceCoverage,'complete');
 for(const e of events){assert(sanitizeEvent({schemaVersion:1,eventId:'fixture',producerId:'fixture',kind:'resource',component:'observe',at:100,...e},100));assert(!JSON.stringify(e).includes(root));}
 inode=2;cpu=100;at=20000;events=await sample();assert.equal(events[1].resourceNewMembers,1);assert(!('resourceCpuCores'in events[1]));
});
test('missing capabilities remain unknown and configuration is finite',async()=>{
 assert.throws(()=>createResourceSampler({host:true,cgroups:[{target:'execution',path:'/etc/private'}]}));
 assert.throws(()=>createResourceSampler({cgroups:[{target:'execution',path:'/sys/fs/cgroup/../private'}]}));
 const sample=createResourceSampler({host:true,cgroups:[{target:'execution',path:'/sys/fs/cgroup/missing'}]},{read:async()=>{throw Error();},info:async()=>{throw Error();}});const events=await sample();assert.equal(events.length,1);assert.equal(events[0].resourceCoverage,'partial');assert(!('resourceCpuCores'in events[0]));
});

test('removed service members invalidate completeness instead of exporting a complete lower bound',async()=>{
 let at=0,names=['fixture-a.service','fixture-b.service'];const root='/sys/fs/cgroup/system.slice';
 const sample=createResourceSampler({cgroups:[{target:'checks',path:root,prefix:'fixture-'}]},{list:async()=>names,info:async()=>({ino:1}),now:()=>at,read:async path=>path.endsWith('/cpu.stat')?`usage_usec ${1000+at*500}\nthrottled_usec 0`:path.endsWith('/io.stat')?'8:0 rbytes=0 wbytes=0':path.endsWith('memory.current')?'1':'some avg10=0.00 avg60=0 avg300=0 total=0'});
 await sample();at=10000;names=['fixture-a.service'];const [event]=await sample();assert.equal(event.resourceCoverage,'partial');assert.equal(event.resourceMembers,1);assert.equal(event.resourceCpuCores,0.5);
 at=20000;names=[];const [missing]=await sample();assert.equal(missing.resourceCoverage,'partial');assert.equal(missing.resourceMembers,0);assert(!('resourceCpuCores'in missing));
});
