/* 老板的办公室。上面是三维办公室（scene.js），下面是一张面板：点谁，就打开谁。
   首屏是老板自己的手机：直属下属的对话列表，招募新员工也从手机发起。
   每个人四个页签：对话（对他说要办什么）、手机（他在联系谁 / 他能联系谁）、电脑（他在做什么 / 他能做什么）、岗位。
   这是结构原型，没有接真实的 Bot：你发出去的话不会有人回。示例内容是一份静态快照，清空后各处如实显示为空。 */
(function () {
  'use strict';
  var KEY = 'opencraft.matter-canvas.v6', $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var KIND = { pc: ['电脑', '例如：办公室的 Mac mini'], env: ['云环境', '例如：测试环境'], conn: ['连接器', '例如：飞书、邮箱'] };
  var TABS = [['talk', '对话'], ['phone', '手机'], ['pc', '电脑'], ['role', '岗位']];

  function blank() { return { people: [], outs: [], msgs: [], res: { pc: [], env: [], conn: [] }, n: 0, sample: false }; }
  function sample() { /* 一家小工作室老板眼里的某个下午 */
    var d = blank(), now = Date.now(), look = 0;
    [['pc', 'r1', '办公室的 Mac mini'], ['pc', 'r2', '机房的 Linux 主机'], ['env', 'r3', '测试环境'], ['env', 'r4', '客户演示环境'], ['conn', 'r5', '飞书'], ['conn', 'r6', '企业邮箱'], ['conn', 'r7', 'GitHub'], ['conn', 'r8', '公司网盘']].forEach(function (r) { d.res[r[0]].push({ id: r[1], name: r[2] }); });
    d.outs.push({ id: 'o1', name: '客户周姐' });
    function person(id, name, role, boss, prompt, pc, env, conn, reach, doing) { d.people.push({ id: id, name: name, role: role, boss: boss, prompt: prompt, pc: pc, env: env, conn: conn, reach: reach, doing: doing || '', look: look++ }); }
    person('a', '阿岚', '项目交付', 'me', '你负责把版本按时交到客户手里。缺什么材料自己找同事要，拿不准的事先问老板。交付前一定让人核对签字页。', 'r1', 'r4', ['r5', 'r6', 'r8'], ['y', 'z', 'o1'], '');
    person('y', '言禾', '合同与验收', 'me', '你保管合同和验收文件。别人来要文件，先确认是哪个版本，再给盖章的那一份。', 'r1', null, ['r5', 'r8'], ['a', 'c'], '');
    person('c', '沐川', '行政与账号', 'me', '你负责开账号、订会议室、收报销单。办完告诉交办的人。', 'r2', null, ['r5', 'r6', 'r7'], ['y', 't', 'n'], '在企业邮箱里翻 10 月的报销邮件，一封封登记到表里');
    person('z', '小折', '文档核对', 'a', '你只做核对：版本、页码、签章。核完写清楚看的是哪一份、结论是什么。', 'r2', 'r3', ['r8'], ['a'], '');
    person('t', '秋池', '对账', 'c', '你核对每一笔报销和发票是否对得上，对不上的列出来交给沐川。', null, null, ['r6'], ['c', 'n'], '');
    person('n', '北野', '采购', 'c', '你负责买办公用品和订场地。超过预算先问沐川。', null, null, [], ['c', 't'], '');
    function msg(min, from, to, text, more) { d.msgs.push(Object.assign({ id: 'm' + d.msgs.length, ts: now - min * 60000, who: from, to: to, text: text }, more || {})); }
    msg(170, 'c', 'me', '周三下午 2 点到 4 点的大会议室订好了，投影也借了。');
    msg(94, 'me', 'a', '周五要把 2.3 版本交给客户，你来负责。缺什么自己找人。');
    msg(80, 'a', 'y', '言禾，客户盖章的验收签字页在你那吗？周五交付要用。'); msg(62, 'y', 'a', '在，发你了。有两个附件页码不一样，盖章的是其中一份，你最好找人核一下。');
    msg(55, 'a', 'z', '帮我核一下这两份签字页：哪份是盖章的，版本对不对。'); msg(30, 'z', 'a', '核完了。盖章的是第 3 页那份，版本 2.3，和交付清单一致。');
    msg(26, 'a', 'o1', '周姐，2.3 版本周五上午发您，签字页我们已经核对过了。');
    msg(49, 'me', 'c', '下周一有新同事入职，账号提前开好。'); msg(22, 'c', 'me', '邮箱和飞书开好了。GitHub 要等他把用户名发我，我已经问了。');
    msg(17, 'a', 'me', '签字页核对好了，交付包齐了。你看一眼核对单，没问题我就发给客户。', { ask: 'open', file: '2.3 版本签字页核对单', body: '盖章的是第 3 页那一份。\n版本号 2.3，和交付清单一致。\n核对人：小折。\n交付包里的三样都齐了：安装包、测试回执、验收签字页。' });
    msg(12, 'c', 't', '10 月的报销我登记到一半，登完发你对账。');
    msg(8, 'me', 'c', '把 10 月的报销单整理一下，周五前给我。');
    d.n = 100; d.sample = true; return d;
  }
  var db = sample();
  try { var raw = JSON.parse(localStorage.getItem(KEY)); if (raw && raw.people && raw.msgs && raw.v === 3) db = raw; } catch (e) { /* 没有存储也能用 */ }
  function save() { db.v = 3; try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ } }
  function uid(p) { db.n += 1; return p + db.n; }
  function P(id) { return db.people.filter(function (x) { return x.id === id; })[0]; }
  function O(id) { return db.outs.filter(function (x) { return x.id === id; })[0]; }
  function N(id) { return id === 'me' ? '你' : (P(id) || O(id) || {}).name || '已移出的人'; }
  function R(k, id) { return db.res[k].filter(function (x) { return x.id === id; })[0]; }
  function thread(a, b) { return db.msgs.filter(function (x) { return (x.who === a && x.to === b) || (x.who === b && x.to === a); }).sort(function (x, y) { return x.ts - y.ts; }); }
  function partners(id) { var o = []; db.msgs.slice().sort(function (x, y) { return y.ts - x.ts; }).forEach(function (x) { var p = x.who === id ? x.to : x.to === id ? x.who : null; if (p && p !== 'me' && o.indexOf(p) < 0) o.push(p); }); return o; }
  function asks(id) { return db.msgs.filter(function (x) { return x.to === 'me' && x.ask === 'open' && (!id || x.who === id); }); }
  function hhmm(ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }

  var ui = { sel: null, tab: 'talk', sub: null }, has3d = false;
  function reachOf(id) { if (id === 'me') return db.people.filter(function (p) { return p.boss === 'me'; }).map(function (p) { return p.id; }); var p = P(id); return p ? p.reach.slice() : []; }
  function toScene() {
    var nodes = [{ id: 'me', name: '你', kind: 'me' }], links = [], boss = [];
    db.people.forEach(function (p) { nodes.push({ id: p.id, name: p.name, kind: 'bot', look: p.look, badge: asks(p.id).length, busy: !!p.doing }); boss.push([p.boss, p.id]); if (p.boss === 'me') links.push(['me', p.id]); p.reach.forEach(function (j) { if (P(j) || O(j)) links.push([p.id, j]); }); });
    db.outs.forEach(function (o) { nodes.push({ id: o.id, name: o.name, kind: 'out' }); });
    return { nodes: nodes, links: links, boss: boss };
  }
  function sync() { if (has3d) { window.Office.sync(toScene()); window.Office.select(ui.sel, ui.sel ? reachOf(ui.sel) : []); } }
  function pick(id) { if (id && !P(id) && !O(id)) id = null; /* 点「你」自己，就是回到你的手机 */ ui.sel = id; ui.sub = null; if (id && !P(id)) ui.tab = 'talk'; if (has3d) window.Office.select(id, id ? reachOf(id) : []); draw(); }

  /* ---------- 面板 ---------- */
  function sec(cls, title, body) { return '<section class="sec ' + cls + '"><h3>' + title + '</h3>' + body + '</section>'; }
  function none(t) { return '<p class="none">' + t + '</p>'; }
  function bubble(m, self) { return '<div class="msg' + (m.who === self ? ' out' : '') + '"><div class="bub">' + esc(m.text) + (m.file ? '<details class="file"><summary>' + esc(m.file) + '</summary><pre>' + esc(m.body) + '</pre></details>' : '') + '</div><time>' + (m.who !== self && self !== 'me' ? esc(N(m.who)) + ' · ' : '') + hhmm(m.ts) + '</time>' +
    (m.ask === 'open' && self === 'me' ? '<div class="ask"><button class="btn ok" data-do="accept" data-id="' + m.id + '">可以</button><button class="btn" data-do="reject" data-id="' + m.id + '">不行，退回</button></div>' : m.ask && self === 'me' ? '<div class="asked">' + (m.ask === 'ok' ? '你说了可以' : '你退回了') + '</div>' : '') + '</div>'; }

  function home() { /* 首屏是老板自己的手机：直属下属的对话列表，招募也从这里发起 */
    var mine = db.people.filter(function (p) { return p.boss === 'me'; }), rest = db.people.filter(function (p) { return p.boss !== 'me'; });
    function last(p) { var l = thread('me', p.id).pop(); return l ? l.ts : 0; }
    mine.sort(function (a, b) { return (asks(b.id).length - asks(a.id).length) || (last(b) - last(a)); });
    var h = '<header class="head"><div><h2>我的手机</h2><p>直接归你管的人都在这里。点一个人，对他说要办什么。</p></div><button class="btn ok" data-do="new">招募</button></header><div class="body">';
    h += mine.length ? '<div class="list">' + mine.map(function (p) { var l = thread('me', p.id).pop(), n = asks(p.id).length;
      return '<button class="row chatrow" data-do="open" data-id="' + p.id + '"><b>' + esc(p.name) + '<em>' + esc(p.role || '未填岗位') + '</em><time>' + (l ? hhmm(l.ts) : '') + '</time></b><span>' + (n ? '<i class="dot">' + n + '</i>' : '') + esc(l ? (l.who === 'me' ? '你：' : '') + l.text : '还没有说过话') + '</span></button>'; }).join('') + '</div>' : sec('', '还没有人', none('手机里还没有人。点右上角「招募」，招第一位员工。'));
    if (rest.length) h += sec('', '不归你直接管的人', '<div class="chips">' + rest.map(function (p) { return '<button class="chip" data-do="open" data-id="' + p.id + '">' + esc(p.name) + '<i>归' + esc(N(p.boss)) + '管</i></button>'; }).join('') + '</div><p class="cap">你不直接对他们说话，但可以看他们的手机和电脑。</p>');
    return h + '<p class="foot">这是原型，没有接真实的 Bot，你发出去的话不会有人回。<button class="lk" data-do="' + (db.sample ? 'clear">清空示例' : 'sample">放回示例') + '</button></p></div>';
  }
  function talk(p) {
    if (p.boss !== 'me') return '<div class="body">' + none(esc(p.name) + '归' + esc(N(p.boss)) + '管。你可以看他的手机和电脑；要交办事情，请对' + esc(N(p.boss)) + '说。') + '<p><button class="btn" data-do="open" data-id="' + esc(p.boss) + '">去找' + esc(N(p.boss)) + '</button></p></div>';
    var t = thread('me', p.id);
    return '<div class="body chat" id="chat">' + (t.length ? t.map(function (m) { return bubble(m, 'me'); }).join('') : none('还没有对话。对他说第一件要办的事。')) + '</div><form class="say" data-do="say"><input id="say" autocomplete="off" placeholder="对' + esc(p.name) + '说要办什么" aria-label="对' + esc(p.name) + '说"><button class="btn ok">发送</button></form>';
  }
  function phone(p) {
    if (ui.sub) { var t = thread(p.id, ui.sub); return '<div class="body chat"><button class="lk back" data-do="sub" data-id="">‹ 返回 ' + esc(p.name) + ' 的手机</button><p class="cap">' + esc(p.name) + ' 和 ' + esc(N(ui.sub)) + ' 的聊天记录（只读）</p>' + t.map(function (m) { return bubble(m, p.id); }).join('') + '</div>'; }
    var ps = partners(p.id), all = db.people.filter(function (x) { return x.id !== p.id; }).concat(db.outs);
    return '<div class="body">' + sec('mint', '他在联系谁', ps.length ? ps.map(function (j) { var l = thread(p.id, j).pop(); return '<button class="row" data-do="sub" data-id="' + j + '"><b>' + esc(N(j)) + (O(j) ? '<em>公司外</em>' : '') + '</b><span>' + esc((l.who === p.id ? '他：' : '') + l.text) + '</span></button>'; }).join('') : none('他还没有联系过别人。')) +
      sec('mint', '他能联系谁', (all.length ? all.map(function (x) { return '<label class="sw"><input type="checkbox" data-sw="reach" data-id="' + x.id + '"' + (p.reach.indexOf(x.id) >= 0 ? ' checked' : '') + '><span>' + esc(x.name) + (O(x.id) ? '<em>公司外</em>' : '') + '</span></label>'; }).join('') : none('还没有别人可以联系。')) +
        '<form class="inl" data-do="out"><input id="out" autocomplete="off" placeholder="加一位公司外的人，例如：客户周姐" aria-label="公司外的人"><button class="btn">添加</button></form><p class="cap">勾选后，办公室里他会自己挪到这些人附近。</p>') + '</div>';
  }
  function pc(p) {
    function one(k) { return '<label class="fld"><span>' + KIND[k][0] + '</span><select data-sw="' + k + '"><option value="">不分配</option>' + db.res[k].map(function (r) { return '<option value="' + r.id + '"' + (p[k] === r.id ? ' selected' : '') + '>' + esc(r.name) + '</option>'; }).join('') + '</select></label>'; }
    return '<div class="body">' + sec('sky', '他在做什么', p.doing ? '<div class="doing"><i></i>' + esc(p.doing) + '</div><p class="cap">用的是：' + esc([R('pc', p.pc), R('env', p.env)].filter(Boolean).map(function (r) { return r.name; }).join('、') || '还没有分配电脑') + '</p>' : none('他的电脑现在空着。')) +
      sec('sky', '他能做什么', one('pc') + one('env') + '<div class="fld"><span>连接器</span><div class="chips">' + (db.res.conn.map(function (r) { return '<label class="chip ck"><input type="checkbox" data-sw="conn" data-id="' + r.id + '"' + (p.conn.indexOf(r.id) >= 0 ? ' checked' : '') + '>' + esc(r.name) + '</label>'; }).join('') || '<span class="none">还没有登记连接器。</span>') + '</div></div>' +
        '<form class="inl" data-do="res"><select id="resk" aria-label="类型">' + Object.keys(KIND).map(function (k) { return '<option value="' + k + '">' + KIND[k][0] + '</option>'; }).join('') + '</select><input id="resn" autocomplete="off" placeholder="登记一个新的" aria-label="名称"><button class="btn">登记</button></form>') + '</div>';
  }
  function role(p) {
    return '<form class="body" data-do="role"><label class="fld"><span>名字</span><input id="rname" value="' + esc(p.name) + '" autocomplete="off"></label><label class="fld"><span>岗位</span><input id="rrole" value="' + esc(p.role) + '" autocomplete="off" placeholder="例如：项目交付"></label><label class="fld"><span>归谁管</span><select id="rboss"><option value="me">你</option>' +
      db.people.filter(function (x) { return x.id !== p.id && x.boss !== p.id; }).map(function (x) { return '<option value="' + x.id + '"' + (p.boss === x.id ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select></label><label class="fld col"><span>岗位提示</span><textarea id="rprompt" rows="5" placeholder="告诉他这个岗位该怎么做事">' + esc(p.prompt) + '</textarea></label><div class="acts"><button class="btn ok">保存</button><button type="button" class="btn danger" data-do="drop">移出办公室</button></div></form>';
  }
  function person(p) {
    var n = asks(p.id).length;
    return '<header class="head"><div><h2>' + esc(p.name) + '</h2><p>' + esc(p.role || '未填岗位') + ' · 归' + esc(N(p.boss)) + '管</p></div><button class="btn x" data-do="open" data-id="" aria-label="返回我的手机">我的手机</button></header><div class="tabs" role="tablist">' +
      TABS.map(function (t) { return '<button role="tab" aria-selected="' + (ui.tab === t[0]) + '" data-tab="' + t[0] + '">' + t[1] + (t[0] === 'talk' && n ? '<i>' + n + '</i>' : '') + '</button>'; }).join('') + '</div>' + ({ talk: talk, phone: phone, pc: pc, role: role })[ui.tab](p);
  }
  function outside(o) { var who = db.people.filter(function (p) { return p.reach.indexOf(o.id) >= 0; });
    return '<header class="head"><div><h2>' + esc(o.name) + '</h2><p>公司外的人</p></div><button class="btn x" data-do="open" data-id="">我的手机</button></header><div class="body">' + sec('mint', '谁能联系他', who.length ? '<div class="chips">' + who.map(function (p) { return '<button class="chip" data-do="open" data-id="' + p.id + '">' + esc(p.name) + '</button>'; }).join('') + '</div>' : none('现在没有人能联系他。')) + '<p><button class="btn danger" data-do="dropout" data-id="' + o.id + '">从门外移走</button></p></div>'; }
  function create() { return '<header class="head"><div><h2>招募新员工</h2><p>先给个名字和岗位。入职后他会出现在办公室里，其余的进去再配。</p></div><button class="btn x" data-do="open" data-id="">返回手机</button></header><form class="body" data-do="add"><label class="fld"><span>名字</span><input id="nname" autocomplete="off" placeholder="例如：青柚"></label><label class="fld"><span>岗位</span><input id="nrole" autocomplete="off" placeholder="例如：客服"></label><label class="fld"><span>归谁管</span><select id="nboss"><option value="me">你</option>' + db.people.map(function (x) { return '<option value="' + x.id + '">' + esc(x.name) + '</option>'; }).join('') + '</select></label><div class="acts"><button class="btn ok">让他入职</button></div></form>'; }

  function draw() {
    var sheet = $('sheet'), b = sheet.querySelector('.body'), keep = b ? b.scrollTop : 0, sameView = sheet.getAttribute('data-view') === (ui.sel + '/' + ui.tab + '/' + ui.sub), p = P(ui.sel);
    sheet.innerHTML = ui.sel === '+' ? create() : p ? person(p) : O(ui.sel) ? outside(O(ui.sel)) : home();
    sheet.setAttribute('data-view', ui.sel + '/' + ui.tab + '/' + ui.sub); document.body.classList.toggle('open', !!ui.sel);
    var nb = sheet.querySelector('.body'); if (nb) { if (sameView) nb.scrollTop = keep; var c = $('chat'); if (c && !sameView) c.scrollTop = c.scrollHeight; }
    if (has3d) window.Office.resize();
  }

  var DO = {
    open: function (el) { pick(el.getAttribute('data-id') || null); },
    'new': function () { ui.sel = '+'; if (has3d) window.Office.select(null, []); draw(); },
    sub: function (el) { ui.sub = el.getAttribute('data-id') || null; draw(); },
    say: function () { var v = $('say').value.trim(); if (!v) return; db.msgs.push({ id: uid('m'), ts: Date.now(), who: 'me', to: ui.sel, text: v }); save(); ui.sub = 'sent' + db.n; draw(); $('say').focus(); },
    accept: function (el) { answer(el.getAttribute('data-id'), 'ok', '可以，就这样。'); },
    reject: function (el) { answer(el.getAttribute('data-id'), 'no', '不行，退回，再看看。'); },
    out: function () { var v = $('out').value.trim(), p = P(ui.sel); if (!v || !p) return; var o = { id: uid('o'), name: v }; db.outs.push(o); p.reach.push(o.id); save(); sync(); draw(); },
    res: function () { var v = $('resn').value.trim(), k = $('resk').value; if (!v) return; db.res[k].push({ id: uid('r'), name: v }); save(); draw(); },
    role: function () { var p = P(ui.sel); if (!p) return; p.name = $('rname').value.trim() || p.name; p.role = $('rrole').value.trim(); p.prompt = $('rprompt').value.trim(); p.boss = $('rboss').value; save(); sync(); draw(); },
    drop: function () { var id = ui.sel, p = P(id); if (!p || !window.confirm('把' + p.name + '移出办公室？他的聊天记录也会一起删掉。')) return; db.people = db.people.filter(function (x) { return x.id !== id; }); db.people.forEach(function (x) { if (x.boss === id) x.boss = p.boss; x.reach = x.reach.filter(function (j) { return j !== id; }); }); db.msgs = db.msgs.filter(function (m) { return m.who !== id && m.to !== id; }); ui.sel = null; save(); sync(); draw(); },
    dropout: function (el) { var id = el.getAttribute('data-id'); db.outs = db.outs.filter(function (x) { return x.id !== id; }); db.people.forEach(function (x) { x.reach = x.reach.filter(function (j) { return j !== id; }); }); db.msgs = db.msgs.filter(function (m) { return m.who !== id && m.to !== id; }); ui.sel = null; save(); sync(); draw(); },
    add: function () { var v = $('nname').value.trim(); if (!v) { $('nname').focus(); return; } var p = { id: uid('p'), name: v, role: $('nrole').value.trim(), boss: $('nboss').value, prompt: '', pc: null, env: null, conn: [], reach: [], doing: '', look: db.n }; db.people.push(p); ui.sel = p.id; ui.tab = 'role'; save(); sync(); draw(); },
    clear: function () { if (!window.confirm('清空示例？办公室会变成空的。')) return; db = blank(); ui.sel = null; save(); sync(); draw(); },
    sample: function () { db = sample(); ui.sel = null; save(); sync(); draw(); }
  };
  function answer(id, state, text) { var m = db.msgs.filter(function (x) { return x.id === id; })[0]; if (!m) return; m.ask = state; db.msgs.push({ id: uid('m'), ts: Date.now(), who: 'me', to: m.who, text: text }); save(); sync(); ui.sub = 'ans' + db.n; draw(); }
  var SW = {
    reach: function (el, p) { var id = el.getAttribute('data-id'); p.reach = p.reach.filter(function (j) { return j !== id; }); if (el.checked) p.reach.push(id); sync(); },
    conn: function (el, p) { var id = el.getAttribute('data-id'); p.conn = p.conn.filter(function (j) { return j !== id; }); if (el.checked) p.conn.push(id); },
    pc: function (el, p) { p.pc = el.value || null; }, env: function (el, p) { p.env = el.value || null; }
  };

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-tab]'); if (t) { ui.tab = t.getAttribute('data-tab'); ui.sub = null; draw(); return; }
    var d = e.target.closest('button[data-do]'); if (d) { e.preventDefault(); DO[d.getAttribute('data-do')](d); }
  });
  document.addEventListener('submit', function (e) { var f = e.target.closest('form[data-do]'); if (f) { e.preventDefault(); DO[f.getAttribute('data-do')](f); } });
  document.addEventListener('change', function (e) { var el = e.target.closest('[data-sw]'), p = P(ui.sel); if (!el || !p) return; SW[el.getAttribute('data-sw')](el, p); save(); });

  has3d = !!(window.Office && window.Office.init($('stage'), $('labels'), pick));
  if (!has3d) $('fail').hidden = false;
  draw(); sync();
  window.__app = { pick: pick, db: function () { return db; } };
})();
