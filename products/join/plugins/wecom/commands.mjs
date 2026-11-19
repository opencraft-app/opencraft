import { wecomMention } from './assistant-mentions.mjs';
import { humanKey } from './mirror/store.mjs';

const pageSize = 6;
const label = value => Array.from(value).slice(0, 32).join('');
const webSelector = '[打开 Join，选择服务器](https://join.woa.com/servers)';
const webHelp = `### OpenCraft\n${webSelector}\n\n在网页中选择并进入你有权限的服务器；首次打开请先登录。\n\n**可用命令**\n- @机器人 帮助 — 使用说明\n- @机器人 服务器 — 打开服务器选择页\n- @机器人 记录 — 已确认的服务器关系`;
const markdownLabel = value => label(value).replace(/[\p{Bidi_Control}\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/[\\`*_{}\[\]()#+.!<>|~-]/gu, '\\$&');
export function mentionCommand(event, corpId) {
  const intent=wecomMention(event);
  if(intent?.kind!=='command')return undefined;
  return { kind: 'command', human: humanKey(corpId, event.author), userId: event.author,
    action: intent.action, serverId: intent.argument };
}

function serverList(servers, page = 1, history = false, markdown = false) {
  const pages = Math.max(1, Math.ceil(servers.length / pageSize));
  if (!Number.isSafeInteger(page)) page = 1;
  page = Math.min(Math.max(page, 1), pages);
  const rows = servers.slice((page - 1) * pageSize, page * pageSize).map(server =>
    `${markdown ? '- ' + markdownLabel(server.name) : label(server.name) + ' (' + server.id + ')'}${history && server.lastConfirmedAt ? ' · 最近确认 ' + new Date(server.lastConfirmedAt).toISOString().slice(0, 10) : ''}`);
  if (pages > 1) rows.push(`第 ${page}/${pages} 页；发送“@机器人 ${history ? '记录' : '服务器'} <页码>”翻页。`);
  return rows.join('\n');
}

/** Replies use the verified sender's directory; participation records never grant access. */
export async function commandReply(store, source, job, { forwardingOnly = false, directory } = {}) {
  const action = job.action.toLowerCase();
  // Opening the selector must work even before a sender has a directory record
  // or while the provider lookup is unavailable. The browser owns admission.
  if (forwardingOnly && action !== '记录' && action !== '历史') {
    if (action === '关联') return `### OpenCraft\n无需关联码，请登录网页选择服务器。\n\n${webSelector}`;
    if (action === '保存') return `### OpenCraft\n本群目前沿用已有转发位置。你可以在网页中选择服务器并进入使用。\n\n${webSelector}`;
    return webHelp;
  }
  if (action === '关联') {
    if (!job.serverId) return '请在目标服务器获取关联码，再发送“@机器人 关联 <关联码>”。';
    const accepted = await store.attachLink(job.serverId.toLowerCase(), source, job.userId);
    return accepted ? '正在确认身份关联，请稍候。' : '关联码已失效，请回到目标服务器重新获取。';
  }
  const automatic=forwardingOnly&&directory?await directory(job,source):undefined;
  const choices = automatic?.servers ?? await store.candidates(job.human);
  if (action === '保存') {
    if (forwardingOnly) return '本群目前沿用已有转发位置。发送“@机器人 帮助”查看当前可用命令。';
    if (!job.serverId) return '发送“@机器人 服务器”查看可选项，再发送“@机器人 保存 <服务器ID>”。';
    if (!choices.some(server => server.id === job.serverId)) return '该服务器当前不可用或尚未关联你的企业微信身份。发送“@机器人 服务器”查看可选项。';
    try {
      await store.bind(source, job.human, job.serverId, '企业微信群');
      return `已指定 ${job.serverId}，正在转交暂存记录。此前超过 200 条的消息未保存。`;
    } catch (error) {
      if (!['identity_denied', 'server_unavailable', 'already_bound'].includes(error.message)) throw error;
      return error.message === 'already_bound' ? '本群已有保存位置，暂不支持切换。' : '该服务器当前不可用或尚未关联你的企业微信身份，请稍后重试。';
    }
  }
  const noServers = forwardingOnly
    ? automatic?.unresolved ? '已识别你的企业微信身份，暂未查到你的服务器记录。通过统一入口使用过服务器后，会自动识别，无需关联码。'
      : automatic?.pending ? '已识别你的企业微信身份，部分服务器暂时无法查询，请稍后重试。'
        : '已识别你的企业微信身份，暂未找到当前可用的服务器；请确认服务器在线且你有访问权限。'
    : '暂未找到你已关联且当前可用的服务器。请先在目标服务器获取关联码，再在本群发送“@机器人 关联 <关联码>”；已关联的服务器离线时，请稍后重试。';
  if (action === '服务器') return choices.length ? '你当前可用的服务器：\n' + serverList(choices, Number(job.serverId) || 1) : noServers;
  if (action === '记录' || action === '历史') {
    const history = automatic?{available:automatic.history}:await store.participation(job.human);
    const text = history.available.length ? '你的服务器记录（仅列出当前仍可用的服务器）：\n' + serverList(history.available, Number(job.serverId) || 1, true, forwardingOnly) : noServers;
    return forwardingOnly ? `### OpenCraft\n${text}\n\n${webSelector}` : text;
  }
  const commands = ['@机器人 帮助 — 命令清单', '@机器人 服务器 — 你的可用服务器', '@机器人 记录 — 已确认的服务器关系'];
  if(!forwardingOnly)commands.push('@机器人 关联 <关联码> — 关联企微身份');
  if (!forwardingOnly) commands.push('@机器人 保存 <服务器ID> — 选择本群保存位置');
  return (choices.length ? '你当前可用的服务器：\n' + serverList(choices) : noServers) + '\n\n可用命令：\n' + commands.join('\n');
}
