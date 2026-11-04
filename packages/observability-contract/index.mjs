/** Deliberately closed telemetry vocabulary. Never serialize business payloads. */
export const schemaVersion = 1;
export const limits = Object.freeze({ eventBytes: 2048, batchEvents: 32, batchBytes: 32768,
  queueEvents: 2048, queueBytes: 2097152, recentEvents: 128, recentBytes: 131072,
  clientQueueBytes: 262144, rows: 500, responseBytes: 1048576, concurrency: 5,
  freshnessMs: 90000, retentionMs: 604800000, maxWindowMs: 86400000 });
export const kinds = ['producer', 'operation', 'rpc', 'recovery', 'execution', 'queue', 'dependency', 'resource', 'relay_capacity', 'client_signal', 'availability', 'lifecycle'];
export const operations = ['navigation', 'thread_open', 'thread_history_first_paint', 'catalog_first', 'catalog_complete', 'configuration_confirmed', 'submit_ready', 'preference_save', 'recovery', 'other'];
export const outcomes = ['started', 'progress', 'ok', 'failed', 'timeout', 'aborted', 'unfinished', 'empty', 'unknown'];
export const stages = ['connecting', 'initializing', 'backoff', 'blocked', 'queued', 'storage', 'history', 'ready', 'model', 'tool', 'human', 'capacity', 'running', 'completed', 'failed', 'other'];
export const methods = ['initialize','runtime/machine/read','thread/read','thread/resume','thread/list','thread/start','thread/fork','thread/unsubscribe','thread/archive','thread/name/set','thread/items/list','thread/turns/list','thread/loaded/list','turn/start','turn/steer','turn/interrupt','turn/continue','turn/respond','model/list','config/read','config/value/write','config/batchWrite','configRequirements/read','tasks/list','tasks/read','tasks/create','tasks/update','tasks/delete','opencraft/tasks/list','opencraft/tasks/read','opencraft/tasks/create','opencraft/tasks/update','opencraft/schedules/list','opencraft/schedules/create','opencraft/schedules/update','opencraft/schedules/delete','fs/read','fs/write','fs/stat','fs/list','fuzzyFileSearch','command/exec','command/exec/write','command/exec/terminate','process/spawn','process/kill','process/writeStdin','skills/list','skills/read','bot/list','bot/read','mcpServerStatus/list','thread/search','thread/searchOccurrences','other'];
export const components = ['web', 'gateway', 'core', 'relay', 'codex', 'dsh', 'pi', 'observe', 'collector', 'prometheus', 'loki', 'grafana'];
export const origins = ['interactive', 'automation', 'operator', 'probe', 'unknown'];
const id = /^[a-zA-Z0-9_.:-]{1,128}$/u;
const revision = /^[a-zA-Z0-9_.:+-]{1,128}$/u;
const ids = ['mediaDocumentId','sqlTopFingerprint','sqlMaxFingerprint','eventId', 'producerId', 'attemptId', 'operationId', 'executionId', 'recoveryId', 'requestId', 'incidentRef', 'pairId', 'gatewayPairId', 'nativeCallId', 'notificationId', 'notificationCauseTraceId', 'notificationCauseSpanId', 'catalogId', 'directoryId', 'traceId', 'spanId', 'parentSpanId', 'linkedTraceId', 'linkedSpanId', 'hostId', 'site', 'errorCode'];
const enums = {
  mediaPhase: ['policy','source','decode'], mediaSource: ['file','resource','external','data','other'],
  mediaTransport: ['host','direct'], mediaRedirected: [0,1],
  mediaContent: ['image','html','other','unknown'],
  mediaPolicy: ['resource','csp'],
  mediaError: ['none','http','type','abort','dom','rpc','other'],
  mediaReadPhase: ['fetch','body'],
  transportFailure: ['socket-error','socket-close','handshake-timeout','probe-timeout','invalid-response'],
  transportPhase: ['connecting','socket-open','ready'], networkState: ['online','offline','unknown'],
  socketReadyState: [0,1,2,3], socketWasClean: [0,1],
  storageLane:['reader','writer'],storageOperation:['create','release','close','read','observe','importResult','initialization','hasThreads','reindex','revision','catalogRevision','itemSourceCursor','sourceCursor','itemSourceDirection','itemRangeFence','directoryFence','other'],
  resourceScope:['host','cgroup'],resourceTarget:['host','web','execution','core','native','ci','checks','browser','observe','build','dsh'],resourceCoverage:['partial','complete'],
  notificationMethod: ['opencraft/thread-access/changed','opencraft/thread-access/revoked','opencraft/thread-catalog/changed','thread/started','thread/name/updated','thread/archived','thread/unarchived','thread/closed','thread/deleted','thread/pins/updated','thread/status/changed','turn/started','turn/completed'],
  notificationSource: ['history-storage','execution-status','upstream-catalog','upstream-native','access-policy','unknown'],
  notificationChange: ['upsert','patch','remove','invalidate','none','unknown'],
  notificationDecision: ['refresh-other-projections','cancel-and-refetch'],
  caller: ['sidebar-catalog','thread-catalog','history','client','server-refresh'],
  trigger: ['initial-load','auto-next-page','connection-ready','catalog-notification','explicit-retry','explicit-next-page','query-refetch','cache-refresh','direct-request','unknown'],
  traceRole: ['trigger','query','cause-link','client-rpc','gateway-rpc','native-rpc','background-refresh','storage-work'],
  directoryCache: ['hit','miss'],directoryMode:['source','recover'],directoryStart:['head','checkpoint','source-cursor'],directoryCheckpoint:['present','absent'],
  directoryStop:['source-page','cache-satisfied','source-ended','page-budget'],directoryRestart:['source-invalidated'],
  directoryMissReason:['unsupported-filter','empty-store','unsynchronized-tail','source-cursor'],directoryRangeReason:['unsupported-filter','empty-store','unsynchronized-tail','source-cursor'],
  directoryPriorState:['unknown','partial','observed'],directoryState:['unknown','partial','observed'],directoryImportPage:['head','continuation'],
  refreshDecision:['scheduled','deduplicated','disabled'],refreshReason:['initial-discovery','cached-head','watched-read','repair'], clientSignal: ['chat_media','transport_failure','rpc_loop_gap','catalog_query','visible','hidden','freeze','resume','pagehide','pageshow','online','offline','timer_gap','longtask','late_response'], lifecycle: ['deployment','restart','owner_handoff'], kind: kinds, component: components, operationType: operations, outcome: outcomes,
  stage: stages, method: methods, originClass: origins, actorKind: ['human','agent','session','unknown'],
  measurementScope: ['navigation','in_page','rpc','domain','process','client','connection'],
  observedBy: ['self','gateway'], identitySource: ['self','health','installed_artifact','installed_manifest','unknown'], producerMode: ['native','health_projection','client'],
  historyReadSource: ["open","snapshot-reread","attention","overview","navigation","refresh","task-metadata"],
  lengthBucket: ['lt50','50to199','200to499','500plus','unknown'],
  cache: ['cold','warm','unknown'], visibility: ['visible','hidden','unknown'], engine: ['codex','dsh','pi','none','unknown'] };
