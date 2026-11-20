/**
 * @typedef {object} ExecutionPort
 * @property {(work: object, signal: AbortSignal) => Promise<string|{status:'waiting_input',workId:string}>} run
 * @property {() => Promise<void>} suspendAll - Suspend, do not implicitly cancel business work.
 *
 * @typedef {object} ReceptionModelPort
 * @property {(input: object, signal: AbortSignal) => Promise<object>} decide - Pure proposal, no business writes.
 *
 * @typedef {object} KnowledgeSourcePort
 * @property {() => {id:string,binding:string}} reference - Configured by the operator, never the model.
 * @property {(directory?:string) => object[]} list
 * @property {(path:string) => {path:string,text:string,sha256:string}} read
 *
 * @typedef {object} ArtifactPort
 * @property {(executionId:string,body:string) => object} publishNote
 *
 * @typedef {object} DeliveryPort
 * @property {(delivery:object) => void} deliver - Reconcile one stable logical delivery identity.
 *
 * Repository and UnitOfWork contracts are currently synchronous local ports.
 * A future remote/Temporal adapter requires an explicit transaction boundary redesign,
 * not a Promise returned from inside a SQLite transaction.
 */
export {};

/**
 * @typedef {object} UserMessageTransportPort
 * @property {(message:object,signal:AbortSignal)=>Promise<{messageId:string,channel:string,level:'accepted',remoteId:string}>} deliver
 * Replay the SAME stable ID/payload and reconcile unknown acceptance before creating another
 * external effect. A timeout/abort does not prove that an external service did nothing.
 * Accepted is a transport receipt, not a human read receipt or Work completion.
 *
 * @typedef {object} AttachmentReadPort
 * @property {(id:string)=>object} describe - Current profile's immutable reference only.
 * @property {(page?:object)=>{items:object[],next:string|null}} list - Bounded metadata, no path import.
 * Explicit local CLI import and actual artifact publication belong to the I/O adapter.
 */

/**
 * @typedef {object} ReceptionReadPort
 * @property {(conversationId:string,messageId:string,limit:number,requireUser?:boolean)=>object|null} history - User inputs require a user anchor; system wakes use a host-captured message anchor.
 * @property {(conversationId:string,after:string|null,limit:number)=>object[]} goals
 * @property {(conversationId:string,goalId:string,page?:object)=>object|null} goal - Scoped plan/criteria with next cursor, no grants.
 * @property {(conversationId:string,after:string|null,limit:number)=>object[]} works
 * @property {(conversationId:string,workId:string)=>object|null} work - Returns no unlinked work.
 * @property {(conversationId:string,after:string|null,limit:number)=>object[]} questions
 * @property {(limit:number)=>object[]} memories
 * @property {(key:string)=>object|null} memory
 * @property {(view:object,options:{query?:string,text?:string,limit?:number,after?:string,match?:string})=>object[]} recall - Internal text selects bounded question-related lexical candidates; explicit query retains literal/AND semantics. SELECT-only; same authorized view, no raw history.
 * @property {(conversationId:string,workId:string)=>object|null} report - Current linked work only; callers bound and paginate its text before exposing it to models.
 * @property {(limit:number)=>object[]} routines - Bounded definitions for this single-assistant profile.
 * SELECT-only projection: no driver, mutation or command method is exposed to callers.
 *
 * @typedef {object} ReceptionPlanningPort
 * @property {(turn:object,input:object,signal:AbortSignal)=>Promise<{proposal:object,queries:object[]}>} plan
 * Query reads may repeat on crash; only ReceptionService settles the final command transaction.
 */

/**
 * @typedef {object} ExecutionReport
 * @property {string} id - Stable report identity per business execution.
 * @property {string} execution_id
 * @property {string} work_id
 * @property {number} revision
 * @property {'returned'|'error'} status - Execution observation, not semantic completion or delivery.
 * @property {string} text - Immutable raw report, possibly empty on failure.
 * @property {string|null} error
 * @property {number} created_at
 *
 * Report admission, its system reception turn and awaiting_review work state commit
 * in one synchronous local UoW. Main-model calls happen later, outside that UoW.
 * Replaying a model decision is safe through the turn identity, work revision and
 * owning services. A silent decision is not channel acceptance or user activity.
 */

