import type {Config} from './config.js';
import {Store} from './store.js';
import {imAdminCall} from './provision.js';

const FRIEND_LIMIT_REACHED=30014;
/**
 * Demo fixture provisioning only. Each new demo identity becomes friends with the pinned demo Agents and the most
 * recent participants. Tencent caps friends per account (20 on this app's plan), so the oldest demo friendships
 * are released first; ordinary user SDK calls keep Tencent's normal rules.
 */
export class DemoDirectory {
 private queue:Promise<unknown>=Promise.resolve();
 constructor(private config:Config,private store:Store,private adminCall=imAdminCall) {}
 enroll(id:string) {
  const next=this.queue.catch(()=>{}).then(async()=>{
   if(!this.config.demoMode)throw new Error('Demo enrollment is disabled');
   if(!this.store.identity(id))throw new Error('Unknown demo identity');
   const limit=this.config.demoFriendLimit??20,pinned=new Set(this.config.demoPinned??[]);
   const others=this.store.demoParticipants().filter(p=>p.id!==id);
   const targets=[...others.filter(p=>pinned.has(p.id)),...others.filter(p=>!pinned.has(p.id)).slice(-(this.config.demoRecentFriends??5))].map(p=>p.id);
   for(const account of [id,...targets])await this.makeRoom(account,limit,pinned,id===account?targets.length:1);
   if(targets.length) {
    // friend_add sends relationship-change notifications to online SDK clients;
    // friend_import only imports cloud state and leaves their caches stale.
    const r=await this.adminCall(this.config,'sns/friend_add',{From_Account:id,AddType:'Add_Type_Both',ForceAddFlags:1,AddFriendItem:targets.map(To_Account=>({To_Account,AddSource:'AddSource_Type_VelaDemo'}))});
    for(const item of r.ResultItem??[]) {
     if(item.ResultCode===0||item.ResultCode===30015)this.store.addDemoFriendship(id,item.To_Account);
     else if(item.ResultCode!==FRIEND_LIMIT_REACHED)throw Object.assign(new Error(item.ResultInfo||'Demo friendship provisioning failed'),{code:item.ResultCode});
    }
   }
   this.store.enrollDemo(id);
  });
  this.queue=next;return next;
 }
 private async makeRoom(account:string,limit:number,pinned:Set<string>,needed:number) {
  const partners=this.store.demoFriends(account);
  const evict=partners.filter(p=>!pinned.has(p)).slice(0,Math.max(0,partners.length+needed-(limit-1)));
  if(!evict.length)return;
  await this.adminCall(this.config,'sns/friend_delete',{From_Account:account,DeleteType:'Delete_Type_Both',To_Account:evict});
  for(const partner of evict)this.store.removeDemoFriendship(account,partner);
 }
}
