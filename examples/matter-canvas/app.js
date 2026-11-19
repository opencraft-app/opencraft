/* 老板管理 Bot 员工。结构是微信那一套：底部三个标签，点进去是整页。
   消息：老板自己的手机，直属下属的对话列表，招募从这里发起。通讯录：所有人，进去看资料。办公室：三维画面（scene.js），只占这一个标签。
   员工资料三个页签：手机（他在联系谁 / 他能联系谁）、电脑（他在做什么 / 他能做什么）、岗位。
   这是结构原型，没有接真实的 Bot：你发出去的话不会有人回。示例内容是一份静态快照，清空后各处如实显示为空。 */
(function () {
  'use strict';
  var KEY = 'opencraft.matter-canvas.v9', $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var KIND = { pc: ['电脑', '台', '他在哪台机器上干活', '添加一台，例如：办公室的 Mac mini'], env: ['云环境', '个', '给他一个单独的环境，试东西不会碰到正式的', '添加一个，例如：测试环境'], conn: ['连接器', '个', '他能用的账号，比如飞书、邮箱、网盘', '添加一个，例如：飞书'] };
  /* 招募时的常见岗位：点一下就填好岗位和一段岗位提示，不用从空白写起 */
  var ROLES = [['客服', '你负责回答客户的问题。答不了的记下来，转给{boss}。'], ['采购', '你负责买东西、订场地。超过预算先问{boss}。'], ['对账', '你核对每一笔账和发票是否对得上，对不上的列出来交给{boss}。'], ['文档核对', '你只做核对：版本、页码、签章。核完写清楚看的是哪一份、结论是什么。'], ['行政', '你负责开账号、订会议室、收报销单。办完告诉交办的人。']];
  var NAMES = ['青柚', '白榆', '半夏', '南星', '远山', '知秋', '云杉', '松果', '小满', '若木'];
  var TABS = [['talk', '对话'], ['phone', '手机'], ['pc', '电脑'], ['role', '岗位']];

  function blank() { return { people: [], outs: [], msgs: [], fx: [], res: { pc: [], env: [], conn: [] }, n: 0, sample: false }; }
  function sample() { /* 一家小工作室老板眼里的某个下午 */
    var d = blank(), now = Date.now(), look = 0;
    [['pc', 'r1', '办公室的 Mac mini'], ['pc', 'r2', '机房的 Linux 主机'], ['env', 'r3', '测试环境'], ['env', 'r4', '客户演示环境'], ['conn', 'r5', '飞书'], ['conn', 'r6', '企业邮箱'], ['conn', 'r7', 'GitHub'], ['conn', 'r8', '公司网盘']].forEach(function (r) { d.res[r[0]].push({ id: r[1], name: r[2] }); });
    d.outs.push({ id: 'o1', name: '客户周姐' });
    function person(id, name, role, boss, prompt, pc, env, conn, reach, doing) { d.people.push({ id: id, name: name, role: role, boss: boss, prompt: prompt, pc: pc, env: env, conn: conn, reach: reach, doing: doing || '', look: look++ }); }
    person('a', '阿岚', '项目交付', 'me', '你负责把版本按时交到客户手里。缺什么材料自己找同事要，拿不准的事先问老板。交付前一定让人核对签字页。', 'r1', 'r4', ['r5', 'r6', 'r8'], ['y', 'o1'], '');
    person('y', '言禾', '合同与验收', 'me', '你保管合同和验收文件。别人来要文件，先确认是哪个版本，再给盖章的那一份。', 'r1', null, ['r5', 'r8'], ['a', 'c'], '');
    person('c', '沐川', '行政与账号', 'me', '你负责开账号、订会议室、收报销单。办完告诉交办的人。', 'r2', null, ['r5', 'r6', 'r7'], ['y'], '在企业邮箱里翻 10 月的报销邮件，一封封登记到表里');
    person('z', '小折', '文档核对', 'a', '你只做核对：版本、页码、签章。核完写清楚看的是哪一份、结论是什么。', 'r2', 'r3', ['r8'], [], '');
    person('t', '秋池', '对账', 'c', '你核对每一笔报销和发票是否对得上，对不上的列出来交给沐川。', null, null, ['r6'], [], '');
    person('n', '北野', '采购', 'c', '你负责买办公用品和订场地。超过预算先问沐川。', null, null, [], ['t'], '');
    function msg(min, from, to, text, more) { d.msgs.push(Object.assign({ id: 'm' + d.msgs.length, ts: now - min * 60000, who: from, to: to, text: text, read: true }, more || {})); }
    /* 副作用：他用电脑、云环境或连接器在外面留下的改动。不是交给谁的东西，只是做事留下的痕迹 */
    function fx(id, min, who, via, what, name, body) { d.fx.push({ id: id, ts: now - min * 60000, who: who, via: via, what: what, name: name, body: body || '' }); }
    fx('e1', 172, 'c', 'r5', '订了会议室', '周三 14:00–16:00 大会议室，借了投影');
    fx('e2', 62, 'y', 'r8', '共享了文件', '验收签字页（两份附件），共享给阿岚');
    fx('e3', 31, 'z', 'r8', '新建了文件', '签字页核对记录', '看了两份附件。\n第 2 页那份没有盖章，是草稿。\n第 3 页那份有客户公章，版本号 2.3。');
    fx('e4', 24, 'c', 'r6', '开了账号', '新同事的邮箱');
    fx('e5', 23, 'c', 'r5', '开了账号', '新同事的飞书');
    fx('e6', 18, 'a', 'r8', '新建了文件', '2.3 版本签字页核对单', '盖章的是第 3 页那一份。\n版本号 2.3，和交付清单一致。\n核对人：小折。\n交付包里的三样都齐了：安装包、测试回执、验收签字页。');
    fx('e7', 4, 'c', 'r8', '改了表格', '10 月报销登记表：新增 23 行');
    msg(200, 'me', 'c', '周三下午客户来访，订个大会议室，要能投影。'); msg(170, 'c', 'me', '周三下午 2 点到 4 点的大会议室订好了，投影也借了。', { fx: ['e1'] });
    msg(94, 'me', 'a', '周五要把 2.3 版本交给客户，你来负责。缺什么自己找人。');
    msg(80, 'a', 'y', '言禾，客户盖章的验收签字页在你那吗？周五交付要用。'); msg(62, 'y', 'a', '在，共享给你了。有两个附件页码不一样，盖章的是其中一份，你最好找人核一下。', { fx: ['e2'] });
    msg(55, 'a', 'z', '帮我核一下这两份签字页：哪份是盖章的，版本对不对。'); msg(30, 'z', 'a', '核完了。盖章的是第 3 页那份，版本 2.3，和交付清单一致。记录放网盘了。', { fx: ['e3'] });
    msg(26, 'a', 'o1', '周姐，2.3 版本周五上午发您，签字页我们已经核对过了。');
    msg(49, 'me', 'c', '下周一有新同事入职，账号提前开好。'); msg(22, 'c', 'me', '邮箱和飞书开好了。GitHub 要等他把用户名发我，我已经问了。', { fx: ['e4', 'e5'] });
    msg(17, 'a', 'me', '签字页核对好了，交付包齐了，核对单放在网盘。你没意见的话，我周五上午发给客户。', { fx: ['e6'], read: false });
    msg(40, 'me', 'c', '把 10 月的报销单整理一下，周五前给我。'); msg(12, 'c', 't', '10 月的报销我登记到一半，登完发你对账。');
    d.n = 100; d.sample = true; return d;
  }
  var db = sample();
  try { var raw = JSON.parse(localStorage.getItem(KEY)); if (raw && raw.people && raw.msgs && raw.v === 4) db = raw; } catch (e) { /* 没有存储也能用 */ }
  function save() { db.v = 4; try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ } }
  function uid(p) { db.n += 1; return p + db.n; }
  function P(id) { return db.people.filter(function (x) { return x.id === id; })[0]; }
  function O(id) { return db.outs.filter(function (x) { return x.id === id; })[0]; }
  function N(id) { return id === 'me' ? '你' : (P(id) || O(id) || {}).name || '已移出的人'; }
  function R(k, id) { return db.res[k].filter(function (x) { return x.id === id; })[0]; }
  function thread(a, b) { return db.msgs.filter(function (x) { return (x.who === a && x.to === b) || (x.who === b && x.to === a); }).sort(function (x, y) { return x.ts - y.ts; }); }
  function partners(id) { var o = []; db.msgs.slice().sort(function (x, y) { return y.ts - x.ts; }).forEach(function (x) { var p = x.who === id ? x.to : x.to === id ? x.who : null; if (p && o.indexOf(p) < 0) o.push(p); }); return o; }
  function kin(id) { var p = P(id), o = []; if (p && p.boss) o.push(p.boss); db.people.forEach(function (x) { if (x.boss === id) o.push(x.id); }); return o; } /* 上级和直接下属：归谁管就总能联系 */
  function below(id) { var o = []; db.people.forEach(function (x) { if (x.boss === id) o.push(x.id); }); o.slice().forEach(function (j) { o = o.concat(below(j)); }); return o; }
  function reachers(id) { var o = kin(id); db.people.forEach(function (x) { if (x.id !== id && x.reach.indexOf(id) >= 0 && o.indexOf(x.id) < 0) o.push(x.id); }); return o; } /* 谁能主动找他 */
  function canTalk(id, j) { return kin(id).indexOf(j) >= 0 || ((P(id) || {}).reach || []).indexOf(j) >= 0; }
  function unread(id) { return db.msgs.filter(function (x) { return x.to === 'me' && !x.read && (!id || x.who === id); }); } /* 红点就是没看过的消息，和微信一样 */
  function markRead(id) { var n = 0; db.msgs.forEach(function (x) { if (x.to === 'me' && x.who === id && !x.read) { x.read = true; n++; } }); if (n) { save(); sync(); } }
  function F(id) { return (db.fx || []).filter(function (x) { return x.id === id; })[0]; }
  function hhmm(ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }

  /* ---------- 界面：微信的结构。三个标签（消息、通讯录、办公室），点进去是整页，左上角返回。 ---------- */
  var TABBAR = [['chats', '消息', '<path d="M12 4.500c-4.700 0-8.500 3.100-8.500 7 0 2.200 1.200 4.100 3.100 5.400L6 20l3.400-1.600c.8.200 1.700.300 2.600.300 4.700 0 8.500-3.100 8.500-7s-3.800-7.200-8.500-7.200z"/>'], ['people', '通讯录', '<circle cx="9" cy="9" r="3.200"/><path d="M3.500 19c.6-3 2.800-4.800 5.500-4.800s4.900 1.800 5.500 4.800M16 6.500a2.800 2.800 0 0 1 0 5.400M17.500 14.600c1.600.7 2.700 2.200 3 4.400"/>'], ['office', '办公室', '<path d="M12 3.500 4 8v8l8 4.500 8-4.500V8z"/><path d="M4 8l8 4.500L20 8M12 12.500v8"/>']];
  var AVC = ['#a9dcc9', '#c3b5ee', '#a9c8f2', '#fbe39c', '#f9cdb0', '#bfe3ee', '#d9e8a6'];
  var ui = { tab: 'chats', stack: [], sel: null, sub: null }, has3d = false;
  function top() { return ui.stack[ui.stack.length - 1]; }
  function cur() { var t = top(); return t && (t.k === 'chat' || t.k === 'profile') ? P(t.id) : null; }
  function reachOf(id) { var p = P(id), o = kin(id); if (p) p.reach.forEach(function (j) { if (o.indexOf(j) < 0) o.push(j); }); return o; }
  function toScene() {
    var nodes = [{ id: 'me', name: '你', kind: 'me' }], links = [], boss = [];
    db.people.forEach(function (p) { nodes.push({ id: p.id, name: p.name, kind: 'bot', look: p.look, badge: unread(p.id).length, busy: !!p.doing, pc: !!(p.pc || p.env) }); boss.push([p.boss, p.id]); links.push([p.boss, p.id]); p.reach.forEach(function (j) { if (P(j) || O(j)) links.push([p.id, j]); }); });
    db.outs.forEach(function (o) { nodes.push({ id: o.id, name: o.name, kind: 'out' }); });
    return { nodes: nodes, links: links, boss: boss };
  }
  function sync() { if (has3d) { window.Office.sync(toScene()); window.Office.select(ui.sel, ui.sel ? reachOf(ui.sel) : [], ui.sel ? reachers(ui.sel) : []); } }
  function pick(id) { if (id && id !== 'me' && !P(id) && !O(id)) id = null; ui.sel = id; if (has3d) window.Office.select(id, id ? reachOf(id) : [], id ? reachers(id) : []); draw(); }
  function go(page) { ui.sub = null; var prev = ui.stack[ui.stack.length - 2]; if (prev && prev.id === page.id && prev.k === page.k) ui.stack.pop(); else ui.stack.push(page); draw(); } /* 对话和资料来回点，不越叠越深 */

  function av(id, n) { var p = P(id); return '<span class="av" style="--c:' + (id === 'me' ? '#e9e6f0' : p ? AVC[(p.look || 0) % AVC.length] : '#f6c1c7') + '">' + (n ? '<i class="badge">' + n + '</i>' : '') + '</span>'; }
  var ICON = { plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>', more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>', back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14.500 5-7 7 7 7"/></svg>', go: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.500 5 7 7-7 7"/></svg>' };
  function nav(title, right) { return '<header class="nav"><button class="back" data-do="back" aria-label="返回">' + ICON.back + '</button><h1>' + esc(title) + '</h1><span class="r">' + (right || '') + '</span></header>'; }
  function sec(cls, title, body) { return '<section class="sec ' + cls + '"><h3>' + title + '</h3><div class="grp">' + body + '</div></section>'; }
  function none(t) { return '<p class="none">' + t + '</p>'; }
  function cell(page, id, title, sub, right, n) { return '<button class="cell" data-go=\'' + esc(JSON.stringify(page)) + '\'>' + av(id, n) + '<span class="t"><b>' + title + '</b>' + (sub ? '<span>' + sub + '</span>' : '') + '</span>' + (right ? '<span class="rt">' + right + '</span>' : '') + '</button>'; }
  function bubble(m, self) { if (m.sys) return '<p class="when">' + esc(m.text) + '</p>'; var mine = m.who === self;
    return '<div class="msg' + (mine ? ' out' : '') + '">' + av(m.who) + '<div class="mb">' + (!mine && self !== 'me' ? '<span class="nm">' + esc(N(m.who)) + '</span>' : '') + '<div class="bub">' + esc(m.text) + '</div>' +
      (m.fx || []).map(function (id) { var e = F(id); return e ? fxCard(e) : ''; }).join('') + '</div></div>'; }
  function fxCard(e) { var r = R('pc', e.via) || R('env', e.via) || R('conn', e.via);
    return (e.body ? '<details class="file">' : '<div class="file">') + '<' + (e.body ? 'summary' : 'div class="fs"') + '><span><b>' + esc(e.name) + '</b><i>' + esc(N(e.who) + (r ? '在' + r.name : '') + e.what) + '</i></span><span class="fi" aria-hidden="true">' + esc(r ? r.name.slice(0, 1) : '改') + '</span></' + (e.body ? 'summary' : 'div') + '>' + (e.body ? '<pre>' + esc(e.body) + '</pre></details>' : '</div>'); }
  function bubbles(list, self) { var prev = 0; return list.map(function (m) { var gap = m.ts - prev > 5 * 60000; prev = m.ts; return (gap && !m.sys ? '<p class="when">' + hhmm(m.ts) + '</p>' : '') + bubble(m, self); }).join(''); }

  /* 标签一：消息。老板自己的手机，只有直接归你管的人 */
  function chats() {
    var mine = db.people.filter(function (p) { return p.boss === 'me' || thread('me', p.id).length; });
    function last(p) { var l = thread('me', p.id).pop(); return l ? l.ts : 0; }
    mine.sort(function (a, b) { return (unread(b.id).length - unread(a.id).length) || (last(b) - last(a)); });
    return '<header class="nav top"><span class="r"></span><h1>消息' + (unread().length ? '(' + unread().length + ')' : '') + '</h1><span class="r"><button class="ic" data-go=\'{"k":"recruit"}\' aria-label="招募">' + ICON.plus + '</button></span></header><div class="body list">' + (mine.length ? mine.map(function (p) { var l = thread('me', p.id).pop(), n = unread(p.id).length;
      return cell({ k: 'chat', id: p.id }, p.id, esc(p.name) + '<em>' + esc(p.boss === 'me' ? p.role || '未填岗位' : '归' + N(p.boss) + '管') + '</em>', esc(l ? (l.who === 'me' && !l.sys ? '你：' : '') + l.text : '还没有说过话'), l ? hhmm(l.ts) : '', n); }).join('') : '<div class="empty"><p>手机里还没有人。</p><button class="btn ok" data-go=\'{"k":"recruit"}\'>招募第一位员工</button></div>') +
      '<p class="foot">这是原型，没有接真实的 Bot，你发出去的话不会有人回。<button class="lk" data-do="' + (db.sample ? 'clear">清空示例' : 'sample">放回示例') + '</button></p></div>';
  }
  /* 标签二：通讯录。所有人都在，管理从这里进 */
  function people() {
    var mine = db.people.filter(function (p) { return p.boss === 'me'; }), rest = db.people.filter(function (p) { return p.boss !== 'me'; });
    function rows(list) { return list.map(function (p) { return cell({ k: 'profile', id: p.id, tab: 'phone' }, p.id, esc(p.name), esc(p.role || '未填岗位'), p.boss === 'me' ? '' : '归' + esc(N(p.boss)) + '管'); }).join(''); }
    return '<header class="nav top"><span class="r"></span><h1>通讯录</h1><span class="r"></span></header><div class="body list"><button class="cell" data-go=\'{"k":"recruit"}\'><span class="av plus">+</span><span class="t"><b>招募</b><span>选个岗位，他就入职</span></span></button>' +
      (mine.length ? '<h4>直接归你管</h4>' + rows(mine) : '') + (rest.length ? '<h4>其他员工</h4>' + rows(rest) : '') + (db.outs.length ? '<h4>公司外的人</h4>' + db.outs.map(function (o) { return cell({ k: 'out', id: o.id }, o.id, esc(o.name), '公司外'); }).join('') : '') + (db.people.length ? '' : '<p class="empty">通讯录还是空的。</p>') + '</div>';
  }
  /* 标签三：办公室。三维画面在 .stage 里，这里只出底部那张卡片 */
  function card() {
    var id = ui.sel, p = P(id), o = O(id);
    if (!id) return '<p class="hint">点一个小家伙：彩色箭头是他能主动找的人，灰色箭头是能主动找他的人。</p>';
    if (id === 'me') return '<div class="pcard">' + av('me') + '<span class="t"><b>你</b><span>老板，不是员工，所以没有工位</span></span><button class="btn ok" data-do="tab" data-id="chats">看消息</button></div>';
    if (o) return '<div class="pcard">' + av(o.id) + '<span class="t"><b>' + esc(o.name) + '</b><span>公司外的人</span></span><button class="btn" data-go=\'' + esc(JSON.stringify({ k: 'out', id: o.id })) + '\'>查看</button></div>';
    return '<div class="pcard">' + av(p.id) + '<span class="t"><b>' + esc(p.name) + '</b><span>' + esc(p.role || '未填岗位') + ' · 归' + esc(N(p.boss)) + '管</span></span>' + (p.boss === 'me' ? '<button class="btn ok" data-go=\'' + esc(JSON.stringify({ k: 'chat', id: p.id })) + '\'>对话</button>' : '') + '<button class="btn" data-go=\'' + esc(JSON.stringify({ k: 'profile', id: p.id, tab: 'phone' })) + '\'>手机和电脑</button></div>';
  }

  /* 整页：对话 */
  function chat(p) { var t = thread('me', p.id);
    return nav(p.name, '<button class="ic" aria-label="资料" data-go=\'' + esc(JSON.stringify({ k: 'profile', id: p.id, tab: 'phone' })) + '\'>' + ICON.more + '</button>') + '<div class="body chat" id="chat">' + (t.length ? bubbles(t, 'me') : none('还没有对话。对他说第一件要办的事。')) + '</div>' + (p.boss === 'me' ? '<form class="say" data-do="say"><input id="say" autocomplete="off" enterkeyhint="send" placeholder="对' + esc(p.name) + '说要办什么" aria-label="对' + esc(p.name) + '说"><button class="btn ok">发送</button></form>' : '<p class="say cap">' + esc(p.name) + '现在归' + esc(N(p.boss)) + '管。以前的话还在，新的事请对' + esc(N(p.boss)) + '说。</p>'); }
  /* 整页：员工资料。手机 / 电脑 / 岗位 */
  function profile(p, page) {
    var body = ({ phone: phone, pc: pc, role: role })[page.tab](p);
    return nav('') + '<div class="who">' + av(p.id) + '<span class="t"><b>' + esc(p.name) + '</b><span>岗位：' + esc(p.role || '未填') + '</span><span>归' + esc(N(p.boss)) + '管</span></span></div><div class="links">' + (p.boss === 'me' || thread('me', p.id).length ? '<button class="lrow" data-go=\'' + esc(JSON.stringify({ k: 'chat', id: p.id })) + '\'>' + (p.boss === 'me' ? '发消息' : '看你们以前的对话') + '</button>' : '') + (p.boss === 'me' ? '' : '<span class="cap">他归' + esc(N(p.boss)) + '管，要交办事情请对' + esc(N(p.boss)) + '说。</span>') + '<button class="lrow" data-do="see" data-id="' + p.id + '">在办公室里看他</button></div>' +
      '<div class="tabs" role="tablist">' + [['phone', '手机'], ['pc', '电脑'], ['role', '岗位']].map(function (t) { return '<button role="tab" aria-selected="' + (page.tab === t[0]) + '" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>' + body;
  }
  function phone(p) {
    if (ui.sub) { var t = thread(p.id, ui.sub); return '<div class="body chat"><button class="lk" data-do="sub" data-id="">‹ 回到他的手机</button><p class="cap">' + esc(p.name) + ' 和 ' + esc(N(ui.sub)) + ' 的聊天记录（只读）</p>' + bubbles(t, p.id) + '</div>'; }
    var ps = partners(p.id), k = kin(p.id), all = db.people.filter(function (x) { return x.id !== p.id && k.indexOf(x.id) < 0; }).concat(db.outs);
    function tagOf(j) { return j === p.boss ? '<em>他的上级</em>' : k.indexOf(j) >= 0 ? '<em>他的下属</em>' : O(j) ? '<em>公司外</em>' : ''; }
    return '<div class="body">' + sec('mint', '他在联系谁', ps.length ? ps.map(function (j) { var l = thread(p.id, j).pop(); return '<button class="cell" data-do="sub" data-id="' + j + '">' + av(j) + '<span class="t"><b>' + esc(N(j)) + tagOf(j) + (canTalk(p.id, j) ? '' : canTalk(j, p.id) ? '<em>只能等对方来找</em>' : '<em>现在不能联系</em>') + '</b><span>' + esc((l.who === p.id && !l.sys ? '他：' : '') + l.text) + '</span></span><span class="rt">' + hhmm(l.ts) + '</span></button>'; }).join('') : none('他还没有联系过别人。')) +
      sec('mint', '他能主动联系谁', k.map(function (j) { return '<div class="sw fixed"><input type="checkbox" checked disabled><span>' + esc(N(j)) + tagOf(j) + '</span></div>'; }).join('') + (k.length ? '<p class="cap">上级和下属总能互相联系，不用勾。其余的人，勾上他才能主动找对方；对方能不能找他，要在对方那边勾。</p>' : '<p class="cap">勾上他才能主动找对方；对方能不能找他，要在对方那边勾。</p>') + (all.length ? all.map(function (x) { return '<label class="sw"><input type="checkbox" data-sw="reach" data-id="' + x.id + '"' + (p.reach.indexOf(x.id) >= 0 ? ' checked' : '') + '><span>' + esc(x.name) + (O(x.id) ? '<em>公司外</em>' : '') + '</span></label>'; }).join('') : none('还没有别人可以联系。')) +
        '<form class="inl" data-do="out"><input id="out" autocomplete="off" placeholder="加一位公司外的人，例如：客户周姐" aria-label="公司外的人"><button class="btn">添加</button></form><p class="cap">勾选后，办公室里他会自己挪到这些人附近。</p>') + sec('mint', '谁能主动联系他', (function () { var ins = reachers(p.id).filter(function (j) { return k.indexOf(j) < 0; }); return ins.length ? ins.map(function (j) { var mut = p.reach.indexOf(j) >= 0; return '<button class="cell" data-go=\'' + esc(JSON.stringify({ k: 'profile', id: j, tab: 'phone' })) + '\'>' + av(j) + '<span class="t"><b>' + esc(N(j)) + '</b><span>' + (mut ? '互相能联系' : '对方能找他，他不能主动找对方') + '</span></span></button>'; }).join('') : none('除了上级和下属，没有别人能主动找他。'); })()) + '</div>';
  }
  function pc(p) {
    var has = R('pc', p.pc) || R('env', p.env);
    function add(k) { return '<form class="inl" data-do="res" data-k="' + k + '"><input autocomplete="off" placeholder="' + KIND[k][3] + '" aria-label="添加' + KIND[k][0] + '"><button class="btn">添加</button></form>'; }
    function one(k) { return '<p class="cap">' + KIND[k][2] + '</p>' + (db.res[k].length ? '<label class="fld"><span>给他</span><select data-sw="' + k + '"><option value="">不给</option>' + db.res[k].map(function (r) { return '<option value="' + r.id + '"' + (p[k] === r.id ? ' selected' : '') + '>' + esc(r.name) + '</option>'; }).join('') + '</select></label>' : '') + add(k); }
    return '<div class="body">' + sec('', '他在做什么', p.doing ? '<div class="doing"><i></i>' + esc(p.doing) + '</div><p class="cap">用的是：' + esc([R('pc', p.pc), R('env', p.env)].filter(Boolean).map(function (r) { return r.name; }).join('、')) + '</p>' : none(has ? '他的电脑现在空着。' : '他还没有电脑，也没有云环境，现在只能用手机联系人。')) +
      sec('', '他留下的改动', (function () { var list = (db.fx || []).filter(function (e) { return e.who === p.id; }).sort(function (a, b) { return b.ts - a.ts; }); return list.length ? '<p class="cap">他用电脑和连接器做事时在外面留下的痕迹，不一定是交给谁的。</p>' + list.map(function (e) { return '<div class="fxrow"><time>' + hhmm(e.ts) + '</time>' + fxCard(e) + '</div>'; }).join('') : none('他还没有在外面动过什么。'); })()) +
      sec('', '电脑', one('pc')) + sec('', '云环境', one('env')) +
      sec('', '连接器', '<p class="cap">' + KIND.conn[2] + '</p>' + (db.res.conn.length ? '<div class="chips">' + db.res.conn.map(function (r) { return '<label class="chip ck"><input type="checkbox" data-sw="conn" data-id="' + r.id + '"' + (p.conn.indexOf(r.id) >= 0 ? ' checked' : '') + '>' + esc(r.name) + '</label>'; }).join('') + '</div>' : '') + add('conn')) + '</div>';
  }
  function role(p) {
    return '<form class="body" data-do="role"><label class="fld"><span>名字</span><input id="rname" value="' + esc(p.name) + '" autocomplete="off"></label><label class="fld"><span>岗位</span><input id="rrole" value="' + esc(p.role) + '" autocomplete="off" placeholder="例如：项目交付"></label><label class="fld"><span>归谁管</span><select id="rboss"><option value="me">你</option>' +
      db.people.filter(function (x) { return x.id !== p.id && below(p.id).indexOf(x.id) < 0; }).map(function (x) { return '<option value="' + x.id + '"' + (p.boss === x.id ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select></label><label class="fld col"><span>岗位提示</span><textarea id="rprompt" rows="5" placeholder="告诉他这个岗位该怎么做事">' + esc(p.prompt) + '</textarea></label><div class="acts"><button class="btn ok wide">保存</button></div><button type="button" class="lrow danger" data-do="drop">移出办公室</button></form>';
  }
  function outside(o) { var who = db.people.filter(function (p) { return p.reach.indexOf(o.id) >= 0; });
    return nav('') + '<div class="who">' + av(o.id) + '<span class="t"><b>' + esc(o.name) + '</b><span>公司外的人</span></span></div><div class="body">' + sec('mint', '谁能联系他', who.length ? who.map(function (p) { return cell({ k: 'profile', id: p.id, tab: 'phone' }, p.id, esc(p.name), esc(p.role || '未填岗位')); }).join('') : none('现在没有人能联系他。')) + '<button class="lrow danger" data-do="dropout" data-id="' + o.id + '">从通讯录移走</button></div>'; }
  function recruit() {
    var used = db.people.map(function (x) { return x.name; }), free = NAMES.filter(function (n) { return used.indexOf(n) < 0; })[0] || '新同事';
    return nav('招募') + '<form class="body" data-do="add"><p class="cap">选一个岗位就能招，名字和岗位提示都可以以后再改。</p>' +
      sec('', '岗位', '<div class="chips">' + ROLES.map(function (r, i) { return '<button type="button" class="chip" data-do="preset" data-id="' + i + '">' + r[0] + '</button>'; }).join('') + '</div><label class="fld"><span>岗位</span><input id="nrole" autocomplete="off" placeholder="选上面的，或者自己写"></label>') +
      sec('', '他是谁', '<label class="fld"><span>名字</span><input id="nname" autocomplete="off" value="' + esc(free) + '"></label><label class="fld"><span>归谁管</span><select id="nboss"><option value="me">你</option>' + db.people.map(function (x) { return '<option value="' + x.id + '">' + esc(x.name) + '</option>'; }).join('') + '</select></label>') +
      sec('', '岗位提示', '<label class="fld col"><textarea id="nprompt" rows="4" aria-label="岗位提示" placeholder="告诉他这个岗位该怎么做事。不填就按岗位给一段最基本的。"></textarea></label>') +
      '<div class="acts"><button class="btn ok wide">招募</button></div></form>';
  }
  function draw() {
    var t = top(), view = $('view'), b = view.querySelector('.body'), keep = b ? b.scrollTop : 0, key = JSON.stringify(t || ui.tab) + ui.sub, same = view.getAttribute('data-key') === key;
    if (t && t.k === 'chat') markRead(t.id);
    while (t && ((t.k === 'chat' || t.k === 'profile') && !P(t.id) || t.k === 'out' && !O(t.id))) { ui.stack.pop(); t = top(); }
    var office = !t && ui.tab === 'office';
    view.innerHTML = t ? (t.k === 'chat' ? chat(P(t.id)) : t.k === 'profile' ? profile(P(t.id), t) : t.k === 'out' ? outside(O(t.id)) : recruit()) : ui.tab === 'chats' ? chats() : ui.tab === 'people' ? people() : '';
    view.setAttribute('data-key', key); view.hidden = office; $('office').hidden = !office; $('card').innerHTML = office ? card() : '';
    var n = unread().length; $('tabbar').hidden = !!t; $('tabbar').innerHTML = TABBAR.map(function (x) { return '<button data-do="tab" data-id="' + x[0] + '" aria-current="' + (ui.tab === x[0] ? 'page' : 'false') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + x[2] + '</svg>' + x[1] + (x[0] === 'chats' && n ? '<i class="badge">' + n + '</i>' : '') + '</button>'; }).join('');
    var nb = view.querySelector('.body'); if (nb && same) nb.scrollTop = keep; var c = $('chat'); if (c && !same) c.scrollTop = c.scrollHeight;
    if (office && has3d) window.Office.resize();
  }

  var DO = {
    tab: function (el) { ui.tab = el.getAttribute('data-id'); ui.stack = []; draw(); },
    back: function () { if (ui.sub && top() && top().k === 'profile') ui.sub = null; else ui.stack.pop(); draw(); },
    see: function (el) { ui.stack = []; ui.tab = 'office'; draw(); pick(el.getAttribute('data-id')); },
    sub: function (el) { ui.sub = el.getAttribute('data-id') || null; draw(); },
    say: function () { var v = $('say').value.trim(), p = cur(); if (!v || !p || p.boss !== 'me') return; db.msgs.push({ id: uid('m'), ts: Date.now(), who: 'me', to: p.id, text: v }); save(); $('view').removeAttribute('data-key'); draw(); $('say').focus(); },
    out: function () { var v = $('out').value.trim(), p = cur(); if (!v || !p) return; var o = { id: uid('o'), name: v }; db.outs.push(o); p.reach.push(o.id); save(); sync(); draw(); },
    res: function (f) { var v = f.querySelector('input').value.trim(), k = f.getAttribute('data-k'), p = cur(); if (!v) return; var r = { id: uid('r'), name: v }; db.res[k].push(r); if (p) { if (k === 'conn') p.conn.push(r.id); else p[k] = r.id; } save(); sync(); draw(); },
    role: function () { var p = cur(); if (!p) return; p.name = $('rname').value.trim() || p.name; p.role = $('rrole').value.trim(); p.prompt = $('rprompt').value.trim(); p.boss = $('rboss').value; save(); sync(); draw(); },
    drop: function () { var p = cur(); if (!p || !window.confirm('把' + p.name + '移出办公室？他的聊天记录会一起删掉' + (db.people.some(function (x) { return x.boss === p.id; }) ? '，他的下属改归' + N(p.boss) + '管' : '') + '。')) return; var id = p.id; db.people = db.people.filter(function (x) { return x.id !== id; }); db.people.forEach(function (x) { if (x.boss === id) x.boss = p.boss; x.reach = x.reach.filter(function (j) { return j !== id; }); }); db.msgs = db.msgs.filter(function (m) { return m.who !== id && m.to !== id; }); if (ui.sel === id) ui.sel = null; ui.stack = []; ui.tab = 'people'; save(); sync(); draw(); },
    dropout: function (el) { var id = el.getAttribute('data-id'); db.outs = db.outs.filter(function (x) { return x.id !== id; }); db.people.forEach(function (x) { x.reach = x.reach.filter(function (j) { return j !== id; }); }); db.msgs = db.msgs.filter(function (m) { return m.who !== id && m.to !== id; }); if (ui.sel === id) ui.sel = null; ui.stack = []; save(); sync(); draw(); },
    preset: function (el) { Array.prototype.forEach.call(el.parentNode.children, function (b) { b.classList.toggle('on', b === el); }); var r = ROLES[+el.getAttribute('data-id')]; $('nrole').value = r[0]; $('nprompt').value = r[1].replace('{boss}', N($('nboss').value)); },
    add: function () { var name = $('nname').value.trim() || $('nname').defaultValue, role = $('nrole').value.trim(), boss = $('nboss').value, prompt = $('nprompt').value.trim();
      if (!prompt && role) prompt = '你负责' + role + '。拿不准的先问' + N(boss) + '，办完告诉交办的人。';
      var p = { id: uid('p'), name: name, role: role, boss: boss, prompt: prompt, pc: null, env: null, conn: [], reach: [], doing: '', look: db.n }; db.people.push(p);
      db.msgs.push({ id: uid('m'), ts: Date.now(), who: boss, to: p.id, sys: true, text: name + '入职了，归' + N(boss) + '管。' + (boss === 'me' ? '现在可以对他说要办什么。' : '') });
      ui.stack = [boss === 'me' ? { k: 'chat', id: p.id } : { k: 'profile', id: p.id, tab: 'phone' }]; ui.tab = boss === 'me' ? 'chats' : 'people'; save(); sync(); draw(); },
    clear: function () { if (!window.confirm('清空示例？办公室会变成空的。')) return; db = blank(); ui.sel = null; save(); sync(); draw(); },
    sample: function () { db = sample(); ui.sel = null; save(); sync(); draw(); }
  };
  var SW = {
    reach: function (el, p) { var id = el.getAttribute('data-id'); p.reach = p.reach.filter(function (j) { return j !== id; }); if (el.checked) p.reach.push(id); sync(); draw(); },
    conn: function (el, p) { var id = el.getAttribute('data-id'); p.conn = p.conn.filter(function (j) { return j !== id; }); if (el.checked) p.conn.push(id); },
    pc: function (el, p) { p.pc = el.value || null; sync(); }, env: function (el, p) { p.env = el.value || null; sync(); }
  };

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-tab]'); if (t && top()) { top().tab = t.getAttribute('data-tab'); ui.sub = null; draw(); return; }
    var g = e.target.closest('[data-go]'); if (g) { go(JSON.parse(g.getAttribute('data-go'))); return; }
    var d = e.target.closest('button[data-do]'); if (d) { e.preventDefault(); DO[d.getAttribute('data-do')](d); }
  });
  document.addEventListener('submit', function (e) { var f = e.target.closest('form[data-do]'); if (f) { e.preventDefault(); DO[f.getAttribute('data-do')](f); } });
  document.addEventListener('change', function (e) { var el = e.target.closest('[data-sw]'), p = cur(); if (!el || !p) return; SW[el.getAttribute('data-sw')](el, p); save(); });

  has3d = !!(window.Office && window.Office.init($('stage'), $('labels'), pick));
  if (!has3d) $('fail').hidden = false;
  draw(); sync();
  window.__app = { pick: pick, go: go, db: function () { return db; } };
})();
