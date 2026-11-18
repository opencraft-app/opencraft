import { browserServerContext, serverFetch } from './server-context';
import type { PushMessages } from './pwa-turn-push';
export type NotificationFailure = 'address'|'account'|'forbidden'|'unavailable'|'storage'|'limit'|'missing'|'im'|'rate'|'delivery'|'network'|'timeout'|'unknown';
export class NotificationOperationError extends Error {
  constructor(readonly reason:NotificationFailure) {super(reason);}
}
async function responseFailure(response:Response):Promise<NotificationOperationError> {
  let code:unknown;
  try {code=(await response.json())?.error;}catch {/* Proxies may return HTML. */}
  const reasons:Record<string,NotificationFailure>={invalid_destination:'address',invalid_target:'im',device_limit:'limit',not_found:'missing',destination_not_found:'missing',notification_storage_unavailable:'storage',notification_delivery_failed:'delivery'};
  const reason:NotificationFailure=response.status===401||response.status===409?'account':response.status===403?'forbidden':response.status===429?'rate':
    typeof code==='string'&&Object.hasOwn(reasons,code)?reasons[code]!:response.status===404?'unavailable':'unknown';
  return new NotificationOperationError(reason);
}
export interface NotificationDestination {id:string;kind:'bark'|'webhook'|'im';label:string;enabled:boolean;authorized:boolean;channelId?:string;senderId?:string;methodId?:string;methodLabel?:string}
export interface ImNotificationTarget {channelId:string;senderId:string;label:string;methodId?:string;methodLabel?:string}
export interface NotificationConfiguration {actorId:string;enabled:boolean;hosts:string[];destinations:NotificationDestination[];imTargets:ImNotificationTarget[];savedId?:string;defaultsAvailable?:boolean;defaultsStatus?:'complete'|'deferred'|'ineligible'}
export interface DestinationSnapshot {phase:'loading'|'ready'|'unavailable'|'error';configuration:NotificationConfiguration|null;busy:string|null}
export class NotificationDestinationsController {
  private snapshot:DestinationSnapshot={phase:'loading',configuration:null,busy:null};
  private readonly listeners=new Set<()=>void>();
  private generation=0;
  private disposed=false;
  private locale='en-US';
  private messages:PushMessages|null=null;
  private abort:AbortController|null=null;
  private retry:ReturnType<typeof setTimeout>|undefined;
  private defaultActor:string|null=null;
  constructor(private readonly fetcher:typeof fetch=serverFetch) {}
  getSnapshot=()=>this.snapshot;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private publish(value:Partial<DestinationSnapshot>) {if(this.disposed)return;this.snapshot={...this.snapshot,...value};for(const listener of this.listeners)listener();}
  configure(locale:string,messages:PushMessages){this.locale=locale;this.messages=messages;void this.refresh();}
  refresh=async()=>{
    if(this.disposed || this.snapshot.busy)return;
    clearTimeout(this.retry);
    const generation=++this.generation;
    this.abort?.abort();const abort=this.abort=new AbortController();
    const timer=setTimeout(()=>abort.abort(),10000);
    try {
      const response=await this.fetcher('/__opencraft_notifications',{credentials:'same-origin',signal:abort.signal});
      if(generation!==this.generation || this.disposed)return;
      if([401,403,404].includes(response.status)){this.publish({phase:'unavailable',configuration:null});return;}
      if(!response.ok)throw Error('notifications_unavailable');
      const value=await response.json();
      if(generation!==this.generation || this.disposed)return;
      const configuration=this.parse(value);
      this.publish({phase:'ready',configuration});
      if(configuration.defaultsAvailable && this.defaultActor!==configuration.actorId && this.messages) {
        const response=await this.fetcher('/__opencraft_notifications',{method:'POST',credentials:'same-origin',signal:abort.signal,headers:{'content-type':'application/json'},
          body:JSON.stringify({operation:'defaults',expectedActorId:configuration.actorId,locale:this.locale,messages:this.messages,basePath:browserServerContext()?.basePath??''})});
        if(!response.ok)throw await responseFailure(response);
        const result=this.parse(await response.json());
        if(generation!==this.generation || this.disposed)return;
        if(result.actorId!==configuration.actorId)throw Error('account_changed');
        this.publish({configuration:result});
        if(result.defaultsStatus==='complete')this.defaultActor=configuration.actorId;
        else if(result.defaultsStatus==='deferred')this.scheduleRetry();
      }
    }catch{if(!this.disposed && generation===this.generation){if(this.snapshot.configuration?.defaultsAvailable)this.scheduleRetry();if(!this.snapshot.configuration)this.publish({phase:'error'});}}finally{clearTimeout(timer);}
  };
  private scheduleRetry(){clearTimeout(this.retry);this.retry=setTimeout(()=>{void this.refresh();},30000);}
  private parse(value: unknown): NotificationConfiguration {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid_notifications");
    const item = value as Record<string, unknown>;
    const record = (candidate: unknown): candidate is Record<string, unknown> =>
      !!candidate && typeof candidate === "object" && !Array.isArray(candidate);
    if (
      typeof item.actorId !== "string" ||
      typeof item.enabled !== "boolean" ||
      !Array.isArray(item.hosts) ||
      item.hosts.some((host: unknown) => typeof host !== "string") ||
      !Array.isArray(item.destinations) ||
      item.destinations.some(
        (destination: unknown) =>
          !record(destination) ||
          typeof destination.id !== "string" ||
          !["bark", "webhook", "im"].includes(String(destination.kind)) ||
          typeof destination.label !== "string" ||
          typeof destination.enabled !== "boolean" ||
          typeof destination.authorized !== "boolean" ||
          (destination.channelId !== undefined && typeof destination.channelId !== "string") ||
          (destination.senderId !== undefined && typeof destination.senderId !== "string"),
      ) ||
      !Array.isArray(item.imTargets) ||
      item.imTargets.some(
        (target: unknown) =>
          !record(target) ||
          typeof target.channelId !== "string" ||
          typeof target.senderId !== "string" ||
          typeof target.label !== "string",
      ) ||
      (item.savedId !== undefined && typeof item.savedId !== "string") ||
      (item.defaultsAvailable !== undefined && typeof item.defaultsAvailable !== "boolean") ||
      (item.defaultsStatus !== undefined && !["complete", "deferred", "ineligible"].includes(String(item.defaultsStatus)))
    )
      throw Error("invalid_notifications");
    return item as unknown as NotificationConfiguration;
  }
  async operation(operation:string,fields:Record<string,unknown>={}):Promise<NotificationConfiguration|{sent:boolean}> {
    if(this.disposed || this.snapshot.busy || !this.snapshot.configuration || !this.messages)throw Error('notifications_unavailable');
    const generation=++this.generation,actorId=this.snapshot.configuration.actorId;
    this.abort?.abort();const abort=this.abort=new AbortController();
    this.publish({busy:typeof fields.id==='string'?fields.id:operation});
    const timer=setTimeout(()=>abort.abort(),15000);
    try {
      const response=await this.fetcher('/__opencraft_notifications',{method:'POST',credentials:'same-origin',signal:abort.signal,headers:{'content-type':'application/json'},
        body:JSON.stringify({...fields,operation,expectedActorId:actorId,locale:this.locale,messages:this.messages,basePath:browserServerContext()?.basePath??''})});
      if(!response.ok){if(response.status===401 || response.status===409)this.publish({configuration:null,phase:'unavailable'});throw await responseFailure(response);}
      const value=await response.json();
      if(this.disposed || generation!==this.generation)throw Error('notification_operation_cancelled');
      if(operation!=='test'){
        const configuration=this.parse(value);
        if(configuration.actorId!==actorId)throw Error('account_changed');
        this.publish({configuration,phase:'ready'});
      }
      return value;
    }catch(error){
      if(error instanceof NotificationOperationError)throw error;
      throw new NotificationOperationError(abort.signal.aborted?'timeout':error instanceof TypeError?'network':'unknown');
    }finally{clearTimeout(timer);if(generation===this.generation)this.publish({busy:null});}
  }
  reset(){this.defaultActor=null;clearTimeout(this.retry);++this.generation;this.abort?.abort();this.publish({configuration:null,phase:'unavailable',busy:null});}
  dispose(){this.reset();this.disposed=true;this.listeners.clear();}
}
