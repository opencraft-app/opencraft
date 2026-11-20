/* OpenCraft Bot 手机：最小 demo。整个页面只讲一句话：
   你有几个 Bot。每个 Bot 有一部手机和一台电脑：手机里有谁，他就能找谁；电脑上有什么，他就能用什么。你也一样，只能找你手机里的 Bot。
   首页是你的 Bot 列表（可以切到办公室看同一批人）；点开一个 Bot 是一页：和你的对话、他的手机、他的电脑。
   这是原型，没有接真实的 Bot：你发出去的话不会有人回。 */
(function () {
  'use strict';
  var KEY = 'opencraft.bots.v1', $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var COLORS = ['#e9e6f0', '#a9dcc9', '#a9c8f2', '#fbe39c', '#c3b5ee', '#f9cdb0', '#bfe3ee'];
  var NAMES = ['青柚', '白榆', '半夏', '南星', '远山', '知秋'];

  /* ---------- 数据：人（你、Bot、公司外的人）、手机（各自能找谁）、电脑（Bot 能用什么）、消息、正在做的事、最近的记录 ---------- */
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
  try { var raw = JSON.parse(localStorage.getItem(KEY)); if (raw && raw.people && raw.v === 1) db = raw; } catch (e) { /* 没有存储也能用 */ }
  function save() { db.v = 1; try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ } }

  function P(id) { return db.people.filter(function (x) { return x.id === id; })[0]; }
  function T(id) { return db.tools.filter(function (x) { return x.id === id; })[0]; }
  function bots() { return db.people.filter(function (x) { return x.kind === 'bot'; }); }
  /* 规则一和三：手机里有谁，就能找谁（你和 Bot 一样）。规则二：电脑上有什么，就能用什么 */
  function canFind(a, b) { var x = P(a); return !!x && (x.phone || []).indexOf(b) >= 0; }
  function canUse(a, t) { var x = P(a); return !!x && (x.pc || []).indexOf(t) >= 0; }
  function thread(a, b) { return db.msgs.filter(function (m) { return (m.from === a && m.to === b) || (m.from === b && m.to === a); }); }
  function hhmm(ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function ago(ts) { var m = Math.round((Date.now() - ts) / 60000); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : hhmm(ts); }
  function tag(x) { return x.kind === 'out' ? '<em>公司外</em>' : ''; }

  /* ---------- 界面 ---------- */
  var ui = { stack: [], view: 'list', sel: null }, has3d = false;
  var wideMq = window.matchMedia ? matchMedia('(min-width: 900px)') : { matches: false };
  function wide() { return wideMq.matches && ui.view === 'list'; }
  function top() { return ui.stack[ui.stack.length - 1]; }
  var ICON = { back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14.500 5-7 7 7 7"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5.500M5.800 11.500 12 5.300l6.200 6.200"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>' };
  function av(id, cls) { var p = P(id); return '<span class="av' + (cls ? ' ' + cls : '') + '" style="--c:' + COLORS[((p || {}).look || 0) % COLORS.length] + '" aria-hidden="true"></span>'; }
  function go(page) { return ' data-go=\'' + esc(JSON.stringify(page)) + '\''; }
  function head(title, sub, right) { return '<header class="head">' + (ui.stack.length && !(wide() && ui.stack.length === 1 && false) ? '<button class="ic" data-do="back" aria-label="返回">' + ICON.back + '</button>' : '') + '<div class="ht"><h1>' + title + '</h1>' + (sub ? '<p>' + sub + '</p>' : '') + '</div>' + (right || '') + '</header>'; }
  function line(m, self) { var mine = m.from === self; return '<div class="msg' + (mine ? ' out' : '') + '">' + (mine ? '' : '<span class="nm">' + esc(P(m.from) ? P(m.from).name : '') + '</span>') + '<div class="bub">' + esc(m.text) + '</div></div>'; }

  /* 首页：你的 Bot。最上面是三条规则 */
  function home() {
    var list = bots();
    return '<div class="page">' + '<header class="head home"><div class="ht"><h1>我的 Bot</h1></div><div class="seg" role="tablist"><button role="tab" data-do="view" data-id="list" aria-selected="' + (ui.view === 'list') + '">列表</button><button role="tab" data-do="view" data-id="office" aria-selected="' + (ui.view === 'office') + '">办公室</button></div></header>' +
      '<div class="body"><ol class="rules"><li>手机里有谁，他就能找谁。</li><li>电脑上有什么，他就能用什么。</li><li>你也一样，只能找你手机里的 Bot。</li></ol>' +
      '<div class="card">' + list.map(function (b) { var d = db.doing[b.id], l = thread('me', b.id).slice(-1)[0], t = top();
        return '<button class="row' + (t && t.id === b.id ? ' on' : '') + '"' + go({ k: 'bot', id: b.id }) + '>' + av(b.id) + '<span class="t"><b>' + esc(b.name) + '<i>' + esc(b.role) + '</i></b><span>' + (d ? '<span class="live">正在' + esc(d.text) + '</span>' : l ? esc((l.from === 'me' ? '你：' : '') + l.text) : '还没说过话') + '</span></span>' + (canFind('me', b.id) ? '' : '<em>不在你手机里</em>') + '</button>'; }).join('') +
      '<button class="row add"' + go({ k: 'new' }) + '><span class="av plus" aria-hidden="true">+</span><span class="t"><b>新 Bot</b></span></button></div>' +
      '<p class="foot">这是原型，没有接真实的 Bot，你发出去的话不会有人回。<button class="lk" data-do="reset">恢复示例</button></p></div></div>';
  }
  /* 一个 Bot：一页从上到下，和你的对话、他的手机、他的电脑 */
  function bot(b) {
    var t = thread('me', b.id), d = db.doing[b.id], recent = db.log.filter(function (r) { return r.who === b.id; }).sort(function (x, y) { return y.ts - x.ts; }).slice(0, 3);
    var chat = '<section class="sec"><h2>和你的对话</h2><button class="card chatcard"' + go({ k: 'chat', id: b.id }) + '>' + (t.length ? t.slice(-2).map(function (m) { return line(m, 'me'); }).join('') : '<p class="none">还没说过话。</p>') + '<span class="more">' + (canFind('me', b.id) ? '打开对话' : '他不在你的手机里，只能看') + ' ›</span></button></section>';
    var phone = '<section class="sec"><h2>他的手机</h2><p class="cap">手机里有谁，他就能找谁。</p><div class="tiles">' + (b.phone || []).map(function (j) { var x = P(j); if (!x) return '';
        return '<div class="tile"><button class="tile-main"' + go({ k: 'peek', id: b.id, w: j }) + '>' + av(j, 'lg') + '<span>' + esc(x.name) + '</span>' + tag(x) + '</button><button class="tile-x" data-do="unfriend" data-id="' + j + '" aria-label="从' + esc(b.name) + '的手机里移除' + esc(x.name) + '">' + ICON.x + '</button></div>'; }).join('') +
      '<button class="tile addtile"' + go({ k: 'add', id: b.id }) + '><span class="av lg plus" aria-hidden="true">+</span><span>添加</span></button></div></section>';
    var pc = '<section class="sec"><h2>他的电脑</h2><p class="cap">电脑上有什么，他就能用什么。</p><div class="card">' +
      (d ? '<div class="row static doing"><span class="dot" aria-hidden="true"></span><span class="t"><b>正在' + esc(d.text) + '</b><span>' + esc(ago(d.ts)) + '开始 · 用' + esc((T(d.tool) || {}).name || '') + '</span></span><button class="btn sm danger" data-do="stop">停下</button></div>' : '') +
      (b.pc || []).map(function (id) { var x = T(id); return x ? '<div class="row static"><span class="tic" aria-hidden="true">' + esc(x.name.slice(0, 1)) + '</span><span class="t"><b>' + esc(x.name) + '</b></span><button class="btn sm ghost" data-do="untool" data-id="' + id + '">移除</button></div>' : ''; }).join('') +
      '<button class="row add"' + go({ k: 'tools', id: b.id }) + '><span class="tic plus" aria-hidden="true">+</span><span class="t"><b>添加</b></span></button></div>' +
      (recent.length ? '<p class="cap recent">最近：' + recent.map(function (r) { return esc(ago(r.ts) + '用' + ((T(r.tool) || {}).name || '') + r.text); }).join('；') + '</p>' : '') + '</section>';
    return '<div class="page">' + head(av(b.id, 'hd') + esc(b.name), esc(b.role)) + '<div class="body">' + chat + phone + pc + '<button class="lk danger" data-do="fire" data-confirm="再点一次，确定删掉' + esc(b.name) + '">删掉这个 Bot</button></div></div>';
  }
  /* 你和他的对话 */
  function chat(b) { var ok = canFind('me', b.id);
    return '<div class="page">' + head(esc(b.name), ok ? '' : '他不在你的手机里') + '<div class="body chat" id="chat">' + (thread('me', b.id).map(function (m) { return line(m, 'me'); }).join('') || '<p class="none center">还没说过话。对他说第一件要办的事。</p>') + '</div>' +
      (ok ? '<form class="say" data-do="say"><input id="say" autocomplete="off" enterkeyhint="send" placeholder="对' + esc(b.name) + '说要办什么" aria-label="对' + esc(b.name) + '说"><button class="send" aria-label="发送">' + ICON.send + '</button></form>'
        : '<div class="say off">你的手机里没有' + esc(b.name) + '，所以找不到他。<button class="btn sm" data-do="befriend-me" data-id="' + b.id + '">加到我的手机</button></div>') + '</div>'; }
  /* 看他和某人的聊天（只读），这里也能把那人从他手机里移除 */
  function peek(b, w) { var x = P(w), t = thread(b.id, w);
    return '<div class="page">' + head(esc(b.name) + ' 和 ' + esc(x.name), '只能看，不能替他回') + '<div class="body chat">' + (t.map(function (m) { return line(m, b.id); }).join('') || '<p class="none center">他们还没聊过。</p>') + '</div>' +
      '<div class="say off">' + esc(x.name) + '在' + esc(b.name) + '的手机里。<button class="btn sm danger" data-do="unfriend" data-id="' + w + '" data-pop="1">从他手机里移除</button></div></div>'; }
  function addContact(b) { var list = db.people.filter(function (x) { return x.id !== b.id && (b.phone || []).indexOf(x.id) < 0; });
    return '<div class="page">' + head('加到' + esc(b.name) + '的手机', '加进去，他就能找这个人') + '<div class="body"><div class="card">' + (list.length ? list.map(function (x) { return '<div class="row static">' + av(x.id) + '<span class="t"><b>' + esc(x.name) + tag(x) + '</b></span><button class="btn sm" data-do="friend" data-id="' + x.id + '">添加</button></div>'; }).join('') : '<p class="none pad">大家都已经在他手机里了。</p>') + '</div>' +
      '<form class="inl" data-do="newout"><input id="outname" autocomplete="off" placeholder="公司外的人，例如：供应商老秦" aria-label="公司外的人"><button class="btn sm">添加</button></form></div></div>'; }
  function addTool(b) { var list = db.tools.filter(function (t) { return (b.pc || []).indexOf(t.id) < 0; });
    return '<div class="page">' + head('放到' + esc(b.name) + '的电脑上', '放上去，他就能用') + '<div class="body"><div class="card">' + (list.length ? list.map(function (t) { return '<div class="row static"><span class="tic" aria-hidden="true">' + esc(t.name.slice(0, 1)) + '</span><span class="t"><b>' + esc(t.name) + '</b></span><button class="btn sm" data-do="tool" data-id="' + t.id + '">添加</button></div>'; }).join('') : '<p class="none pad">公司里的都已经给他了。</p>') + '</div>' +
      '<form class="inl" data-do="newtool"><input id="toolname" autocomplete="off" placeholder="新的，例如：钉钉、云测试环境" aria-label="新的东西"><button class="btn sm">添加</button></form></div></div>'; }
  function newBot() { var used = db.people.map(function (x) { return x.name; }), name = NAMES.filter(function (n) { return used.indexOf(n) < 0; })[0] || '新 Bot';
    return '<div class="page">' + head('新 Bot', '他的手机里先只有你，电脑上什么都没有') + '<form class="body" data-do="hire"><div class="card form"><label class="fld"><span>名字</span><input id="bname" autocomplete="off" value="' + esc(name) + '"></label><label class="fld"><span>岗位</span><input id="brole" autocomplete="off" placeholder="例如：客服"></label></div><button class="btn ok wide">创建</button></form></div>'; }

  /* 办公室：同一批人换一种看法。箭头是他手机里的人 */
  function toScene() {
    var nodes = db.people.map(function (p) { return { id: p.id, name: p.name, kind: p.kind === 'me' ? 'me' : p.kind === 'out' ? 'out' : 'bot', look: p.look, busy: !!db.doing[p.id], pc: p.kind === 'bot' && (p.pc || []).length > 0 }; }), links = [];
    db.people.forEach(function (p) { (p.phone || []).forEach(function (j) { if (P(j)) links.push([p.id, j]); }); });
    return { nodes: nodes, links: links, boss: [] };
  }
  function sync() { if (has3d) { window.Office.sync(toScene()); window.Office.select(ui.sel, ui.sel ? (P(ui.sel).phone || []) : [], []); } }
  function pick(id) { if (id && !P(id)) id = null; ui.sel = id; draw(); if (has3d) window.Office.select(id, id ? (P(id).phone || []) : [], []); }
  function card() { var p = P(ui.sel);
    if (!p) return '<div class="hint"><span>箭头指向他手机里的人。点一个人看看。</span><div class="seg"><button data-do="view" data-id="list">列表</button><button aria-selected="true">办公室</button></div></div>';
    var d = db.doing[p.id];
    return '<div class="pcard">' + av(p.id) + '<span class="t"><b>' + esc(p.name) + (p.role ? '<i>' + esc(p.role) + '</i>' : '') + '</b><span>' + (d ? '正在' + esc(d.text) : p.kind === 'out' ? '公司外的人' : p.kind === 'me' ? '你的手机里有 ' + (p.phone || []).length + ' 个 Bot' : '手机里有 ' + (p.phone || []).length + ' 个人') + '</span></span>' +
      (p.kind === 'bot' ? '<button class="btn sm ok" data-do="open" data-id="' + p.id + '">打开</button>' : '') + '<button class="btn sm" data-do="view" data-id="list">回到列表</button></div>'; }

  function draw() {
    var t = top(), view = $('view'), key = JSON.stringify(t || ''), same = view.getAttribute('data-key') === key, b0 = view.querySelector('.pane.r .body') || view.querySelector('.body'), keep = b0 ? b0.scrollTop : 0;
    while (t && ((t.id && !P(t.id)) || (t.w && !P(t.w)))) { ui.stack.pop(); t = top(); }
    var b = t && P(t.id), page = !t ? '' : t.k === 'bot' ? bot(b) : t.k === 'chat' ? chat(b) : t.k === 'peek' ? peek(b, t.w) : t.k === 'add' ? addContact(b) : t.k === 'tools' ? addTool(b) : newBot();
    var office = ui.view === 'office';
    view.hidden = office; $('office').hidden = !office;
    view.classList.toggle('split', wide());
    view.innerHTML = wide() ? '<div class="pane l">' + home() + '</div><div class="pane r">' + (page || '<p class="blank">选一个 Bot</p>') + '</div>' : page || home();
    view.setAttribute('data-key', key);
    var nb = view.querySelector('.pane.r .body') || view.querySelector('.body'); if (nb && same) nb.scrollTop = keep; var c = $('chat'); if (c) c.scrollTop = c.scrollHeight;
    $('card').innerHTML = office ? card() : '';
    if (office && has3d) window.Office.resize();
  }
  function changed() { save(); sync(); $('view').removeAttribute('data-key'); draw(); }
  function cur() { var t = top(); return t && P(t.id); }
  function del(arr, v) { return (arr || []).filter(function (x) { return x !== v; }); }

  var DO = {
    back: function () { ui.stack.pop(); draw(); },
    view: function (el) { ui.view = el.getAttribute('data-id'); if (ui.view === 'office') ui.stack = []; draw(); if (ui.view === 'office') sync(); },
    open: function (el) { ui.view = 'list'; ui.stack = [{ k: 'bot', id: el.getAttribute('data-id') }]; draw(); },
    say: function () { var v = $('say').value.trim(), b = cur(); if (!v || !b || !canFind('me', b.id)) return; db.msgs.push({ from: 'me', to: b.id, text: v, ts: Date.now() }); changed(); $('say').focus(); },
    'befriend-me': function (el) { var me = P('me'); me.phone = del(me.phone, el.getAttribute('data-id')).concat(el.getAttribute('data-id')); changed(); },
    friend: function (el) { var b = cur(); b.phone = del(b.phone, el.getAttribute('data-id')).concat(el.getAttribute('data-id')); ui.stack.pop(); changed(); },
    unfriend: function (el) { var b = cur(); b.phone = del(b.phone, el.getAttribute('data-id')); if (el.hasAttribute('data-pop')) ui.stack.pop(); changed(); },
    tool: function (el) { var b = cur(); b.pc = del(b.pc, el.getAttribute('data-id')).concat(el.getAttribute('data-id')); ui.stack.pop(); changed(); },
    untool: function (el) { var b = cur(), id = el.getAttribute('data-id'); b.pc = del(b.pc, id); if (db.doing[b.id] && db.doing[b.id].tool === id) delete db.doing[b.id]; changed(); }, /* 拿走正在用的东西，手上的事也就停了 */
    stop: function () { var b = cur(); delete db.doing[b.id]; changed(); },
    fire: function () { var b = cur(); db.people = db.people.filter(function (x) { return x.id !== b.id; }); db.people.forEach(function (x) { x.phone = del(x.phone, b.id); }); db.msgs = db.msgs.filter(function (m) { return m.from !== b.id && m.to !== b.id; }); delete db.doing[b.id]; ui.stack = []; changed(); },
    newout: function () { var v = $('outname').value.trim(), b = cur(); if (!v) { $('outname').focus(); return; } var o = { id: 'o' + (++db.n), kind: 'out', name: v, look: 5 }; db.people.push(o); b.phone.push(o.id); ui.stack.pop(); changed(); },
    newtool: function () { var v = $('toolname').value.trim(), b = cur(); if (!v) { $('toolname').focus(); return; } var t = { id: 't' + (++db.n), name: v }; db.tools.push(t); b.pc.push(t.id); ui.stack.pop(); changed(); },
    hire: function () { var name = $('bname').value.trim() || $('bname').defaultValue, id = 'b' + (++db.n); db.people.push({ id: id, kind: 'bot', name: name, role: $('brole').value.trim() || '未填岗位', look: 1 + db.n % 6, phone: ['me'], pc: [] }); P('me').phone.push(id); ui.stack = [{ k: 'bot', id: id }]; changed(); },
    reset: function () { db = sample(); ui.stack = []; ui.sel = null; changed(); }
  };
  document.addEventListener('click', function (e) {
    var g = e.target.closest('[data-go]'); if (g) { var page = JSON.parse(g.getAttribute('data-go')); if (wide() && g.closest('.pane.l')) ui.stack = []; ui.stack.push(page); draw(); return; }
    var d = e.target.closest('button[data-do]'); if (!d) return; e.preventDefault();
    if (d.hasAttribute('data-confirm') && !d.hasAttribute('data-armed')) { d.setAttribute('data-armed', d.textContent); d.textContent = d.getAttribute('data-confirm'); setTimeout(function () { if (d.isConnected && d.hasAttribute('data-armed')) { d.textContent = d.getAttribute('data-armed'); d.removeAttribute('data-armed'); } }, 4000); return; } /* 删不回来的事，在原位点两下确认 */
    DO[d.getAttribute('data-do')](d);
  });
  document.addEventListener('submit', function (e) { var f = e.target.closest('form[data-do]'); if (f) { e.preventDefault(); DO[f.getAttribute('data-do')](f); } });

  has3d = !!(window.Office && window.Office.init($('stage'), $('labels'), pick));
  if (!has3d) $('fail').hidden = false;
  if (wideMq.addEventListener) wideMq.addEventListener('change', function () { draw(); });
  draw(); sync();
  window.__app = { db: function () { return db; }, canFind: canFind, canUse: canUse };
})();
