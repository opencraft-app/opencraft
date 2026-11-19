import {messagePresentation} from './message-presentation.mjs';
import {sendMarkdownMessage} from './message-markdown.mjs';
import {wecomAuthorPrefix} from './message-attribution.mjs';
import {cleanProviderMessage,errorCategory} from './operation-diagnostics.mjs';
import {checkedNativeMentions,nativeMentionFrames} from './native-mentions.mjs';
import {syncSnapshot as checkedGroupSnapshot} from './group-sync.mjs';
import {senderIdentity} from './external-identity.mjs';
import {utf8Chunks} from './text-chunks.mjs';
import {downloadEmotion} from './emotion-media.mjs';
import { createHash, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { describeMessage, forwardedRecord, forwardedSenders, nestedMedia, DESCRIBED_TYPES } from './rich-inbound.mjs';

/** Private Join composition. Native channels own the timeline and membership; this adapter only verifies and transports provider messages. */
export const DIRECT_WELCOME = '### 你好，我是你的 OpenCraft 助理\n这里是你和助理的私聊，直接发消息就行，不用 @。\n- 发文字、图片、文件或转发聊天记录给我\n- 让我查资料、整理纪要、做表格、跑任务\n- 在群里 @我 也能用，结果会发回那个群';
export const DIRECT_MENU = Object.freeze([
  Object.freeze({ key: 'oc-my-tasks', title: '我的待办', prompt: '请查询我有权限查看的待办任务，列出未完成事项、截止时间和下一步。没有可查询的数据或权限时请明确说明，不要编造。' }),
  Object.freeze({ key: 'oc-daily-report', title: '今日日报', prompt: '请根据今天有权限查看的任务和工作记录整理今日日报，包括已完成、进行中、阻塞和下一步；注明资料不足的部分。' }),
  Object.freeze({ key: 'oc-help', title: '使用帮助', prompt: '请简要介绍我在企业微信私聊中能使用的助理功能，以及如何发文件、查询任务和委派工作。' }),
]);
export function createWeComChannelTransport({ corpId, corpSecret, serviceId, token, aesKey, localGroups = [], enableImages = false, callbackPath = "/__opencraft_im/channel-callback/wecom", relayIngress = false, onMention, onCardEvent, onShortcut, onDirectEnter, directChats = false, fetcher = fetch }, { onSenderProfile } = {}) {
  if (!/^wx[\da-z]+$/i.test(corpId) || !/^fw[\da-z]+$/i.test(serviceId)
      || !/^[A-Za-z0-9+/]{43}$/.test(aesKey) || !/^[A-Za-z0-9]{3,32}$/.test(token)
      || typeof corpSecret !== 'string' || !corpSecret) throw Error('Invalid WeCom configuration');
  if (!Array.isArray(localGroups) || (!relayIngress && !localGroups.length) || localGroups.length > 256 || localGroups.some(group => !group
      || typeof group.chatId !== 'string' || !group.chatId || group.chatId.length > 64 || /[\s\x00-\x1f\x7f]/u.test(group.chatId)
      || typeof group.channelId !== 'string' || !/^group:[a-f0-9-]{36}$/u.test(group.channelId))
      || new Set(localGroups.map(group => group.chatId)).size !== localGroups.length
      || new Set(localGroups.map(group => group.channelId)).size !== localGroups.length) throw Error('Invalid native group bindings');
  const local = new Map(localGroups.map(group => [group.chatId, group]));
  const key = Buffer.from(aesKey, 'base64');
  const maxBody = 1024 * 1024, maxImage = 2 * 1024 * 1024;
  const sourceFor = groupId => JSON.stringify(['wecom-customer-service', corpId, serviceId, groupId]);
  const validGroupId = id => typeof id === 'string' && id.length > 0 && id.length <= 64 && !/[\s\x00-\x1f\x7f]/u.test(id);
  const acceptsGroup = id => local.has(id) || (relayIngress === true && validGroupId(id));
  // A private chat is its own source: "single:<userid>". Group chat ids never contain ':'.
  const DIRECT = 'single:';
  const directUser = id => typeof id === 'string' && id.startsWith(DIRECT) ? id.slice(DIRECT.length) : null;
  const receiverFor = id => directUser(id) ? { type: 'single', id: directUser(id) } : { type: 'group', id };
  const groupIdFor = value => {
    try { const decoded=JSON.parse(value), id=decoded?.[3];return acceptsGroup(id)&&sourceFor(id)===value?id:null; } catch {return null;}
  };
  const bindings = localGroups.map(group => ({source:sourceFor(group.chatId),channelId:group.channelId}));
  // Keep an explicitly deployed provider URL while replacing its storage owner.
  // This is one native callback, never a second legacy timeline.
  if (!['/__opencraft_im/channel-callback/wecom', '/__opencraft_im/shadow-callback/wecom'].includes(callbackPath)) throw Error('Invalid WeCom callback path');
  const path = callbackPath;
  let consume;
  let cachedAccess;
  let pendingAccess;
  const senderNamesCache = new Map();
  const robotCache = new Map();
  let pendingSenderLookups = 0;
  function parseXml(input) {
    const parser = new SaxesParser();
    const stack = [];
    let root;
    parser.on('doctype', () => { throw Error('DOCTYPE forbidden'); });
    parser.on('opentag', tag => {
      if (stack.length >= 32) throw Error('XML too deep');
      const node = { name: tag.name, children: [], text: '' };
      if (stack.length) stack.at(-1).children.push(node);
      else root = node;
      stack.push(node);
    });
    const append = text => { if (stack.length) stack.at(-1).text += text; };
    parser.on('text', append);
    parser.on('cdata', append);
    parser.on('closetag', () => stack.pop());
    parser.write(input).close();
    if (root?.name !== 'xml') throw Error('Expected XML envelope');
    return root;
  }
  function child(node, name) {
    const matches = node?.children.filter(n => n.name === name) ?? [];
    if (matches.length > 1) throw Error('Duplicate XML field');
    return matches[0];
  }
  const field = (node, name) => child(node, name)?.text.trim();
  function decrypt(encrypted) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) throw Error('Invalid ciphertext');
    const cipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
    cipher.setAutoPadding(false);
    const bytes = Buffer.concat([cipher.update(Buffer.from(encrypted, 'base64')), cipher.final()]);
    const pad = bytes.at(-1);
    if (!pad || pad > 32 || pad > bytes.length || !bytes.subarray(-pad).every(b => b === pad)) throw Error('Invalid padding');
    const data = bytes.subarray(0, bytes.length - pad);
    if (data.length < 20) throw Error('Invalid payload');
    const end = 20 + data.readUInt32BE(16);
    if (end > data.length || !data.subarray(end).equals(Buffer.from(serviceId))) throw Error('Wrong recipient');
    return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(20, end));
  }
  function signed(url, encrypted) {
    const fields = ['msg_signature', 'timestamp', 'nonce'];
    if (fields.some(name => url.searchParams.getAll(name).length !== 1)) return false;
    const [signature, ts, nonce] = fields.map(name => url.searchParams.get(name));
    if (!/^[a-f0-9]{40}$/i.test(signature) || !/^\d{10}$/.test(ts) || !nonce || nonce.length > 256) return false;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
    const expected = createHash('sha1').update([token, ts, nonce, encrypted].sort().join('')).digest();
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  }
  async function readXml(req) {
    const chunks = [];
    let length = 0;
    // Leave the socket open long enough to return 413 when the bound is exceeded.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      length += chunk.length;
      if (length > maxBody) return null;
      chunks.push(chunk);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  }
  const send = (res, status, body = '') => {
    res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
  };

  async function callApi(endpoint, params, body, signal) {
    const url = new URL(endpoint, 'https://in.qyapi.weixin.qq.com');
    url.search = new URLSearchParams(params);
    const response = await fetcher(url, {
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw Object.assign(Error('WeCom API HTTP failure'),{code:'WE_COM_HTTP'});
    const result = await response.json();
    if (!Number.isSafeInteger(result.errcode)) throw Object.assign(Error('Invalid WeCom API response'),{code:'WE_COM_RESPONSE'});
    return result;
  }

  async function accessToken(signal) {
    if (cachedAccess && cachedAccess.until > Date.now()) return cachedAccess.token;
    pendingAccess ??= callApi('/cgi-bin/gettoken', { corpid: corpId, corpsecret: corpSecret }, null, signal)
      .then(result => {
        if (result.errcode !== 0 || typeof result.access_token !== 'string' || !result.access_token) throw Error('WeCom token unavailable');
        const seconds = Number.isSafeInteger(result.expires_in) && result.expires_in > 0 ? Math.min(300, result.expires_in - 1) : 30;
        cachedAccess = { token: result.access_token, until: Date.now() + seconds * 1000 };
        return cachedAccess.token;
      }).finally(() => { pendingAccess = undefined; });
    return pendingAccess;
  }

  function recordSenderProfile(source, id, name) {
    try { onSenderProfile?.({source, id, name}); } catch { /* Optional photo cache must not block ingress. */ }
  }

  // Token-invalid errors are side-effect free, so one refreshed retry is safe.
  const staleToken = new Set([40001, 40014, 41001, 42001]);
  async function withToken(signal, run) {
    for (let attempt = 0; ; attempt++) {
      const access_token = await accessToken(signal);
      const result = await run(access_token);
      if (!staleToken.has(result?.errcode) || attempt) return result;
      if (cachedAccess?.token === access_token) cachedAccess = undefined;
    }
  }

  /** Stream reply to one provider message (MsgId valid for one day). Resolves the provider errcode. */
  async function respond(msgId, streamId, content, finish, signal) {
    if (typeof msgId !== 'string' || !msgId || msgId.length > 256 || !/^[\x21-\x7e]{1,64}$/u.test(streamId)
      || typeof content !== 'string' || Buffer.byteLength(content) > 20480) throw Error('Invalid stream reply');
    const result = await withToken(signal, access_token => callApi('/cgi-bin/tencent/chat/respond_msg', { access_token },
      { msgid: msgId, msgtype: 'stream', stream: { id: streamId, finish: finish === true, content } }, signal));
    return result.errcode;
  }

  async function sendCard(sourceKey, card, signal) {
    const access_token = await accessToken(signal);
    return sendGroup(sourceKey, { msgtype: 'template_card', template_card: card }, access_token, signal);
  }
  /** Replace an interactive card in place; responseCode is single-use and valid for five seconds. */
  async function updateCard(responseCode, card, users, signal) {
    if (typeof responseCode !== 'string' || !responseCode || responseCode.length > 512 || !card || typeof card !== 'object'
      || (users !== undefined && (!Array.isArray(users) || users.length > 50))) throw Error('Invalid card update');
    const result = await withToken(signal, access_token => callApi('/cgi-bin/tencent/chat/update_template_card', { access_token },
      { response_code: responseCode, template_card: card, ...(users?.length ? { update_user_list: users } : {}) }, signal));
    return result.errcode;
  }
  const cardEvent = (msg, groupId) => {
    const card = child(msg, 'TemplateCardEvent');
    const selected = (child(card, 'SelectedItems')?.children ?? []).filter(n => n.name === 'SelectedItem').slice(0, 16)
      .map(item => ({ questionKey: (field(item, 'QuestionKey') ?? '').slice(0, 256),
        optionIds: (child(item, 'OptionIds')?.children ?? []).filter(n => n.name === 'OptionId').slice(0, 64).map(n => n.text.trim().slice(0, 256)) }));
    const time = Number(field(msg, 'CreateTime'));
    return { source: sourceFor(groupId), id: field(msg, 'MsgId'), author: field(child(msg, 'From'), 'Sender'),
      cardType: field(card, 'CardType') ?? '', eventKey: (field(card, 'EventKey') ?? '').slice(0, 1024), taskId: field(card, 'TaskId') ?? '',
      responseCode: field(msg, 'ResponseCode') ?? '', selected, at: Number.isSafeInteger(time) && time > 0 && time <= Date.now() / 1000 + 300 ? time * 1000 : Date.now() };
  };

  async function senderNames(value, ids, signal) {
    const names = new Map();
    if (!groupIdFor(value)) return names;
    const robots=await robotInfo(ids.filter(id=>/^wb[A-Za-z0-9_-]+$/u.test(id)),signal).catch(()=>new Map());
    for(const [id,robot] of robots)names.set(id,robot.name+'（机器人）');
    const missing = [];
    for (const id of ids) {
      // Tencent directory IDs are distinct from names already carried by callbacks.
      if (!/^T[0-9]{1,32}[A-Z]?$/u.test(id)) continue;
      const cached = senderNamesCache.get(id);
      if (!cached || cached.until <= Date.now()) missing.push(id);
      else if (cached.name) { names.set(id, cached.name); recordSenderProfile(value, id, cached.name); }
    }
    if (!missing.length || pendingSenderLookups >= 4) return names;
    pendingSenderLookups++;
    try {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(1200)]);
      const access_token = await accessToken(deadline);
      const result = await callApi('/cgi-bin/tencent/user/convert_to_name', { access_token }, {
        userid_list: missing,
      }, deadline);
      if (result.errcode !== 0 || !Array.isArray(result.user_list) || result.user_list.length > missing.length) return names;
      const resolved = new Map(result.user_list.filter(row => row && typeof row.name === 'string'
        && /^[A-Za-z0-9_.-]{1,128}$/u.test(row.name)).map(row => [row.userid, row.name]));
      for (const id of missing) {
        const name = resolved.get(id);
        senderNamesCache.delete(id);
        if (senderNamesCache.size >= 1024) senderNamesCache.delete(senderNamesCache.keys().next().value);
        senderNamesCache.set(id, { name, until: Date.now() + (name ? 300000 : 20000) });
        if (name) { names.set(id, name); recordSenderProfile(value, id, name); }
      }
    } catch {
      // Keep cached labels and the timeline available on provider failure.
    } finally {
      pendingSenderLookups--;
    }
    return names;
  }

  async function robotInfo(ids,signal) {
    const result=new Map(),missing=[];
    for(const id of [...new Set(ids)].slice(0,100)) {const cached=robotCache.get(id);if(cached?.until>Date.now())result.set(id,cached.value);else missing.push(id);}
    if(missing.length) {
      const response=await withToken(signal,access_token=>callApi('/cgi-bin/tencent/batch/get_robot_info',{access_token},{robotid_list:missing},signal));
      if(response.errcode!==0||!Array.isArray(response.robot_list))throw Error('Robot lookup unavailable');
      for(const row of response.robot_list)if(missing.includes(row.robotid)&&typeof row.name==='string') {
        const value={id:row.robotid,name:row.name.slice(0,128),kind:'robot',avatarUrl:typeof row.head_image_url==='string'&&/^https?:\/\//u.test(row.head_image_url)?row.head_image_url:undefined};
        if(robotCache.size>=1024)robotCache.delete(robotCache.keys().next().value);
        robotCache.set(row.robotid,{until:Date.now()+300000,value});result.set(row.robotid,value);
      }
    }return result;
  }
  async function memberInfo(source,signal) {
    const ids=await chatMembers(source,signal),names=await senderNames(source,ids,signal),robots=await robotInfo(ids.filter(id=>id.startsWith('wb')),signal).catch(()=>new Map());
    return ids.map(id=>robots.get(id)??{id,name:names.get(id)??id,kind:id.startsWith('wb')?'robot':id.startsWith('fw')?'service':'human'});
  }
  async function quitChat(source,signal) {
    const chatid=groupIdFor(source);if(!chatid||directUser(chatid))throw Error('Group required');
    const result=await withToken(signal,access_token=>callApi('/cgi-bin/tencent/chat/quit',{access_token},{chatid},signal));
    return result.errcode===0?'delivered':'rejected';
  }
  async function sendShortcuts(source,signal) {
    const access_token=await accessToken(signal);
    return sendGroup(source,{msgtype:'rich_text',rich_text:[{type:'text',text:{content:'OpenCraft 群聊快捷入口：'}},
      ...DIRECT_MENU.flatMap(item=>[{type:'text',text:{content:' '}},{type:'link',link:{type:'click',text:item.title,key:item.key}}])]},access_token,signal);
  }
  function mediaUrl(action, parameters) {
    const url = new URL('/cgi-bin/media/' + action, 'https://in.qyapi.weixin.qq.com');
    url.search = new URLSearchParams(parameters);
    return url;
  }

  /** Current members of a bound group as provider userids. */
  async function chatMembers(sourceKey, signal) {
    const groupId = groupIdFor(sourceKey);
    if (!groupId) throw Error('Unbound WeCom group');
    if (directUser(groupId)) return [directUser(groupId)];
    const result = await withToken(signal, access_token => callApi('/cgi-bin/tencent/chat/get', { access_token, chatid: groupId }, null, signal));
    if (result.errcode !== 0 || !Array.isArray(result.chat_info?.userlist)) throw Error('WeCom group members unavailable');
    return result.chat_info.userlist.filter(id => typeof id === 'string' && id !== serviceId);
  }
  async function chatSnapshot(sourceKey,signal) {
    const chatid=groupIdFor(sourceKey);if(!chatid||directUser(chatid))throw Error('Group required');
    const r=await withToken(signal,access_token=>callApi('/cgi-bin/tencent/chat/get',{access_token,chatid},null,signal));
    if(r.errcode!==0||!Array.isArray(r.chat_info?.userlist)||r.chat_info.userlist.length>2000)throw Error('WeCom group unavailable');
    return {externalId:chatid,name:String(r.chat_info.name??'').slice(0,128),memberIds:r.chat_info.userlist.filter(id=>typeof id==='string'&&id!==serviceId)};
  }
  /** Strict full-snapshot API for permission replication; malformed fields must never become an empty roster. */
  async function syncSnapshot(source,signal){
    const chatid=groupIdFor(source);if(!chatid||directUser(chatid))throw Error('Group required');
    const secrets=[corpSecret,token,aesKey];
    const result=await withToken(signal,access_token=>{secrets.push(access_token);return callApi('/cgi-bin/tencent/chat/get',{access_token,chatid},null,signal);});
    if(result.errcode!==0)throw Object.assign(Error('WeCom group unavailable'),{diagnostics:{errcode:result.errcode,errmsg:cleanProviderMessage(result.errmsg,secrets),category:'provider_rejected'}});
    const snapshot=checkedGroupSnapshot({externalId:result.chat_info?.chatid,name:result.chat_info?.name,memberIds:result.chat_info?.userlist},source);
    return {...snapshot,memberIds:snapshot.memberIds.filter(id=>id!==serviceId)};
  }
  /** rtx names → provider userids (unknown names omitted). */
  async function userIds(names, signal) {
    const result = await withToken(signal, access_token => callApi('/cgi-bin/tencent/user/convert_to_userid', { access_token }, { name_list: names }, signal));
    if (result.errcode !== 0 || !Array.isArray(result.user_list)) throw Error('WeCom directory unavailable');
    return new Map(result.user_list.filter(u => typeof u?.name === 'string' && typeof u.userid === 'string').map(u => [u.name, u.userid]));
  }
  /** Identity evidence uses fresh reciprocal directory reads, never presentation caches.
   * A recycled RTX cannot claim a departed employee's old userid. */
  async function employeeDirectoryIds(ids, signal) {
    if (!Array.isArray(ids) || ids.length > 2000 || ids.some(id => typeof id !== 'string'
      || !/^[A-Za-z0-9._-]{1,128}$/u.test(id))) throw Error('invalid_wecom_employee');
    const wanted = new Set(ids.filter(id => !/^(wb|fw)/iu.test(id)));
    if (!wanted.size) return new Map();
    const response = await withToken(signal, access_token => callApi('/cgi-bin/tencent/user/convert_to_name',
      { access_token }, { userid_list: [...wanted] }, signal));
    if (response.errcode !== 0 || !Array.isArray(response.user_list) || response.user_list.length > wanted.size)
      throw Error('wecom_identity_unavailable');
    const forward = new Map(), names = new Set();
    for (const row of response.user_list) {
      if (!wanted.has(row?.userid) || forward.has(row.userid) || typeof row.name !== 'string'
        || !/^[A-Za-z0-9._-]{1,128}$/u.test(row.name) || names.has(row.name.toLowerCase()))
        throw Error('wecom_identity_unavailable');
      forward.set(row.userid, row.name.toLowerCase()); names.add(row.name.toLowerCase());
    }
    if (!names.size) return new Map();
    const reverse = await withToken(signal, access_token => callApi('/cgi-bin/tencent/user/convert_to_userid',
      { access_token }, { name_list: [...names] }, signal));
    if (reverse.errcode !== 0 || !Array.isArray(reverse.user_list) || reverse.user_list.length > names.size)
      throw Error('wecom_identity_conflict');
    const result = new Map(), seenNames = new Set(), seenIds = new Set();
    for (const row of reverse.user_list) {
      const rtx = typeof row?.name === 'string' ? row.name.toLowerCase() : null;
      if (!names.has(rtx) || typeof row.userid !== 'string' || seenNames.has(rtx) || seenIds.has(row.userid))
        throw Error('wecom_identity_conflict');
      seenNames.add(rtx); seenIds.add(row.userid);
      if (forward.get(row.userid) === rtx) result.set(row.userid, rtx);
    }
    return result;
  }
  async function employeeById(userId, signal) {
    if (typeof userId !== 'string' || /^(wb|fw)/iu.test(userId)) throw Error('invalid_wecom_employee');
    const rtx = (await employeeDirectoryIds([userId], signal)).get(userId);
    if (!rtx) throw Error('wecom_identity_conflict');
    return rtx;
  }
  async function employeeIdentities(source, ids, signal) {
    if (!groupIdFor(source)) throw Error('invalid_wecom_employee');
    return employeeDirectoryIds(ids, signal);
  }
  async function employeeIdentity(source, userId, signal) {
    if (!groupIdFor(source)) throw Error('invalid_wecom_employee');
    return employeeById(userId, signal);
  }
  async function employeeForRtx(rtx, signal) {
    if (typeof rtx !== 'string' || !/^[a-z0-9._-]{1,128}$/u.test(rtx)) throw Error('invalid_wecom_employee');
    const response = await withToken(signal, access_token => callApi('/cgi-bin/tencent/user/convert_to_userid',
      { access_token }, { name_list: [rtx] }, signal));
    if (response.errcode !== 0 || !Array.isArray(response.user_list) || response.user_list.length !== 1
      || response.user_list[0]?.name?.toLowerCase() !== rtx) throw Error('wecom_identity_unavailable');
    const userId = response.user_list[0].userid;
    if (await employeeById(userId, signal) !== rtx) throw Error('wecom_identity_conflict');
    return { corpId, userId, rtx };
  }
  /** Create a group with the service account; returns its source key. */
  async function createChat(name, users, signal) {
    const result = await withToken(signal, access_token => callApi('/cgi-bin/tencent/chat/create', { access_token },
      { name, userlist: [...new Set([...users, serviceId])] }, signal));
    if (result.errcode !== 0 || !validGroupId(result.chatid)) throw Error('WeCom chat creation failed: ' + result.errcode);
    return sourceFor(result.chatid);
  }
  /** Rename a bound group and add or remove members (provider userids). */
  async function performChatUpdate(sourceKey, { name, add = [], remove = [] }, signal, detail) {
    const started=Date.now(),secrets=[corpSecret,token,aesKey];
    const groupId = groupIdFor(sourceKey);
    if (!groupId || directUser(groupId)) throw Error('Unbound WeCom group');
    const result = await withToken(signal, access_token => {
      secrets.push(access_token);
      return callApi('/cgi-bin/tencent/chat/update', { access_token },
        { chatid: groupId, ...(name ? { name } : {}), ...(add.length ? { add_user_list: add } : {}), ...(remove.length ? { del_user_list: remove } : {}) }, signal);
    });
    const status=result.errcode===0?'delivered':'rejected';
    return detail?{status,diagnostics:{stage:'write',apiPath:'/cgi-bin/tencent/chat/update',category:status==='rejected'?'provider_rejected':'accepted',errcode:result.errcode,errmsg:cleanProviderMessage(result.errmsg,secrets),elapsedMs:Date.now()-started}}:status;
  }
  // The original string/throw contract is retained for all existing callers.
  async function updateChat(sourceKey, change, signal) {
    return performChatUpdate(sourceKey,change,signal,false);
  }
  async function updateChatDetailed(sourceKey, change, signal) {
    const started=Date.now();
    try{return await performChatUpdate(sourceKey,change,signal,true);}
    catch(error){return {status:'unknown',diagnostics:{stage:'write',apiPath:'/cgi-bin/tencent/chat/update',category:errorCategory(error),elapsedMs:Date.now()-started}};}
  }
  /** Upload bytes as a temporary file and post it to a bound group. */
  async function sendFile(sourceKey, name, bytes, signal) {
    if (typeof name !== 'string' || !name || name.length > 160 || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 20 * 1024 * 1024) throw Error('Invalid file');
    const uploaded = await withToken(signal, async access_token => {
      const form = new FormData();
      form.append('media', new Blob([bytes]), name);
      const response = await fetcher(mediaUrl('upload', { access_token, type: 'file' }), { method: 'POST', body: form, redirect: 'error', signal });
      if (!response.ok) { await response.body?.cancel(); throw Error('WeCom file upload failed'); }
      return response.json();
    });
    if (uploaded?.errcode !== 0 || typeof uploaded.media_id !== 'string') return 'rejected';
    const access_token = await accessToken(signal);
    return sendGroup(sourceKey, { msgtype: 'file', file: { media_id: uploaded.media_id } }, access_token, signal);
  }
  /** Notify specific members: a rich_text message whose mentions actually ping them. */
  async function mentionMembers(sourceKey, userIds, text, signal) {
    if (!Array.isArray(userIds) || !userIds.length || userIds.length > 50) throw Error('Invalid mention list');
    const access_token = await accessToken(signal);
    return sendGroup(sourceKey, { msgtype: 'rich_text', rich_text: [
      { type: 'mentioned', mentioned: { userlist: userIds } }, { type: 'text', text: { content: ' ' + text } }] }, access_token, signal);
  }
  /** Notify the whole group; callers enforce who may and how often. */
  async function mentionEveryone(sourceKey, text, signal) {
    if (directUser(groupIdFor(sourceKey))) return 'rejected';
    return mentionMembers(sourceKey, ['@all'], text, signal);
  }
  async function sendGroup(sourceKey, payload, access_token, signal) {
    const groupId = groupIdFor(sourceKey);
    if (!groupId) throw Error('Unbound WeCom group');
    const result = await callApi('/cgi-bin/tencent/chat/send', { access_token }, {
      receiver: receiverFor(groupId), ...payload,
    }, signal);
    return result.errcode === 0 ? 'delivered' : 'rejected';
  }

  /** Welcome someone opening a private chat with the assistant. */
  async function welcomeDirect(userId, signal) {
    const access_token = await accessToken(signal);
    const result = await callApi('/cgi-bin/tencent/chat/send', { access_token }, {
      receiver: { type: 'single', id: userId }, msgtype: 'rich_text', rich_text: [
        { type: 'text', text: { content: DIRECT_WELCOME.replace(/^### /u, '') + '\n快捷入口：' } },
        ...DIRECT_MENU.flatMap((item, index) => [
          ...(index ? [{ type: 'text', text: { content: ' · ' } }] : []),
          { type: 'link', link: { type: 'click', text: item.title, key: item.key } },
        ]),
      ],
    }, signal);
    return result.errcode === 0 ? 'delivered' : 'rejected';
  }
  async function rejectDirectMessage(userId) {
    const signal = AbortSignal.timeout(3000);
    const access_token = await accessToken(signal);
    const result = await callApi('/cgi-bin/tencent/chat/send', { access_token }, {
      receiver: { type: 'single', id: userId },
      msgtype: 'text',
      text: { content: '暂不支持单聊，请将我加入企业微信群后，在群聊中使用。' },
    }, signal);
    if (result.errcode !== 0) throw Error('WeCom direct-message notice rejected');
  }

  async function sendDirectNotification(userId, content, signal, assertCurrent) {
    if(typeof userId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/u.test(userId)||/^(wb|fw)/iu.test(userId)
      ||typeof content!=='string'||!content.isWellFormed()||Buffer.byteLength(content)>5000||typeof assertCurrent!=='function')throw Error('Invalid personal notification');
    const result=await withToken(signal,async access_token=>{
      await assertCurrent();
      return callApi('/cgi-bin/tencent/chat/send',{access_token},{receiver:{type:'single',id:userId},msgtype:'text',text:{content}},signal);
    });
    return result.errcode===0?'delivered':'rejected';
  }

  async function sendText(message, signal) {
    const author = message.author.replace(/[\p{Bidi_Control}\p{Cc}\p{Zl}\p{Zp}]/gu, '').trim();
    const prefix = wecomAuthorPrefix(message);
    const budget=5000-Buffer.byteLength(prefix);
    if (!author || !prefix || budget<4 || typeof message.text!=='string'||!message.text.isWellFormed()) return 'rejected';
    let mentions=[];
    if(message.mentions!==undefined)try{mentions=checkedNativeMentions(message.text,message.mentions);}catch{return 'rejected';}
    if(mentions.length) {
      let members;try{members=new Set(await chatMembers(message.source,signal));}catch{return 'rejected';}
      if(mentions.some(m=>!members.has(m.recipient)))return 'rejected';
    }
    let access_token;
    // Without a token nothing was sent: a definitive rejection, not an unknown outcome.
    try { access_token = await accessToken(signal); } catch { return 'rejected'; }
    if(mentions.length){let delivered=0;for(const parts of nativeMentionFrames(message.text,mentions,prefix)){
      const status=await sendGroup(message.source,{msgtype:'rich_text',rich_text:parts},access_token,signal);
      if(status!=='delivered'){if(delivered)throw Error('partial_native_mention_delivery');return status;}delivered++;
    }return 'delivered';}
    // Old queued messages can predate native byte framing. No regeneration or
    // blind retry: a refusal/uncertain send stops this sequence immediately.
    for(const part of utf8Chunks(message.text,budget)) {
      const status=await sendGroup(message.source,{msgtype:'text',text:{content:prefix+part}},access_token,signal);
      if(status!=='delivered')return status;
    }
    return 'delivered';
  }

  async function sendMarkdown(message, signal) {
    if (typeof message.text !== 'string' || !message.text.trim() || !message.text.isWellFormed() || Buffer.byteLength(message.text) > 4096) return 'rejected';
    const access_token = await accessToken(signal);
    return sendGroup(message.source, { msgtype: 'markdown', markdown: { content: message.text } }, access_token, signal);
  }

  async function downloadMedia(mediaId, signal, limit, timeout) {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
      const access_token = await accessToken(deadline);
      const response = await fetcher(mediaUrl('get', { access_token, media_id: mediaId }), { redirect: 'error', signal: deadline });
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel();
        throw Error('WeCom media unavailable');
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw Error('WeCom media too large');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, size);
  }
  /** Files people send to the group, so the assistant can read them. */
  const files = { download: (mediaId, signal, limit = 20 * 1024 * 1024) => downloadMedia(mediaId, signal, limit, 50000) };
  const images = {
    download: (mediaId, signal) => downloadMedia(mediaId, signal, maxImage, 5000),
    async upload(image, signal) {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(7000)]);
      const access_token = await accessToken(deadline);
      const form = new FormData();
      form.append('media', new Blob([image.bytes], { type: image.type }), image.type === 'image/png' ? 'image.png' : 'image.jpg');
      const response = await fetcher(mediaUrl('upload', { access_token, type: 'image' }), {
        method: 'POST', body: form, redirect: 'error', signal: deadline,
      });
      if (!response.ok) { await response.body?.cancel(); return null; }
      const result = await response.json();
      return result.errcode === 0 && typeof result.media_id === 'string' && result.media_id.length <= 512
        ? result.media_id : null;
    },
    attribute(message, signal) { return sendText({ ...message, text: '发送了一张图片' }, signal); },
    async send(sourceKey, mediaId, signal) {
      const access_token = await accessToken(signal);
      return sendGroup(sourceKey, { msgtype: 'image', image: { media_id: mediaId } }, access_token, signal);
    },
  };

  return {
    bindings,
    senderNames, robotInfo, memberInfo, chatSnapshot, syncSnapshot, quitChat, sendShortcuts, employeeIdentity, employeeIdentities, employeeForRtx,
    // The Tencent directory returns employee accounts for provider directory
    // IDs. Reuse that authenticated mapping, never callback display labels.
    async resolveSender(source, id, signal) {
      if (!groupIdFor(source) || typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(id)) throw Error('invalid_wecom_sender');
      if (/^(wb|fw)/u.test(id))throw Error('Robot is not an employee');
      if (!/^T[0-9]{1,32}[A-Z]?$/u.test(id)) return id;
      const account = (await senderNames(source, [id], signal)).get(id);
      if (!account) throw Error('wecom_identity_unavailable');
      return account;
    },
    ...(enableImages === true ? { images } : {}),
    files,
    downloadEmotion:(url,signal)=>downloadEmotion(url,signal,fetcher),
    subscribe(receive) {
      if (consume) throw Error('WeCom channel transport already connected');
      consume = receive;
      return () => { if (consume === receive) consume = undefined; };
    },
    send: async(message,signal)=>messagePresentation(message).format==='markdown'&&message.mentions===undefined
      ?sendMarkdownMessage({sendMarkdown,sendFile},message,signal):sendText(message,signal),
    sendMarkdown,
    sendDirectNotification,
    sendRichText:async(source,parts,signal)=>sendGroup(source,{msgtype:'rich_text',rich_text:parts},await accessToken(signal),signal),
    respond,
    updateCard,
    sendCard,
    chatMembers,
    mentionMembers,
    mentionEveryone,
    sendFile,
    userIds,
    createChat,
    updateChat,
    updateChatDetailed,
    welcomeDirect,
    isDirect: sourceKey => !!directUser(groupIdFor(sourceKey)),
    callback: { path, async handle(req, res, forward) {
      if (!consume && !(relayIngress === true && forward)) return send(res, 503);
      req.setTimeout(4000, () => req.destroy());
      const url = new URL(req.url, 'http://callback.invalid');
      if(req.method==='GET'&&url.pathname===path) {
        const echo=url.searchParams.get('echostr');
        if(!echo||echo.length>8192||url.searchParams.getAll('echostr').length!==1||!signed(url,echo))return send(res,401);
        try{return send(res,200,decrypt(echo));}catch{return send(res,400);}
      }
      if (req.method !== 'POST' || url.pathname !== path) return send(res, 404);
      if (Number(req.headers['content-length']) > maxBody) return send(res, 413);
      let arrival, directUserId, forwardedBody, mentioned = false;
      try {
        const body = await readXml(req);
        if (body === null) return send(res, 413);
        const encrypted = field(parseXml(body), 'Encrypt');
        if (!encrypted || !signed(url, encrypted)) return send(res, 401);
        const root = parseXml(decrypt(encrypted));
        if (field(root, 'ServiceId') !== serviceId || field(root, 'ToUserName') !== corpId
          || field(root, 'AgentType') !== 'chat') return send(res, 403);
        const msg = child(root, 'Msg');
        const from = child(msg, 'From');
        const groupId = field(from, 'Id');
        const type = field(msg, 'MsgType');
        const foreign=senderIdentity(field(from,'Sender')??groupId,field(from,'SenderCorpId'),corpId);
        // Foreign private accounts cannot be addressed unambiguously by this provider API.
        if(foreign.external&&(field(from,'Type')==='single'||type==='Event'))return send(res,200);
        // Card events arrive once and their ResponseCode expires in 5 s: hand them to the
        // Relay immediately and acknowledge, never forwarding or queueing the raw event.
        if (relayIngress === true && onCardEvent && type === 'Event' && field(msg, 'Event') === 'template_card_event'
          && ((field(from, 'Type') === 'group' && acceptsGroup(groupId))
            || (field(from, 'Type') === 'single' && directChats === true && validGroupId(groupId) && !groupId.includes(':') && groupId !== serviceId))) {
          const direct = field(from, 'Type') === 'single';
          const event = cardEvent(msg, direct ? DIRECT + groupId : groupId);
          if (direct) { event.author = groupId; event.direct = true; }
          if (!event.id || !event.author || event.author === serviceId || !event.responseCode) return send(res, 200);
          try { await onCardEvent(event); } catch { /* Delivered once by the provider: never ask for a retry. */ }
          return send(res, 200);
        }
        // A Relay using the existing Hub receiver can reject private chats here
        // while preserving the original encrypted group callback byte for byte.
        if (relayIngress === true && forward && field(from, 'Type') !== 'single') {
          forwardedBody = body;
          const author = field(from, 'Sender'), id = field(msg, 'MsgId'), time = Number(field(msg, 'CreateTime'));
          mentioned = ['1', '2', '3'].includes(field(msg, 'MentionedType'));
          if (field(from, 'Type') === 'group' && type === 'text' && mentioned && acceptsGroup(groupId)
            && author && author !== serviceId && id && Number.isSafeInteger(time) && time > 0 && time <= Date.now() / 1000 + 300) {
            arrival = { source: sourceFor(groupId), id, author, text: field(msg, 'Content') ?? '', at: time * 1000, mentioned: true };
          }
        } else if(field(from,'Type')==='group' && relayIngress===true && type==='Event' && field(msg,'Event')==='click') {
          const item=DIRECT_MENU.find(item=>item.key===field(msg,'EventKey'));
          const author=field(from,'Sender'),id=field(msg,'MsgId'),time=Number(field(msg,'CreateTime'));
          if(!acceptsGroup(groupId)||!author||author===serviceId||/^(wb|fw)/u.test(author)||!id||!Number.isSafeInteger(time)||time<=0||time>Date.now()/1000+300)return send(res,200);
          if(!item){if(onShortcut)await onShortcut({source:sourceFor(groupId),id,author,eventKey:field(msg,'EventKey')??'',at:time*1000});return send(res,200);}
          arrival={source:sourceFor(groupId),id,author,sender:{id:author,displayName:author},text:item.prompt,at:time*1000};mentioned=true;
        } else if (field(from, 'Type') === 'single' && relayIngress === true && directChats === true && type === 'Event') {
          if (!validGroupId(groupId) || groupId === serviceId || groupId.includes(':')) return send(res, 200);
          const event = field(msg, 'Event');
          if (event === 'enter_chat') {
            if (onDirectEnter) await onDirectEnter(groupId).catch(() => {});
            return send(res, 200);
          }
          // Known shortcuts become ordinary owner-scoped input. The provider MsgId
          // goes through the same durable deduplication as a typed message.
          const item = event === 'click' && DIRECT_MENU.find(item => item.key === field(msg, 'EventKey'));
          const id = field(msg, 'MsgId'), time = Number(field(msg, 'CreateTime'));
          if(!item){if(event==='click'&&onShortcut&&id&&Number.isSafeInteger(time)&&time>0&&time<=Date.now()/1000+300)await onShortcut({source:sourceFor(DIRECT+groupId),id,author:groupId,eventKey:field(msg,'EventKey')??'',at:time*1000});return send(res,200);}
          if (!id || id.length > 256 || !Number.isSafeInteger(time) || time <= 0 || time > Date.now() / 1000 + 300) return send(res, 400);
          mentioned = true;
          arrival = { source: sourceFor(DIRECT + groupId), id, author: groupId,
            sender: { id: groupId, displayName: groupId }, text: item.prompt, direct: true, at: time * 1000 };
        } else if (field(from, 'Type') === 'single' && relayIngress === true && directChats === true) {
          // A private chat is the person's own room with their assistant: every message is addressed to it.
          const author = groupId, id = field(msg, 'MsgId');
          if (!validGroupId(author) || author === serviceId || author.includes(':') || !id) return send(res, 200);
          const described = DESCRIBED_TYPES.has(type);
          if (type !== 'text' && !described && !(enableImages === true && type === 'image')) return send(res, 200);
          const ids=forwardedSenders(msg,corpId);
          const names=ids.length?await senderNames(sourceFor(DIRECT+author),ids,AbortSignal.timeout(1500)).catch(()=>new Map()):new Map();
          const record=forwardedRecord(msg,names,corpId);
          let text = type === 'text' ? field(msg, 'Content') : describeMessage(msg,names,0,corpId).slice(0,16000);
          const mediaId = type === 'image' ? field(msg, 'MediaId') : undefined;
          const fileMedia = type === 'file' ? field(msg, 'MediaId') : undefined;
          const voiceMedia = type === 'voice' ? field(msg, 'MediaId') : undefined;
          if (!(text || mediaId)) return send(res, 200);
          const time = Number(field(msg, 'CreateTime'));
          if (!Number.isSafeInteger(time) || time <= 0 || time > Date.now() / 1000 + 300) return send(res, 400);
          mentioned = true;
          arrival = { source: sourceFor(DIRECT + author), id, author, sender: { id: author, displayName: author }, text,...(record?{forwardedRecord:record}:{}), nestedMedia: nestedMedia(msg), direct: true,
            ...(mediaId && { mediaId }), ...(fileMedia && fileMedia.length <= 512 && { file: { mediaId: fileMedia, name: field(msg, 'FileName') ?? '' } }),
            ...(voiceMedia && voiceMedia.length <= 512 && { voice: { mediaId: voiceMedia, format: field(msg, 'Format') ?? '' } }), at: time * 1000 };
        } else if (field(from, 'Type') === 'single') {
          // A private conversation never reaches the group queue or native timeline.
          if (!relayIngress || !validGroupId(groupId) || groupId === serviceId
            || !field(msg, 'MsgId') || !['text', 'image', 'voice', 'video', 'shortvideo', 'file', 'location', 'link'].includes(type)) return send(res, 200);
          directUserId = groupId;
        } else {
          const described = relayIngress === true && DESCRIBED_TYPES.has(type);
          if (field(from, 'Type') !== 'group' || (type !== 'text' && !described && !(enableImages === true && type === 'image'))
            || !acceptsGroup(groupId)) return send(res, 200);
          mentioned = ['1', '2', '3'].includes(field(msg, 'MentionedType'));
          const author = field(from, 'Sender');
          const id = field(msg, 'MsgId');
          let text = type === 'text' ? field(msg, 'Content') : '';
          let record;
          if (described) {
            // Forwarded records name their senders by provider id; resolve them briefly, best effort.
            const ids = forwardedSenders(msg,corpId);
            const names = ids.length ? await senderNames(sourceFor(groupId), ids, AbortSignal.timeout(1500)).catch(() => new Map()) : new Map();
            record=forwardedRecord(msg,names,corpId);
            text = describeMessage(msg, names,0,corpId).slice(0, 16000);
          }
          const mediaId = type === 'image' ? field(msg, 'MediaId') : undefined;
          const fileMedia = type === 'file' && described ? field(msg, 'MediaId') : undefined;
          const voiceMedia = type === 'voice' && described ? field(msg, 'MediaId') : undefined;
          if (!author || author === serviceId || !id || !(text || mediaId)) return send(res, 200);
          const time = Number(field(msg, 'CreateTime'));
          if(relayIngress===true&&(!Number.isSafeInteger(time)||time<=0||time>Date.now()/1000+300))return send(res,400);
          arrival = { source: sourceFor(groupId), id, author, sender: { id: author, displayName: author }, text,...(record?{forwardedRecord:record}:{}), nestedMedia: nestedMedia(msg), ...(mediaId && { mediaId }), ...(fileMedia && fileMedia.length <= 512 && { file: { mediaId: fileMedia, name: field(msg, 'FileName') ?? '' } }), ...(voiceMedia && voiceMedia.length <= 512 && { voice: { mediaId: voiceMedia, format: field(msg, 'Format') ?? '' } }), at: Number.isSafeInteger(time) && time > 0 && time <= Date.now() / 1000 + 300 ? time * 1000 : Date.now() };
        }
        if(arrival&&foreign.external){arrival={...arrival,author:foreign.id,sender:{id:foreign.id,displayName:foreign.displayName},mentioned:false};mentioned=false;}
      } catch {
        if (!res.destroyed) send(res, 400);
        return;
      }
      if (forwardedBody !== undefined) {
        try { if (arrival && onMention) await onMention(arrival); }
        catch { return send(res, 503); }
        return forward(forwardedBody);
      }
      if (directUserId) {
        try { await rejectDirectMessage(directUserId); }
        catch { return send(res, 503); }
        return send(res, 200);
      }
      arrival.mentioned = mentioned;
      if (!consume) return send(res, 503);
      // ACK only once the timeline owner has durably recorded the arrival.
      try { await consume(arrival); if (relayIngress === true && mentioned && onMention) await onMention(arrival); }
      catch { return send(res, 503); }
      return send(res, 200);
    } },
  };
}