/**
 * @typedef {object} RunPolicy
 * @property {number} maxSteps - Generation steps per same-requirement execution chain, persisted/deduplicated by native task ID, not provider attempt count.
 * @property {number} workTimeoutMs - One active adapter run; pauses on wait/shutdown, starts fresh on resume.
 * @property {number} modelTimeoutMs - Model exchange deadline; late proposals cannot commit.
 * @property {number} maxRetries - Per retry layer; not a whole-work call or cost cap.
 *
 * @typedef {object} UsageObservation
 * @property {string} id - Host call ID or stable pi:work:bucket:mode snapshot identity.
 * @property {'fixture'|'model'} mode
 * @property {object} usage - Nonnegative observed counters/estimatedCostUsd, unknown values are null.
 * @property {number|null} hostCalls - Host exchanges only; native/provider internal retry counts may be unknown.
 *
 * Usage callbacks are synchronous observations outside model transactions. Failures must
 * reach diagnostics without rerunning successful calls. Native snapshots replace cumulative
 * values rather than adding each sample; estimates are not billed amounts or balances.
 */

/**
 * @typedef {object} ExecutionHostPort
 * @property {(work:object)=>object} execution - Existing execution identity; no creation or retirement capability.
 * @property {(work:object)=>object|null} predecessor - Same-root bound ancestor, read-only; native checkpoint remains in the harness.
 * @property {(work:object)=>object} snapshot - Host-owned immutable delegation snapshot.
 * @property {(work:object,taskId:string|number,limit:number)=>void} modelStep
 * @property {(work:object,rootId:unknown,submissionId:unknown,options?:{admitted?:boolean})=>void} bound - Immutable native binding; admitted=false does not claim native input acceptance.
 * @property {(work:object)=>object} assertCurrent
 * @property {(work:object,observation:object)=>void} observeRun
 *
 * @typedef {object} WorkToolPort
 * @property {(tool:string,resource?:object,epoch?:unknown)=>void} assertAction - Always check before actual I/O.
 * @property {()=>object} readContext
 * @property {(artifact:object,body:string)=>object} publishedNote - Host receipt, never a model completion assertion.
 * @property {(material:object)=>object} materialRead
 * @property {(callId:string,question:string,options?:object)=>object} requestInteraction
 * @property {()=>object[]} listSkills
 * @property {(id:string)=>object} loadSkill
 * @property {(kind:string,data:object)=>void} event
 *
 * WorkToolPort is bound to one work revision and its snapshot by the composition root.
 * No caller-supplied work ID, repository, credential, or lifecycle owner is exposed.
 * The trusted adapter still checks assertAction before I/O; projections do not grant
 * authority or replace the original service validation. All methods are synchronous.
 */

/**
 * WorkToolPort now also exposes recallMemory(options) for the captured resource scope,
 * and searchHistory(options) for the work's explicitly linked conversation.
 * ReceptionReadPort adds recall(projectId, options) and searchHistory(conversationId, options)
 * as SELECT-only adapter methods; host projections compute IDs, never model input.
 * Recall returns bounded profile/recent records or literal matches with stable identities,
 * truncation and available evidence. Neither summaries nor matches are new user authority.
 */

/**
 * @typedef {object} ConversationContextModelPort
 * @property {(input:{previous:object|null,messages:object[]},signal:AbortSignal)=>Promise<object>} summarize - Pure, cited four-section proposal; no cursor or command authority.
 *
 * @typedef {object} ConversationContextViewPort
 * @property {(turn:object)=>object|null} view - Anchored checkpoint plus explicit unsummarized gap; never a Work/Memory authority.
 *
 * @typedef {object} HistoryMessageReadPort
 * @property {(conversationId:string,messageId:string,anchorId:string,offset:number,limit:number)=>object|null} historyMessage - SELECT-only canonical text at or before the host-captured anchor.
 * Summary calls happen outside UoW. The context owner validates parent/source/citations and commits
 * the immutable checkpoint before reception planning. A failed summary never settles an input.
 */

/**
 * PlatformChannelPort: host-only authenticated bridge, asynchronous outside all UoWs.
 * authorize(binding, signal) -> {binding, epoch, expiresAt}; epoch fences retired assignments.
 * request(binding, nativeMethod, params, signal) -> delegated read result; the native owner checks
 * the represented Human current visibility. No sends, read-marker mutation, caller-supplied
 * Actor context or storage handle. Desktop and server Hosts use the same contract.
 * Group results are source references/content observations, not private memory write authority.
 */
