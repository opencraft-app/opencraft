#!/usr/bin/env node
// wecom — CLI for the internal WeCom customer-service API (内部客服接口).
// Covers chat create/get/update/quit, every send type (text, markdown, image, file,
// rich_text, template_card), card update, stream replies, rtx<->userid and robot info.
// Credentials come from a private JSON file; nothing is sent with --dry-run.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const BASE = 'http://in.qyapi.weixin.qq.com';
const HELP = `wecom <command> [args] [--config FILE] [--dry-run] [--json]

Chats
  chat create <name> <user...>            建群 (客服号自动加入)
  chat get <chatid>                       群信息与成员
  chat rename <chatid> <name>             改群名
  chat add <chatid> <user...>             拉人
  chat remove <chatid> <user...>          踢人
  chat quit <chatid>                      客服号退群

Send  (target: g:<chatid> 群聊 | u:<userid|rtx> 单聊)
  send text <target> <text|->             文本 (≤5000B, '-' 读 stdin)
  send md <target> <markdown|->           Markdown (≤4096B)
  send image <target> <file.png|jpg>      图片 (自动上传)
  send file <target> <path>               文件 (自动上传)
  send rich <target> <seg...>             富文本: text:… @:user,@all link:文本=key view:文本=url
  send card <target> <card.json|->        原始模板卡片 JSON
  card notice <target> --title T [--desc D] [--sub S] [--kv k=v]... [--url U] [--quote Q] [--big N=label]
  card buttons <target> --title T [--desc D] --button 文本[=key[:style]]...  (省略 key 时用文本作 key，点击后显示文本) [--task ID]
  card vote <target> --title T --option id=文本... [--multi-choice] [--submit 提交] [--task ID]
  card select <target> --title T --select 'key:标题:id=文本,id=文本'... [--task ID]
  card news <target> --title T --image URL [--desc D] [--url U]
  card update <response_code> <card.json|-> [--users u1,u2]   5 秒内用回调里的 ResponseCode

Streams
  stream <msgid> <text|-> [--id STREAMID] [--finish]          回复流式消息 (markdown, ≤20480B)
  stream pipe <msgid> [--id ID] [--interval 800]              stdin 逐行累积推送，EOF 结束

Directory
  user id <rtx...>                        rtx → userid
  user name <userid...>                   userid → rtx
  robot <robotid...>                      机器人信息
  token                                   检查凭据 (不打印 token)
  media upload <path> [--type image|file] 上传临时素材，打印 media_id

Config: --config, $WECOM_CONFIG, or ./wecom.json — {"corpId","corpSecret","serviceId"}.
`;

function parse(argv) {
  const out = { _: [], multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
    const flag = ['dry-run', 'json', 'finish', 'multi-choice', 'help'].includes(k);
    const v = flag ? true : inline ?? argv[++i];
    if (['kv', 'button', 'option', 'select'].includes(k)) (out.multi[k] ??= []).push(v);
    else out[k] = v;
  }
  return out;
}
const die = (msg, code = 2) => { process.stderr.write(msg + '\n'); process.exit(code); };
const readArg = v => v === '-' ? fs.readFileSync(0, 'utf8') : v;
const readJsonArg=v=>JSON.parse(v==='-'?fs.readFileSync(0,'utf8'):v.trimStart().startsWith('{')?v:fs.readFileSync(v,'utf8'));
const bytes = s => Buffer.byteLength(s);
const need = (v, what) => (v === undefined || v === '' ? die('missing ' + what) : v);
const receiver = t => {
  const m = /^(g|u):(.+)$/u.exec(need(t, 'target'));
  if (!m) die(`target must be g:<chatid> or u:<userid>, got ${t}`);
  return { type: m[1] === 'g' ? 'group' : 'single', id: m[2] };
};
const optPair = s => s.includes('=') ? pair(s, 'option') : [s, s];
const pair = (s, what) => { const i = s.indexOf('='); if (i < 1) die(`${what} must be key=value: ${s}`); return [s.slice(0, i), s.slice(i + 1)]; };
const taskId = t => { const id = t ?? 'oc-' + randomUUID().replaceAll('-', '').slice(0, 24); if (!/^[A-Za-z0-9_\-@]{1,128}$/u.test(id)) die('invalid task id'); return id; };

