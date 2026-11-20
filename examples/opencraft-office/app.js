/* OpenCraft 新办公室。按精简后的模型重做，旧原型 examples/matter-canvas 不动。
   四个名词：人（你、员工、公司外的人，同一种资料页）、对话、工具（工作环境、账号）、改动（他用工具在外面做的事）。
   只有一种关系：能联系谁（单向，勾选，对公司里外的人都一样）。没有上下级；招人时默认你和他互相能联系。你是老板，所有人的设置都能改。
   这是结构原型，没有接真实的 Bot：你发出去的话不会有人回。示例内容是一份静态快照，清空后各处如实显示为空。 */
(function () {
  'use strict';
  var KEY = 'opencraft.office.v4', $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var ENV = { pc: '电脑', cloud: '云环境' };
  var ROLES = [['客服', '你负责回答客户的问题。答不了的记下来，转给你。'], ['采购', '你负责买东西、订场地。超过预算先问你。'], ['对账', '你核对每一笔账和发票是否对得上，对不上的列出来交给你。'], ['文档核对', '你只做核对：版本、页码、签章。核完写清楚看的是哪一份、结论是什么。'], ['行政', '你负责开账号、订会议室、收报销单。办完告诉交办的人。']];
  var NAMES = ['青柚', '白榆', '半夏', '南星', '远山', '知秋', '云杉', '松果', '小满', '若木'];

  function blank() { return { people: [{ id: 'me', kind: 'human', name: '你', role: '老板', look: 0 }], grants: [], msgs: [], changes: [], work: [], tools: [], n: 0, sample: false }; }
  /* 招人时的默认值：你和他互相能联系 */
  function defaults(d, id) { d.grants.push({ from: 'me', to: id, can: 'talk' }, { from: id, to: 'me', can: 'talk' }); }
  function sample() { /* 一家小工作室老板眼里的某个下午 */
    var d = blank(), now = Date.now(), look = 1, ago = function (min) { return now - min * 60000; };
    [['t1', 'pc', '办公室的 Mac mini'], ['t2', 'pc', '机房的 Linux 主机'], ['t3', 'cloud', '测试环境'], ['t4', 'cloud', '客户演示环境'], ['a5', 'account', '飞书'], ['a6', 'account', '企业邮箱'], ['a7', 'account', 'GitHub'], ['a8', 'account', '公司网盘']].forEach(function (t) { d.tools.push({ id: t[0], kind: t[1], name: t[2] }); });
    function bot(id, name, role, howto, env, accounts) { d.people.push({ id: id, kind: 'bot', name: name, role: role, howto: howto, env: env, accounts: accounts, look: look++ }); }
    bot('a', '阿岚', '项目交付', '你负责把版本按时交到客户手里。缺什么材料自己找同事要，拿不准的事先问老板。交付前一定让人核对签字页。', 't1', ['a5', 'a6', 'a8']);
    bot('y', '言禾', '合同与验收', '你保管合同和验收文件。别人来要文件，先确认是哪个版本，再给盖章的那一份。', 't1', ['a5', 'a8']);
    bot('c', '沐川', '行政与账号', '你负责开账号、订会议室、收报销单。办完告诉交办的人。', 't2', ['a5', 'a6', 'a7']);
    bot('z', '小折', '文档核对', '你只做核对：版本、页码、签章。核完写清楚看的是哪一份、结论是什么。', 't3', ['a8']);
    bot('t', '秋池', '对账', '你核对每一笔报销和发票是否对得上，对不上的列出来交给沐川。', null, ['a6']);
    bot('n', '北野', '采购', '你负责买办公用品和订场地。超过预算先问沐川。', null, []);
    d.people.push({ id: 'o1', kind: 'outside', name: '客户周姐', look: 0 });
    /* 谁能联系谁，一条条写明。北野能联系秋池，秋池不能联系北野；你还不能联系小折 */
    [['me', 'a'], ['a', 'me'], ['me', 'y'], ['y', 'me'], ['me', 'c'], ['c', 'me'], ['a', 'z'], ['z', 'a'], ['c', 't'], ['t', 'c'], ['c', 'n'], ['n', 'c'], ['a', 'y'], ['y', 'a'], ['y', 'c'], ['c', 'y'], ['n', 't'], ['a', 'o1']].forEach(function (g) { d.grants.push({ from: g[0], to: g[1], can: 'talk' }); });
    function change(id, min, who, via, what, name, body) { d.changes.push({ id: id, ts: ago(min), who: who, via: via, what: what, name: name, body: body || '' }); }
    change('e1', 172, 'c', 'a5', '订了会议室', '周三 14:00–16:00 大会议室，借了投影');
    change('e2', 62, 'y', 'a8', '共享了文件', '验收签字页（两份附件），共享给阿岚');
    change('e3', 31, 'z', 'a8', '新建了文件', '签字页核对记录', '看了两份附件。\n第 2 页那份没有盖章，是草稿。\n第 3 页那份有客户公章，版本号 2.3。');
    change('e4', 24, 'c', 'a6', '开了账号', '新同事的邮箱');
    change('e5', 23, 'c', 'a5', '开了账号', '新同事的飞书');
    change('e6', 18, 'a', 'a8', '新建了文件', '2.3 版本签字页核对单', '盖章的是第 3 页那一份。\n版本号 2.3，和交付清单一致。\n核对人：小折。\n交付包里的三样都齐了：安装包、测试回执、验收签字页。');
    change('e7', 4, 'c', 'a8', '改了表格', '10 月报销登记表：新增 23 行');
    function msg(min, from, to, text, more) { d.msgs.push(Object.assign({ id: 'm' + d.msgs.length, ts: ago(min), who: from, to: to, text: text, read: true }, more || {})); }
    msg(200, 'me', 'c', '周三下午客户来访，订个大会议室，要能投影。'); msg(170, 'c', 'me', '周三下午 2 点到 4 点的大会议室订好了，投影也借了。', { ch: ['e1'] });
    msg(94, 'me', 'a', '周五要把 2.3 版本交给客户，你来负责。缺什么自己找人。');
    msg(80, 'a', 'y', '言禾，客户盖章的验收签字页在你那吗？周五交付要用。'); msg(62, 'y', 'a', '在，共享给你了。有两个附件页码不一样，盖章的是其中一份，你最好找人核一下。', { ch: ['e2'] });
    msg(55, 'a', 'z', '帮我核一下这两份签字页：哪份是盖章的，版本对不对。'); msg(30, 'z', 'a', '核完了。盖章的是第 3 页那份，版本 2.3，和交付清单一致。记录放网盘了。', { ch: ['e3'] });
    msg(26, 'a', 'o1', '周姐，2.3 版本周五上午发您，签字页我们已经核对过了。', { via: 'a6' });
    msg(49, 'me', 'c', '下周一有新同事入职，账号提前开好。'); msg(22, 'c', 'me', '邮箱和飞书开好了。GitHub 要等他把用户名发我，我已经问了。', { ch: ['e4', 'e5'] });
    msg(17, 'a', 'me', '签字页核对好了，交付包齐了，核对单放在网盘。你没意见的话，我周五上午发给客户。', { ch: ['e6'], read: false });
    msg(40, 'me', 'c', '把 10 月的报销单整理一下，周五前给我。'); msg(12, 'c', 't', '10 月的报销我登记到一半，登完发你对账。');
    d.work.push({ id: 'w1', who: 'c', text: '在企业邮箱里翻 10 月的报销邮件，一封封登记到表里', ts: ago(10), state: 'running' });
    d.n = 100; d.sample = true; return d;
  }
  var db = sample();
  try { var raw = JSON.parse(localStorage.getItem(KEY)); if (raw && raw.people && raw.grants && raw.v === 4) db = raw; } catch (e) { /* 没有存储也能用 */ }
  function save() { db.v = 4; try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ } }
  function uid(p) { db.n += 1; return p + db.n; }

  /* ---------- 模型 ---------- */
  function P(id) { return db.people.filter(function (x) { return x.id === id; })[0]; }
  function T(id) { return db.tools.filter(function (x) { return x.id === id; })[0]; }
  function N(id) { return (P(id) || {}).name || '已移走的人'; }
  function bots() { return db.people.filter(function (x) { return x.kind === 'bot'; }); }
  function outs() { return db.people.filter(function (x) { return x.kind === 'outside'; }); }
  function granted(a, b, can) { return db.grants.some(function (g) { return g.from === a && g.to === b && g.can === can; }); }
  function setGrant(a, b, can, on) { db.grants = db.grants.filter(function (g) { return !(g.from === a && g.to === b && g.can === can); }); if (on) db.grants.push({ from: a, to: b, can: can }); }
  /* 能找：公司里的人看权限；公司外的人看有没有他用的账号 */
  function grantOf(a, b) { return db.grants.filter(function (g) { return g.from === a && g.to === b && g.can === 'talk'; })[0]; }
  function inBook(a, b) { return !!grantOf(a, b); } /* 在 a 的通讯录里 */
  function isOff(a, b) { var g = grantOf(a, b); return !!(g && g.off); } /* 在通讯录里，但被禁用了 */
  function setOff(a, b, off) { var g = grantOf(a, b); if (g) g.off = off || undefined; }
  function canTalk(a, b) { var x = P(a), y = P(b); if (!x || !y || a === b || x.kind === 'outside') return false; return inBook(a, b) && !isOff(a, b); }
  function talkTargets(id) { return db.people.filter(function (x) { return canTalk(id, x.id); }).map(function (x) { return x.id; }); }
  function thread(a, b) { return db.msgs.filter(function (x) { return (x.who === a && x.to === b) || (x.who === b && x.to === a); }).sort(function (x, y) { return x.ts - y.ts; }); }
  function partners(id) { var o = []; db.msgs.slice().sort(function (x, y) { return y.ts - x.ts; }).forEach(function (x) { var p = x.who === id ? x.to : x.to === id ? x.who : null; if (p && o.indexOf(p) < 0) o.push(p); }); return o; }
  function unread(id) { return db.msgs.filter(function (x) { return x.to === 'me' && !x.read && (!id || x.who === id); }); } /* 红点就是没看过的消息 */
  function markRead(id) { var n = 0; db.msgs.forEach(function (x) { if (x.to === 'me' && x.who === id && !x.read) { x.read = true; n++; } }); if (n) { save(); sync(); } }
  function running(id) { return db.work.filter(function (w) { return w.who === id && w.state === 'running'; })[0]; }
  function C(id) { return db.changes.filter(function (x) { return x.id === id; })[0]; }
  function lastChange(id) { return db.changes.filter(function (e) { return e.who === id && Date.now() - e.ts < 3600000; }).sort(function (a, b) { return b.ts - a.ts; })[0]; } /* 最近一小时里他在外面做的最后一件事 */
  function hhmm(ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function ago(ts) { var m = Math.round((Date.now() - ts) / 60000); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : hhmm(ts); }
  function sub(p) { return p.kind === 'human' ? '老板' : p.kind === 'outside' ? '公司外的人' : (p.role || '未填岗位'); }

  /* ---------- 界面：微信的结构。三个标签（消息、通讯录、办公室），点进去是整页，左上角返回。 ---------- */
  var TABBAR = [['chats', '消息', '<path d="M12 4.500c-4.700 0-8.500 3.100-8.500 7 0 2.200 1.200 4.100 3.100 5.400L6 20l3.400-1.600c.8.200 1.700.300 2.600.300 4.700 0 8.500-3.100 8.500-7s-3.800-7.200-8.500-7.200z"/>'], ['people', '通讯录', '<circle cx="9" cy="9" r="3.200"/><path d="M3.500 19c.6-3 2.800-4.800 5.500-4.800s4.900 1.800 5.500 4.800M16 6.500a2.800 2.800 0 0 1 0 5.400M17.500 14.600c1.600.7 2.700 2.200 3 4.400"/>'], ['office', '办公室', '<path d="M12 3.500 4 8v8l8 4.500 8-4.500V8z"/><path d="M4 8l8 4.500L20 8M12 12.500v8"/>']];
  var AVC = ['#e9e6f0', '#a9dcc9', '#c3b5ee', '#a9c8f2', '#fbe39c', '#f9cdb0', '#bfe3ee', '#d9e8a6'];
  var ICON = { compose: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.500 5H6.500A2 2 0 0 0 4.500 7v10.500a2 2 0 0 0 2 2H17a2 2 0 0 0 2-2V10.500"/><path d="M17.800 3.700a1.600 1.600 0 0 1 2.300 2.300L12 14.100l-3 .8.800-3z"/></svg>', send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.400" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5.500M5.800 11.500 12 5.300l6.200 6.200"/></svg>', plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>', more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>', back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14.500 5-7 7 7 7"/></svg>' };
  var ui = { tab: 'chats', stack: [], sel: null, edit: false }, has3d = false;
  var wideMq = window.matchMedia ? matchMedia('(min-width: 900px)') : { matches: false }; function wide() { return wideMq.matches && ui.tab !== 'office'; }
  function top() { return ui.stack[ui.stack.length - 1]; }
  function cur() { var t = top(); return t && t.id ? P(t.id) : null; }
  function toScene() {
    var nodes = [], links = [], boss = [];
    db.people.forEach(function (p) { var e = p.kind === 'bot' && lastChange(p.id), t = e && T(e.via);
      nodes.push({ id: p.id, name: p.name, kind: p.kind === 'human' ? 'me' : p.kind === 'outside' ? 'out' : 'bot', look: p.look, badge: unread(p.id).length, busy: !!running(p.id), pc: !!p.env, fx: e ? { id: e.id, mark: t ? t.name.slice(0, 1) : '改' } : null });
    });
    db.people.forEach(function (a) { talkTargets(a.id).forEach(function (b) { links.push([a.id, b]); }); });
    return { nodes: nodes, links: links, boss: boss };
  }
  function sync() { if (has3d) { window.Office.sync(toScene()); window.Office.select(ui.sel, ui.sel ? talkTargets(ui.sel) : [], []); } }
  function pick(id) { if (id && !P(id)) id = null; ui.sel = id; draw(); if (has3d) window.Office.select(id, id ? talkTargets(id) : [], []); }
  function go(page) { ui.edit = false; var prev = ui.stack[ui.stack.length - 2]; if (prev && prev.id === page.id && prev.k === page.k) ui.stack.pop(); else ui.stack.push(page); draw(); }

  function av(id, n) { var p = P(id); return '<span class="av" style="--c:' + (p && p.kind === 'outside' ? '#f6c1c7' : AVC[((p || {}).look || 0) % AVC.length]) + '">' + (n ? '<i class="badge">' + n + '</i>' : '') + '</span>'; }
  function nav(title, right) { return '<header class="nav"><button class="back" data-do="back" aria-label="返回">' + ICON.back + '</button><h1>' + esc(title) + '</h1><span class="r">' + (right || '') + '</span></header>'; }
  function sec(title, body, note) { return '<section class="sec"><h3>' + title + '</h3><div class="grp">' + (note ? '<p class="cap">' + note + '</p>' : '') + body + '</div></section>'; }
  function none(t) { return '<p class="none">' + t + '</p>'; }
  function link(page) { return ' data-go=\'' + esc(JSON.stringify(page)) + '\''; }
  function cell(page, id, title, subline, right, n) { return '<button class="cell"' + link(page) + '>' + av(id, n) + '<span class="t"><b>' + title + '</b>' + (subline ? '<span>' + subline + '</span>' : '') + '</span>' + (right ? '<span class="rt">' + right + '</span>' : '') + '</button>'; }
  function person(id, tab) { return { k: 'person', id: id, tab: tab || '' }; }
  function changeCard(e) { var t = T(e.via);
    return (e.body ? '<details class="file">' : '<div class="file">') + '<' + (e.body ? 'summary' : 'div class="fs"') + '><span><b>' + esc(e.name) + '</b><i>' + esc(N(e.who) + (t ? '在' + t.name : '') + e.what) + '</i></span><span class="fi" aria-hidden="true">' + esc(t ? t.name.slice(0, 1) : '改') + '</span></' + (e.body ? 'summary' : 'div') + '>' + (e.body ? '<pre>' + esc(e.body) + '</pre></details>' : '</div>'); }
  function bubble(m, self) { if (m.sys) return '<p class="when">' + esc(m.text) + '</p>'; var mine = m.who === self, t = m.via && T(m.via);
    return '<div class="msg' + (mine ? ' out' : '') + '">' + av(m.who) + '<div class="mb">' + (!mine && self !== 'me' ? '<span class="nm">' + esc(N(m.who)) + '</span>' : '') + '<div class="bub">' + esc(m.text) + '</div>' + (t ? '<span class="nm">通过' + esc(t.name) + '</span>' : '') +
      (m.ch || []).map(function (id) { var e = C(id); return e ? changeCard(e) : ''; }).join('') + '</div></div>'; }
  function bubbles(list, self) { var prev = 0; return list.map(function (m) { var gap = m.ts - prev > 5 * 60000; prev = m.ts; return (gap && !m.sys ? '<p class="when">' + hhmm(m.ts) + '</p>' : '') + bubble(m, self); }).join(''); }
  function check(sw, a, b, can, on, label, note, locked) { return '<label class="sw' + (locked ? ' fixed' : '') + '"><input type="checkbox" data-sw="' + sw + '" data-a="' + a + '" data-b="' + b + '" data-can="' + can + '"' + (on ? ' checked' : '') + (locked ? ' disabled' : '') + '><span>' + label + (note ? '<em>' + note + '</em>' : '') + '</span></label>'; }

  /* 标签一：消息。你的手机：和你有过对话的人，以及你能找的人 */
  function chats() {
    var list = db.people.filter(function (p) { return p.id !== 'me' && (thread('me', p.id).length || canTalk('me', p.id)); });
    function last(p) { var l = thread('me', p.id).pop(); return l ? l.ts : 0; }
    list.sort(function (a, b) { return (unread(b.id).length - unread(a.id).length) || (last(b) - last(a)); });
    return '<header class="nav top"><span class="r"></span><h1></h1><span class="r"><button class="ic"' + link({ k: 'recruit' }) + ' aria-label="招募">' + ICON.compose + '</button></span></header><div class="body list"><h2 class="large">消息' + (unread().length ? '<i>' + unread().length + ' 条未读</i>' : '') + '</h2>' +
      (list.length ? list.map(function (p) { var l = thread('me', p.id).pop();
        return cell({ k: 'chat', id: p.id }, p.id, esc(p.name) + '<em>' + esc(p.role || '') + '</em>', esc(l ? (l.who === 'me' && !l.sys ? '你：' : '') + l.text : '还没有说过话'), l ? hhmm(l.ts) : '', unread(p.id).length); }).join('') : '<div class="empty"><p>手机里还没有人。</p><button class="btn ok"' + link({ k: 'recruit' }) + '>招募第一位员工</button></div>') +
      '<p class="foot">这是原型，没有接真实的 Bot，你发出去的话不会有人回。<button class="lk" data-do="' + (db.sample ? 'clear" data-confirm="再点一次，清空所有示例">清空示例' : 'sample">放回示例') + '</button></p></div>';
  }
  /* 标签二：通讯录。你、员工、公司外的人，三种人点进去是同一种资料页 */
  function people() {
    return '<header class="nav top"><span class="r"></span><h1></h1><span class="r"></span></header><div class="body list"><h2 class="large">通讯录</h2>' +
      '<button class="cell"' + link({ k: 'recruit' }) + '><span class="av plus">+</span><span class="t"><b>招募</b><span>选个岗位，他就入职</span></span></button>' +
      '<button class="cell"' + link({ k: 'newout' }) + '><span class="av plus">+</span><span class="t"><b>添加公司外的人</b><span>客户、供应商</span></span></button>' +
      cell(person('me'), 'me', '你', '老板') +
      (bots().length ? '<h4>员工</h4>' + bots().map(function (p) { return cell(person(p.id), p.id, esc(p.name), esc(p.role || '未填岗位')); }).join('') : '') +
      (outs().length ? '<h4>公司外的人</h4>' + outs().map(function (o) { return cell(person(o.id), o.id, esc(o.name), esc(sub(o))); }).join('') : '') + '</div>';
  }
  /* 标签三：办公室。三维画面在 .stage 里，这里只出底部那张卡片 */
  function card() {
    var p = P(ui.sel);
    if (!p) return '<p class="hint">点人看他能联系谁；绿方块是他最近一小时用过的工具。单指移动，双指旋转和缩放。</p>';
    var e = p.kind === 'bot' && lastChange(p.id), t = e && T(e.via);
    return '<div class="pcard">' + av(p.id) + '<span class="t"><b>' + esc(p.name) + '</b><span>' + esc(sub(p)) + '</span>' + (e ? '<button class="lastfx"' + link(person(p.id, 'pc')) + '>' + esc(ago(e.ts) + (t ? '在' + t.name : '') + e.what + '：' + e.name) + '</button>' : '') + '</span>' +
      (p.id !== 'me' && canTalk('me', p.id) ? '<button class="btn ok"' + link({ k: 'chat', id: p.id }) + '>发消息</button>' : '') + '<button class="btn"' + link(person(p.id)) + '>' + (p.kind === 'bot' ? '他的手机' : p.id === 'me' ? '你的通讯录' : '资料') + '</button></div>';
  }

  /* 整页：对话 */
  function chat(p) { var t = thread('me', p.id), ok = canTalk('me', p.id);
    return nav(p.name, '<button class="ic" aria-label="他的手机"' + link(person(p.id)) + '>' + ICON.more + '</button>') + '<div class="body chat" id="chat">' + (t.length ? bubbles(t, 'me') : none('还没有对话。对他说第一件要办的事。')) + '</div>' +
      (ok ? '<form class="say" data-do="say"><input id="say" autocomplete="off" enterkeyhint="send" placeholder="对' + esc(p.name) + '说要办什么" aria-label="对' + esc(p.name) + '说"><button class="send" aria-label="发送">' + ICON.send + '</button></form>'
        : '<p class="say cap">你现在不能联系' + esc(p.name) + '。在你的通讯录里添加他就可以。<button class="lk"' + link(person('me')) + '>打开你的通讯录</button></p>'); }

  /* 点一个员工，整屏切进他的手机。进去只管两件事，底部两个标签：通讯录（管理他的通讯录，在联系谁也在这里）、电脑（管理他的电脑）。
     手机里再点进去的聊天、联系人、添加联系人都是一层层推进去的整页；最外一层返回就退出他的手机。顶栏是他的颜色，一眼看出在操作谁的手机。 */
  var PTABS = [['contacts', '通讯录', '<circle cx="9" cy="9" r="3.200"/><path d="M3.500 19c.6-3 2.800-4.800 5.500-4.800s4.900 1.800 5.500 4.800M16 6.500a2.800 2.800 0 0 1 0 5.400M17.500 14.600c1.600.7 2.700 2.200 3 4.400"/>'], ['pc', '电脑', '<rect x="3.500" y="4.500" width="17" height="11.500" rx="1.800"/><path d="M8.500 20h7M12 16v4"/>']];
  var ICHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4.500c-4.700 0-8.500 3.100-8.500 7 0 2.200 1.200 4.100 3.100 5.400L6 20l3.400-1.600c.8.200 1.700.300 2.600.300 4.700 0 8.500-3.100 8.500-7s-3.800-7.200-8.500-7.200z"/></svg>';
  function tint(id) { var p = P(id); return p && p.kind === 'bot' ? AVC[(p.look || 0) % AVC.length] : AVC[0]; }
  function phoneTop(p, title, right) {
    return '<header class="phtop" style="--tint:' + tint(p.id) + '"><button class="back" data-do="back" aria-label="返回">' + ICON.back + '</button><span class="phwho">' + av(p.id) + '<span><i>' + esc(p.id === 'me' ? '你的手机' : p.name + '的手机') + '</i><b>' + esc(title) + '</b></span></span><span class="r">' + (right || '') + '</span></header>';
  }
  function phone(p, page) {
    var self = p.id === 'me', tab = self ? 'contacts' : page.tab === 'pc' ? 'pc' : 'contacts', title = tab === 'pc' ? '电脑' : '通讯录';
    var right = (tab === 'contacts' ? '<button class="tx" data-do="edit">' + (ui.edit ? '完成' : '编辑') + '</button><button class="ic" aria-label="添加联系人"' + link({ k: 'padd', id: p.id }) + '>' + ICON.plus + '</button>' : '') +
      (!self && canTalk('me', p.id) ? '<button class="ic" aria-label="给他发消息"' + link({ k: 'chat', id: p.id }) + '>' + ICHAT + '</button>' : '');
    return '<div class="phone">' + phoneTop(p, title, right) + (tab === 'pc' ? pPc(p) : pContacts(p)) +
      (self ? '' : '<nav class="phtabs" style="--tint:' + tint(p.id) + '" aria-label="' + esc(p.name) + '的手机">' + PTABS.map(function (t) { return '<button data-tab="' + t[0] + '" aria-current="' + (tab === t[0] ? 'page' : 'false') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + t[2] + '</svg>' + t[1] + '</button>'; }).join('') + '</nav>') + '</div>';
  }
  function who(x) { return x.kind === 'outside' ? '公司外' : x.kind === 'human' ? '老板' : esc(x.role || ''); }
  /* 消息：他在联系谁，只读 */
  function pool(p) { return db.people.filter(function (x) { return x.id !== p.id && !(p.kind === 'human' && x.kind === 'outside'); }); }
  /* 通讯录：他能联系谁，按最近聊天排在前面；在联系谁就是每个人下面那句最后的话 */
  /* 通讯录：他能联系谁，按最近聊天排在前面；在联系谁就是每个人下面那句最后的话。
     左滑一行露出「禁用/启用」和「删除」；禁用的人还在通讯录里，只是暂时联系不上 */
  function pContacts(p) {
    var he = p.id === 'me' ? '你' : '他', last = function (j) { var l = thread(p.id, j).pop(); return l ? l.ts : 0; };
    var list = pool(p).filter(function (x) { return inBook(p.id, x.id); }).sort(function (a, b) { return last(b.id) - last(a.id); }),
      gone = partners(p.id).filter(function (j) { return P(j) && !inBook(p.id, j); }), off = list.filter(function (x) { return isOff(p.id, x.id); }).length;
    function line(x) { var l = thread(p.id, x.id).pop(); return l ? esc((l.who === p.id && !l.sys ? he + '：' : '') + l.text) : '还没聊过 · ' + who(x); }
    function row(x) { var l = thread(p.id, x.id).pop(), o = isOff(p.id, x.id);
      return '<div class="swipe' + (o ? ' off' : '') + '"><div class="swipe-act"><button class="sa ' + (o ? 'on' : 'pause') + '" data-do="phoff" data-id="' + x.id + '">' + (o ? '启用' : '禁用') + '</button><button class="sa del" data-do="phdel" data-id="' + x.id + '">删除</button></div>' +
        cell({ k: 'pcard', id: p.id, w: x.id }, x.id, esc(x.name) + (x.kind === 'outside' ? '<em>公司外</em>' : '') + (o ? '<em class="offtag">已禁用</em>' : ''), line(x), l ? hhmm(l.ts) : '') + '</div>'; }
    return '<div class="body list' + (ui.edit ? ' editing' : '') + '"><p class="count">' + list.length + ' 位联系人' + (off ? '，' + off + ' 位已禁用' : '') + (list.length ? ' · 左滑可以禁用或删除' : '') + '</p>' + (list.length ? list.map(row).join('') : '<p class="empty">通讯录是空的。点右上角 ⊕ 添加联系人。</p>') +
      (gone.length ? '<p class="count">聊过，但不在通讯录里了</p>' + gone.map(function (j) { var x = P(j), l = thread(p.id, j).pop(); return cell({ k: 'pcard', id: p.id, w: j }, j, esc(x.name), line(x), l ? hhmm(l.ts) : ''); }).join('') : '') +
      '<p class="foot">' + he + '的通讯录里有谁，' + he + '就能联系谁；禁用了就暂时联系不上。这是单向的：' + he + '能联系对方，不代表对方能联系' + he + '。</p></div>';
  }
  function pPc(p) {
    var w = running(p.id), envT = T(p.env), list = db.changes.filter(function (e) { return e.who === p.id; }).sort(function (a, b) { return b.ts - a.ts; });
    var envs = db.tools.filter(function (t) { return t.kind !== 'account'; }), accs = db.tools.filter(function (t) { return t.kind === 'account'; });
    return '<div class="body">' +
      sec('在做什么', w ? '<div class="doing"><i></i>' + esc(w.text) + '</div><p class="cap">' + esc(ago(w.ts)) + '开始' + (envT ? '，在' + esc(envT.name) + '上' : '') + '</p><div class="inl"><button class="btn danger" data-do="stop" data-id="' + w.id + '" data-confirm="再点一次，让他停下">让他停下</button></div>' : none(envT ? '他现在没在做事。' : '他还没有电脑，现在只能发消息。')) +
      sec('做过的改动', list.length ? list.map(function (e) { return '<div class="fxrow"><time>' + hhmm(e.ts) + '</time>' + changeCard(e) + '</div>'; }).join('') : none('他还没有在外面做过什么。'), list.length ? '他用工具在外面做的事。做了就是做了，不能撤回。' : '') +
      '<form data-do="role">' + sec('岗位', '<label class="fld"><span>名字</span><input id="rname" value="' + esc(p.name) + '" autocomplete="off"></label><label class="fld"><span>岗位</span><input id="rrole" value="' + esc(p.role) + '" autocomplete="off" placeholder="例如：项目交付"></label><label class="fld col"><span>做事说明</span><textarea id="rhowto" rows="4" aria-label="做事说明" placeholder="告诉他这个岗位该怎么做事">' + esc(p.howto) + '</textarea></label><div class="inl"><button class="btn ok">保存</button></div>', '他按这个做事。') + '</form>' +
      sec('他用哪台电脑', '<label class="fld"><span>用</span><select data-sw="env"><option value="">没有</option>' + ['pc', 'cloud'].map(function (k) { return '<optgroup label="' + ENV[k] + '">' + envs.filter(function (t) { return t.kind === k; }).map(function (t) { return '<option value="' + t.id + '"' + (p.env === t.id ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('') + '</optgroup>'; }).join('') + '</select></label>' +
        '<form class="inl" data-do="tool" data-k="env"><select aria-label="哪种"><option value="pc">电脑</option><option value="cloud">云环境</option></select><input autocomplete="off" placeholder="添加一个新的给他" aria-label="名字"><button class="btn">添加</button></form>', '他在哪儿干活：一台电脑，或者一个云环境。') +
      sec('他能用的账号', (accs.length ? '<div class="chips">' + accs.map(function (t) { return '<label class="chip ck"><input type="checkbox" data-sw="acc" data-id="' + t.id + '"' + (p.accounts.indexOf(t.id) >= 0 ? ' checked' : '') + '>' + esc(t.name) + '</label>'; }).join('') + '</div>' : '') +
        '<form class="inl" data-do="tool" data-k="account"><input autocomplete="off" placeholder="添加一个账号给他，例如：飞书" aria-label="账号名"><button class="btn">添加</button></form>', '飞书、邮箱、网盘这些。') + '<button type="button" class="lrow danger" data-do="drop" data-confirm="再点一次，确定让他离开">让他离开</button></div>';
  }
  /* 我：他是谁、做事说明 */
  /* 联系人：你们俩的聊天记录（只读），底下管他在不在通讯录里 */
  /* 联系人：顶部名片，中间你们俩的聊天记录（只读），底部一组 iOS 设置：允许联系的开关、删除 */
  function pCard(p, w) { var x = P(w), he = p.id === 'me' ? '你' : '他', book = inBook(p.id, w), on = book && !isOff(p.id, w), tr = thread(p.id, w);
    return '<div class="phone">' + phoneTop(p, x.name) + '<div class="body chat" id="chat"><div class="mini">' + av(w) + '<span><b>' + esc(x.name) + '</b><i>' + who(x) + ' · ' + (!book ? '不在' + he + '的通讯录里' : on ? '在' + he + '的通讯录里' : '在' + he + '的通讯录里，已禁用') + '</i></span></div>' +
      (tr.length ? bubbles(tr, p.id) : '<p class="when">还没聊过</p>') + (p.id === 'me' ? '' : '<p class="when">聊天记录只能看，不能替他回</p>') + '</div>' +
      '<div class="actsheet">' + (book ? '<label class="row-sw"><span>允许' + he + '联系' + esc(x.name) + '</span><span class="switch"><input type="checkbox" role="switch" data-sw="off" data-a="' + p.id + '" data-b="' + w + '"' + (on ? ' checked' : '') + '><i></i></span></label>' +
          (p.id === 'me' && on ? '<button class="row-btn"' + link({ k: 'chat', id: w }) + '>发消息</button>' : '') + '<button class="row-btn danger" data-do="phdel" data-id="' + w + '">删除联系人</button>'
        : '<button class="row-btn" data-do="phadd" data-id="' + w + '">添加到通讯录</button>') + '</div></div>'; }
  function pAdd(p) { var he = p.id === 'me' ? '你' : '他', list = pool(p).filter(function (x) { return !inBook(p.id, x.id); });
    return '<div class="phone">' + phoneTop(p, '添加联系人') + '<div class="body list">' + (list.length ? list.map(function (x) { return '<div class="cell">' + av(x.id) + '<span class="t"><b>' + esc(x.name) + '</b><span>' + who(x) + '</span></span><button class="btn ok sm" data-do="phadd" data-id="' + x.id + '">添加</button></div>'; }).join('') : '<p class="empty">公司里的人都已经在' + he + '的通讯录里了。</p>') + '</div></div>'; }
  function outside(o) { return nav('') + '<div class="who">' + av(o.id) + '<span class="t"><b>' + esc(o.name) + '</b><span>公司外的人</span></span></div>' + outsideBody(o); }
  function outsideBody(o) {
    var who = db.people.filter(function (x) { return canTalk(x.id, o.id); }).map(function (x) { return x.id; });
    return '<div class="body">' + sec('谁能联系' + esc(o.name), who.length ? who.map(function (j) { return cell(person(j), j, esc(N(j)), esc(P(j).role || '')); }).join('') : none('现在没有人能联系他。'), '在员工的「能联系谁」里勾上' + esc(o.name) + '。') +
      '<button class="lrow danger" data-do="dropout" data-id="' + o.id + '" data-confirm="再点一次，确定移走">从通讯录移走</button></div>';
  }
  function recruit() {
    var used = db.people.map(function (x) { return x.name; }), free = NAMES.filter(function (n) { return used.indexOf(n) < 0; })[0] || '新同事';
    return nav('招募') + '<form class="body" data-do="add"><p class="cap">选一个岗位就能招，名字和做事说明都可以以后再改。</p>' +
      sec('岗位', '<div class="chips">' + ROLES.map(function (r, i) { return '<button type="button" class="chip" data-do="preset" data-id="' + i + '">' + r[0] + '</button>'; }).join('') + '</div><label class="fld"><span>岗位</span><input id="nrole" autocomplete="off" placeholder="选上面的，或者自己写"></label>') +
      sec('他是谁', '<label class="fld"><span>名字</span><input id="nname" autocomplete="off" value="' + esc(free) + '"></label>', '入职后，你和他互相能联系。他还能联系谁，在他的「联系」里勾。') +
      sec('做事说明', '<label class="fld col"><textarea id="nhowto" rows="4" aria-label="做事说明" placeholder="告诉他这个岗位该怎么做事。不填就按岗位给一段最基本的。"></textarea></label>') +
      '<div class="acts"><button class="btn ok wide">招募</button></div></form>';
  }
  function newOut() {
    return nav('添加公司外的人') + '<form class="body" data-do="addout">' + sec('他是谁', '<label class="fld"><span>名字</span><input id="oname" autocomplete="off" placeholder="例如：供应商老秦"></label>', '添加后，在员工的「能联系谁」里勾上他，那个员工就能联系他。') + '<div class="acts"><button class="btn ok wide">添加</button></div></form>';
  }
  function draw() {
    var t = top(), view = $('view'), b = view.querySelector('.pane.r .body') || view.querySelector('.body'), keep = b ? b.scrollTop : 0, key = JSON.stringify(t || ui.tab), same = view.getAttribute('data-key') === key;
    if (t && t.k === 'chat') markRead(t.id);
    while (t && ((t.id && !P(t.id)) || (t.w && !P(t.w)))) { ui.stack.pop(); t = top(); }
    var tp = t && P(t.id), office = !t && ui.tab === 'office', page = !t ? '' : t.k === 'chat' ? chat(tp) : t.k === 'person' ? (tp.kind === 'outside' ? outside(tp) : phone(tp, t)) : t.k === 'pcard' ? pCard(tp, t.w) : t.k === 'padd' ? pAdd(tp) : t.k === 'newout' ? newOut() : recruit(), root = ui.tab === 'chats' ? chats() : ui.tab === 'people' ? people() : '';
    view.classList.toggle('split', wide());
    view.innerHTML = wide() ? '<div class="pane l">' + root + '</div><div class="pane r">' + (page || '<p class="blank">选一个人</p>') + '</div>' : t ? page : root;
    if (wide() && t) Array.prototype.forEach.call(view.querySelectorAll('.pane.l [data-go]'), function (el) { var g = JSON.parse(el.getAttribute('data-go')); el.classList.toggle('on', !!g.id && g.id === t.id); });
    view.setAttribute('data-key', key); view.hidden = office; $('office').hidden = !office; $('card').innerHTML = office ? card() : '';
    var n = unread().length; $('tabbar').hidden = !!t && !wide(); $('tabbar').innerHTML = TABBAR.map(function (x) { return '<button data-do="tab" data-id="' + x[0] + '" aria-current="' + (ui.tab === x[0] ? 'page' : 'false') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + x[2] + '</svg>' + x[1] + (x[0] === 'chats' && n ? '<i class="badge">' + n + '</i>' : '') + '</button>'; }).join('');
    var nb = view.querySelector('.pane.r .body') || view.querySelector('.body'); if (nb && same) nb.scrollTop = keep; var c = $('chat'); if (c && !same) c.scrollTop = c.scrollHeight;
    if (office && has3d) window.Office.resize();
  }
  function changed() { save(); sync(); view0(); }
  function view0() { $('view').removeAttribute('data-key'); draw(); }

  var DO = {
    tab: function (el) { ui.tab = el.getAttribute('data-id'); ui.stack = []; draw(); },
    back: function () { ui.stack.pop(); ui.edit = false; draw(); },
    see: function (el) { ui.stack = []; ui.tab = 'office'; draw(); pick(el.getAttribute('data-id')); },
    phadd: function (el) { var p = cur(); if (!p) return; setGrant(p.id, el.getAttribute('data-id'), 'talk', true); changed(); },
    phdel: function (el) { var p = cur(); if (!p) return; setGrant(p.id, el.getAttribute('data-id'), 'talk', false); changed(); },
    phoff: function (el) { var p = cur(), w = el.getAttribute('data-id'); if (!p) return; setOff(p.id, w, !isOff(p.id, w)); changed(); },
    edit: function () { ui.edit = !ui.edit; draw(); },
    say: function () { var v = $('say').value.trim(), p = cur(); if (!v || !p || !canTalk('me', p.id)) return; db.msgs.push({ id: uid('m'), ts: Date.now(), who: 'me', to: p.id, text: v }); changed(); $('say').focus(); },
    stop: function (el) { var w = db.work.filter(function (x) { return x.id === el.getAttribute('data-id'); })[0], p = cur(); if (!w || !p) return; w.state = 'stopped'; db.msgs.push({ id: uid('m'), ts: Date.now(), who: 'me', to: w.who, sys: true, text: '你让' + N(w.who) + '停下了：' + w.text + '。已经做了的改动还在。' }); changed(); },
    tool: function (f) { var p = cur(), v = f.querySelector('input').value.trim(), k = f.getAttribute('data-k'); if (!v || !p) return; var kind = k === 'env' ? f.querySelector('select').value : 'account', t = { id: uid('t'), kind: kind, name: v }; db.tools.push(t); if (k === 'env') p.env = t.id; else p.accounts.push(t.id); changed(); },
    role: function () { var p = cur(); if (!p) return; p.name = $('rname').value.trim() || p.name; p.role = $('rrole').value.trim(); p.howto = $('rhowto').value.trim(); changed(); },
    drop: function () { var p = cur(); if (!p) return; remove(p.id); ui.tab = 'people'; changed(); },
    dropout: function (el) { remove(el.getAttribute('data-id')); changed(); },
    preset: function (el) { Array.prototype.forEach.call(el.parentNode.children, function (b) { b.classList.toggle('on', b === el); }); var r = ROLES[+el.getAttribute('data-id')]; $('nrole').value = r[0]; $('nhowto').value = r[1]; },
    add: function () { var name = $('nname').value.trim() || $('nname').defaultValue, role = $('nrole').value.trim(), howto = $('nhowto').value.trim();
      if (!howto && role) howto = '你负责' + role + '。拿不准的先问老板，办完告诉交办的人。';
      var p = { id: uid('p'), kind: 'bot', name: name, role: role, howto: howto, env: null, accounts: [], look: db.n }; db.people.push(p); defaults(db, p.id);
      db.msgs.push({ id: uid('m'), ts: Date.now(), who: 'me', to: p.id, sys: true, text: name + '入职了。现在可以对他说要办什么。' });
      ui.stack = [canTalk('me', p.id) ? { k: 'chat', id: p.id } : person(p.id)]; ui.tab = canTalk('me', p.id) ? 'chats' : 'people'; changed(); },
    addout: function () { var name = $('oname').value.trim(); if (!name) { $('oname').focus(); return; } var o = { id: uid('o'), kind: 'outside', name: name, look: 0 }; db.people.push(o); ui.stack = [person(o.id)]; changed(); },
    clear: function () { db = blank(); ui.sel = null; ui.stack = []; changed(); },
    sample: function () { db = sample(); ui.sel = null; ui.stack = []; changed(); }
  };
  function remove(id) { db.people = db.people.filter(function (x) { return x.id !== id; }); db.grants = db.grants.filter(function (g) { return g.from !== id && g.to !== id; }); db.msgs = db.msgs.filter(function (m) { return m.who !== id && m.to !== id; }); db.work = db.work.filter(function (w) { return w.who !== id; }); if (ui.sel === id) ui.sel = null; ui.stack = []; }
  var SW = {
    reach: function (el) { setGrant(el.getAttribute('data-a'), el.getAttribute('data-b'), 'talk', el.checked); changed(); },
    off: function (el) { setOff(el.getAttribute('data-a'), el.getAttribute('data-b'), !el.checked); changed(); },
    acc: function (el, p) { var id = el.getAttribute('data-id'); p.accounts = p.accounts.filter(function (j) { return j !== id; }); if (el.checked) p.accounts.push(id); changed(); },
    env: function (el, p) { p.env = el.value || null; changed(); }
  };

  document.addEventListener('click', function (e) {
    if (swallow) { swallow = false; e.preventDefault(); return; }
    var opened = document.querySelector('.swipe.open'); if (opened && !e.target.closest('.swipe-act')) { opened.classList.remove('open'); e.preventDefault(); return; } /* 有一行滑开着：先收起来 */
    var t = e.target.closest('[data-tab]'); if (t && top()) { top().tab = t.getAttribute('data-tab'); ui.edit = false; draw(); return; }
    var g = e.target.closest('[data-go]'); if (g) { if (wide() && g.closest('.pane.l')) ui.stack = []; go(JSON.parse(g.getAttribute('data-go'))); return; }
    var d = e.target.closest('button[data-do]'); if (!d) return; e.preventDefault();
    /* 删除、停下这类做了就收不回的操作：在原位点两下确认，不弹窗 */
    if (d.hasAttribute('data-confirm') && !d.hasAttribute('data-armed')) { d.setAttribute('data-armed', d.textContent); d.textContent = d.getAttribute('data-confirm'); d.classList.add('armed'); setTimeout(function () { if (d.isConnected && d.hasAttribute('data-armed')) { d.textContent = d.getAttribute('data-armed'); d.removeAttribute('data-armed'); d.classList.remove('armed'); } }, 4000); return; }
    DO[d.getAttribute('data-do')](d);
  });
  /* 左滑：手指或鼠标横着拖一行，松手超过一半就停在打开的位置；竖着拖照常滚动 */
  var sw = null, swallow = false, OPEN = 160;
  document.addEventListener('pointerdown', function (e) { var c = e.target.closest('.swipe > .cell'); if (!c || e.button > 0) return; sw = { row: c.parentNode, cell: c, x: e.clientX, y: e.clientY, base: c.parentNode.classList.contains('open') ? -OPEN : 0, dx: 0, on: false }; });
  document.addEventListener('pointermove', function (e) { if (!sw) return; var dx = e.clientX - sw.x, dy = e.clientY - sw.y;
    if (!sw.on) { if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { sw = null; return; } if (Math.abs(dx) < 8) return; sw.on = true; sw.row.classList.add('drag'); Array.prototype.forEach.call(document.querySelectorAll('.swipe.open'), function (r) { if (r !== sw.row) r.classList.remove('open'); }); }
    sw.dx = dx; sw.cell.style.transform = 'translateX(' + Math.max(-OPEN - 40, Math.min(0, sw.base + dx)) + 'px)'; });
  function swEnd() { if (!sw) return; if (sw.on) { sw.row.classList.remove('drag'); sw.cell.style.transform = ''; sw.row.classList.toggle('open', sw.base + sw.dx < -OPEN / 2); swallow = true; setTimeout(function () { swallow = false; }, 350); } sw = null; }
  document.addEventListener('pointerup', swEnd); document.addEventListener('pointercancel', swEnd);
  document.addEventListener('submit', function (e) { var f = e.target.closest('form[data-do]'); if (f) { e.preventDefault(); DO[f.getAttribute('data-do')](f); } });
  document.addEventListener('change', function (e) { var el = e.target.closest('[data-sw]'), p = cur(); if (!el) return; var k = el.getAttribute('data-sw'); if (k !== 'reach' && !p) return; SW[k](el, p); });

  has3d = !!(window.Office && window.Office.init($('stage'), $('labels'), pick));
  if (!has3d) $('fail').hidden = false;
  if (wideMq.addEventListener) wideMq.addEventListener('change', function () { draw(); });
  draw(); sync();
  window.__app = { pick: pick, go: go, db: function () { return db; }, canTalk: canTalk, inBook: inBook };
})();
