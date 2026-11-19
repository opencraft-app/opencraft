import {deliverTurnNotification} from './turn-notifications.mjs';
import {wecomAttributedText} from '../message-attribution.mjs';
import {sendMarkdownMessage} from '../message-markdown.mjs';
import {messagePresentation} from '../message-presentation.mjs';
import {groupSyncProvider} from './group-sync-provider.mjs';
import {shortcutEvent} from '../rich-outbound.mjs';
import {readProviderState,verifyChatChange} from './provider-state.mjs';
import {tickInteractions} from './interaction-lifecycle.mjs';
import { assistantAction, interactionEvent } from './interactions.mjs';
import { reportCard } from '../report-card.mjs';
import { MAX_GROUP_FILE_BYTES, MAX_GROUP_FILE_BASE64 } from '../outbound-files.mjs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { channelImageType } from '@opencraft/appserver-protocol';
import { mentionCommand, commandReply } from '../commands.mjs';
import { describeChoice, answeredCard, timelineText } from './cards.mjs';
import { parseChoiceQuestion } from '../choice-card.mjs';
import { mentionsEveryone } from '../mentions-out.mjs';
/** At most one @all per group in this window, so a loop or a prompt injection cannot spam a room. */
export const EVERYONE_COOLDOWN_MS = 10*60*1000;
import { humanKey } from './store.mjs';
export const MIRROR_PATH = '/__opencraft_wecom_mirror';
const digest = value => createHash('sha256').update(value).digest();
/** Deterministic per provider message, so a placeholder and its answer share one stream without extra state. */
export const streamIdFor = (source,msgId,part='') => 'oc-'+createHash('sha256').update(JSON.stringify([source,msgId,part])).digest('hex').slice(0,40);
/** Follow-ups without @ from the same person within this window still reach their assistant. */
export const FOLLOW_UP_WINDOW_MS = 5*60*1000;
const FILE_FETCH_MS = 50000, MAX_FILE_BYTES = 20*1024*1024;
/** The thinking placeholder appears only if no answer has started by then (@ and follow-ups alike). */
export const FOLLOW_UP_PLACEHOLDER_DELAY_MS = 0;
export const STILL_WORKING = '等待回复已超时，已结束等待状态；若后续有结果，会另行发送。';
/** WeCom stops accepting stream updates after roughly 10–12 minutes (measured 2026-11-13). */
export const PLACEHOLDER_TIMEOUT_MS = 8*60*1000;
const json = (res,status,body) => { res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body)); };
async function readBody(req, maxBytes=4194304) {
  const chunks=[];let size=0;
  for await (const chunk of req) { size+=chunk.length;if(size>maxBytes)throw Error('body_too_large');chunks.push(chunk); }
  const input=JSON.parse(Buffer.concat(chunks));
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('invalid_body');
  return input;
}

