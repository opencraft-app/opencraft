import type { PushDevicePort, DevicePushSubscription } from './push-device';
import { browserServerContext, serverFetch } from './server-context';

export interface PushMessages { completed:string;failed:string;interrupted:string;body:string;test:string }
export interface TurnPushSnapshot {
  readonly phase:'loading'|'unavailable'|'blocked'|'disabled'|'enabling'|'enabled'|'disabling'|'testing'|'error';
  readonly enabled:boolean;
  readonly testSent:boolean;
}
interface Configuration {publicKey:string;actorId:string;hosts:string[]}

/** One Application's authenticated device consent. Disposing a document never
 * revokes the persistent subscription that must outlive that document. */
export class PwaTurnPushController {
  private snapshot: TurnPushSnapshot={phase:'loading',enabled:false,testSent:false};
  private readonly listeners=new Set<()=>void>();
  private configuration: Configuration | null=null;
  private subscription: DevicePushSubscription | null=null;
  private messages: PushMessages | null=null;
  private locale='en-US';
  private disposed=false;
  private busy=false;
  private revoking=false;
  private generation=0;
  constructor(private readonly device: PushDevicePort, private readonly fetcher: typeof fetch=serverFetch) {}
  getSnapshot=()=>this.snapshot;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  handles(hostId:string) {return this.snapshot.enabled && this.configuration?.hosts.includes(hostId)===true;}
  private publish(phase:TurnPushSnapshot['phase'],enabled=this.snapshot.enabled,testSent=false) {
    if(this.disposed)return;this.snapshot={phase,enabled,testSent};
    for(const listener of this.listeners)listener();
  }
  configure(locale:string,messages:PushMessages) {this.locale=locale;this.messages=messages;void this.refresh();}
  private async operation(operation:string,subscription:DevicePushSubscription,signal?:AbortSignal) {
    const response=await this.fetcher('/__opencraft_push',{method:'POST',credentials:'same-origin',signal:signal??AbortSignal.timeout(10000),
      headers:{'content-type':'application/json'},body:JSON.stringify({operation,subscription,expectedActorId:this.configuration?.actorId,
        locale:this.locale,messages:this.messages,basePath:browserServerContext()?.basePath??''})});
    if(!response.ok)throw new Error('Push operation unavailable');
    return await response.json() as {enabled?:boolean;sent?:boolean};
  }
  refresh=async()=>{
    if(this.disposed || this.busy || !this.messages)return;
    const generation=++this.generation;
    try {
      const response=await this.fetcher('/__opencraft_push',{credentials:'same-origin',signal:AbortSignal.timeout(10000)});
      if(this.disposed || generation!==this.generation)return;
      if(!response.ok){this.configuration=null;this.publish('unavailable',false);return;}
      const value=await response.json();
      if(this.disposed || generation!==this.generation)return;
      if(value.available!==true || typeof value.publicKey!=='string' || typeof value.actorId!=='string' || !Array.isArray(value.hosts) || value.hosts.some((h:unknown)=>typeof h!=='string'))throw new Error('Invalid push configuration');
      this.configuration=value;
      const subscription=await this.device.getSubscription();
      if(this.disposed || generation!==this.generation)return;
      this.subscription=subscription;
      if(this.device.permission()!=='granted') {
        if(subscription) {await this.operation('unsubscribe',subscription);await this.device.unsubscribe();this.subscription=null;}
        if(generation===this.generation)this.publish(this.device.permission()==='denied'?'blocked':'disabled',false);
        return;
      }
      const result=this.subscription ? await this.operation('status',this.subscription) : {enabled:false};
      if(this.disposed || generation!==this.generation)return;
      if (!result.enabled && this.subscription) {
        await this.device.unsubscribe(); this.subscription=null;
        if(this.disposed || generation!==this.generation)return;
      }
      this.publish(result.enabled?'enabled':'disabled',result.enabled===true);
    } catch {if(generation===this.generation)this.publish('error',false);}
  };
  async enable() {
    if(this.disposed || this.busy || !this.configuration || !this.messages)return;
    if(this.device.permission()==='denied'){this.publish('blocked',false);return;}
    this.busy=true;const generation=++this.generation;this.publish('enabling',false);
    this.revoking=false;
    try {
      // This call must remain before the first await in the user's gesture.
      const requested=this.device.subscribe(this.configuration.publicKey);
      const subscription=await requested;
      if(this.disposed || generation!==this.generation){if(this.revoking)await this.device.unsubscribe();return;}
      this.subscription=subscription;
      await this.operation('subscribe',subscription);
      if(generation===this.generation)this.publish('enabled',true);
    } catch {if(generation===this.generation)this.publish('error',false);}
    finally {this.busy=false;}
  }
  async disable() {
    if(this.disposed || this.busy)return;
    this.busy=true;++this.generation;this.publish('disabling');
    try {
      const subscription=this.subscription??await this.device.getSubscription();
      if(subscription)await this.operation('unsubscribe',subscription);
      await this.device.unsubscribe();this.subscription=null;this.publish('disabled',false);
    } catch {this.publish('error');}
    finally {this.busy=false;}
  }
  async beforeSignOut() {
    this.revoking=true;this.busy=true;++this.generation;this.publish('disabling');
    try {
      try {if(this.subscription)await this.operation('unsubscribe',this.subscription);} catch { /* Device revocation still prevents further delivery. */ }
      await this.device.unsubscribe(); this.subscription=null; this.publish('disabled',false);
    } finally {this.busy=false;}
  }
  async test() {
    if(this.disposed || this.busy || !this.subscription || !this.snapshot.enabled)return;
    this.busy=true;const generation=++this.generation;
    this.publish('testing');
    try {await this.operation('test',this.subscription);if(generation===this.generation)this.publish('enabled',true,true);}
    catch {if(generation===this.generation)this.publish('error');}
    finally {this.busy=false;}
  }
  dispose() {this.disposed=true;++this.generation;this.listeners.clear();}
}