class Client {
  constructor(config, { dryRun, fetcher = fetch }) { this.c = config; this.dry = dryRun; this.fetch = fetcher; }
  async token() {
    if (this.dry) return 'DRY_RUN';
    if (this.cached) return this.cached;
    const r = await this.json(`${BASE}/cgi-bin/gettoken?` + new URLSearchParams({ corpid: this.c.corpId, corpsecret: this.c.corpSecret }));
    if (r.errcode !== 0) throw Object.assign(Error(`gettoken ${r.errcode} ${r.errmsg}`), { result: r });
    return (this.cached = r.access_token);
  }
  async json(url, init) {
    const res = await this.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000), ...init });
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw Error(`HTTP ${res.status}: ${text.slice(0, 200)}`); }
  }
  async call(endpoint, body, query = {}) {
    if (this.dry) return { dryRun: true, endpoint, query, body };
    for (let attempt = 0; ; attempt++) {
      const url = `${BASE}/cgi-bin/${endpoint}?` + new URLSearchParams({ ...query, access_token: await this.token() });
      const r = await this.json(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if ([40001, 40014, 42001].includes(r.errcode) && !attempt) { this.cached = undefined; continue; }
      return r;
    }
  }
  async upload(file, type) {
    const data = fs.readFileSync(file);
    if (data.length > (type === 'image' ? 2 : 20) * 1024 * 1024) die(`${file} too large for ${type}`);
    if (this.dry) return { dryRun: true, endpoint: 'media/upload', type, file, size: data.length, media_id: 'DRY_RUN_MEDIA' };
    const form = new FormData();
    form.append('media', new Blob([data]), path.basename(file));
    const url = `${BASE}/cgi-bin/media/upload?` + new URLSearchParams({ access_token: await this.token(), type });
    return this.json(url, { method: 'POST', body: form });
  }
  send(target, msgtype, payload) { return this.call('tencent/chat/send', { receiver: receiver(target), msgtype, [msgtype]: payload }); }
}

export const cards = {
  notice(o) {
    const card = { card_type: 'text_notice', main_title: { title: need(o.title, '--title'), ...(o.desc && { desc: o.desc }) },
      card_action: o.url ? { type: 1, url: o.url } : { type: 1, url: 'https://work.weixin.qq.com' } };
    if (o.sub) card.sub_title_text = o.sub;
    if (o.quote) card.quote_area = { type: 0, quote_text: o.quote };
    if (o.big) { const [t, d] = pair(o.big, '--big'); card.emphasis_content = { title: t, desc: d }; }
    if (o.multi.kv) card.horizontal_content_list = o.multi.kv.slice(0, 6).map(s => { const [k, v] = pair(s, '--kv'); return { keyname: k, value: v }; });
    return card;
  },
  buttons(o) {
    const list = need(o.multi.button, '--button');
    return { card_type: 'button_interaction', main_title: { title: need(o.title, '--title'), ...(o.desc && { desc: o.desc }) },
      ...(o.sub && { sub_title_text: o.sub }), task_id: taskId(o.task),
      button_list: list.slice(0, 6).map(s => { const [text, rest] = optPair(s); const [key, style] = rest.split(':'); return { text, key, style: Number(style ?? 1) }; }) };
  },
  vote(o) {
    return { card_type: 'vote_interaction', main_title: { title: need(o.title, '--title'), ...(o.desc && { desc: o.desc }) }, task_id: taskId(o.task),
      checkbox: { question_key: o.question ?? 'vote', mode: o['multi-choice'] ? 1 : 0,
        option_list: need(o.multi.option, '--option').slice(0, 20).map(s => { const [id, text] = optPair(s); return { id, text }; }) },
      submit_button: { text: o.submit ?? '提交', key: o.key ?? 'submit' } };
  },
  select(o) {
    return { card_type: 'multiple_interaction', main_title: { title: need(o.title, '--title'), ...(o.desc && { desc: o.desc }) }, task_id: taskId(o.task),
      select_list: need(o.multi.select, '--select').slice(0, 3).map(s => {
        const [key, title, opts] = s.split(/:(.*?):(.*)/s).filter(Boolean);
        const option_list = need(opts, '--select options').split(',').map(x => { const [id, text] = pair(x, 'option'); return { id, text }; });
        return { question_key: key, title, option_list };
      }), submit_button: { text: o.submit ?? '提交', key: o.key ?? 'submit' } };
  },
  news(o) {
    return { card_type: 'news_notice', main_title: { title: need(o.title, '--title'), ...(o.desc && { desc: o.desc }) },
      card_image: { url: need(o.image, '--image'), aspect_ratio: 1.3 }, card_action: { type: 1, url: o.url ?? o.image } };
  },
};

