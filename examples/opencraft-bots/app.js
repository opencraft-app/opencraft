/* OpenCraft Bot 手机：最小 demo。整个页面只讲一句话：
   每个人都有一部手机：手机里有谁（或哪个群），就能找谁（或在哪个群里说话）。Bot 还有一台电脑：电脑上有什么，就能用什么。
   人和 Bot 都是成员；群聊也只是一个能放进手机里的条目：谁的手机里有这个群，谁就在群里。
   首页是你的 Inbox：「对话」是你手机里的人、Bot 和群；「成员」是所有人，也能反过来看谁能找到他、谁能用什么。
   所有说法都是「谁 能找 谁」「谁 能用 什么」，主语在前。改动一点就生效，底部用同一句式说出结果，并给一次撤销，不弹确认。
   这是原型，没有接真实的 Bot：你发出去的话不会有人回。 */
(function () {
  'use strict';
  var KEY = 'opencraft.bots.v3', $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var COLORS = ['#e9e6f0', '#a9dcc9', '#a9c8f2', '#fbe39c', '#c3b5ee', '#f9cdb0', '#bfe3ee'];
  var NAMES = ['青柚', '白榆', '半夏', '南星', '远山', '知秋'];

  /* ================= 数据 =================
     people 里有五种：你（me）、Bot（bot）、同事（human）、公司外的人（out）、群聊（group）。
     phone 是这个人手机里的人和群；pc 是 Bot 电脑上的东西。群没有手机：谁的手机里有它，谁就在群里。 */
  function sample() {
    var now = Date.now(), ago = function (m) { return now - m * 60000; };
    return {
      people: [
        { id: 'me', kind: 'me', name: '你', look: 0, phone: ['a', 'c', 'g1'] },
        { id: 'a', kind: 'bot', name: '阿岚', role: '项目交付', look: 1, phone: ['me', 'z', 'h1', 'g1'], pc: ['mac', 'mail', 'drive'] },
        { id: 'c', kind: 'bot', name: '沐川', role: '行政', look: 2, phone: ['me', 'a', 'h2'], pc: ['mac', 'mail', 'drive'] },
        { id: 'z', kind: 'bot', name: '小折', role: '文档核对', look: 3, phone: ['a', 'g1'], pc: ['drive'] },
        { id: 'h1', kind: 'human', name: '林舟', role: '产品经理', look: 4, phone: ['a', 'g1'] },
        { id: 'h2', kind: 'human', name: '苏禾', role: '财务', look: 6, phone: ['c'] },
        { id: 'o1', kind: 'out', name: '客户周姐', look: 5 },
        { id: 'g1', kind: 'group', name: '2.3 交付' }
      ],
      tools: [{ id: 'mac', name: '办公室的 Mac mini' }, { id: 'mail', name: '企业邮箱' }, { id: 'drive', name: '公司网盘' }],
      msgs: [
        { from: 'h1', to: 'a', text: '交付包里加一份变更说明。', ts: ago(95) },
        { from: 'a', to: 'h1', text: '好，今天加上。', ts: ago(93) },
        { from: 'me', to: 'a', text: '周五把 2.3 版本交给客户，你来负责。', ts: ago(90) },
        { from: 'a', to: 'g1', text: '签字页周四下午给大家过一遍。', ts: ago(70) },
        { from: 'h1', to: 'g1', text: '好，我约周姐周五上午。', ts: ago(65) },
        { from: 'a', to: 'z', text: '帮我核一下签字页的版本和页码。', ts: ago(60) },
        { from: 'z', to: 'a', text: '在核了，一会儿给你。', ts: ago(55) },
        { from: 'a', to: 'me', text: '签字页让小折在核，周五上午我发给客户。', ts: ago(50) },
        { from: 'me', to: 'c', text: '把 10 月的报销整理一下。', ts: ago(40) },
        { from: 'h2', to: 'c', text: '10 月的发票我放网盘了。', ts: ago(35) },
        { from: 'c', to: 'h2', text: '收到，登记完给你看。', ts: ago(33) },
        { from: 'c', to: 'me', text: '在登记了，周五前给你。', ts: ago(30) },
        { from: 'z', to: 'g1', text: '页码核完了，就差版本号。', ts: ago(20) }
      ],
      doing: { z: { text: '核对签字页的版本和页码', tool: 'drive', ts: ago(8) }, c: { text: '登记 10 月的报销', tool: 'mail', ts: ago(12) } },
      log: [
        { who: 'c', tool: 'drive', text: '改了「10 月报销表」', ts: ago(20) },
        { who: 'z', tool: 'drive', text: '新建了「签字页核对记录」', ts: ago(15) },
        { who: 'a', tool: 'drive', text: '整理了「2.3 交付包」', ts: ago(45) }
      ],
      n: 10
    };
  }
  var db = sample();
  try { var raw = JSON.parse(localStorage.getItem(KEY)); if (raw && raw.people && raw.v === 3) db = raw; } catch (e) { /* 没有存储也能用 */ }
  function save() { db.v = 3; try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ } }

  function P(id) { return db.people.filter(function (x) { return x.id === id; })[0]; }
  function T(id) { return db.tools.filter(function (x) { return x.id === id; })[0]; }
  function of(kind) { return db.people.filter(function (x) { return x.kind === kind; }); }
  function bots() { return of('bot'); }
  function holders() { return db.people.filter(function (x) { return x.phone; }); } /* 有手机的：你、Bot、同事 */
  function N(id) { return id === 'me' ? '你' : (P(id) || {}).name || ''; }
  function isGroup(id) { return (P(id) || {}).kind === 'group'; }

  /* ================= 规则 =================
     手机里有谁（或哪个群），就能找谁（或在哪个群里说话）。电脑上有什么，就能用什么。 */
  function canFind(a, b) { var x = P(a); return !!x && (x.phone || []).indexOf(b) >= 0; }
  function canUse(a, t) { var x = P(a); return !!x && (x.pc || []).indexOf(t) >= 0; }
  function finders(id) { return holders().filter(function (x) { return x.id !== id && canFind(x.id, id); }); } /* 谁的手机里有他；对群来说就是群成员 */
  function users(t) { return bots().filter(function (x) { return canUse(x.id, t); }); }
  function names(list) { return list.map(function (x) { return N(x.id); }).join('、'); }
  /* 结果句：主语在前 */
  function findText(who, target, yes) { var s = N(who);
    return isGroup(target) ? s + (yes ? '现在在「' : '现在不在「') + N(target) + '」里了' : s + (yes ? '现在能找' : '现在找不到') + N(target) + '了'; }

  function thread(a, b) { return db.msgs.filter(function (m) { return isGroup(b) ? m.to === b : (m.from === a && m.to === b) || (m.from === b && m.to === a); }); }
  function hhmm(ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function ago(ts) { var m = Math.round((Date.now() - ts) / 60000); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : hhmm(ts); }
  function without(arr, v) { return (arr || []).filter(function (x) { return x !== v; }); }

  /* ================= 改动：一点就生效，底部留一次撤销 ================= */
  var toast = null, toastTimer = 0;
  function change(label, fn) {
    var before = JSON.stringify(db); fn(); save();
    toast = { text: label, before: before }; clearTimeout(toastTimer); toastTimer = setTimeout(function () { toast = null; paintToast(); }, 6000);
    refresh();
  }
  function undo() { if (!toast) return; db = JSON.parse(toast.before); save(); toast = null; clearTimeout(toastTimer); refresh(); }
  function paintToast() { var el = $('toast'); el.hidden = !toast; el.innerHTML = toast ? '<span>' + esc(toast.text) + '</span><button class="btn sm" data-do="undo">撤销</button>' : ''; }

  /* ================= 界面 ================= */
  var ui = { stack: [], view: 'list', tab: 'chats', q: '', sel: null }, has3d = false;
  var wideMq = window.matchMedia ? matchMedia('(min-width: 900px)') : { matches: false };
  function wide() { return wideMq.matches && ui.view === 'list'; }
  function top() { return ui.stack[ui.stack.length - 1]; }
  function cur() { var t = top(); return t && P(t.id); }
  var SVG = function (d, w) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (w || 1.8) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; };
  var ICON = { back: SVG('<path d="m14.500 5-7 7 7 7"/>', 2), send: SVG('<path d="M12 19V5.500M5.800 11.500 12 5.300l6.200 6.200"/>', 2.2), x: SVG('<path d="M7 7l10 10M17 7 7 17"/>', 2.2),
    phone: SVG('<rect x="7" y="3" width="10" height="18" rx="2.500"/><path d="M11 18h2"/>'), pc: SVG('<rect x="3.500" y="4.500" width="17" height="11.500" rx="1.800"/><path d="M8.500 20h7M12 16v4"/>'), chat: SVG('<path d="M12 4.500c-4.700 0-8.500 3.100-8.500 7 0 2.200 1.200 4.100 3.100 5.400L6 20l3.400-1.600c.8.200 1.700.300 2.600.300 4.700 0 8.500-3.100 8.500-7s-3.800-7.200-8.500-7.200z"/>'),
    plus: SVG('<path d="M12 5.500v13M5.500 12h13"/>', 1.8), search: SVG('<circle cx="11" cy="11" r="6.500"/><path d="m16 16 4 4"/>'), people: SVG('<circle cx="9" cy="8.500" r="3.200"/><path d="M3.500 19c.6-3.300 2.700-5.200 5.500-5.200s4.900 1.900 5.500 5.200M15.500 5.600a3.200 3.200 0 0 1 0 6M17 13.900c2 .5 3.200 2.200 3.600 5.100"/>'),
    bot: SVG('<rect x="4.500" y="6.500" width="15" height="12" rx="4"/><path d="M12 6.500V4M9.500 12v1M14.500 12v1"/>') };
  var PERSON = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="15.500" r="7"/><path d="M5.500 41c.8-8.500 6.800-13.500 14.500-13.500S33.700 32.500 34.500 41z"/></svg>';
  /* 头像：Bot 是带眼睛的圆角方块，人是圆的剪影（你是深色的），群是成员头像拼成的格子 */
  function av(id, cls) { var p = P(id); if (!p) return ''; var c = ' style="--c:' + COLORS[(p.look || 0) % COLORS.length] + '"', k = cls ? ' ' + cls : '';
    if (p.kind === 'group') { var m = finders(id).slice(0, 4); return '<span class="av grp' + k + (m.length > 1 ? '' : ' one') + '" aria-hidden="true">' + m.map(function (x) { return av(x.id, 'mini'); }).join('') + '</span>'; }
    if (p.kind === 'bot') return '<span class="av' + k + '"' + c + ' aria-hidden="true"></span>';
    return '<span class="av hu' + (p.kind === 'me' ? ' me' : '') + k + '"' + c + ' aria-hidden="true">' + PERSON + '</span>'; }
  function go(page) { return ' data-go=\'' + esc(JSON.stringify(page)) + '\''; }
  function tag(x) { return x.kind === 'out' ? '<em>公司外</em>' : ''; }
  function status(b) { var d = db.doing[b.id]; return d ? '<span class="status busy">正在' + esc(d.text) + '</span>' : '<span class="status">空闲</span>'; }
  function backBtn() { return wide() && ui.stack.length <= 1 ? '' : '<button class="ic" data-do="back" aria-label="返回">' + ICON.back + '</button>'; } /* 宽屏右边那一层是默认打开的，不需要返回 */
  function head(title, sub, right) { return '<header class="head">' + backBtn() + '<div class="ht"><h1>' + title + '</h1>' + (sub ? '<p>' + sub + '</p>' : '') + '</div>' + (right || '') + '</header>'; }
  function line(m, self) { var mine = m.from === self; return '<div class="msg' + (mine ? ' out' : '') + '">' + (mine ? '' : '<span class="nm">' + esc(N(m.from)) + '</span>') + '<div class="bub">' + esc(m.text) + '</div></div>'; }
  function opens(id) { var x = P(id); return x.kind === 'group' ? { k: 'group', id: id } : x.kind === 'bot' ? { k: 'bot', id: id } : { k: 'who', id: id }; }
  function isOn(page) { var t = top(); return !!t && t.k === page.k && (t.id || t.t) === (page.id || page.t); }

  /* ---------- 首页：你的 Inbox。搜索、加号，「对话 / 成员」两个小标签 ---------- */
  function home() {
    var tabs = [['chats', '对话'], ['people', '成员']];
    return '<div class="page"><header class="inbox-h"><h1>Inbox</h1><div class="seg" role="tablist" aria-label="看法"><button role="tab" data-do="view" data-id="list" aria-selected="' + (ui.view === 'list') + '">列表</button><button role="tab" data-do="view" data-id="office" aria-selected="' + (ui.view === 'office') + '">办公室</button></div></header>' +
      '<div class="searchbar"><label class="search">' + ICON.search + '<input id="q" type="search" autocomplete="off" placeholder="搜索群聊、成员或 Bot" aria-label="搜索" value="' + esc(ui.q) + '"></label><button class="ic plus" aria-label="新建"' + go({ k: 'new' }) + '>' + ICON.plus + '</button></div>' +
      '<div class="pills" role="tablist">' + tabs.map(function (t) { return '<button role="tab" data-do="tab" data-id="' + t[0] + '" aria-selected="' + (ui.tab === t[0]) + '">' + t[1] + '</button>'; }).join('') + '</div>' +
      '<div class="body inbox">' + (ui.tab === 'people' ? peopleTab() : chatsTab()) + '<p class="none pad" id="noresult" hidden>' + (ui.tab === 'people' ? '没有找到。' : '你手机里没有这个人。去<button class="lk in" data-do="tab" data-id="people">成员</button>里找找。') + '</p>' + '<p class="foot">这是原型，没有接真实的 Bot，你发出去的话不会有人回。<button class="lk" data-do="reset">恢复示例</button></p></div></div>';
  }
  function irow(page, id, title, sub, right, q) { return '<div class="row' + (isOn(page) ? ' on' : '') + '" data-q="' + esc(q) + '"><button class="row-main"' + go(page) + '>' + av(id, 'lg') + '<span class="t"><b>' + title + '</b><span>' + sub + '</span></span></button>' + (right || '') + '</div>'; }
  /* 对话：你手机里的人、Bot 和群，按最近一句排 */
  function convos() { return (P('me').phone || []).filter(P).map(function (id) { var t = thread('me', id); return { id: id, last: t[t.length - 1] }; })
    .sort(function (x, y) { return (y.last ? y.last.ts : 0) - (x.last ? x.last.ts : 0); }); }
  function convoPage(id) { return isGroup(id) ? { k: 'group', id: id } : { k: 'chat', id: id }; }
  function chatsTab() {
    var rows = convos().map(function (it) { var x = P(it.id), l = it.last, page = convoPage(it.id);
      var sub = l ? esc((l.from === 'me' ? '你：' : x.kind === 'group' ? N(l.from) + '：' : '') + l.text) : '<span class="status">还没说过话</span>';
      var busy = db.doing[x.id] ? '<i class="busydot" title="正在做事"></i>' : '';
      return irow(page, x.id, esc(x.name) + busy + tag(x), sub, '<span class="rt">' + (l ? hhmm(l.ts) : '') + '</span>', x.name); }).join('');
    var others = bots().filter(function (b) { return !canFind('me', b.id); }).length;
    return '<div class="flat">' + (rows || '<p class="none pad">你的手机里还没有人，你现在谁也找不到。</p>') + '</div>' +
      '<p class="cap">这里是你手机里的人、Bot 和群。' + (others ? '还有 ' + others + ' 个 Bot 你找不到，在<button class="lk in" data-do="tab" data-id="people">成员</button>里。' : '') + '</p>';
  }
  /* 成员：所有 Bot 和人，能直接加进你的手机；也能反过来看谁能找到他、谁能用什么 */
  function peopleTab() {
    var botRows = bots().map(function (b) { var mine = canFind('me', b.id);
      return irow({ k: 'bot', id: b.id }, b.id, esc(b.name) + '<i>' + esc(b.role) + '</i>', status(b), mine ? '<button class="btn sm ghost" data-do="meout" data-id="' + b.id + '">移出</button>' : '<button class="btn sm" data-do="mein" data-id="' + b.id + '">加入</button>', b.name + b.role); }).join('');
    function reachLine(id) { var f = finders(id); return f.length ? esc(names(f)) + ' 能找' : '谁也找不到'; }
    var hum = of('human').map(function (x) { return irow({ k: 'who', id: x.id }, x.id, esc(x.name) + '<i>' + esc(x.role) + '</i>', reachLine(x.id), '<span class="rt">成员</span>', x.name + x.role); }).join('');
    var outs = of('out').map(function (x) { return irow({ k: 'who', id: x.id }, x.id, esc(x.name), reachLine(x.id), '<span class="rt">公司外</span>', x.name); }).join('');
    var tools = db.tools.map(function (x) { var u = users(x.id), page = { k: 'use', t: x.id };
      return '<div class="row' + (isOn(page) ? ' on' : '') + '" data-q="' + esc(x.name) + '"><button class="row-main"' + go(page) + '><span class="tic" aria-hidden="true">' + esc(x.name.slice(0, 1)) + '</span><span class="t"><b>' + esc(x.name) + '</b><span>' + (u.length ? esc(names(u)) + ' 能用' : '谁也用不了') + '</span></span></button><span class="rt">东西</span></div>'; }).join('');
    return '<p class="rules"><b>手机</b>里有谁，就能找谁；<b>电脑</b>上有什么，就能用什么。人和 Bot 都一样。</p>' +
      '<h2 class="group">Bot <i>' + bots().length + '</i></h2><div class="flat">' + botRows + '</div>' +
      '<button class="newbot"' + go({ k: 'newbot' }) + '>' + ICON.plus + '新 Bot</button>' +
      (hum ? '<h2 class="group">成员 <i>' + of('human').length + '</i></h2><div class="flat">' + hum + '</div>' : '') +
      (outs ? '<h2 class="group">公司外</h2><div class="flat">' + outs + '</div>' : '') +
      '<h2 class="group">公司的东西</h2><div class="flat">' + tools + '</div>';
  }

  /* 一个人、一个群或一样东西：分「能」和「不能」两组，每行直接加入或移除 */
  function reach(kind, id) {
    var isTool = kind === 'use', grp = !isTool && isGroup(id), name = isTool ? T(id).name : N(id);
    var who = isTool ? bots() : grp ? holders() : bots();
    var has = function (b) { return isTool ? canUse(b.id, id) : canFind(b.id, id); };
    var yes = who.filter(has), no = who.filter(function (b) { return !has(b); });
    var W = isTool ? ['能用' + name + '的', '用不了的', '能用', '不能用', '电脑上有' + name, '给他', '移除']
      : grp ? ['在群里的', '不在群里的', '在群里', '不在群里', '手机里有这个群', '拉进群', '移出群']
      : ['能找' + name + '的', '找不到的', '能找', '不能找', '手机里有' + name, '给他', '移除'];
    function row(b, inside) { var main = av(b.id) + '<span class="t"><b>' + esc(N(b.id)) + (b.role ? '<i>' + esc(b.role) + '</i>' : '') + '</b><span class="status">' + (inside ? W[2] : W[3]) + (grp ? '' : esc(name)) + '</span></span>';
      return '<div class="row">' + (b.kind === 'bot' ? '<button class="row-main"' + go({ k: 'bot', id: b.id }) + '>' + main + '</button>' : '<span class="row-main static">' + main + '</span>') +
        (inside ? '<button class="btn sm ghost" data-do="revoke" data-id="' + b.id + '">' + W[6] + '</button>' : '<button class="btn sm" data-do="grant" data-id="' + b.id + '">' + W[5] + '</button>') + '</div>'; }
    var sub = isTool ? '公司的东西' : grp ? '群聊 · ' + yes.length + ' 人' : P(id).kind === 'out' ? '公司外的人' : (P(id).role || '成员');
    return '<div class="page">' + head((isTool ? '' : av(id, 'hd')) + esc(name), esc(sub)) + '<div class="body">' +
      '<h2 class="group">' + esc(W[0]) + ' <i>' + yes.length + '</i></h2><p class="cap">' + esc(W[4]) + '</p><div class="card">' + (yes.length ? yes.map(function (b) { return row(b, true); }).join('') : '<p class="none pad">现在谁也' + (isTool ? '用不了' : grp ? '不在群里' : '找不到') + '。</p>') + '</div>' +
      (no.length ? '<h2 class="group">' + W[1] + ' <i>' + no.length + '</i></h2><div class="card">' + no.map(function (b) { return row(b, false); }).join('') + '</div>' : '') + '</div></div>';
  }

  /* ---------- 一个 Bot：名片、和你的对话、他的手机、他的电脑 ---------- */
  function mineFirst(list) { list = list || []; return list.indexOf('me') >= 0 ? ['me'].concat(without(list, 'me')) : list; } /* “你”永远排第一个 */
  function bot(b) {
    var mine = canFind('me', b.id), t = thread('me', b.id), d = db.doing[b.id], recent = db.log.filter(function (r) { return r.who === b.id; }).sort(function (x, y) { return y.ts - x.ts; }).slice(0, 2);
    var hero = '<header class="hero">' + backBtn() + av(b.id, 'xl') + '<div class="ht"><h1>' + esc(b.name) + '<i>' + esc(b.role) + '</i></h1><p>' + status(b) + '</p></div>' +
      (mine ? '<button class="btn ok"' + go({ k: 'chat', id: b.id }) + '>' + ICON.chat + '发消息</button>' : '<button class="btn" data-do="mein" data-id="' + b.id + '">加到我的手机</button>') + '</header>';
    var chat = '<button class="card convo"' + go({ k: 'chat', id: b.id }) + '><span class="convo-h">和你的对话' + (mine ? '' : '<em>你找不到他，只能看</em>') + '</span>' +
      (t.length ? t.slice(-2).map(function (m) { return line(m, 'me'); }).join('') : '<p class="none">还没说过话。</p>') + '<span class="more">打开对话 ›</span></button>';
    var phone = '<section class="card panel"><div class="panel-h"><span class="pi">' + ICON.phone + '</span><div><h2>他的手机</h2><p>手机里有谁、有哪个群，他就能找谁、在哪个群里说话。</p></div><i>' + (b.phone || []).length + '</i></div><div class="tiles">' +
      mineFirst(b.phone).map(function (j) { var x = P(j); if (!x) return '';
        var page = j === 'me' ? { k: 'chat', id: b.id } : x.kind === 'group' ? { k: 'group', id: j } : { k: 'peek', id: b.id, w: j };
        return '<div class="tile"><button class="tile-main"' + go(page) + '>' + av(j, 'lg') + '<span>' + esc(N(j)) + '</span>' + tag(x) + '</button><button class="tile-x" data-do="unfriend" data-id="' + j + '" aria-label="从' + esc(b.name) + '的手机里移除' + esc(N(j)) + '">' + ICON.x + '</button></div>'; }).join('') +
      '<button class="tile addtile"' + go({ k: 'add', id: b.id }) + '><span class="plusbox">' + ICON.plus + '</span><span>添加</span></button></div>' +
      ((b.phone || []).length ? '' : '<p class="empty-note">手机里没有人，他谁也找不到。</p>') +
      '<p class="recent">反过来，' + (finders(b.id).length ? esc(names(finders(b.id))) + '能找他。' : '谁也找不到他。') + '</p></section>';
    var pc = '<section class="card panel"><div class="panel-h"><span class="pi">' + ICON.pc + '</span><div><h2>他的电脑</h2><p>电脑上有什么，他就能用什么。</p></div><i>' + (b.pc || []).length + '</i></div>' +
      (d ? '<div class="doing"><span class="dot" aria-hidden="true"></span><span class="t"><b>正在' + esc(d.text) + '</b><span>' + esc(ago(d.ts)) + '开始 · 用' + esc((T(d.tool) || {}).name || '') + '</span></span><button class="btn sm danger" data-do="stop">停下</button></div>' : '') +
      '<div class="tools">' + (b.pc || []).map(function (id) { var x = T(id); return x ? '<div class="tool"><button class="tool-main"' + go({ k: 'use', t: id }) + '><span class="tic" aria-hidden="true">' + esc(x.name.slice(0, 1)) + '</span><span class="t"><b>' + esc(x.name) + '</b><span>' + esc(users(id).length > 1 ? '还有 ' + (users(id).length - 1) + ' 个 Bot 能用' : '只有他能用') + '</span></span></button><button class="btn sm ghost" data-do="untool" data-id="' + id + '">移除</button></div>' : ''; }).join('') +
      '<button class="tool add"' + go({ k: 'tools', id: b.id }) + '><span class="tic plusbox" aria-hidden="true">' + ICON.plus + '</span><span class="t"><b>添加</b></span></button></div>' +
      ((b.pc || []).length ? '' : '<p class="empty-note">电脑上什么都没有，他现在只能聊天。</p>') +
      (recent.length ? '<p class="recent">最近：' + recent.map(function (r) { return esc(ago(r.ts) + '用' + ((T(r.tool) || {}).name || '') + r.text); }).join('；') + '</p>' : '') + '</section>';
    return '<div class="page">' + hero + '<div class="body">' + chat + '<div class="split2">' + phone + pc + '</div>' +
      '<p class="bot-foot">' + (mine ? '<button class="lk" data-do="meout" data-id="' + b.id + '">从我的手机移出</button>' : '') + '<button class="lk danger" data-do="fire">删掉这个 Bot</button></p></div></div>';
  }
  /* 你和一个人或 Bot 的对话 */
  function composer(id, name) { return '<form class="say" data-do="say"><input id="say" autocomplete="off" enterkeyhint="send" placeholder="对' + esc(name) + '说" aria-label="对' + esc(name) + '说"><button class="send" aria-label="发送">' + ICON.send + '</button></form>'; }
  function chat(b) { var ok = canFind('me', b.id), right = b.kind === 'bot' ? '<button class="btn sm"' + go({ k: 'bot', id: b.id }) + '>' + ICON.bot + '手机和电脑</button>' : '';
    return '<div class="page">' + head(av(b.id, 'hd') + esc(b.name), b.kind === 'bot' ? status(b) : esc(b.role || ''), right) + '<div class="body chat" id="chat">' + (thread('me', b.id).map(function (m) { return line(m, 'me'); }).join('') || '<p class="none center">还没说过话。对' + esc(b.name) + '说第一件要办的事。</p>') + '</div>' +
      (ok ? composer(b.id, b.name) : '<div class="say off"><span>你找不到' + esc(b.name) + '：他不在你手机里。</span><button class="btn sm" data-do="mein" data-id="' + b.id + '">加到我的手机</button></div>') + '</div>'; }
  /* 群聊：谁的手机里有这个群，谁就在群里 */
  function group(g) { var ok = canFind('me', g.id), m = finders(g.id);
    return '<div class="page">' + head(av(g.id, 'hd') + esc(g.name), esc(names(m))) + '<div class="body chat" id="chat">' + (thread('me', g.id).map(function (x) { return line(x, 'me'); }).join('') || '<p class="none center">群里还没人说话。</p>') + '</div>' +
      '<div class="gbar"><button class="btn sm"' + go({ k: 'who', id: g.id }) + '>' + ICON.people + '群成员 ' + m.length + '</button></div>' +
      (ok ? composer(g.id, g.name) : '<div class="say off"><span>你不在这个群里，只能看。</span><button class="btn sm" data-do="mein" data-id="' + g.id + '">加入群聊</button></div>') + '</div>'; }
  /* 看他和某人的聊天（只读）；底部说清楚两个方向，也能在这里移除 */
  function peek(b, w) { var x = P(w), t = thread(b.id, w), there = canFind(b.id, w);
    var fwd = b.name + (there ? '能找' : '找不到') + x.name + '。';
    var rev = x.kind === 'out' ? x.name + '是公司外的人，没有这部手机。' : x.name + (canFind(w, b.id) ? '能找' : '找不到') + b.name + '。';
    return '<div class="page">' + head(esc(b.name) + ' 和 ' + esc(x.name), '只能看，不能替他回') + '<div class="body chat">' + (t.map(function (m) { return line(m, b.id); }).join('') || '<p class="none center">他们还没聊过。</p>') + '</div>' +
      '<div class="say off two"><span><b>' + esc(fwd) + '</b><br>' + esc(rev) + ' <button class="lk"' + go({ k: 'who', id: w }) + '>谁能找' + esc(x.name) + ' ›</button></span>' + (there ? '<button class="btn sm danger" data-do="unfriend" data-id="' + w + '">从' + esc(b.name) + '手机里移除</button>' : '<button class="btn sm" data-do="friend" data-id="' + w + '">加回去</button>') + '</div></div>'; }
  function addContact(b) { var list = db.people.filter(function (x) { return x.id !== b.id && (b.phone || []).indexOf(x.id) < 0; });
    return '<div class="page">' + head('加到' + esc(b.name) + '的手机', '加进去，' + esc(b.name) + '就能找这个人，或在这个群里说话') + '<div class="body"><div class="card">' + (list.length ? list.map(function (x) { return '<div class="row"><span class="row-main static">' + av(x.id) + '<span class="t"><b>' + esc(N(x.id)) + tag(x) + '</b><span>' + esc(x.kind === 'group' ? '群聊' : x.kind === 'bot' ? 'Bot · ' + x.role : x.kind === 'human' ? '成员 · ' + x.role : x.kind === 'me' ? '老板' : '公司外的人') + '</span></span></span><button class="btn sm" data-do="friend" data-id="' + x.id + '" data-pop="1">添加</button></div>'; }).join('') : '<p class="none pad">大家都已经在他手机里了。</p>') + '</div>' +
      '<form class="inl" data-do="newout"><input id="outname" autocomplete="off" placeholder="公司外的人，例如：供应商老秦" aria-label="公司外的人"><button class="btn">添加</button></form></div></div>'; }
  function addTool(b) { var list = db.tools.filter(function (t) { return (b.pc || []).indexOf(t.id) < 0; });
    return '<div class="page">' + head('放到' + esc(b.name) + '的电脑上', '放上去，' + esc(b.name) + '就能用') + '<div class="body"><div class="card">' + (list.length ? list.map(function (t) { return '<div class="row"><span class="row-main static"><span class="tic" aria-hidden="true">' + esc(t.name.slice(0, 1)) + '</span><span class="t"><b>' + esc(t.name) + '</b></span></span><button class="btn sm" data-do="tool" data-id="' + t.id + '">添加</button></div>'; }).join('') : '<p class="none pad">公司里的都已经给他了。</p>') + '</div>' +
      '<form class="inl" data-do="newtool"><input id="toolname" autocomplete="off" placeholder="新的，例如：钉钉、云测试环境" aria-label="新的东西"><button class="btn">添加</button></form></div></div>'; }
  /* 加号：新 Bot 或新群聊 */
  function newAny() { return '<div class="page">' + head('新建') + '<div class="body"><div class="card">' +
    '<div class="row"><button class="row-main"' + go({ k: 'newbot' }) + '><span class="tic big" aria-hidden="true">' + ICON.bot + '</span><span class="t"><b>新 Bot</b><span>他的手机里先只有你，电脑上什么都没有</span></span></button></div>' +
    '<div class="row"><button class="row-main"' + go({ k: 'newgroup' }) + '><span class="tic big" aria-hidden="true">' + ICON.people + '</span><span class="t"><b>新群聊</b><span>选进来的人和 Bot，手机里都会多出这个群</span></span></button></div></div></div></div>'; }
  function newBot() { var used = db.people.map(function (x) { return x.name; }), name = NAMES.filter(function (n) { return used.indexOf(n) < 0; })[0] || '新 Bot';
    return '<div class="page">' + head('新 Bot', '他的手机里先只有你，电脑上什么都没有') + '<form class="body" data-do="hire"><div class="card form"><label class="fld"><span>名字</span><input id="bname" autocomplete="off" value="' + esc(name) + '"></label><label class="fld"><span>岗位</span><input id="brole" autocomplete="off" placeholder="例如：客服"></label></div><button class="btn ok wide">创建</button></form></div>'; }
  function newGroup() { return '<div class="page">' + head('新群聊', '选进来的人和 Bot，手机里都会多出这个群') + '<form class="body" data-do="mkgroup"><div class="card form"><label class="fld"><span>群名</span><input id="gname" autocomplete="off" placeholder="例如：11 月活动"></label></div><div class="card">' +
    holders().map(function (x) { return '<label class="row pick"><span class="row-main static">' + av(x.id) + '<span class="t"><b>' + esc(N(x.id)) + (x.role ? '<i>' + esc(x.role) + '</i>' : '') + '</b></span></span><input type="checkbox" name="m" value="' + x.id + '"' + (x.id === 'me' ? ' checked' : '') + '></label>'; }).join('') +
    '</div><button class="btn ok wide">创建</button></form></div>'; }

  /* ---------- 办公室：同一批人换一种看法。箭头是他手机里的人（群不画） ---------- */
  function toScene() {
    var nodes = db.people.filter(function (p) { return p.kind !== 'group'; }).map(function (p) { return { id: p.id, name: p.name, kind: p.kind === 'me' ? 'me' : p.kind === 'bot' ? 'bot' : 'out', look: p.look, busy: !!db.doing[p.id], pc: p.kind === 'bot' && (p.pc || []).length > 0 }; }), links = [];
    db.people.forEach(function (p) { (p.phone || []).forEach(function (j) { if (P(j) && !isGroup(j)) links.push([p.id, j]); }); });
    return { nodes: nodes, links: links, boss: [] };
  }
  function reachOf(id) { return id ? (P(id).phone || []).filter(function (j) { return !isGroup(j); }) : []; }
  function sync() { if (has3d) { window.Office.sync(toScene()); window.Office.select(ui.sel, reachOf(ui.sel), []); } }
  function pick(id) { if (id && !P(id)) id = null; ui.sel = id; draw(); if (has3d) window.Office.select(id, reachOf(id), []); }
  function card() { var p = P(ui.sel);
    if (!p) return '<div class="hint"><span>箭头指向他手机里的人。点一个人看看。</span><button class="btn sm" data-do="view" data-id="list">回到列表</button></div>';
    return '<div class="pcard">' + av(p.id) + '<span class="t"><b>' + esc(p.name) + (p.role ? '<i>' + esc(p.role) + '</i>' : '') + '</b><span>' + (p.kind === 'bot' ? status(p) : p.kind === 'out' ? '公司外的人' : '手机里有 ' + (p.phone || []).length + ' 个人和群') + '</span></span>' +
      (p.kind === 'bot' ? '<button class="btn sm ok" data-do="open" data-id="' + p.id + '">打开</button>' : '') + '<button class="btn sm" data-do="view" data-id="list">回到列表</button></div>'; }

  /* ---------- 画页面 ---------- */
  var PAGES = { bot: bot, chat: chat, group: group, add: addContact, tools: addTool };
  /* 搜索：只隐藏不匹配的行；这一页没有匹配时说一句，并指向另一个标签 */
  function filter() { var q = ui.q.trim().toLowerCase(), shown = 0, rows = document.querySelectorAll('[data-q]'), nr = $('noresult');
    rows.forEach(function (r) { r.hidden = !!q && r.getAttribute('data-q').toLowerCase().indexOf(q) < 0; if (!r.hidden) shown++; });
    document.querySelectorAll('.inbox .group, .inbox .flat, .inbox .rules, .inbox .newbot, .inbox > .cap').forEach(function (el) { el.hidden = !!q && (el.classList.contains('flat') || el.classList.contains('group') ? !(el.classList.contains('flat') ? el : el.nextElementSibling || el).querySelector('[data-q]:not([hidden])') : true); });
    if (nr) nr.hidden = !q || shown > 0; }
  function draw() {
    var view = $('view'), t, focusQ = document.activeElement && document.activeElement.id === 'q';
    if (wide() && !ui.stack.length) { var first = convos()[0]; if (first) ui.stack = [convoPage(first.id)]; else if (bots().length) ui.stack = [{ k: 'bot', id: bots()[0].id }]; } /* 宽屏默认打开最近的对话 */
    t = top(); while (t && ((t.id && !P(t.id)) || (t.w && !P(t.w)) || (t.t && !T(t.t)))) { ui.stack.pop(); t = top(); }
    var key = JSON.stringify(t || '') + ui.tab, same = view.getAttribute('data-key') === key, b0 = view.querySelector('.pane.r .body') || view.querySelector('.body'), keep = b0 ? b0.scrollTop : 0;
    var page = !t ? '' : t.k === 'peek' ? peek(P(t.id), t.w) : t.k === 'new' ? newAny() : t.k === 'newbot' ? newBot() : t.k === 'newgroup' ? newGroup() : t.k === 'who' ? reach('who', t.id) : t.k === 'use' ? reach('use', t.t) : PAGES[t.k](P(t.id)), office = ui.view === 'office';
    view.hidden = office; $('office').hidden = !office;
    view.classList.toggle('split', wide());
    view.innerHTML = wide() ? '<div class="pane l">' + home() + '</div><div class="pane r">' + (page || '<p class="blank">还没有人</p>') + '</div>' : page || home();
    view.setAttribute('data-key', key);
    var nb = view.querySelector('.pane.r .body') || view.querySelector('.body'); if (nb && same) nb.scrollTop = keep; var c = $('chat'); if (c) c.scrollTop = c.scrollHeight;
    filter(); if (focusQ && $('q')) { $('q').focus(); $('q').setSelectionRange(ui.q.length, ui.q.length); }
    $('card').innerHTML = office ? card() : '';
    paintToast();
    if (office && has3d) window.Office.resize();
  }
  function refresh() { sync(); $('view').removeAttribute('data-key'); draw(); }

  var DO = {
    back: function () { ui.stack.pop(); draw(); },
    tab: function (el) { ui.tab = el.getAttribute('data-id'); if (!wide()) ui.stack = []; draw(); },
    view: function (el) { ui.view = el.getAttribute('data-id'); if (ui.view === 'office') ui.stack = []; draw(); if (ui.view === 'office') sync(); },
    open: function (el) { ui.view = 'list'; ui.stack = [{ k: 'bot', id: el.getAttribute('data-id') }]; draw(); },
    undo: undo,
    reset: function () { change('已恢复示例', function () { db = sample(); ui.stack = []; ui.sel = null; }); },
    say: function () { var v = $('say').value.trim(), b = cur(); if (!v || !b || !canFind('me', b.id)) return; db.msgs.push({ from: 'me', to: b.id, text: v, ts: Date.now() }); save(); refresh(); $('say').focus(); },
    mein: function (el) { var id = el.getAttribute('data-id'); change(findText('me', id, true), function () { var me = P('me'); me.phone = without(me.phone, id).concat(id); }); },
    meout: function (el) { var id = el.getAttribute('data-id'); change(findText('me', id, false), function () { var me = P('me'); me.phone = without(me.phone, id); }); },
    friend: function (el) { var b = cur(), id = el.getAttribute('data-id'); if (el.hasAttribute('data-pop')) ui.stack.pop(); change(findText(b.id, id, true), function () { b.phone = without(b.phone, id).concat(id); }); },
    unfriend: function (el) { var b = cur(), id = el.getAttribute('data-id'); change(findText(b.id, id, false), function () { b.phone = without(b.phone, id); }); },
    tool: function (el) { var b = cur(), id = el.getAttribute('data-id'); ui.stack.pop(); change(b.name + '现在能用' + T(id).name + '了', function () { b.pc = without(b.pc, id).concat(id); }); },
    untool: function (el) { var b = cur(), id = el.getAttribute('data-id'), d = db.doing[b.id];
      change(b.name + '现在用不了' + T(id).name + '了' + (d && d.tool === id ? '，手上的事也停了' : ''), function () { b.pc = without(b.pc, id); if (d && d.tool === id) delete db.doing[b.id]; }); }, /* 拿走正在用的东西，手上的事也就停了 */
    grant: function (el) { var t = top(), b = P(el.getAttribute('data-id'));
      if (t.k === 'use') change(b.name + '现在能用' + T(t.t).name + '了', function () { b.pc = without(b.pc, t.t).concat(t.t); });
      else change(findText(b.id, t.id, true), function () { b.phone = without(b.phone, t.id).concat(t.id); }); },
    revoke: function (el) { var t = top(), b = P(el.getAttribute('data-id')), d = db.doing[b.id];
      if (t.k === 'use') change(b.name + '现在用不了' + T(t.t).name + '了' + (d && d.tool === t.t ? '，手上的事也停了' : ''), function () { b.pc = without(b.pc, t.t); if (d && d.tool === t.t) delete db.doing[b.id]; });
      else change(findText(b.id, t.id, false), function () { b.phone = without(b.phone, t.id); }); },
    stop: function () { var b = cur(); change(b.name + '停下了，现在空闲', function () { delete db.doing[b.id]; }); },
    fire: function () { var b = cur(); ui.stack = []; change('已删掉' + b.name + '，谁也找不到他了', function () { db.people = db.people.filter(function (x) { return x.id !== b.id; }); db.people.forEach(function (x) { if (x.phone) x.phone = without(x.phone, b.id); }); db.msgs = db.msgs.filter(function (m) { return m.from !== b.id && m.to !== b.id; }); delete db.doing[b.id]; }); },
    newout: function () { var v = $('outname').value.trim(), b = cur(); if (!v) { $('outname').focus(); return; } ui.stack.pop(); change(b.name + '现在能找' + v + '了', function () { var o = { id: 'o' + (++db.n), kind: 'out', name: v, look: 5 }; db.people.push(o); b.phone.push(o.id); }); },
    newtool: function () { var v = $('toolname').value.trim(), b = cur(); if (!v) { $('toolname').focus(); return; } ui.stack.pop(); change(b.name + '现在能用' + v + '了', function () { var t = { id: 't' + (++db.n), name: v }; db.tools.push(t); b.pc.push(t.id); }); },
    hire: function () { var name = $('bname').value.trim() || $('bname').defaultValue, role = $('brole').value.trim() || '未填岗位', id = 'b' + (db.n + 1);
      ui.stack = [{ k: 'bot', id: id }]; change(name + '来了：你能找他，他也能找你', function () { db.n++; db.people.push({ id: id, kind: 'bot', name: name, role: role, look: 1 + db.n % 6, phone: ['me'], pc: [] }); P('me').phone.push(id); }); },
    mkgroup: function (f) { var name = $('gname').value.trim(), picked = [].map.call(f.querySelectorAll('input[name=m]:checked'), function (x) { return x.value; }), id = 'g' + (db.n + 1);
      if (!name) { $('gname').focus(); return; }
      ui.stack = [{ k: 'group', id: id }]; change('「' + name + '」建好了，' + (picked.length ? names(picked.map(P)) + '在群里' : '还没有人在群里'), function () { db.n++; db.people.push({ id: id, kind: 'group', name: name }); picked.forEach(function (m) { P(m).phone.push(id); }); }); }
  };
  document.addEventListener('click', function (e) {
    var g = e.target.closest('[data-go]'); if (g) { var page = JSON.parse(g.getAttribute('data-go')); if (wide() && g.closest('.pane.l')) ui.stack = []; ui.stack.push(page); draw(); return; }
    var d = e.target.closest('button[data-do]'); if (!d) return; e.preventDefault(); DO[d.getAttribute('data-do')](d);
  });
  document.addEventListener('submit', function (e) { var f = e.target.closest('form[data-do]'); if (f) { e.preventDefault(); DO[f.getAttribute('data-do')](f); } });
  document.addEventListener('input', function (e) { if (e.target.id === 'q') { ui.q = e.target.value; filter(); } }); /* 搜索只隐藏行，不重画，输入法和光标都不受影响 */

  has3d = !!(window.Office && window.Office.init($('stage'), $('labels'), pick));
  if (!has3d) $('fail').hidden = false;
  if (wideMq.addEventListener) wideMq.addEventListener('change', function () { draw(); });
  draw(); sync();
  window.__app = { db: function () { return db; }, canFind: canFind, canUse: canUse };
})();