/** Unknown keys are discarded; malformed known keys reject only this record. */
export function sanitizeEvent(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== schemaVersion) return null;
  if (!kinds.includes(input.kind) || !components.includes(input.component)) return null;
  const event = { schemaVersion };
  for (const [key, choices] of Object.entries(enums)) if (input[key] !== undefined) {
    if (!choices.includes(input[key])) return null;
    event[key] = input[key];
  }
  for (const key of ids) if (input[key] !== undefined) {
    if (typeof input[key] !== 'string' || !id.test(input[key])) return null;
    event[key] = input[key];
  }
  if (event.gatewayPairId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(event.gatewayPairId)) return null;
  if (event.nativeCallId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(event.nativeCallId)) return null;
  for (const [key,length] of [['sqlTopFingerprint',16],['sqlMaxFingerprint',16],['notificationId',32],['notificationCauseTraceId',32],['notificationCauseSpanId',16],['catalogId',32],['traceId',32],['spanId',16],['parentSpanId',16],['linkedTraceId',32],['linkedSpanId',16]])
    if (event[key] !== undefined && (!new RegExp(`^[0-9a-f]{${length}}$`,'u').test(event[key]) || /^0+$/.test(event[key]))) return null;
  if ((event.notificationCauseTraceId === undefined) !== (event.notificationCauseSpanId === undefined)) return null;
  if ((event.traceId === undefined) !== (event.spanId === undefined) || (event.linkedTraceId === undefined) !== (event.linkedSpanId === undefined)) return null;
  if (!event.eventId || !event.producerId) return null;
  if(event.errorCode && !/^(?:rpc:-?\d{1,10}|none|initialize|thread-list|timeout|connection|not-ready|unavailable|unknown)$/u.test(event.errorCode))return null;
  if (event.mediaDocumentId !== undefined && !/^[a-f0-9]{64}$/u.test(event.mediaDocumentId)) return null;
  if (input.mediaHttpStatus !== undefined) {
    if (!Number.isSafeInteger(input.mediaHttpStatus) || input.mediaHttpStatus < 100 || input.mediaHttpStatus > 599) return null;
    event.mediaHttpStatus = input.mediaHttpStatus;
  }
  if (input.mediaReadAttempts !== undefined) {
    if (!Number.isSafeInteger(input.mediaReadAttempts) || input.mediaReadAttempts < 1 || input.mediaReadAttempts > 5) return null;
    event.mediaReadAttempts = input.mediaReadAttempts;
  }
  for (const key of ['socketBufferedBytes','lastMessageAgoMs','probeElapsedMs','lastProbeRttMs','transportTimeoutMs','timerLateMs','pagePauseMs','pageResumeAgoMs','pageHiddenForMs']) if (input[key] !== undefined) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0) return null;
    event[key] = input[key];
  }
  if (input.socketCloseCode !== undefined) {
    if (!Number.isSafeInteger(input.socketCloseCode) || input.socketCloseCode < 0 || input.socketCloseCode > 4999) return null;
    event.socketCloseCode = input.socketCloseCode;
  }
  if (event.clientSignal === 'transport_failure' && (!event.attemptId || !event.transportFailure || !event.transportPhase)) return null;
  for (const key of ['nativeReplyYieldMs','nativeStatusSnapshotMs','nativeStatusPublishMs','nativeStatusChanges','nativeStatusPublishAttempts','storageSamplesDropped','storageSqlCalls','storageSqlRows','storageSqlMs','storageWorkerCpuMs','sqlCalls','sqlRows','sqlMs','sqlMaxMs','sqlErrors','sqlPrepareCalls','sqlPrepareMs','sqlFingerprintOverflow','sqlTopCalls','sqlTopRows','sqlTopMs','directoryFenceCalls','directoryFenceCacheHits','directoryFenceRebuilds','directoryFenceRows','directoryFenceBytes','resourceCpuCores','resourceCpuBusyPercent','resourceIoWaitPercent','resourceCpuPressurePercent','resourceIoPressurePercent','resourceCpuThrottledMs','resourceReadBytes','resourceWriteBytes','resourceMemoryBytes','resourceMemoryAvailableBytes','resourceMembers','resourceNewMembers','resourceSampleMs','diagnosticTrimmed','notificationRevision','notificationToInvalidateMs','notificationCount','clientLoopDelayMs','clientOutsideGatewayMs','gatewayIngressAt','gatewayIngressQueueMs','gatewayRpcAccessMs','gatewayIngressToReadMs','gatewayIngressToReplyMs','gatewayReplyAt','causeCount','causeOverflow','pageIndex','directoryPages','directoryQueued','generation','attempt','count','bytes','dropped','rejected','durationMs','webSentAt','clientQueueMs','historyCoreMs','historyDecodeMs','historyMetadataMs','historyQueueMs','historySourceMs','historyReconcileMs','historyPageMs','historyProjectionMs','historyScanMs','historyNativeRpcMs','historyNativeRpcCount','requestPending','clientBudgetMs','clientWallMs','clientElapsedMs','clientReceivedAt','clientReceiveToSettleMs','gatewayTimingVersion','nativeStartOffsetMs','nativeDecodeMs','nativeDispatchAtMs','nativeReplyAtMs','nativeReplyWaitMs','nativeSendMs','nativeReceiveQueueMs','nativeReplyProcessingMs','nativePendingWritesMs','nativeImportQueueMs','nativeImportMs','gatewayMs','gatewayDependencyMs','gatewayStorageMs','gatewayInitializeMs','gatewaySourceMs','gatewaySerializeMs','gatewayDeliverMs','storageDependencyMs','storageQueueMs','storageExecuteMs','storageBusyMs','storageBusyRetries','storageAuthorizeMs','rssBytes','heapBytes','cpuSeconds','eventLoopDelayMs','relayCapturedAt','relayActiveStreams','relayPendingStreams','relayControlConnections','relayMaxInstanceSlots','relayPeakSlots','relayPeakInstanceSlots','relayInstanceLimit','relayGlobalLimit','relayRejectedInstance','relayRejectedGlobal','relayOpenTimeouts','lastSuccessAt','consecutiveFailures']) if (input[key] !== undefined) {
    if (!Number.isFinite(input[key]) || input[key] < 0 || input[key] > Number.MAX_SAFE_INTEGER) return null;
    event[key] = input[key];
  }
  if (event.kind === 'availability' && (!event.site || !event.hostId || !event.engine || !['ok','failed','timeout'].includes(event.outcome))) return null;
  if (event.kind === 'lifecycle' && !event.lifecycle) return null;
  if (event.kind === 'relay_capacity') {
    if (event.component !== 'relay') return null;
    for (const key of ['relayCapturedAt','relayActiveStreams','relayPendingStreams','relayControlConnections','relayMaxInstanceSlots','relayPeakSlots','relayPeakInstanceSlots','relayInstanceLimit','relayGlobalLimit','relayRejectedInstance','relayRejectedGlobal','relayOpenTimeouts']) {
      if (!Number.isSafeInteger(event[key])) return null;
    }
    if (event.relayCapturedAt !== input.at || !event.relayInstanceLimit || !event.relayGlobalLimit) return null;
  }
  for (const key of ['sourceRevision','buildId','version','workloadDigest']) if (input[key] !== undefined) {
    if (input[key] === null) { event[key] = null; continue; }
    if (typeof input[key] !== 'string' || !revision.test(input[key])) return null;
    event[key] = input[key];
  }
  if (!Number.isFinite(input.at) || (input.at > now + 30000 || now - input.at > limits.retentionMs)) return null;
  event.at = input.at;
  event.originClass ??= 'unknown'; event.actorKind ??= 'unknown';
  return new TextEncoder().encode(JSON.stringify(event)).length <= limits.eventBytes ? event : null;
}
export function fault(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
export function windowFor(input = {}, now = Date.now(), max = limits.maxWindowMs) {
  const to = input.to === undefined ? now : Date.parse(input.to);
  const from = input.from === undefined ? to - 900000 : Date.parse(input.from);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > max || to > now + 30000) throw fault('invalid_window');
  return { from, to };
}
