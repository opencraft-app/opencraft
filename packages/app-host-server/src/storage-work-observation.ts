import {createRequestTrace} from "@opencraft/appserver-protocol";
import {addHistoryReadTiming,roundedHistoryDiagnostic,type HistoryReadTiming} from "./history-read-timing.js";
const operations=new Set(["create","release","close","read","observe","importResult","initialization","hasThreads","reindex","revision","catalogRevision","itemSourceCursor","sourceCursor","itemSourceDirection","itemRangeFence","directoryFence"]);
/** One bounded summary per slow worker operation, never one log per SQL call. */
export function observeStorageWork(trace:HistoryReadTiming|undefined,operation:string,reader:boolean,timing:Record<string,any>|undefined,failed:boolean):void {
  if(!trace||!timing)return;
  for(const [source,target] of [["sqlCalls","storageSqlCalls"],["sqlRows","storageSqlRows"],["sqlMs","storageSqlMs"],["workerCpuMs","storageWorkerCpuMs"]])addHistoryReadTiming(trace,target!,timing[source!]);
  for(const key of ["directoryFenceCalls","directoryFenceCacheHits","directoryFenceRebuilds","directoryFenceRows","directoryFenceBytes"])addHistoryReadTiming(trace,key,timing.fence?.[key]);
  if(!trace.context||!trace.sink)return;
  if((timing.queueMs??0)+(timing.executeMs??0)<100&&(timing.sqlCalls??0)<100&&(timing.fence?.directoryFenceRows??0)<100&&(timing.sqlMaxMs??0)<25)return;
  if((trace.storageSamples??0)>=3){addHistoryReadTiming(trace,"storageSamplesDropped",1);return;}
  trace.storageSamples=(trace.storageSamples??0)+1;
  const event:Record<string,unknown>={kind:"dependency",stage:"storage",traceRole:"storage-work",measurementScope:"rpc",observedBy:"self",identitySource:"self",producerMode:"native",
    ...createRequestTrace(trace.context.caller,trace.context.trigger,trace.context),gatewayPairId:trace.gatewayPairId,method:trace.requestMethod??"other",outcome:failed?"failed":"ok",
    storageOperation:operations.has(operation)?operation:"other",storageLane:reader?"reader":"writer",durationMs:Math.max(0,(timing.queueMs??0)+(timing.executeMs??0))};
  for(const key of ["sqlCalls","sqlRows","sqlMs","sqlMaxMs","sqlErrors","sqlPrepareCalls","sqlPrepareMs","sqlFingerprintOverflow","sqlTopFingerprint","sqlTopCalls","sqlTopRows","sqlTopMs","sqlMaxFingerprint"])if(timing[key]!==undefined)event[key]=timing[key];
  for(const [source,target] of [["queueMs","storageQueueMs"],["executeMs","storageExecuteMs"],["workerCpuMs","storageWorkerCpuMs"],["busyWaitMs","storageBusyMs"],["busyRetries","storageBusyRetries"],["authorizationMs","storageAuthorizeMs"]])if(timing[source!]!==undefined)event[target!]=timing[source!];
  for(const key of ["directoryFenceCalls","directoryFenceCacheHits","directoryFenceRebuilds","directoryFenceRows","directoryFenceBytes"])if(timing.fence?.[key]!==undefined)event[key]=timing.fence[key];
  try{trace.sink(roundedHistoryDiagnostic(event));}catch{/* Diagnostics cannot affect the worker receipt. */}
}
