export interface DevicePushSubscription {
  readonly endpoint: string;
  readonly keys: {readonly p256dh:string;readonly auth:string};
}
export interface PushDevicePort {
  readonly supported: boolean;
  permission(): 'default'|'granted'|'denied';
  getSubscription(): Promise<DevicePushSubscription | null>;
  /** Called directly in a user gesture, before other asynchronous work. */
  subscribe(publicKey: string): Promise<DevicePushSubscription>;
  unsubscribe(): Promise<void>;
  dispose(): void;
}

/** Browser mechanics only. Account binding and execution are Application/server concerns. */
export class ApplePwaPushDevice implements PushDevicePort {
  private disposed = false;
  private registration: Promise<PushManager> | null = null;
  private readonly view: Window & typeof globalThis;
  constructor(private readonly document: Document, private readonly workerUrl: string, private readonly workerScope: string) {
    this.view = document.defaultView as Window & typeof globalThis;
  }
  get supported() {
    const view=this.view;
    return !!view && view.top===view && view.isSecureContext===true
      && (view.navigator as Navigator & {standalone?:boolean}).standalone===true
      && typeof view.Notification!=='undefined' && ('pushManager' in view || ('serviceWorker' in view.navigator && typeof view.PushManager!=='undefined'));
  }
  permission() {return this.view.Notification?.permission ?? 'denied';}
  private assertCurrent() {if(this.disposed || !this.supported)throw new Error('Push device unavailable');}
  private manager(): Promise<PushManager> {
    this.assertCurrent();
    const declarative=(this.view as unknown as {pushManager?:PushManager}).pushManager;
    if(declarative)return Promise.resolve(declarative);
    if(this.registration)return this.registration;
    this.registration=(async()=>{
      const registration=await this.view.navigator.serviceWorker.register(this.workerUrl,{scope:this.workerScope});
      const worker=registration.active??registration.installing??registration.waiting;
      if(!worker)throw new Error('Push worker unavailable');
      if(worker.state!=='activated')await new Promise<void>((resolve,reject)=>{
        const finish=(error?:Error)=>{clearTimeout(timer);worker.removeEventListener('statechange',check);error?reject(error):resolve();};
        const check=()=>{if(worker.state==='activated')finish();else if(worker.state==='redundant')finish(new Error('Push worker retired'));};
        const timer=setTimeout(()=>finish(new Error('Push worker timed out')),8000);
        worker.addEventListener('statechange',check);check();
      });
      this.assertCurrent();return registration.pushManager;
    })().catch(error=>{this.registration=null;throw error;});
    return this.registration;
  }
  private project(subscription: PushSubscription): DevicePushSubscription {
    const value=subscription.toJSON();
    if(!value.endpoint || !value.keys?.p256dh || !value.keys.auth)throw new Error('Invalid push subscription');
    return {endpoint:value.endpoint,keys:{p256dh:value.keys.p256dh,auth:value.keys.auth}};
  }
  async getSubscription() {const manager=await this.manager();const value=await manager.getSubscription();this.assertCurrent();return value?this.project(value):null;}
  async subscribe(publicKey: string) {
    this.assertCurrent();
    const permission=await this.view.Notification.requestPermission();
    this.assertCurrent();if(permission!=='granted')throw new Error('Notification permission required');
    const manager=await this.manager();
    const encoded=publicKey.replace(/-/gu,'+').replace(/_/gu,'/');
    const decoded=this.view.atob(encoded+'='.repeat((4-encoded.length%4)%4));
    const key=Uint8Array.from(decoded,c=>c.charCodeAt(0));
    let subscription=await manager.getSubscription();
    const previous=subscription?.options.applicationServerKey;
    if(subscription && previous && (new Uint8Array(previous).length!==key.length || new Uint8Array(previous).some((n,i)=>n!==key[i]))) {
      await subscription.unsubscribe();subscription=null;
    }
    this.assertCurrent();
    subscription??=await manager.subscribe({userVisibleOnly:true,applicationServerKey:key});
    this.assertCurrent();return this.project(subscription);
  }
  async unsubscribe() {const manager=await this.manager();await (await manager.getSubscription())?.unsubscribe();}
  dispose() {this.disposed=true;}
}