export function richSegments(segs) {
  return segs.map(s => {
    if (s.startsWith('text:')) return { type: 'text', text: { content: s.slice(5) } };
    if (s.startsWith('@:')) return { type: 'mentioned', mentioned: { userlist: s.slice(2).split(',').filter(Boolean) } };
    if (s.startsWith('link:')) { const [text, key] = pair(s.slice(5), 'link'); return { type: 'link', link: { type: 'click', text, key } }; }
    if (s.startsWith('view:')) { const [text, key] = pair(s.slice(5), 'view'); return { type: 'link', link: { type: 'view', text, key, browser: 0 } }; }
    return { type: 'text', text: { content: s } };
  });
}

function loadConfig(o) {
  const file = o.config ?? process.env.WECOM_CONFIG ?? 'wecom.json';
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (o['dry-run']) return { corpId: 'wxDRY', corpSecret: 'x', serviceId: 'fwDRY' }; die(`cannot read config ${file}: ${e.code ?? e.message}`); }
  const c = raw.wecom ?? raw;
  for (const k of ['corpId', 'corpSecret', 'serviceId']) if (typeof c[k] !== 'string' || !c[k]) die(`config ${file} lacks ${k}`);
  return c;
}

export async function main(argv, { fetcher, stdout = process.stdout } = {}) {
  const o = parse(argv);
  const [cmd, sub, ...rest] = o._;
  if (!cmd || o.help || cmd === 'help') { stdout.write(HELP); return 0; }
  const cfg = loadConfig(o), api = new Client(cfg, { dryRun: !!o['dry-run'], fetcher });
  let r;
  switch (cmd) {
    case 'token': r = { ok: !!(await api.token()), corpId: cfg.corpId, serviceId: cfg.serviceId }; break;
    case 'chat':
      if (sub === 'create') r = await api.call('tencent/chat/create', { name: need(rest[0], 'name'), userlist: [...new Set([...rest.slice(1), cfg.serviceId])] });
      else if (sub === 'get') r = await api.call('tencent/chat/get', undefined, { chatid: need(rest[0], 'chatid') });
      else if (sub === 'rename') r = await api.call('tencent/chat/update', { chatid: need(rest[0], 'chatid'), name: need(rest[1], 'name') });
      else if (sub === 'add') r = await api.call('tencent/chat/update', { chatid: need(rest[0], 'chatid'), add_user_list: rest.slice(1) });
      else if (sub === 'remove') r = await api.call('tencent/chat/update', { chatid: need(rest[0], 'chatid'), del_user_list: rest.slice(1) });
      else if (sub === 'quit') r = await api.call('tencent/chat/quit', { chatid: need(rest[0], 'chatid') });
      else die('unknown chat command');
      break;
    case 'send': {
      const [target, ...args] = rest;
      if (sub === 'text') { const content = readArg(need(args[0], 'text')); if (bytes(content) > 5000) die('text exceeds 5000 bytes'); r = await api.send(target, 'text', { content }); }
      else if (sub === 'md') { const content = readArg(need(args[0], 'markdown')); if (bytes(content) > 4096) die('markdown exceeds 4096 bytes'); r = await api.send(target, 'markdown', { content }); }
      else if (sub === 'image' || sub === 'file') {
        receiver(target);
        const up = await api.upload(need(args[0], 'path'), sub);
        if (!up.media_id) { r = up; break; }
        r = await api.send(target, sub, { media_id: up.media_id });
      }
      else if (sub === 'rich') r = await api.send(target, 'rich_text', richSegments(need(args.length ? args : undefined, 'segments')));
      else if (sub === 'card') r = await api.send(target, 'template_card', readJsonArg(need(args[0], 'card json')));
      else die('unknown send type');
      break;
    }
    case 'card': {
      if (sub === 'update') {
        const users = o.users ? String(o.users).split(',') : undefined;
        r = await api.call('tencent/chat/update_template_card', { response_code: need(rest[0], 'response_code'), template_card: readJsonArg(need(rest[1], 'card json')), ...(users && { update_user_list: users.slice(0, 50) }) });
        break;
      }
      if (!cards[sub]) die('unknown card type: ' + sub);
      const card = cards[sub](o);
      r = await api.send(rest[0], 'template_card', card);
      if (card.task_id) r = { ...r, task_id: card.task_id };
      break;
    }
    case 'stream': {
      const pipe = sub === 'pipe', msgid = need(pipe ? rest[0] : sub, 'msgid'), id = o.id ?? 'oc-cli-' + Date.now().toString(36);
      if (!/^[\x21-\x7e]{1,64}$/u.test(id)) die('invalid stream id');
      if (!pipe) {
        const content = readArg(need(rest[0], 'content'));
        if (bytes(content) > 20480) die('stream content exceeds 20480 bytes');
        r = { ...(await api.call('tencent/chat/respond_msg', { msgid, msgtype: 'stream', stream: { id, finish: !!o.finish, content } })), stream_id: id };
        break;
      }
      const interval = Number(o.interval ?? 800); let content = '', sentAt = 0, last;
      const push = async finish => { last = await api.call('tencent/chat/respond_msg', { msgid, msgtype: 'stream', stream: { id, finish, content } }); sentAt = Date.now(); if (last.errcode) throw Object.assign(Error(`respond_msg ${last.errcode} ${last.errmsg}`), { result: last }); };
      for await (const chunk of process.stdin) {
        content += chunk; if (bytes(content) > 20480) content = Buffer.from(content).subarray(0, 20480).toString().replace(/\uFFFD$/u, '');
        if (Date.now() - sentAt >= interval) await push(false);
      }
      await push(true); r = { ...last, stream_id: id, bytes: bytes(content) };
      break;
    }
    case 'user':
      if (sub === 'id') r = await api.call('tencent/user/convert_to_userid', { name_list: rest });
      else if (sub === 'name') r = await api.call('tencent/user/convert_to_name', { userid_list: rest });
      else die('unknown user command');
      break;
    case 'robot': r = await api.call('tencent/batch/get_robot_info', { robotid_list: [sub, ...rest].filter(Boolean) }); break;
    case 'media': if (sub !== 'upload') die('unknown media command'); r = await api.upload(need(rest[0], 'path'), o.type ?? 'file'); break;
    default: die('unknown command: ' + cmd + '\n\n' + HELP);
  }
  stdout.write(JSON.stringify(r, null, o.json ? 0 : 2) + '\n');
  return r?.errcode && !r.dryRun ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/wecom') || process.argv[1]?.endsWith('wecom.mjs'))
  main(process.argv.slice(2)).then(code => process.exit(code), e => { process.stderr.write((e.result ? JSON.stringify(e.result) : e.message) + '\n'); process.exit(1); });
