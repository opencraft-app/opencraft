/* OpenCraft Bot 手机：最小 demo。整个页面只讲一句话：
   你有几个 Bot。每个 Bot 有一部手机和一台电脑：手机里有谁，他就能找谁；电脑上有什么，他就能用什么。你也一样，只能找你手机里的 Bot。
   首页就是你的手机：在你手机里的 Bot 和不在的分两组；点开一个 Bot 是一页：他的名片、和你的对话、他的手机、他的电脑。
   所有说法都是「谁 能找 谁」「谁 能用 什么」，主语在前。改动一点就生效，底部用同一句式说出结果，并给一次撤销，不弹确认。
   也能反过来看：公司外的人和每样东西，都能点开看谁能找到他、谁能用它。这是原型，没有接真实的 Bot：你发出去的话不会有人回。 */
(function () {
  'use strict';
  var KEY = 'opencraft.bots.v2', $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var COLORS = ['#e9e6f0', '#a9dcc9', '#a9c8f2', '#fbe39c', '#c3b5ee', '#f9cdb0', '#bfe3ee'];
  var NAMES = ['青柚', '白榆', '半夏', '南星', '远山', '知秋'];

  /* ================= 数据 =================
     people：你（kind me）、Bot、公司外的人（kind out）。phone 是这个人手机里的人；pc 是 Bot 电脑上的东西。
     msgs 是两人之间的消息；doing 是 Bot 正在做的事（用哪样东西）；log 是最近用电脑上的东西做过的事。 */
  function sample() {
    var now = Date.now(), ago = function (m) { return now - m * 60000; };
    return {
      people: [
        { id: 'me', kind: 'me', name: '你', look: 0, phone: ['a', 'c'] },
        { id: 'a', kind: 'bot', name: '阿岚', role: '项目交付', look: 1, phone: ['me', 'z'], pc: ['mac', 'mail', 'drive'] },
        { id: 'c', kind: 'bot', name: '沐川', role: '行政', look: 2, phone: ['me', 'a'], pc: ['mac', 'mail', 'drive'] },
        { id: 'z', kind: 'bot', name: '小折', role: '文档核对', look: 3, phone: ['a'], pc: ['drive'] },
        { id: 'o1', kind: 'out', name: '客户周姐', look: 5 }
      ],
      tools: [{ id: 'mac', name: '办公室的 Mac mini' }, { id: 'mail', name: '企业邮箱' }, { id: 'drive', name: '公司网盘' }],
      msgs: [
        { from: 'me', to: 'a', text: '周五把 2.3 版本交给客户，你来负责。', ts: ago(90) },
        { from: 'a', to: 'z', text: '帮我核一下签字页的版本和页码。', ts: ago(60) },
        { from: 'z', to: 'a', text: '在核了，一会儿给你。', ts: ago(55) },
        { from: 'a', to: 'me', text: '签字页让小折在核，周五上午我发给客户。', ts: ago(50) },
        { from: 'me', to: 'c', text: '把 10 月的报销整理一下。', ts: ago(40) },
        { from: 'c', to: 'me', text: '在登记了，周五前给你。', ts: ago(30) }
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
  try { var raw = JSON.parse(localStorage.getItem(KEY)); if (raw && raw.people && raw.v === 2) db = raw; } catch (e) { /* 没有存储也能用 */ }
  function save() { db.v = 2; try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ } }

  function P(id) { return db.people.filter(function (x) { return x.id === id; })[0]; }
  function T(id) { return db.tools.filter(function (x) { return x.id === id; })[0]; }
  function bots() { return db.people.filter(function (x) { return x.kind === 'bot'; }); }
  function N(id) { return (P(id) || {}).name || ''; }

  /* ================= 三条规则 =================
     一和三：手机里有谁，就能找谁（你和 Bot 一样）。二：电脑上有什么，就能用什么。 */
  function canFind(a, b) { var x = P(a); return !!x && (x.phone || []).indexOf(b) >= 0; }
  function canUse(a, t) { var x = P(a); return !!x && (x.pc || []).indexOf(t) >= 0; }

  function finders(id) { return bots().concat(P('me')).filter(function (x) { return x.id !== id && canFind(x.id, id); }); } /* 谁的手机里有他 */
  function users(t) { return bots().filter(function (x) { return canUse(x.id, t); }); }
  function names(list) { return list.map(function (x) { return x.name; }).join('、'); }
  function thread(a, b) { return db.msgs.filter(function (m) { return (m.from === a && m.to === b) || (m.from === b && m.to === a); }); }
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
  var ui = { stack: [], view: 'list', sel: null }, has3d = false;
  var wideMq = window.matchMedia ? matchMedia('(min-width: 900px)') : { matches: false };
  function wide() { return wideMq.matches && ui.view === 'list'; }
  function top() { return ui.stack[ui.stack.length - 1]; }
  function cur() { var t = top(); return t && P(t.id); }
  var SVG = function (d, w) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (w || 1.8) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; };
  var ICON = { back: SVG('<path d="m14.500 5-7 7 7 7"/>', 2), send: SVG('<path d="M12 19V5.500M5.800 11.500 12 5.300l6.200 6.200"/>', 2.2), x: SVG('<path d="M7 7l10 10M17 7 7 17"/>', 2.2),
    phone: SVG('<rect x="7" y="3" width="10" height="18" rx="2.500"/><path d="M11 18h2"/>'), pc: SVG('<rect x="3.500" y="4.500" width="17" height="11.500" rx="1.800"/><path d="M8.500 20h7M12 16v4"/>'), chat: SVG('<path d="M12 4.500c-4.700 0-8.500 3.100-8.500 7 0 2.200 1.200 4.100 3.100 5.400L6 20l3.400-1.600c.8.200 1.700.300 2.600.300 4.700 0 8.500-3.100 8.500-7s-3.800-7.200-8.500-7.200z"/>'), plus: SVG('<path d="M12 6v12M6 12h12"/>', 2) };
  function av(id, cls) { var p = P(id); return '<span class="av' + (cls ? ' ' + cls : '') + '" style="--c:' + COLORS[((p || {}).look || 0) % COLORS.length] + '" aria-hidden="true"></span>'; }
  function go(page) { return ' data-go=\'' + esc(JSON.stringify(page)) + '\''; }
  function tag(x) { return x.kind === 'out' ? '<em>公司外</em>' : ''; }
  function status(b) { var d = db.doing[b.id]; return d ? '<span class="status busy">正在' + esc(d.text) + '</span>' : '<span class="status">空闲</span>'; }
  function backBtn() { return wide() && ui.stack.length <= 1 ? '' : '<button class="ic" data-do="back" aria-label="返回">' + ICON.back + '</button>'; } /* 宽屏右边那一层是默认打开的，不需要返回 */
  function head(title, sub) { return '<header class="head">' + backBtn() + '<div class="ht"><h1>' + title + '</h1>' + (sub ? '<p>' + sub + '</p>' : '') + '</div></header>'; }
  function line(m, self) { var mine = m.from === self; return '<div class="msg' + (mine ? ' out' : '') + '">' + (mine ? '' : '<span class="nm">' + esc(N(m.from)) + '</span>') + '<div class="bub">' + esc(m.text) + '</div></div>'; }

  /* ---------- 首页：你的手机。在你手机里的 Bot 和不在的分两组，每行都能直接加入或移出 ---------- */
  function home() {
    var t = top(), inMine = bots().filter(function (b) { return canFind('me', b.id); }), outMine = bots().filter(function (b) { return !canFind('me', b.id); });
    function row(b, inside) { return '<div class="row' + (t && t.id === b.id ? ' on' : '') + '"><button class="row-main"' + go({ k: 'bot', id: b.id }) + '>' + av(b.id) + '<span class="t"><b>' + esc(b.name) + '<i>' + esc(b.role) + '</i></b>' + status(b) + '</span></button>' +
      (inside ? '<button class="btn sm ghost" data-do="meout" data-id="' + b.id + '">移出</button>' : '<button class="btn sm" data-do="mein" data-id="' + b.id + '">加入</button>') + '</div>'; }
    return '<div class="page">' + '<header class="head home"><div class="ht"><h1>我的 Bot</h1></div><div class="seg" role="tablist" aria-label="看法"><button role="tab" data-do="view" data-id="list" aria-selected="' + (ui.view === 'list') + '">列表</button><button role="tab" data-do="view" data-id="office" aria-selected="' + (ui.view === 'office') + '">办公室</button></div></header>' +
      '<div class="body"><p class="rules"><b>手机</b>里有谁，就能找谁；<b>电脑</b>上有什么，就能用什么。你也一样。</p>' +
      '<h2 class="group">你能找的 <i>' + inMine.length + '</i></h2><p class="cap">在你手机里</p><div class="card">' + (inMine.length ? inMine.map(function (b) { return row(b, true); }).join('') : '<p class="none pad">你的手机里还没有 Bot，你现在谁也找不到。</p>') + '</div>' +
      (outMine.length ? '<h2 class="group">你找不到的 <i>' + outMine.length + '</i></h2><p class="cap">不在你手机里。他们照常干活，只是你找不到。</p><div class="card">' + outMine.map(function (b) { return row(b, false); }).join('') + '</div>' : '') +
      reverse() +
      '<button class="newbot"' + go({ k: 'new' }) + '>' + ICON.plus + '新 Bot</button>' +
      '<p class="foot">这是原型，没有接真实的 Bot，你发出去的话不会有人回。<button class="lk" data-do="reset">恢复示例</button></p></div></div>';
  }

  /* 反过来看：公司外的人被谁找得到，每样东西被谁用着 */
  function reverse() {
    var t = top(), outs = db.people.filter(function (x) { return x.kind === 'out'; });
    function row(page, icon, name, n, verb) { var on = t && t.k === page.k && (t.id || t.t) === (page.id || page.t);
      return '<div class="row' + (on ? ' on' : '') + '"><button class="row-main"' + go(page) + '>' + icon + '<span class="t"><b>' + esc(name) + '</b><span class="status">' + (n.length ? esc(names(n)) + ' ' + verb : verb === '能找' ? '谁也找不到' : '谁也用不了') + '</span></span><span class="chev" aria-hidden="true">›</span></button></div>'; }
    return '<h2 class="group">反过来看</h2><p class="cap">谁能找到公司外的人，谁能用公司的东西</p><div class="card">' +
      outs.map(function (x) { return row({ k: 'who', id: x.id }, av(x.id), x.name, finders(x.id), '能找'); }).join('') +
      db.tools.map(function (x) { return row({ k: 'use', t: x.id }, '<span class="tic" aria-hidden="true">' + esc(x.name.slice(0, 1)) + '</span>', x.name, users(x.id), '能用'); }).join('') + '</div>';
  }
  /* 一个人或一样东西：分「能」和「不能」两组，和首页同一个样子，每行直接加入或移出 */
  function reach(kind, id) {
    var isTool = kind === 'use', name = isTool ? T(id).name : P(id).name, verb = isTool ? '用' : '找', has = function (b) { return isTool ? canUse(b.id, id) : canFind(b.id, id); };
    var yes = bots().filter(has), no = bots().filter(function (b) { return !has(b); });
    function row(b, inside) { return '<div class="row"><button class="row-main"' + go({ k: 'bot', id: b.id }) + '>' + av(b.id) + '<span class="t"><b>' + esc(b.name) + '<i>' + esc(b.role) + '</i></b><span class="status">' + (inside ? '能' : '不能') + verb + esc(name) + '</span></span></button>' +
      (inside ? '<button class="btn sm ghost" data-do="revoke" data-id="' + b.id + '">移除</button>' : '<button class="btn sm" data-do="grant" data-id="' + b.id + '">给他</button>') + '</div>'; }
    var where = isTool ? '电脑上' : '手机里';
    return '<div class="page">' + head(esc(name), isTool ? '公司的东西' : '公司外的人') + '<div class="body">' +
      '<h2 class="group">能' + verb + esc(name) + '的 <i>' + yes.length + '</i></h2><p class="cap">' + where + '有' + esc(name) + '</p><div class="card">' + (yes.length ? yes.map(function (b) { return row(b, true); }).join('') : '<p class="none pad">现在谁也' + (isTool ? '用不了' : '找不到') + esc(name) + '。</p>') + '</div>' +
      (no.length ? '<h2 class="group">' + (isTool ? '用不了' : '找不到') + '的 <i>' + no.length + '</i></h2><div class="card">' + no.map(function (b) { return row(b, false); }).join('') + '</div>' : '') + '</div></div>';
  }

  /* ---------- 一个 Bot：名片、和你的对话、他的手机、他的电脑 ---------- */
  function mineFirst(list) { list = list || []; return list.indexOf('me') >= 0 ? ['me'].concat(without(list, 'me')) : list; } /* “你”永远排第一个 */
  function bot(b) {
    var mine = canFind('me', b.id), t = thread('me', b.id), d = db.doing[b.id], recent = db.log.filter(function (r) { return r.who === b.id; }).sort(function (x, y) { return y.ts - x.ts; }).slice(0, 2);
    var hero = '<header class="hero">' + backBtn() + av(b.id, 'xl') + '<div class="ht"><h1>' + esc(b.name) + '<i>' + esc(b.role) + '</i></h1><p>' + status(b) + '</p></div>' +
      (mine ? '<button class="btn ok"' + go({ k: 'chat', id: b.id }) + '>' + ICON.chat + '发消息</button>' : '<button class="btn" data-do="mein" data-id="' + b.id + '">加到我的手机</button>') + '</header>';
    var chat = '<button class="card convo"' + go({ k: 'chat', id: b.id }) + '><span class="convo-h">和你的对话' + (mine ? '' : '<em>他不在你手机里，只能看</em>') + '</span>' +
      (t.length ? t.slice(-2).map(function (m) { return line(m, 'me'); }).join('') : '<p class="none">还没说过话。</p>') + '<span class="more">打开对话 ›</span></button>';
    var phone = '<section class="card panel"><div class="panel-h"><span class="pi">' + ICON.phone + '</span><div><h2>他的手机</h2><p>手机里有谁，他就能找谁。</p></div><i>' + (b.phone || []).length + ' 人</i></div><div class="tiles">' +
      mineFirst(b.phone).map(function (j) { var x = P(j); if (!x) return '';
        return '<div class="tile"><button class="tile-main"' + go(j === 'me' ? { k: 'chat', id: b.id } : { k: 'peek', id: b.id, w: j }) + '>' + av(j, 'lg') + '<span>' + esc(x.name) + '</span>' + tag(x) + '</button><button class="tile-x" data-do="unfriend" data-id="' + j + '" aria-label="从' + esc(b.name) + '的手机里移除' + esc(x.name) + '">' + ICON.x + '</button></div>'; }).join('') +
      '<button class="tile addtile"' + go({ k: 'add', id: b.id }) + '><span class="plusbox">' + ICON.plus + '</span><span>添加</span></button></div>' +
      ((b.phone || []).length ? '' : '<p class="empty-note">手机里没有人，他谁也找不到。</p>') +
      '<p class="recent">反过来，' + (finders(b.id).length ? esc(names(finders(b.id))) + '能找他。' : '谁也找不到他。') + '</p></section>';
    var pc = '<section class="card panel"><div class="panel-h"><span class="pi">' + ICON.pc + '</span><div><h2>他的电脑</h2><p>电脑上有什么，他就能用什么。</p></div><i>' + (b.pc || []).length + ' 样</i></div>' +
      (d ? '<div class="doing"><span class="dot" aria-hidden="true"></span><span class="t"><b>正在' + esc(d.text) + '</b><span>' + esc(ago(d.ts)) + '开始 · 用' + esc((T(d.tool) || {}).name || '') + '</span></span><button class="btn sm danger" data-do="stop">停下</button></div>' : '') +
      '<div class="tools">' + (b.pc || []).map(function (id) { var x = T(id); return x ? '<div class="tool"><button class="tool-main"' + go({ k: 'use', t: id }) + '><span class="tic" aria-hidden="true">' + esc(x.name.slice(0, 1)) + '</span><span class="t"><b>' + esc(x.name) + '</b><span>' + esc(users(id).length > 1 ? '还有 ' + (users(id).length - 1) + ' 个 Bot 能用' : '只有他能用') + '</span></span></button><button class="btn sm ghost" data-do="untool" data-id="' + id + '">移除</button></div>' : ''; }).join('') +
      '<button class="tool add"' + go({ k: 'tools', id: b.id }) + '><span class="tic plusbox" aria-hidden="true">' + ICON.plus + '</span><span class="t"><b>添加</b></span></button></div>' +
      ((b.pc || []).length ? '' : '<p class="empty-note">电脑上什么都没有，他现在只能聊天。</p>') +
      (recent.length ? '<p class="recent">最近：' + recent.map(function (r) { return esc(ago(r.ts) + '用' + ((T(r.tool) || {}).name || '') + r.text); }).join('；') + '</p>' : '') + '</section>';
    return '<div class="page">' + hero + '<div class="body">' + chat + '<div class="split2">' + phone + pc + '</div><button class="lk danger" data-do="fire">删掉这个 Bot</button></div></div>';
  }
  /* 你和他的对话 */
  function chat(b) { var ok = canFind('me', b.id);
    return '<div class="page">' + head(av(b.id, 'hd') + esc(b.name), esc(b.role)) + '<div class="body chat" id="chat">' + (thread('me', b.id).map(function (m) { return line(m, 'me'); }).join('') || '<p class="none center">还没说过话。对他说第一件要办的事。</p>') + '</div>' +
      (ok ? '<form class="say" data-do="say"><input id="say" autocomplete="off" enterkeyhint="send" placeholder="对' + esc(b.name) + '说要办什么" aria-label="对' + esc(b.name) + '说"><button class="send" aria-label="发送">' + ICON.send + '</button></form>'
        : '<div class="say off"><span>你找不到' + esc(b.name) + '：他不在你手机里。</span><button class="btn sm" data-do="mein" data-id="' + b.id + '">加到我的手机</button></div>') + '</div>'; }
  /* 看他和某人的聊天（只读）；底部说清楚两个方向，也能在这里移除 */
  function peek(b, w) { var x = P(w), t = thread(b.id, w), there = canFind(b.id, w), back = x.kind === 'out' ? null : canFind(w, b.id);
    var fwd = b.name + (there ? '能找' : '找不到') + x.name + '。';
    var rev = back === null ? x.name + '是公司外的人，没有这部手机。' : x.name + (back ? '能找' : '找不到') + b.name + '。';
    return '<div class="page">' + head(esc(b.name) + ' 和 ' + esc(x.name), '只能看，不能替他回') + '<div class="body chat">' + (t.map(function (m) { return line(m, b.id); }).join('') || '<p class="none center">他们还没聊过。</p>') + '</div>' +
      '<div class="say off two"><span><b>' + esc(fwd) + '</b><br>' + esc(rev) + (x.kind === 'out' ? ' <button class="lk"' + go({ k: 'who', id: w }) + '>谁能找' + esc(x.name) + ' ›</button>' : '') + '</span>' + (there ? '<button class="btn sm danger" data-do="unfriend" data-id="' + w + '">从' + esc(b.name) + '手机里移除</button>' : '<button class="btn sm" data-do="friend" data-id="' + w + '">加回去</button>') + '</div></div>'; }
  function addContact(b) { var list = db.people.filter(function (x) { return x.id !== b.id && (b.phone || []).indexOf(x.id) < 0; });
    return '<div class="page">' + head('加到' + esc(b.name) + '的手机', '加进去，' + esc(b.name) + '就能找这个人') + '<div class="body"><div class="card">' + (list.length ? list.map(function (x) { return '<div class="row"><span class="row-main static">' + av(x.id) + '<span class="t"><b>' + esc(x.name) + tag(x) + '</b></span></span><button class="btn sm" data-do="friend" data-id="' + x.id + '" data-pop="1">添加</button></div>'; }).join('') : '<p class="none pad">大家都已经在他手机里了。</p>') + '</div>' +
      '<form class="inl" data-do="newout"><input id="outname" autocomplete="off" placeholder="公司外的人，例如：供应商老秦" aria-label="公司外的人"><button class="btn">添加</button></form></div></div>'; }
  function addTool(b) { var list = db.tools.filter(function (t) { return (b.pc || []).indexOf(t.id) < 0; });
    return '<div class="page">' + head('放到' + esc(b.name) + '的电脑上', '放上去，' + esc(b.name) + '就能用') + '<div class="body"><div class="card">' + (list.length ? list.map(function (t) { return '<div class="row"><span class="row-main static"><span class="tic" aria-hidden="true">' + esc(t.name.slice(0, 1)) + '</span><span class="t"><b>' + esc(t.name) + '</b></span></span><button class="btn sm" data-do="tool" data-id="' + t.id + '">添加</button></div>'; }).join('') : '<p class="none pad">公司里的都已经给他了。</p>') + '</div>' +
      '<form class="inl" data-do="newtool"><input id="toolname" autocomplete="off" placeholder="新的，例如：钉钉、云测试环境" aria-label="新的东西"><button class="btn">添加</button></form></div></div>'; }
  function newBot() { var used = db.people.map(function (x) { return x.name; }), name = NAMES.filter(function (n) { return used.indexOf(n) < 0; })[0] || '新 Bot';
    return '<div class="page">' + head('新 Bot', '他的手机里先只有你，电脑上什么都没有') + '<form class="body" data-do="hire"><div class="card form"><label class="fld"><span>名字</span><input id="bname" autocomplete="off" value="' + esc(name) + '"></label><label class="fld"><span>岗位</span><input id="brole" autocomplete="off" placeholder="例如：客服"></label></div><button class="btn ok wide">创建</button></form></div>'; }

  /* ---------- 办公室：同一批人换一种看法。箭头是他手机里的人 ---------- */
  function toScene() {
    var nodes = db.people.map(function (p) { return { id: p.id, name: p.name, kind: p.kind === 'me' ? 'me' : p.kind === 'out' ? 'out' : 'bot', look: p.look, busy: !!db.doing[p.id], pc: p.kind === 'bot' && (p.pc || []).length > 0 }; }), links = [];
    db.people.forEach(function (p) { (p.phone || []).forEach(function (j) { if (P(j)) links.push([p.id, j]); }); });
    return { nodes: nodes, links: links, boss: [] };
  }
  function sync() { if (has3d) { window.Office.sync(toScene()); window.Office.select(ui.sel, ui.sel ? (P(ui.sel).phone || []) : [], []); } }
  function pick(id) { if (id && !P(id)) id = null; ui.sel = id; draw(); if (has3d) window.Office.select(id, id ? (P(id).phone || []) : [], []); }
  function card() { var p = P(ui.sel), seg = '<div class="seg"><button data-do="view" data-id="list">列表</button><button aria-selected="true">办公室</button></div>';
    if (!p) return '<div class="hint"><span>箭头指向他手机里的人。点一个人看看。</span>' + seg + '</div>';
    return '<div class="pcard">' + av(p.id) + '<span class="t"><b>' + esc(p.name) + (p.role ? '<i>' + esc(p.role) + '</i>' : '') + '</b><span>' + (p.kind === 'bot' ? status(p) : p.kind === 'out' ? '公司外的人' : '你的手机里有 ' + (p.phone || []).length + ' 个 Bot') + '</span></span>' +
      (p.kind === 'bot' ? '<button class="btn sm ok" data-do="open" data-id="' + p.id + '">打开</button>' : '') + '<button class="btn sm" data-do="view" data-id="list">回到列表</button></div>'; }

  /* ---------- 画页面 ---------- */
  var PAGES = { bot: bot, chat: chat, add: addContact, tools: addTool };
  function draw() {
    var view = $('view'), t;
    if (wide() && !ui.stack.length) { var first = bots().filter(function (b) { return canFind('me', b.id); })[0] || bots()[0]; if (first) ui.stack = [{ k: 'bot', id: first.id }]; } /* 宽屏默认打开第一个 Bot */
    t = top(); while (t && ((t.id && !P(t.id)) || (t.w && !P(t.w)) || (t.t && !T(t.t)))) { ui.stack.pop(); t = top(); }
    var key = JSON.stringify(t || ''), same = view.getAttribute('data-key') === key, b0 = view.querySelector('.pane.r .body') || view.querySelector('.body'), keep = b0 ? b0.scrollTop : 0;
    var page = !t ? '' : t.k === 'peek' ? peek(P(t.id), t.w) : t.k === 'new' ? newBot() : t.k === 'who' ? reach('who', t.id) : t.k === 'use' ? reach('use', t.t) : PAGES[t.k](P(t.id)), office = ui.view === 'office';
    view.hidden = office; $('office').hidden = !office;
    view.classList.toggle('split', wide());
    view.innerHTML = wide() ? '<div class="pane l">' + home() + '</div><div class="pane r">' + (page || '<p class="blank">还没有 Bot</p>') + '</div>' : page || home();
    view.setAttribute('data-key', key);
    var nb = view.querySelector('.pane.r .body') || view.querySelector('.body'); if (nb && same) nb.scrollTop = keep; var c = $('chat'); if (c) c.scrollTop = c.scrollHeight;
    $('card').innerHTML = office ? card() : '';
    paintToast();
    if (office && has3d) window.Office.resize();
  }
  function refresh() { sync(); $('view').removeAttribute('data-key'); draw(); }

  var DO = {
    back: function () { ui.stack.pop(); draw(); },
    view: function (el) { ui.view = el.getAttribute('data-id'); if (ui.view === 'office') ui.stack = []; draw(); if (ui.view === 'office') sync(); },
    open: function (el) { ui.view = 'list'; ui.stack = [{ k: 'bot', id: el.getAttribute('data-id') }]; draw(); },
    undo: undo,
    reset: function () { change('已恢复示例', function () { db = sample(); ui.stack = []; ui.sel = null; }); },
    say: function () { var v = $('say').value.trim(), b = cur(); if (!v || !b || !canFind('me', b.id)) return; db.msgs.push({ from: 'me', to: b.id, text: v, ts: Date.now() }); save(); refresh(); $('say').focus(); },
    mein: function (el) { var id = el.getAttribute('data-id'); change('你现在能找' + N(id) + '了', function () { var me = P('me'); me.phone = without(me.phone, id).concat(id); }); },
    meout: function (el) { var id = el.getAttribute('data-id'); change('你现在找不到' + N(id) + '了', function () { var me = P('me'); me.phone = without(me.phone, id); }); },
    friend: function (el) { var b = cur(), id = el.getAttribute('data-id'); if (el.hasAttribute('data-pop')) ui.stack.pop(); change(b.name + '现在能找' + N(id) + '了', function () { b.phone = without(b.phone, id).concat(id); }); },
    unfriend: function (el) { var b = cur(), id = el.getAttribute('data-id'); change(b.name + '现在找不到' + N(id) + '了', function () { b.phone = without(b.phone, id); }); },
    tool: function (el) { var b = cur(), id = el.getAttribute('data-id'); ui.stack.pop(); change(b.name + '现在能用' + T(id).name + '了', function () { b.pc = without(b.pc, id).concat(id); }); },
    untool: function (el) { var b = cur(), id = el.getAttribute('data-id'), d = db.doing[b.id];
      change(b.name + '现在用不了' + T(id).name + '了' + (d && d.tool === id ? '，手上的事也停了' : ''), function () { b.pc = without(b.pc, id); if (d && d.tool === id) delete db.doing[b.id]; }); }, /* 拿走正在用的东西，手上的事也就停了 */
    grant: function (el) { var t = top(), b = P(el.getAttribute('data-id'));
      if (t.k === 'use') change(b.name + '现在能用' + T(t.t).name + '了', function () { b.pc = without(b.pc, t.t).concat(t.t); });
      else change(b.name + '现在能找' + N(t.id) + '了', function () { b.phone = without(b.phone, t.id).concat(t.id); }); },
    revoke: function (el) { var t = top(), b = P(el.getAttribute('data-id')), d = db.doing[b.id];
      if (t.k === 'use') change(b.name + '现在用不了' + T(t.t).name + '了' + (d && d.tool === t.t ? '，手上的事也停了' : ''), function () { b.pc = without(b.pc, t.t); if (d && d.tool === t.t) delete db.doing[b.id]; });
      else change(b.name + '现在找不到' + N(t.id) + '了', function () { b.phone = without(b.phone, t.id); }); },
    stop: function () { var b = cur(); change(b.name + '停下了，现在空闲', function () { delete db.doing[b.id]; }); },
    fire: function () { var b = cur(); ui.stack = []; change('已删掉' + b.name + '，谁也找不到他了', function () { db.people = db.people.filter(function (x) { return x.id !== b.id; }); db.people.forEach(function (x) { x.phone = without(x.phone, b.id); }); db.msgs = db.msgs.filter(function (m) { return m.from !== b.id && m.to !== b.id; }); delete db.doing[b.id]; }); },
    newout: function () { var v = $('outname').value.trim(), b = cur(); if (!v) { $('outname').focus(); return; } ui.stack.pop(); change(b.name + '现在能找' + v + '了', function () { var o = { id: 'o' + (++db.n), kind: 'out', name: v, look: 5 }; db.people.push(o); b.phone.push(o.id); }); },
    newtool: function () { var v = $('toolname').value.trim(), b = cur(); if (!v) { $('toolname').focus(); return; } ui.stack.pop(); change(b.name + '现在能用' + v + '了', function () { var t = { id: 't' + (++db.n), name: v }; db.tools.push(t); b.pc.push(t.id); }); },
    hire: function () { var name = $('bname').value.trim() || $('bname').defaultValue, role = $('brole').value.trim() || '未填岗位', id = 'b' + (db.n + 1);
      ui.stack = [{ k: 'bot', id: id }]; change(name + '来了：你能找他，他也能找你', function () { db.n++; db.people.push({ id: id, kind: 'bot', name: name, role: role, look: 1 + db.n % 6, phone: ['me'], pc: [] }); P('me').phone.push(id); }); }
  };
  document.addEventListener('click', function (e) {
    var g = e.target.closest('[data-go]'); if (g) { var page = JSON.parse(g.getAttribute('data-go')); if (wide() && g.closest('.pane.l')) ui.stack = []; ui.stack.push(page); draw(); return; }
    var d = e.target.closest('button[data-do]'); if (!d) return; e.preventDefault(); DO[d.getAttribute('data-do')](d);
  });
  document.addEventListener('submit', function (e) { var f = e.target.closest('form[data-do]'); if (f) { e.preventDefault(); DO[f.getAttribute('data-do')](f); } });

  has3d = !!(window.Office && window.Office.init($('stage'), $('labels'), pick));
  if (!has3d) $('fail').hidden = false;
  if (wideMq.addEventListener) wideMq.addEventListener('change', function () { draw(); });
  draw(); sync();
  window.__app = { db: function () { return db; }, canFind: canFind, canUse: canUse };
})();
