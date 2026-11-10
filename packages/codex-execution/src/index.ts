export type ConfigurationStage = 'read-thread' | 'check-idle' | 'wait-for-unload' | 'capture-settings' | 'preserve-permissions' | 'unsubscribe' | 'apply-tools' | 'restore-settings';
type RecordValue = Record<string, any>;
const record=(v:unknown):RecordValue=>v && typeof v==='object' && !Array.isArray(v)?v as RecordValue:{};
const string=(v:unknown)=>typeof v==='string'?v:'';
/** Native execution configuration owner shared by legacy and bridge writers.
 * Captures permissions, drains the old runtime, applies config, restores settings.
 */
export async function refreshCodexExecutionConfiguration(threadId:string,config:RecordValue,ports:{
  request(method:string,params:RecordValue):Promise<unknown>;
  current():void; stage(value:ConfigurationStage):void; nativeStatus(value:string):void;
  ephemeral():void; cancelRelease():void; retirement():RecordValue|undefined;
  waitForRetirement:boolean; pending():Error; invalidate():void; retire(live:RecordValue):void;
  unsubscribed():void; clearRetirement():void;
}):Promise<boolean> {
  const {request,current}=ports;
      ports.stage("read-thread");
      const read = record(await request("thread/read", { threadId, includeTurns: false }));
      const thread = record(read.thread);
      if (thread.ephemeral === true) {
        ports.ephemeral();
        return false;
      }
      ports.stage("check-idle");
      let status = string(record(thread.status).type);
      ports.nativeStatus(["idle", "systemError", "notLoaded", "active"].includes(status) ? status : "unknown");
      if (!["idle", "systemError", "notLoaded"].includes(status)) throw new Error("Wait until the Codex thread is idle before changing its tools");
      ports.cancelRelease();
      const retirement = ports.retirement();
      const waitForUnload = async () => {
        ports.stage("wait-for-unload");
        // Native unsubscribe releases a subscription, not the Thread runtime.
        // Keep this admitted input in preparation while native's retirement runs;
        // never resubmit input or reattach the old runtime to poll readiness.
        if (!ports.waitForRetirement) {
          const snapshot = record(await request("thread/read", { threadId, includeTurns: false }));
          status = string(record(record(snapshot.thread).status).type);
          ports.nativeStatus(["idle", "systemError", "notLoaded", "active"].includes(status) ? status : "unknown");
          if (status !== "notLoaded") throw ports.pending();
          return;
        }
        const deadline = Date.now() + 90_000;
        while (status !== "notLoaded") {
          current();
          if (Date.now() >= deadline) throw ports.pending();
          await new Promise<void>(resolve => setTimeout(resolve, 250));
          const snapshot = record(await request("thread/read", { threadId, includeTurns: false }));
          status = string(record(record(snapshot.thread).status).type);
          ports.nativeStatus(["idle", "systemError", "notLoaded", "active"].includes(status) ? status : "unknown");
          if (!["idle", "systemError", "notLoaded"].includes(status)) throw ports.pending();
        }
      };
      if (retirement && status !== "notLoaded") await waitForUnload();
      ports.stage("capture-settings");
      const live = retirement ?? (status === "notLoaded" ? {} : record(await request("thread/resume", { threadId, excludeTurns: true })));
      const resume: RecordValue = {};
      for (const key of ["model", "modelProvider", "serviceTier", "cwd", "runtimeWorkspaceRoots", "approvalPolicy", "approvalsReviewer"])
        if (live[key] !== undefined) resume[key] = live[key];
      ports.stage("preserve-permissions");
      const profile = string(record(live.activePermissionProfile).id);
      if (profile) resume.permissions = profile;
      else {
        const sandbox = record(live.sandbox), modes: Record<string, string> = { dangerFullAccess: "danger-full-access", readOnly: "read-only", workspaceWrite: "workspace-write" };
        if (sandbox.type && !modes[string(sandbox.type)]) throw new Error("Cannot preserve this Codex sandbox while refreshing tools");
        if (sandbox.type) resume.sandbox = modes[string(sandbox.type)];
      }
      // Once native configuration can change, the old confirmation is no longer
      // valid either. A partial failure must not make a later rollback look applied.
      ports.invalidate();
      if (status !== "notLoaded") {
        ports.retire(live);
        ports.stage("unsubscribe");
        await request("thread/unsubscribe", { threadId });
        ports.unsubscribed();
        await waitForUnload();
      }
      ports.stage("apply-tools");
      await request("thread/resume", { ...resume, threadId, excludeTurns: true, config: {
        ...config,
      } });
      ports.clearRetirement();
      if (Object.keys(live).length) {
        const settings: RecordValue = { threadId };
        if (profile) settings.permissions = profile;
        else if (live.sandbox) settings.sandboxPolicy = live.sandbox;
        for (const key of ["approvalPolicy", "approvalsReviewer", "model", "serviceTier", "collaborationMode"])
          if (live[key] !== undefined && live[key] !== null) settings[key] = live[key];
        if (live.reasoningEffort) settings.effort = live.reasoningEffort;
        ports.stage("restore-settings");
        await request("thread/settings/update", settings);
      }
  return true;
}
