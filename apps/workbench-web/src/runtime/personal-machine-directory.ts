import {parseRuntimeMachineIdentity} from '@opencraft/appserver-protocol';
import type {PersonalMachinesDirectory} from '@opencraft/appserver-protocol/personal-machines';
import type {HostConnectionProfile} from '@opencraft/workbench-runtime';
import {serverFetch} from './server-context';
/** Owner transport projects server-owned recipes; it never saves them to IDB. */
export class PersonalMachineDirectory {
  private snapshot:PersonalMachinesDirectory|null=null;private listeners=new Set<()=>void>();private stopped=false;private timer?:ReturnType<typeof setTimeout>;private abort?:AbortController;
  getSnapshot=()=>this.snapshot;
  subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>{this.listeners.delete(f);};};
  start(){void this.refresh();}
  private async refresh(){
    const abort=new AbortController();this.abort=abort;const deadline=setTimeout(()=>abort.abort(),10000);
    try{
      const r=await serverFetch('/__opencraft_machines/status',{signal:abort.signal});if(!r.ok)throw new Error('Machine directory unavailable');
      const next=await r.json() as PersonalMachinesDirectory;
      if(typeof next.hubId!=='string'||typeof next.ownerActorId!=='string'||next.enrollmentOrigin!==null&&typeof next.enrollmentOrigin!=='string'||!Array.isArray(next.machines)||next.machines.some(m=>!/^[-a-f0-9]{36}$/.test(m.id)||typeof m.connected!=='boolean'||!['pending','enrolled'].includes(m.phase)))throw new Error('Invalid machine directory');
      for(const m of next.machines){if(typeof m.name!=='string'||m.expiresAt!==null&&!Number.isFinite(m.expiresAt))throw new Error('Invalid machine entry');if(m.machine!==null)m.machine=parseRuntimeMachineIdentity(m.machine);if(m.phase==='enrolled'&&!m.machine)throw new Error('Missing machine identity');}
      if(this.stopped)return;if(JSON.stringify(next)!==JSON.stringify(this.snapshot)){this.snapshot=next;for(const f of this.listeners)f();}
    }catch{/* Keep an admitted read projection through a transient transport failure. */}
    finally{clearTimeout(deadline);if(!this.stopped)this.timer=setTimeout(()=>void this.refresh(),3000);}
  }
  profiles():HostConnectionProfile[]{return (this.snapshot?.machines??[]).filter(m=>m.phase==='enrolled').map(m=>({hostId:'personal:'+m.id,displayName:m.name,providerId:'opencraft.websocket',providerConfig:{url:new URL('/__opencraft_machines/'+m.id+'/rpc',location.href).href.replace(/^http/,'ws')},providerConfigVersion:1,hostKind:'remote-control',enabled:true,autoConnect:false,includeInSidebar:true,credentialRef:null,transportEndpoint:null,executionLocation:m.name,workspaceBrowseRoots:[],revision:1,machineIdentity:m.machine,machinePresence:m.connected?'online':'offline',agent:'OpenCraft'}));}
  close(){this.stopped=true;clearTimeout(this.timer);this.abort?.abort();this.listeners.clear();}
}