export class MirrorService {
  constructor({store,transport,servers=[],corpId,memberEvidence,nativeMemberEvidence,receiverEnrollment,allowLoopbackInsecure=false,forwardingOnly=false,directory,streamReplies=false,followUps=false,immediateWaiting=process.env.OPENCRAFT_WECOM_IMMEDIATE_WAITING!=='0',followUpDelay=immediateWaiting?FOLLOW_UP_PLACEHOLDER_DELAY_MS:120000}) {
    this.receiverEnrollment=receiverEnrollment;
    this.streamReplies=streamReplies===true&&typeof transport.respond==='function';
    this.followUps=this.streamReplies&&followUps===true;
    this.followUpDelay=followUpDelay;this.immediateWaiting=immediateWaiting;
    this.memberEvidence=memberEvidence;
    this.nativeMemberEvidence=nativeMemberEvidence;
    this.store=store;this.transport=transport;this.corpId=corpId;this.servers=new Map();this.stopped=false;
    this.abort=new AbortController();this.pending=new Set();
    this.allowLoopbackInsecure=allowLoopbackInsecure;
    this.forwardingOnly=forwardingOnly;
    this.directory=directory;
    if(!Array.isArray(servers)||servers.length>256)throw Error('invalid_servers');
    for(const server of servers) {
      if(!/^[A-Za-z0-9._-]{1,128}$/u.test(server.id)||typeof server.name!=='string'||!server.name||server.name.length>128
        ||!/^[-_A-Za-z0-9]{43}$/u.test(server.credential)||this.servers.has(server.id)
        ||(server.legacyRecording!==undefined&&typeof server.legacyRecording!=='boolean'))throw Error('invalid_server');
      this.servers.set(server.id,{id:server.id,name:server.name,digest:digest(server.credential),legacyRecording:server.legacyRecording===true});
    }
    this.unsubscribe=transport.subscribe(event=>this.track(this.ingest(event)));
  }
  track(job) { this.pending.add(job);void job.then(()=>this.pending.delete(job),()=>this.pending.delete(job));return job; }
  async ingest(event) {
    this.abort.signal.throwIfAborted();
    if(/^(wb|fw|external:)/u.test(event.author))event={...event,mentioned:false};
    // A sent file travels as a reference; the bound server fetches and reads it in the background.
    if(event.voice){const {voice,...rest}=event;event=!this.forwardingOnly&&typeof voice.mediaId==='string'&&voice.mediaId.length<=512
      ?{...rest,voice:{mediaId:voice.mediaId,format:String(voice.format??'').slice(0,16)}}:rest;}
    if(event.file){const {file,...rest}=event;event=!this.forwardingOnly&&typeof file.mediaId==='string'&&file.mediaId.length<=512
      &&typeof file.name==='string'&&file.name.length<=255?{...rest,file:{mediaId:file.mediaId,name:file.name}}:rest;}
    // A private chat binds itself to the person's own server the first time they write.
    if(event.direct===true){const {direct:_,...rest}=event;event=rest;await this.bindDirect(event);}
    let job=mentionCommand(event,this.corpId);
    // Unbound rooms retain onboarding; bound rooms send ordinary mentions to the assistant.
    if(!job&&event.mentioned&&!((await this.store.snapshot(event.source)).binding))
      job=mentionCommand({...event,text:'帮助'},this.corpId);
    if(this.forwardingOnly)return job?this.store.control(event,job):'ignored';
    // A plain message from someone whose window is open continues their conversation.
    // Control commands still require an explicit @.
    if(!/^(wb|fw|external:)/u.test(event.author)&&!job&&!event.mentioned&&this.followUps
      &&(event.text?.trim()||event.mediaId||event.file||event.voice||event.emotion||event.nestedMedia?.length)
      &&(await this.store.snapshot(event.source)).binding
      &&await (this.store.followUpDecision?.(event.source,event.id,event.author)??this.store.windowOpen(event.source,event.author))) {
      const candidate={...event,mentioned:true};
      if(!mentionCommand(candidate,this.corpId)){event=candidate;}
    }
    const typing=this.streamReplies?{delay:this.followUpDelay,replace:this.immediateWaiting,human:humanKey(this.corpId,event.author)}:undefined;
    let first=await this.store.ingest(event,undefined,job,typing);
    if(first==='media_required') {
      const bytes=await this.transport.images.download(event.mediaId,this.abort.signal);
      if(!channelImageType(bytes))throw Error('invalid_media');
      this.abort.signal.throwIfAborted();
      first=await this.store.ingest(event,bytes,job,typing);
    }
    if(first==='stored'&&!job&&event.mentioned){
      if(this.followUps)await this.store.openWindow(event.source,event.author,FOLLOW_UP_WINDOW_MS);
      // Best effort: only choice cards depend on it, and only to find the requester.
      this.track((async()=>this.store.rememberMention?.(event.source,event.id,event.author))().catch(()=>{}));
      // @all is allowed only for a reply to a person who asked for it in their own message.
      if(mentionsEveryone(event.text))this.track((async()=>this.store.allowEveryone?.(event.source,event.id))().catch(()=>{}));
      // Cosmetic API calls never hold up admission or agent execution.
      if(this.immediateWaiting)this.wakeTyping();
    }
    return first;
  }
  /** Bind "single:<userid>" to a server the person has registered on; quiet when there is none. */
  async bindDirect(event) {
    if((await this.store.snapshot(event.source)).binding)return;
    const human=humanKey(this.corpId,event.author);
    const [server]=await this.store.candidates(human);
    if(!server)return;
    const names=await this.transport.senderNames?.(event.source,[event.author],AbortSignal.timeout(1500)).catch(()=>new Map());
    const label=names?.get(event.author)??event.author;
    await this.store.bind(event.source,human,server.id,(label+' 的私聊').slice(0,60)).catch(()=>{});
  }
  /** Welcome someone opening a private chat, at most once a day. */
  async welcome(userId) {
    if(typeof this.transport.welcomeDirect!=='function'||!(await this.store.claimOnce?.('welcome-menu-v1:'+userId,86400000)))return;
    await this.transport.welcomeDirect(userId,AbortSignal.any([this.abort.signal,AbortSignal.timeout(4000)]));
  }
  /** Serialize cosmetic opens and real replies across Relay replicas, not merely within this process. */
  async withTyping(member,signal,work,wait=true) {
    const state=this.store.typing;
    if(!state||!member)return work(null);
    for(;;){
      signal.throwIfAborted();
      const token=await state.lock(member);
      if(token){try{return await work(token);}finally{await state.release(member,token);}}
      if(!wait)return;
      await new Promise(resolve=>{const t=setTimeout(done,20);function done(){clearTimeout(t);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();});
    }
  }
  /** Coalesce intake wakeups without losing a new message arriving during an API await. */
  wakeTyping() {
    if(!this.streamReplies||!this.store.typing||this.stopped)return;
    this.typingAgain=true;
    if(!this.typingJob)this.typingJob=this.track((async()=>{
      do{this.typingAgain=false;await this.pumpTyping().catch(()=>{});}while(this.typingAgain&&!this.stopped);
    })().finally(()=>{this.typingJob=undefined;if(this.typingAgain&&!this.stopped)this.wakeTyping();}));
  }
  /** Close only the superseded spinner, never a finished answer. Unknown acknowledgements are not replayed. */
  async retireTyping(member,token,signal,now=Date.now()) {
    const state=this.store.typing,r=await state.read(member);if(!r?.retiring)return true;
    if(r.retiring.closing)return false;
    const closing=await state.change(member,token,'retire',now,PLACEHOLDER_TIMEOUT_MS);if(!closing)return false;
    const anchor=closing.retiring.anchor;
    if(!await state.owns(member,token)||!await this.store.claimStream(r.source,anchor))return false;
    const code=await this.transport.respond(anchor,streamIdFor(r.source,anchor),'',true,AbortSignal.any([signal,AbortSignal.timeout(4000)]));
    if(code!==0)return false;
    return !!await state.change(member,token,'retired',now,0,'',anchor);
  }
  /** A new eligible message supersedes this sender's spinner, not the underlying task. */
  async pumpTyping(now=Date.now()) {
    const state=this.store.typing;if(!this.streamReplies||!state)return;
    for(const member of await state.due(now)) {
      if(this.stopped)break;
      const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(7000)]);
      try{await this.withTyping(member,signal,async token=>{
        let r=await state.read(member);if(!r){await state.change(member,token,'take');return;}
        if(r.dueAt>now)return;
        const binding=(await this.store.snapshot(r.source)).binding;
        if(!binding||binding.serverId!==r.serverId||binding.generation!==r.generation){await state.change(member,token,'discard',now,0,r.id);return;}
        if(r.retiring){
          // A lost close acknowledgement suppresses fresh dots; do not replay or pile up bubbles.
          if(r.retiring.closing&&now>=r.retiring.openedAt+PLACEHOLDER_TIMEOUT_MS){await state.change(member,token,'discard',now,0,r.id);return;}
          if(!await this.retireTyping(member,token,signal,now))return;
          r=await state.read(member);if(!r||r.dueAt>now)return;
        }
        if(r.settled){await state.change(member,token,'discard',now,0,r.id);return;}
        if(r.anchor){
          if(!await state.owns(member,token))return;
          const expired=await state.change(member,token,'take',now,0,r.id);
          if(!expired||!await state.owns(member,token))return;
          if(await this.store.claimStream(r.source,r.anchor))await this.transport.respond(r.anchor,streamIdFor(r.source,r.anchor),STILL_WORKING,true,signal);
          return;
        }
        if(now-r.createdAt>=this.followUpDelay+PLACEHOLDER_TIMEOUT_MS){await state.change(member,token,'take',now,0,r.id);return;}
        const cap=await this.store.serverCapabilities(r.serverId);
        // A bound group alone is not proof that this person has an assistant on its receiver.
        if(!cap?.streamReplies||!Object.hasOwn(cap.humans??{},r.human)){await state.change(member,token,'defer',now,15000,r.id);return;}
        if(typeof this.transport.chatMembers==='function'&&!(await this.transport.chatMembers(r.source,signal)).includes(r.author)){await state.change(member,token,'take',now,0,r.id);return;}
        if(!await state.owns(member,token))return;
        const opened=await state.change(member,token,'open',now,PLACEHOLDER_TIMEOUT_MS,r.id);if(!opened)return;
        // Persist before external I/O: unknown acknowledgements never open a second bubble on retry/restart.
        const code=await this.transport.respond(opened.anchor,streamIdFor(r.source,opened.anchor),'',false,AbortSignal.any([signal,AbortSignal.timeout(4000)]));
        if(code!==0)await state.change(member,token,'take',now,0,r.id);
      },false);}catch{ /* Cosmetic failure must never delay native intake or replay an uncertain open. */ }
    }
  }
  async settleTyping(input,signal) {
    if(!this.streamReplies||!this.store.typing||!input.replyTo)return;
    const ctx=await this.store.typing.context(input.source,input.replyTo);if(!ctx)return;
    await this.withTyping(ctx.member,signal,async token=>{
      const current=await this.store.typing.read(ctx.member);
      if(current?.id===ctx.id)await this.retireTyping(ctx.member,token,signal).catch(()=>false);
      const r=await this.store.typing.change(ctx.member,token,'take',Date.now(),0,ctx.id);
      if(r?.anchor&&await this.store.claimStream(r.source,r.anchor))await this.transport.respond(r.anchor,streamIdFor(r.source,r.anchor),'',true,signal);
    });
  }
  /** Close placeholders whose answer has not arrived in time; the later answer opens a new stream beneath the same message. */
  async closeStalePlaceholders(now=Date.now()) {
    if(!this.streamReplies||typeof this.store.stalePlaceholders!=='function')return;
    for(const {source,msgId,member} of await this.store.stalePlaceholders(now-PLACEHOLDER_TIMEOUT_MS)) {
      if(this.stopped)break;
      try {
        if(await this.store.claimStream(source,msgId))
          await this.transport.respond(msgId,streamIdFor(source,msgId),STILL_WORKING,true,AbortSignal.any([this.abort.signal,AbortSignal.timeout(4000)]));
      } catch { /* Best effort: the provider window bounds the visible effect. */ }
      finally { await this.store.dropPlaceholder(member).catch(()=>{}); }
    }
  }
  /** Send an interactive card and keep its definition so clicks can be answered in time. */
  async sendCard(source,card,signal) {
    if(!card||typeof card!=='object'||!['button_interaction','vote_interaction','multiple_interaction'].includes(card.card_type)
      ||typeof card.task_id!=='string'||!/^[A-Za-z0-9_\-@]{1,128}$/u.test(card.task_id)||JSON.stringify(card).length>16384)throw Error('invalid_card');
    await this.store.rememberCard(source,card.task_id,card);
    return this.transport.sendCard(source,card,signal);
  }
  /** Card click: update the card inside the 5 s window, then record the outcome in the bound group. */
  async cardEvent(event) {
    if(event.eventKey?.startsWith('oc-x-'))return shortcutEvent(this,event);

    if(event.direct===true) {
      const source=JSON.parse(event.source);
      if(source[3]!=='single:'+event.author)return 'not_owner';
      await this.bindDirect(event);
    }
    if(!await this.store.claimCardEvent(event.source,event.id))return 'duplicate';
    // Cards sent outside the Relay (e.g. the CLI) have no stored definition: answer with a plain notice.
    const card=await this.store.card(event.source,event.taskId)??{card_type:'unknown',main_title:{title:'已处理'}};
    if(card.multi||card.multiControl||card.control||event.eventKey==='oc-pause-daily')return interactionEvent(this,event,card);
    if(card.owner&&event.author!==card.owner) {
      // Choice cards answer one requester's assistant; others see a note and the buttons stay usable.
      await this.transport.updateCard(event.responseCode,{card_type:card.card_type,main_title:card.main_title,sub_title_text:'仅提问人可以选择，其他人请 @助理 回复',button_list:card.button_list},
        [event.author],AbortSignal.any([this.abort.signal,AbortSignal.timeout(3500)])).catch(()=>{});
      return 'not_owner';
    }
    const names=await this.transport.senderNames(event.source,[event.author],AbortSignal.timeout(1200)).catch(()=>new Map());
    const [won,answer]=await this.store.answerCard(event.source,event.taskId||event.id,{actor:names.get(event.author)??event.author,choice:describeChoice(card,event)});
    await this.transport.updateCard(event.responseCode,answeredCard(card,answer.actor,answer.choice),undefined,AbortSignal.any([this.abort.signal,AbortSignal.timeout(3500)])).catch(()=>{});
    if(!won)return 'already_answered';
    const actor=answer.actor,choice=answer.choice;
    if(!(await this.store.snapshot(event.source)).binding)return 'answered';
    // A choice card answers the requester's assistant: record it as their own mention.
    return this.store.ingest({source:event.source,id:'card:'+event.id,author:event.author,sender:{id:event.author,displayName:actor},
      text:card.owner?`选择：${choice}`:timelineText(card,choice),at:event.at,...((card.owner||event.direct===true)?{mentioned:true}:{})},undefined,undefined);
  }
  /** Answer as a finished stream under the original message; definitive provider refusal falls back to standalone Markdown. */
  async reply(input,signal) {
    // An answer keeps the requester's window open for a natural follow-up.
    if(this.followUps)this.track((async()=>{const owner=await this.store.mentionAuthor?.(input.source,input.replyTo);
      if(owner)await this.store.openWindow(input.source,owner,FOLLOW_UP_WINDOW_MS);})().catch(()=>{}));
    const ctx=await this.store.typing?.context(input.source,input.replyTo);
    return this.withTyping(ctx?.member,signal,async token=>{
      if(ctx&&(await this.store.typing.read(ctx.member))?.id===ctx.id)await this.retireTyping(ctx.member,token,signal).catch(()=>false);
      const r=ctx?await this.store.typing.change(ctx.member,token,'take',Date.now(),0,ctx.id):null;
      const target=r?.anchor??input.replyTo;
      if(target!==input.replyTo)await this.store.claimStream(input.source,input.replyTo);
      if(ctx&&!await this.store.typing.owns(ctx.member,token))throw Error('typing_lease_lost');
      return this.replyStream(input,signal,target,!!r?.anchor);
    });
  }
  async replyStream(input,signal,target=input.replyTo,placeholder=false) {
    const content=wecomAttributedText(input,true);
    // Explicit, authorized @all is the notification itself, never an extra
    // canned ping after an already delivered answer. Ordinary Markdown @names
    // are just text; real member notifications use the explicit rich-text API.
    if(mentionsEveryone(input.text)&&input.replyTo&&typeof this.transport.mentionEveryone==='function'
      &&await this.store.everyoneAllowed?.(input.source,input.replyTo)
      &&await this.store.claimEveryone?.(input.source,EVERYONE_COOLDOWN_MS)) {
      if(this.streamReplies&&await this.store.claimStream(input.source,target))
        await this.transport.respond(target,streamIdFor(input.source,target),'',true,signal);
      const status=await this.transport.mentionEveryone(input.source,wecomAttributedText(input),signal);
      if(status==='delivered')this.track(this.choiceCard(input).catch(()=>{}));
      return status;
    }
    if(Buffer.byteLength(content)<=20480) {
      const part=await this.store.claimStream(input.source,target)?'':String(input.requestId);
      // Transport errors propagate: the target settles them as unknown and never resends.
      if(await this.transport.respond(target,streamIdFor(input.source,target,part),content,true,signal)===0) {
        this.track(this.choiceCard(input).catch(()=>{}));
        return 'delivered';
      }
    }
    if(placeholder&&Buffer.byteLength(content)>20480&&await this.store.claimStream(input.source,target))await this.transport.respond(target,streamIdFor(input.source,target),'',true,signal);
    const status=await sendMarkdownMessage(this.transport,input,signal);
    if(status==='delivered')this.track(this.choiceCard(input).catch(()=>{}));
    return status;
  }
  /** A delivered question with numbered choices also gets buttons for its requester. */
  async choiceCard(input) {
    const question=parseChoiceQuestion(input.text);
    if(!question||typeof this.transport.sendCard!=='function')return;
    const owner=await this.store.mentionAuthor(input.source,input.replyTo);
    if(!owner)return;
    const task_id='oc-q-'+createHash('sha256').update(JSON.stringify([input.source,input.requestId])).digest('hex').slice(0,40);
    const card={card_type:'button_interaction',task_id,owner,main_title:{title:question.prompt.slice(0,120)},
      sub_title_text:'由提问人选择',action_menu:{desc:'更多',action_list:[{text:'不选了，跳过',key:'oc-skip'}]},button_list:question.choices.map((text,i)=>({text:text.slice(0,20),key:'c'+(i+1),style:1}))};
    await this.store.rememberCard(input.source,task_id,card);
    const {owner:_,...wire}=card;
    await this.transport.sendCard(input.source,wire,AbortSignal.any([this.abort.signal,AbortSignal.timeout(7000)]));
  }
  async replyFor(source,job) {
    if(job.kind==='reply')return job.text;
    if(job.kind==='warning')return '本群已暂存 10 条消息，请指定保存服务器。发送“@机器人 服务器”查看选项；最多保留前 200 条，超出部分丢弃。';
    if(this.selection)return this.selection.reply(source,job);
    return commandReply(this.store,source,job,{forwardingOnly:this.forwardingOnly,directory:this.directory});
  }
  async tick() {
    await tickInteractions(this).catch(()=>{});
    this.wakeTyping();
    await this.closeStalePlaceholders().catch(()=>{});
    for(const source of await this.store.work()) {
      if(this.stopped)break;
      const token=await this.store.claim(source,true);if(!token)continue;
      try {
        const job=await this.store.head(source,token,true);if(!job)continue;
        const text=await this.replyFor(source,job);
        if(!await this.store.notice(source,token,text))continue;
        const send = this.forwardingOnly || this.selection ? this.transport.sendMarkdown : this.transport.send;
        const sent=await send.call(this.transport,{source,requestId:'mirror-notice',text,author:'OpenCraft'},AbortSignal.any([this.abort.signal,AbortSignal.timeout(7000)]));
        if(sent==='delivered')await this.store.ack(source,token,'',true);
      } catch { /* Keep this notice queued; other rooms must still make progress. */ }
      finally { await this.store.release(source,token,true); }
    }
  }
  start() {
    const run=()=>{
      if(this.stopped)return;
      this.job=this.track(this.tick()).catch(()=>{}).finally(()=>{if(!this.stopped){this.timer=setTimeout(run,1500);this.timer.unref();}});
    };
    run();
  }
  authenticate(req) {
    if(!req.socket.encrypted&&!(this.allowLoopbackInsecure&&req.socket.remoteAddress==='127.0.0.1'))throw Error('denied');
    if(req.headers.origin)throw Error('denied');
    const id=req.headers['x-opencraft-mirror-server'];const server=typeof id==='string'&&this.servers.get(id);
    const auth=req.headers.authorization;
    if(typeof id!=='string'||!/^[A-Za-z0-9._-]{1,128}$/u.test(id)||typeof auth!=='string'||!auth.startsWith('Bearer ')||auth.length>256)throw Error('denied');
    if(server&&timingSafeEqual(server.digest,digest(auth.slice(7))))return server;
    if(this.receiverEnrollment)return this.receiverEnrollment.authenticate(id,auth.slice(7));
    throw Error('denied');
  }
  async authorizedSource(server,source) {
    if(typeof source!=='string'||source.length>512)throw Error('denied');
    const {binding}=await this.store.snapshot(source);
    if(binding?.serverId!==server.id)throw Error('denied');
    return binding;
  }
  async handle(req,res) {
    if(this.stopped)return json(res,503,{error:'unavailable'});
    try {
      const action=req.url.slice((MIRROR_PATH+'/').length);
      if(action==='enroll'){
        if(!req.socket.encrypted||req.headers.origin!==undefined||req.method!=='POST'||!this.receiverEnrollment||this.forwardingOnly)throw Error('denied');
        return json(res,200,await this.receiverEnrollment.enroll(await readBody(req,8192)));
      }
      const server=await this.authenticate(req);
      if(req.method!=='POST')return json(res,405,{error:'method'});
      const input=await readBody(req,action==='file-send'?MAX_GROUP_FILE_BASE64+8192:4194304);
      if(action==='register'){await this.store.register(server.id,server.name,input.humans,(input.recording===true||(input.recording===undefined&&server.legacyRecording))&&!this.forwardingOnly,input.streamReplies===true);if(!this.forwardingOnly&&input.channels!==undefined)await this.store.registerChannels(server.id,input.channels);return json(res,200,{ok:true,turnNotifications:!this.forwardingOnly&&typeof this.transport.sendDirectNotification==='function'});}
      if(action==='turn-notification')return json(res,200,await deliverTurnNotification(this,server,input));
      if(action==='link-start')return json(res,200,await this.store.beginLink(server.id,input.actorId,input.generation));
      if(action==='link-poll')return json(res,200,{links:await this.store.links(server.id)});
      if(action==='link-ack'){if(typeof input.linked!=='boolean')throw Error('invalid_link');await this.store.completeLink(server.id,input.id,input.linked);return json(res,200,{ok:true});}
      if(this.forwardingOnly)return json(res,404,{error:'missing'});
      if(action==='poll') {
        const deliveries=[];
        for(const source of await this.store.work()) {
          const {binding}=await this.store.snapshot(source);if(binding?.serverId!==server.id)continue;
          const token=await this.store.claim(source);if(!token)continue;
          try {
            let event=await this.store.head(source,token);
            if(event) {
              const sender=event.sender??{id:event.author,displayName:event.author};
              if(/^T[0-9]{1,32}[A-Z]?$/u.test(sender.id)||/^wb[A-Za-z0-9_-]+$/u.test(sender.id)) {
                const names=await this.transport.senderNames(source,[sender.id],AbortSignal.any([this.abort.signal,AbortSignal.timeout(2000)]));
                const name=names.get(sender.id)??(sender.id.startsWith('wb')?sender.id+'（机器人）':undefined);
                if(!name || name===sender.id)throw Error('sender_name_unavailable');
                event={...event,sender:{...sender,displayName:name}};
              }
              deliveries.push({binding,token,event});
            } else await this.store.release(source,token);
          } catch {
            // Keep the original durable event for retry. A failed directory lookup
            // must neither persist a provider ID as a name nor stall other rooms.
            await this.store.release(source,token);
          }
          if(deliveries.length===8)break;
        }
        return json(res,200,{deliveries});
      }
      if(action==='image-upload') {
        if(typeof input.bytes!=='string'||input.bytes.length>2796204||!['image/png','image/jpeg'].includes(input.type))throw Error('invalid_image');
        const bytes=Buffer.from(input.bytes,'base64');
        if(bytes.toString('base64')!==input.bytes||channelImageType(bytes)!==input.type)throw Error('invalid_image');
        const mediaId=await this.transport.images.upload({type:input.type,bytes},AbortSignal.any([this.abort.signal,AbortSignal.timeout(7000)]));
        return json(res,200,{mediaId});
      }
      if(action==='image') {
        const source=await this.store.mediaSource(input.reference);
        await this.authorizedSource(server,source);
        const bytes=await this.store.media(input.reference);
        res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store'});res.end(bytes);return;
      }
      if(action==='native-member-resolve') {
        const id=/^[A-Za-z0-9._:/-]{1,256}$/u,uid=/^[A-Za-z0-9_.@-]{1,64}$/u;
        if(typeof input.owner!=='string'||!uid.test(input.owner)||!Array.isArray(input.members)||input.members.length>32
          ||!input.members.every(m=>m&&typeof m.actorId==='string'&&id.test(m.actorId)
            &&typeof m.subject==='string'&&/^[1-9][0-9]*$/u.test(m.subject)
            &&(m.rtxHint===undefined||(typeof m.rtxHint==='string'&&/^[A-Za-z0-9._-]{1,128}$/u.test(m.rtxHint)))
            &&(m.provider===undefined||m.provider==='tencentoa')
            &&(m.identitySource===undefined||(m.identitySource==='ioa-admission'&&typeof m.rtx==='string'&&/^[a-z0-9._-]{1,128}$/u.test(m.rtx)))
            &&(m.rtx===undefined||m.identitySource==='ioa-admission'))
          ||new Set(input.members.map(m=>m.actorId)).size!==input.members.length)throw Error('invalid_members');
        const human=humanKey(this.corpId,input.owner),record=JSON.parse(await this.store.command('GET',this.store.prefix+'server:'+server.id)??'null');
        if(!record?.humans?.[human])return json(res,403,{error:'identity_denied'});
        if(!this.nativeMemberEvidence)return json(res,503,{error:'unavailable'});
        return json(res,200,await this.nativeMemberEvidence(input.members,AbortSignal.any([this.abort.signal,AbortSignal.timeout(12000)])));
      }
      if(action==='native-chat-create') {
        // A server creates the provider group for its own native group. Only a human
        // registered to this server can own it; one native group maps to one provider group.
        const id=/^[A-Za-z0-9._:-]{1,128}$/u,uid=/^[A-Za-z0-9_.@-]{1,64}$/u;
        if(typeof input.channelId!=='string'||!id.test(input.channelId)||typeof input.title!=='string'||!input.title.trim()||input.title.length>60
          ||typeof input.owner!=='string'||!uid.test(input.owner)||!Array.isArray(input.members)||input.members.length>49||!input.members.every(m=>typeof m==='string'&&uid.test(m)))throw Error('invalid_chat');
        const human=humanKey(this.corpId,input.owner),record=JSON.parse(await this.store.command('GET',this.store.prefix+'server:'+server.id)??'null');
        if(!record?.humans?.[human])return json(res,403,{error:'identity_denied'});
        const key=this.store.prefix+'native-create:'+server.id+':'+input.channelId,prior=await this.store.command('GET',key);
        if(prior==='pending')return json(res,409,{error:'busy'});
        let source=prior;
        if(!source){
          if(await this.store.command('SET',key,'pending','NX','EX',300)!=='OK')return json(res,409,{error:'busy'});
          try{source=await this.transport.createChat(input.title.trim(),[...new Set([input.owner,...input.members])],AbortSignal.any([this.abort.signal,AbortSignal.timeout(60000)]));}
          catch(error){await this.store.command('DEL',key).catch(()=>{});throw error;}
          await this.store.command('SET',key,source);
        }
        const binding=await this.store.bind(source,human,server.id,input.title.trim(),true);
        if(!prior)this.track(this.transport.sendMarkdown({source,text:'### '+input.title.trim()+'\n已由 OpenCraft 创建，并与 OpenCraft 群聊关联：两边消息互通，群名和成员保持一致。'},AbortSignal.any([this.abort.signal,AbortSignal.timeout(7000)])).catch(()=>{}));
        return json(res,200,{binding});
      }
      if(action==='assistant-action'&&input.kind==='quit-chat'&&await this.store.retirement?.(input.source,server.id,input.requestId))return json(res,200,{status:'delivered'});
      await this.authorizedSource(server,input.source);
      if(action==='presentation-settle'){await this.settleTyping(input,AbortSignal.any([this.abort.signal,AbortSignal.timeout(4000)]));return json(res,200,{ok:true});}
      if(action==='group-sync')return json(res,200,await groupSyncProvider(this,server,input,AbortSignal.any([this.abort.signal,AbortSignal.timeout(12000)])));
      if(action==='provider-query')return json(res,200,await readProviderState(this,server,input,AbortSignal.any([this.abort.signal,AbortSignal.timeout(8000)])));
      if(action==='assistant-action') {
        const status=await assistantAction(this,server,input,AbortSignal.any([this.abort.signal,AbortSignal.timeout(15000)]));
        if(['delivered','rejected'].includes(status))this.track(this.settleTyping(input,AbortSignal.any([this.abort.signal,AbortSignal.timeout(4000)])).catch(()=>{}));
        return json(res,200,{status});
      }
      if(action==='emotion') {
        const bytes=await this.transport.downloadEmotion(input.picUrl,AbortSignal.any([this.abort.signal,AbortSignal.timeout(10000)]));
        res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store'});res.end(bytes);return;
      }
      if(action==='file') {
        if(typeof input.mediaId!=='string'||!input.mediaId||input.mediaId.length>512||!this.transport.files)throw Error('invalid_file');
        const bytes=await this.transport.files.download(input.mediaId,AbortSignal.any([this.abort.signal,AbortSignal.timeout(FILE_FETCH_MS)]),MAX_FILE_BYTES);
        res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store'});res.end(bytes);return;
      }
      if(action==='lease') {
        if(typeof input.token!=='string'||typeof input.id!=='string')throw Error('invalid_lease');
        const head=await this.store.head(input.source,input.token);
        return json(res,head?.id===input.id?200:409,{ok:head?.id===input.id});
      }
      if(action==='ack') {
        if(typeof input.token!=='string'||typeof input.id!=='string'||typeof input.messageId!=='string'||!input.messageId)throw Error('invalid_ack');
        const acked=await this.store.ack(input.source,input.token,input.id);await this.store.release(input.source,input.token);
        return json(res,acked?200:409,{acked});
      }
      if(action==='release'){await this.store.release(input.source,input.token);return json(res,200,{ok:true});}
      if(action==='image-send') {
        if(typeof input.mediaId!=='string'||!input.mediaId||input.mediaId.length>512)throw Error('invalid_image');
        const status=await this.transport.images.send(input.source,input.mediaId,AbortSignal.any([this.abort.signal,AbortSignal.timeout(7000)]));
        if(['delivered','rejected'].includes(status))this.track(this.settleTyping(input,AbortSignal.any([this.abort.signal,AbortSignal.timeout(4000)])).catch(()=>{}));
        return json(res,200,{status});
      }
      if(action==='chat-create') {
        // The requesting server already owns the origin group; the new group binds to it too.
        if(typeof input.title!=='string'||!input.title.trim()||input.title.length>60||typeof input.owner!=='string'||!/^[A-Za-z0-9_-]{1,64}$/u.test(input.owner)
          ||!Array.isArray(input.members)||input.members.length>50||!input.members.every(m=>typeof m==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/u.test(m)))throw Error('invalid_chat');
        const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(60000)]);
        const origin=await this.transport.chatMembers(input.source,signal);
        if(!origin.includes(input.owner))throw Error('denied');
        const found=input.members.length?await this.transport.userIds(input.members,signal):new Map();
        const missing=input.members.filter(n=>!found.has(n));
        const source=await this.transport.createChat(input.title.trim(),[input.owner,...found.values()],signal);
        const bound=await this.store.bind(source,humanKey(this.corpId,input.owner),server.id,input.title.trim(),true).catch(()=>null);
        const names=[...found.keys()].map(n=>'@'+n).join(' ');
        await this.transport.sendMarkdown({source,text:`### ${input.title.trim()}\n已由助理建群。${bound?'已关联 OpenCraft。':'关联 OpenCraft 尚未完成，请勿重复建群。'}${names?'\n成员：'+names:''}`},signal).catch(()=>{});
        await this.transport.sendMarkdown({source:input.source,text:`已建群「${input.title.trim()}」${bound?'':'，但关联 OpenCraft 尚未完成，请勿重复建群。'}${found.size?'，拉入 '+names:''}${missing.length?'。\n未找到：'+missing.join('、'):''}`},signal).catch(()=>{});
        this.track(this.settleTyping(input,AbortSignal.any([this.abort.signal,AbortSignal.timeout(4000)])).catch(()=>{}));
        return json(res,200,{status:'delivered'});
      }
      if(action==='chat-update') {
        // Only a current member of the bound group may change it; the owner and the service account stay.
        const rtx=v=>Array.isArray(v)&&v.length<=50&&v.every(m=>typeof m==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/u.test(m));
        if(typeof input.owner!=='string'||!/^[A-Za-z0-9_-]{1,64}$/u.test(input.owner)||!rtx(input.add)||!rtx(input.remove)
          ||(input.name!==undefined&&(typeof input.name!=='string'||!input.name.trim()||input.name.length>60)))throw Error('invalid_chat');
        const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(60000)]);
        const members=await this.transport.chatMembers(input.source,signal);
        if(!members.includes(input.owner))throw Error('denied');
        const names=[...new Set([...input.add,...input.remove])];
        const found=names.length?await this.transport.userIds(names,signal):new Map();
        const add=input.add.map(n=>found.get(n)).filter(id=>id&&!members.includes(id));
        const remove=input.remove.map(n=>found.get(n)).filter(id=>id&&members.includes(id)&&id!==input.owner);
        const missing=names.filter(n=>!found.has(n));
        if(!add.length&&!remove.length&&!input.name){
          await this.transport.sendMarkdown({source:input.source,text:missing.length?'没有改动。未找到：'+missing.join('、'):'没有需要改动的成员。'},signal).catch(()=>{});
          this.track(this.settleTyping(input,AbortSignal.any([this.abort.signal,AbortSignal.timeout(4000)])).catch(()=>{}));
          return json(res,200,{status:'delivered'});
        }
        const status=await this.transport.updateChat(input.source,{name:input.name?.trim(),add,remove},signal);
        const verification=status==='delivered'?await verifyChatChange(this.transport,input.source,{name:input.name?.trim(),add,remove},signal):undefined;
        if(verification?.verified&&input.name)await this.store.rename?.(input.source,input.name.trim()).catch(()=>{});
        await this.transport.sendMarkdown({source:input.source,text:status==='delivered'
          ?[verification.verified?'已复查确认群设置':'修改请求已被接口接受，但复查尚未确认；请勿据此认定已完成。',input.name?'目标群名：'+input.name.trim():'',add.length?'请求拉入：'+input.add.filter(n=>add.includes(found.get(n))).map(n=>'@'+n).join(' '):'',
            remove.length?'移出：'+input.remove.filter(n=>remove.includes(found.get(n))).join('、'):'',missing.length?'未找到：'+missing.join('、'):''].filter(Boolean).join('\n')
          :'群设置没有改成功（企业微信拒绝了请求）。'},signal).catch(()=>{});
        this.track(this.settleTyping(input,AbortSignal.any([this.abort.signal,AbortSignal.timeout(4000)])).catch(()=>{}));
        return json(res,200,{status,...(verification?{verification}:{})});
      }
      if(action==='file-send') {
        if(typeof input.name!=='string'||typeof input.bytes!=='string'||input.bytes.length>MAX_GROUP_FILE_BASE64)throw Error('invalid_file');
        const bytes=Buffer.from(input.bytes,'base64');
        if(!bytes.length||bytes.length>MAX_GROUP_FILE_BYTES||bytes.toString('base64')!==input.bytes)throw Error('invalid_file');
        const status=await this.transport.sendFile(input.source,input.name,bytes,AbortSignal.any([this.abort.signal,AbortSignal.timeout(60000)]));
        if(['delivered','rejected'].includes(status))this.track(this.settleTyping(input,AbortSignal.any([this.abort.signal,AbortSignal.timeout(4000)])).catch(()=>{}));
        return json(res,200,{status});
      }
      if(action==='report') {
        const card=reportCard(input.report);
        if(typeof input.owner==='string'&&typeof input.requestId==='string') {
          card.task_id='oc-r-'+createHash('sha256').update(JSON.stringify([input.source,input.requestId])).digest('hex').slice(0,40);
          card.action_menu={desc:'推送设置',action_list:[{text:'关闭我的本群日报',key:'oc-pause-daily'}]};
          await this.store.rememberCard(input.source,card.task_id,{...card,owner:input.owner,binding:(await this.store.snapshot(input.source)).binding});
        }
        const status=await this.transport.sendCard(input.source,card,AbortSignal.any([this.abort.signal,AbortSignal.timeout(7000)]));
        if(['delivered','rejected'].includes(status))this.track(this.settleTyping(input,AbortSignal.any([this.abort.signal,AbortSignal.timeout(4000)])).catch(()=>{}));
        return json(res,200,{status});
      }
      if(action==='card') {
        const status=await this.sendCard(input.source,input.card,AbortSignal.any([this.abort.signal,AbortSignal.timeout(7000)]));
        this.track(this.settleTyping(input,AbortSignal.any([this.abort.signal,AbortSignal.timeout(4000)])).catch(()=>{}));
        return json(res,200,{status,taskId:input.card.task_id});
      }
      if(action==='send'||action==='image-attribute') {
        input.serverId=server.id;input.serverName=server.name; // Authenticated installation, never request-supplied origin.
        if(typeof input.text!=='string'||input.text.length>16384||typeof input.author!=='string'||input.author.length>256)throw Error('invalid_message');
        const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(7000)]);
        const format=messagePresentation(input).format;
        const streamed=action==='send'&&format==='markdown'&&input.mentions===undefined&&this.streamReplies&&typeof input.replyTo==='string'&&/^[\x21-\x7e]{1,256}$/u.test(input.replyTo);
        // Markdown does not depend on stream capability or the presence of an
        // unanswered mention. Keep structured native mentions on their own path.
        const standalone=action==='send'&&input.mentions===undefined&&!streamed&&format==='markdown';
        const status=await (streamed?this.reply(input,signal)
          :standalone?sendMarkdownMessage(this.transport,input,signal)
          :action==='send'?this.transport.send(input,signal):this.transport.images.attribute(input,signal));
        if(['delivered','rejected'].includes(status))this.track(this.settleTyping(input,AbortSignal.any([this.abort.signal,AbortSignal.timeout(4000)])).catch(()=>{}));
        return json(res,200,{status});
      }
      return json(res,404,{error:'missing'});
    } catch(error) { if(!res.headersSent)json(res,error.message==='denied'?403:503,{error:'unavailable'});else res.destroy(); }
  }
  ingress(req,res) {
    if(['POST','GET'].includes(req.method)&&(req.url??'').split('?',1)[0]==='/wecom_callback') {
      req.url=this.transport.callback.path+req.url.slice('/wecom_callback'.length);
      void this.track(this.transport.callback.handle(req,res)).catch(()=>res.destroy());return true;
    }
    if(!req.url?.startsWith(MIRROR_PATH+'/'))return false;
    void this.track(this.handle(req,res)).catch(()=>res.destroy());return true;
  }
  async close() {
    if(this.stopped)return;
    this.stopped=true;clearTimeout(this.timer);this.abort.abort();this.unsubscribe();
    await Promise.allSettled([...this.pending,this.job]);
  }
}
