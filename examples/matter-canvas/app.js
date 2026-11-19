/* 老板的两个界面：事情（每件事一个负责人，待办跟着事情走）和员工（可以管理：岗位、岗位提示、是否在岗、能联系谁、增减员工）。版式照聊天应用。 */
(function () {
  'use strict';
  var E = window.MatterEngine, dsl = E.validate(E.clone(window.MATTER_DSL)), KEY = 'opencraft.matter-canvas.v4';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  function svg(d) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; }
  var BACK = svg('<path d="m14.500 5-7 7 7 7"/>'), GO = svg('<path d="m9.500 5 7 7-7 7"/>');
  var TABS = [['things', '事情', svg('<rect x="4.500" y="4" width="15" height="16" rx="2.500"/><path d="m8 9.500 1.500 1.500L12 8.500M8 15l1.500 1.500L12 14M14.500 10h2M14.500 15.500h2"/>')],
    ['staff', '员工', svg('<path d="M12 4.500c-4.700 0-8.500 3.100-8.500 7 0 2.200 1.200 4.100 3.100 5.400L6 20l3.400-1.600c.8.200 1.700.300 2.600.300 4.700 0 8.500-3.100 8.500-7s-3.800-7.200-8.500-7.200z"/>')],
    ['book', '通讯录', svg('<circle cx="9.500" cy="8.500" r="3.500"/><path d="M3 19.500c.600-3.400 3.200-5.500 6.500-5.500s5.900 2.100 6.500 5.500M17 9h4M17 12.500h4M18.500 16h2.500"/>')]];

  /* ---------- 数据：三件事各自一份进度；负责人和岗位提示可以改 ---------- */
  var saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { /* 没有存储也能用 */ }
  var owners = saved.owners || { expo: null }, prompts = saved.prompts || {}, worlds = {}, book = Object.assign(E.emptyBook(), saved.book || {}), added = saved.added || [], removed = saved.removed || [];
  function newTeam() { if (!dsl.teams.some(function (t) { return t.id === 'new'; })) dsl.teams.unshift({ id: 'new', name: '新加入', color: '#6f7a8a' }); }
  if (added.length) newTeam();
  dsl.bots = dsl.bots.filter(function (b) { return removed.indexOf(b.id) < 0; }).concat(added);
  function reassign(c, to) { /* 把这件事交给另一个 Bot：步骤里的负责人一起换，并让他能联系上对接人 */
    var from = c.owner; if (from === to) return;
    c.steps.forEach(function (st) { if (st.source === from) st.source = to; if (st.target === from) st.target = to; if (st.desktop && st.desktop.operator === from) st.desktop.operator = to; });
    c.nodes.forEach(function (n) { if (n.id === from) n.id = to; }); c.owner = to;
    dsl.bots.forEach(function (b) { if (b.id !== to && c.steps.some(function (st) { return st.source === b.id || st.target === b.id; })) { dsl.contacts.push([to, b.id]); dsl.grants.push([to, b.id], [b.id, to]); } });
  }
  dsl.cases.forEach(function (c, i) {
    if (owners[c.id]) reassign(c, owners[c.id]);
    var run = E.newRun(dsl, c.id, 1, c.id); run.events = (saved.runs || {})[c.id] || [];
    var w = worlds[c.id] = E.makeWorld(dsl, book, run, 'real');
    if (!saved.runs && i < 2) E.settle(w, function (x) { var k = c.steps[x.state.idx].kind; return k === (i ? 'deliver' : 'confirm') ? false : { bot: c.market[0] }; });
  });
  function save() { var runs = {}; dsl.cases.forEach(function (c) { runs[c.id] = worlds[c.id].run.events; }); try { localStorage.setItem(KEY, JSON.stringify({ owners: owners, prompts: prompts, runs: runs, book: book, added: added, removed: removed })); } catch (e) { /* ignore */ } }
  var W0 = worlds[dsl.cases[0].id];
  function N(id) { return id === 'user' ? '老板' : E.nameOf(W0, id); }
  function job(id) { return E.skillsOf(W0, id); }
  function ownerOf(c) { return c.id in owners ? owners[c.id] : c.owner; }
  function promptOf(id) {
    if (id in prompts) return prompts[id];
    var b = E.botOf(W0, id), d = (id in book.skills ? [] : b.duties || []).map(function (x) { return '· ' + x.name + '：' + x.text; }).join('\n');
    return '你是' + b.name + '，岗位是' + job(id) + '。\n' + (d ? d + '\n' : '') + '收到消息先确认要交付什么，做完把材料交回给交办的人。拿不准的事，先问这件事的负责人。';
  }
  function each(fn) { dsl.cases.forEach(function (c) { fn(c, worlds[c.id], worlds[c.id].state); }); }
  function castOf(c) { var s = worlds[c.id].state, ids = ownerOf(c) ? [ownerOf(c)] : []; s.log.forEach(function (ev) { [ev.from, ev.to, ev.bot, ev.operator].forEach(function (x) { if (x && x !== 'user' && ids.indexOf(x) < 0) ids.push(x); }); }); return ids; }
  function msgsOf(a, b) { var o = []; each(function (c, w, s) { s.messages.forEach(function (m) { if ((m.from === a && m.to === b) || (m.from === b && m.to === a)) o.push(m); }); }); return o; }
  function chatsOf(id) { var o = []; each(function (c, w, s) { s.messages.forEach(function (m) { var x = m.from === id ? m.to : m.to === id ? m.from : null; if (x && o.indexOf(x) < 0) o.push(x); }); }); return o; }
  function jobsOf(id) { var o = []; each(function (c, w, s) { s.files.forEach(function (f) { if (f.owner === id && f.kind !== 'submission') o.push({ c: c, f: f }); }); }); return o; }
  function ownsOf(id) { return dsl.cases.filter(function (c) { return ownerOf(c) === id; }); }
  function onDuty(id) { return E.comp(W0, id).work; }
  function busyIn(id) { return dsl.cases.some(function (c) { return castOf(c).indexOf(id) >= 0; }); }
  function status(c) { /* 待办跟着事情走 */
    var w = worlds[c.id], st = c.steps[w.state.idx];
    if (!ownerOf(c)) return ['待分配负责人', 'you'];
    if (st.kind === 'done') return ['已完成', 'ok'];
    if (st.kind === 'confirm') return ['等你验收', 'you'];
    if (w.state.halt) return ['卡住了', 'you'];
    return [w.state.log.length ? st.status : '待开始', ''];
  }

  /* ---------- 界面 ---------- */
  var tab = 'things', stack = [];
  function av(id, cls) { if (!id) return '<span class="av q ' + (cls || '') + '">?</span>'; var b = E.botOf(W0, id), t = b && dsl.teams.find(function (x) { return x.id === b.team; }); return '<span class="av ' + (cls || '') + '"' + (t ? ' style="--tc:' + t.color + '"' : '') + '>' + esc(id === 'user' ? '老' : N(id).slice(-1)) + '</span>'; }
  function nav(title) { return '<div class="nav">' + (stack.length ? '<button data-go="back" aria-label="返回">' + BACK + '</button>' : '<i></i>') + '<h1>' + esc(title) + '</h1><i></i></div>'; }
  function go(o) { return ' data-go=\'' + esc(JSON.stringify(o)) + '\''; }
  function cell(o, left, title, sub, right) { return '<button class="cell' + (left ? ' a' : '') + '"' + go(o) + '>' + left + '<span class="t"><b>' + esc(title) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</span><span class="r">' + esc(right || '') + GO + '</span></button>'; }
  function botRow(id, sub, o) { return '<button class="cell chatrow"' + go(o || { p: 'one', id: id }) + '>' + av(id, 'x') + '<span class="t"><b>' + esc(N(id)) + '</b><span>' + esc(sub) + '</span></span></button>'; }

  var PAGE = {
    things: function () {
      var rank = { you: 0, '': 1, ok: 2 }, list = dsl.cases.slice().sort(function (a, b) { return rank[status(a)[1]] - rank[status(b)[1]]; });
      return nav('事情') + '<div class="body"><div class="cells">' + list.map(function (c) {
        var st = status(c), o = ownerOf(c);
        return '<button class="cell chatrow"' + go({ p: 'thing', c: c.id }) + '>' + av(o, 'x') + '<span class="t"><b>' + esc(c.title) + '</b><span>' + esc(o ? N(o) + '负责 · ' + c.headline : c.headline) + '</span></span><span class="st ' + st[1] + '">' + st[0] + '</span></button>';
      }).join('') + '</div></div>';
    },
    thing: function (g) {
      var c = dsl.cases.find(function (x) { return x.id === g.c; }), w = worlds[c.id], s = w.state, st = c.steps[s.idx], o = ownerOf(c), sta = status(c), fresh = !s.log.length, act = '';
      var files = s.files.filter(function (f) { return f.kind !== 'submission'; });
      if (!o) act = '<button class="go"' + go({ p: 'pick', c: c.id }) + '>分配负责人</button>';
      else if (st.kind === 'confirm') act = '<button class="go" data-do="next" data-c="' + c.id + '">' + esc(st.action) + '</button>';
      else if (st.kind !== 'done') act = '<button class="go alt" data-do="next" data-c="' + c.id + '">' + (s.halt ? '再试一次' : '推进一步：' + esc(st.kind === 'hire' ? '请' + N(c.market[0]) + '帮忙' : st.action)) + '</button>';
      return nav(c.title) + '<div class="body"><div class="cells"><div class="cell text"><small>' + esc(c.tag) + ' · <span class="st ' + sta[1] + '">' + sta[0] + '</span></small><b style="font-size:20px">' + esc(st.kind === 'done' ? '办完了' : c.headline) + '</b><p>' + esc(st.summary) + '</p>' + (s.halt && o ? '<p class="warn">' + esc(E.describe(w, s.halt)) + '</p>' : '') + '</div></div>' + (act ? '<div class="act">' + act + '</div>' : '<div class="gap"></div>') +
        '<div class="cells">' + (o ? '<button class="cell a"' + go({ p: 'one', id: o }) + '>' + av(o) + '<span class="t"><b>' + esc(N(o)) + '</b><span>负责人 · ' + esc(job(o)) + '</span></span><span class="r">' + GO + '</span></button>' : '<div class="cell a">' + av(null) + '<span class="t"><b>还没有负责人</b><span>分配后这件事才会开始</span></span></div>') +
        (o && fresh ? cell({ p: 'pick', c: c.id }, '', '换一位负责人', '', '') : '') + '</div>' +
        '<div class="sec">进度</div><div class="cells">' + c.steps.map(function (x, i) { var k = i < s.idx || x.kind === 'done' && i === s.idx ? 'd' : i === s.idx && o ? 'n' : 'w'; return '<div class="cell step ' + k + '"><i>' + (k === 'd' ? '✓' : '') + '</i><span class="t"><b>' + esc(x.status) + '</b>' + (k === 'n' ? '<span>' + esc(x.summary) + '</span>' : '') + '</span></div>'; }).join('') + '</div>' +
        (castOf(c).length > 1 ? '<div class="sec">参与的人</div><div class="cells">' + castOf(c).map(function (id) { return '<button class="cell a"' + go({ p: 'one', id: id }) + '>' + av(id) + '<span class="t"><b>' + esc(N(id)) + '</b><span>' + esc(id === o ? '负责人' : id === s.hired ? '临时帮手' : job(id)) + '</span></span><span class="r">' + GO + '</span></button>'; }).join('') + '</div>' : '') +
        (files.length ? '<div class="sec">材料</div><div class="cells">' + files.map(function (f) { return cell({ p: 'job', c: c.id, f: f.id }, '', f.name, N(f.owner) + ' · ' + c.steps[f.step].reaction, ''); }).join('') + '</div>' : '') +
        '<div class="gap"></div></div>';
    },
    pick: function (g) {
      var c = dsl.cases.find(function (x) { return x.id === g.c; });
      return nav('分配负责人') + '<div class="body"><div class="sec">' + esc(c.title) + ' · 选一位来负责</div>' + dsl.teams.filter(function (t) { return t.id !== 'market'; }).map(function (t) {
        return '<div class="sec">' + esc(t.name) + '</div><div class="cells">' + dsl.bots.filter(function (b) { return b.team === t.id; }).map(function (b) { return '<button class="cell a" data-do="assign" data-c="' + c.id + '" data-id="' + b.id + '">' + av(b.id) + '<span class="t"><b>' + esc(b.name) + '</b><span>' + esc(b.skills) + '</span></span></button>'; }).join('') + '</div>';
      }).join('') + '</div>';
    },
    staff: function () {
      var ids = []; dsl.cases.forEach(function (c) { castOf(c).forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); }); });
      return nav('员工') + '<div class="body"><div class="cells">' + ids.map(function (id) { var own = ownsOf(id), j = jobsOf(id).pop(); return botRow(id, own.length ? '负责：' + own.map(function (c) { return c.title; }).join('、') : j ? '参与：' + j.c.title : job(id)); }).join('') + '</div><p class="foot">这里是手上有事的员工，全部员工在通讯录。</p></div>';
    },
    book: function () {
      return nav('通讯录') + '<div class="body"><div class="cells">' + cell({ p: 'add' }, '<span class="av q">+</span>', '新增员工', '', '') + '</div>' + dsl.teams.map(function (t) { return '<div class="sec">' + esc(t.name) + '</div><div class="cells">' + dsl.bots.filter(function (b) { return b.team === t.id; }).map(function (b) { return '<button class="cell a"' + go({ p: 'one', id: b.id }) + '>' + av(b.id) + '<span class="t"><b>' + esc(b.name) + '</b><span>' + esc(job(b.id)) + (onDuty(b.id) ? '' : ' · 已停工') + '</span></span></button>'; }).join('') + '</div>'; }).join('') + '<p class="foot">' + dsl.bots.length + ' 位员工</p></div>';
    },
    one: function (g) {
      var own = ownsOf(g.id), on = onDuty(g.id);
      return nav('') + '<div class="body"><div class="cells"><div class="cell big a">' + av(g.id, 'l') + '<span class="t"><b>' + esc(N(g.id)) + '</b><span>' + (on ? '在岗' : '已停工') + ' · ' + esc(job(g.id)) + '</span></span></div></div>' +
        (own.length ? '<div class="sec">负责的事</div><div class="cells">' + own.map(function (c) { var st = status(c); return cell({ p: 'thing', c: c.id }, '', c.title, '', st[0]); }).join('') + '</div>' : '') +
        '<div class="sec">看他在做什么</div><div class="cells">' + cell({ p: 'phone', id: g.id }, '', '手机', '', chatsOf(g.id).length + ' 个聊天') + cell({ p: 'pc', id: g.id }, '', '电脑', '', jobsOf(g.id).length + ' 件事') + '</div>' +
        '<div class="sec">管理</div><div class="cells">' + cell({ p: 'role', id: g.id }, '', '岗位', '', job(g.id)) +
        '<button class="cell text"' + go({ p: 'prompt', id: g.id }) + '><small>岗位提示 · 点开修改</small><p>' + esc(promptOf(g.id)) + '</p></button>' +
        '<label class="cell sw"><span class="t"><b>在岗</b><span>关掉后，他收到消息也不会处理</span></span><input type="checkbox" data-sw="duty" data-id="' + g.id + '"' + (on ? ' checked' : '') + '></label></div>' +
        (busyIn(g.id) ? '' : '<div class="gap"></div><div class="cells"><button class="cell c warn"' + go({ p: 'drop', id: g.id }) + '><b>移出团队</b></button></div>') + '<div class="gap"></div></div>';
    },
    role: function (g) {
      return nav('岗位') + '<div class="body"><div class="gap"></div><div class="field"><label for="f1">岗位</label><input id="f1" value="' + esc(job(g.id)) + '"></div><div class="act"><button class="go" data-do="role" data-id="' + g.id + '">保存</button></div></div>';
    },
    add: function () {
      return nav('新增员工') + '<div class="body"><div class="gap"></div><div class="field"><label for="f0">名字</label><input id="f0" placeholder="例如：阿青"></div><div class="field"><label for="f1">岗位</label><input id="f1" placeholder="例如：发票核对"></div><div class="act"><button class="go" data-do="add">加入团队</button></div><p class="foot">加入后可以给他写岗位提示、加联系人、分配事情。</p></div>';
    },
    drop: function (g) {
      return nav('移出团队') + '<div class="body"><div class="cells"><div class="cell a">' + av(g.id) + '<span class="t"><b>' + esc(N(g.id)) + '</b><span>' + esc(job(g.id)) + '</span></span></div></div><p class="foot">移出后，他不再出现在通讯录里，别人也联系不到他。</p><div class="act"><button class="go red" data-do="drop" data-id="' + g.id + '">确认移出</button></div></div>';
    },
    addc: function (g) {
      var has = E.contactsOf(W0, g.id);
      return nav('添加联系人') + '<div class="body"><div class="cells">' + dsl.bots.filter(function (b) { return b.id !== g.id && has.indexOf(b.id) < 0; }).map(function (b) { return '<button class="cell a" data-do="addc" data-id="' + g.id + '" data-b="' + b.id + '">' + av(b.id) + '<span class="t"><b>' + esc(b.name) + '</b><span>' + esc(job(b.id)) + '</span></span></button>'; }).join('') + '</div></div>';
    },
    prompt: function (g) {
      return nav(N(g.id) + '的岗位提示') + '<div class="body"><div class="sec">告诉' + esc(N(g.id)) + '这个岗位该怎么做事</div><textarea id="pt" aria-label="岗位提示">' + esc(promptOf(g.id)) + '</textarea><div class="act"><button class="go" data-do="prompt" data-id="' + g.id + '">保存</button></div></div>';
    },
    phone: function (g) {
      var list = chatsOf(g.id), people = E.contactsOf(W0, g.id);
      return nav(N(g.id) + '的手机') + '<div class="body">' + (list.length ? '<div class="sec">聊天</div><div class="cells">' + list.map(function (o) { return botRow(o, msgsOf(g.id, o).pop().text, { p: 'chat', id: g.id, o: o }); }).join('') + '</div>' : '') +
        '<div class="sec">联系人 · 开关决定他能不能发消息给对方</div><div class="cells">' + people.map(function (o) { return '<label class="cell a sw">' + av(o) + '<span class="t"><b>' + esc(N(o)) + '</b><span>' + esc(job(o)) + '</span></span><input type="checkbox" data-sw="grant" data-id="' + g.id + '" data-b="' + o + '"' + (E.granted(W0, g.id, o) ? ' checked' : '') + '></label>'; }).join('') +
        cell({ p: 'addc', id: g.id }, '<span class="av q">+</span>', '添加联系人', '', '') + '</div><div class="gap"></div></div>';
    },
    chat: function (g) {
      return nav(N(g.o)) + '<div class="body"><div class="chat">' + msgsOf(g.id, g.o).map(function (m) { return '<div class="line' + (m.from === g.id ? ' me' : '') + '">' + av(m.from) + '<div class="msg">' + esc(m.text) + '</div></div>'; }).join('') + '</div><p class="foot">这是' + esc(N(g.id)) + '的手机，绿色是' + esc(N(g.id)) + '发的。</p></div>';
    },
    pc: function (g) {
      var list = jobsOf(g.id);
      return nav(N(g.id) + '的电脑') + '<div class="body">' + (list.length ? '<div class="cells">' + list.slice().reverse().map(function (j) { return cell({ p: 'job', c: j.c.id, f: j.f.id }, '', j.c.steps[j.f.step].reaction, j.c.title + ' · ' + N(j.f.from) + '交办', '已完成'); }).join('') + '</div>' : '<p class="none">还没有做过事</p>') + '</div>';
    },
    job: function (g) {
      var c = dsl.cases.find(function (x) { return x.id === g.c; }), f = worlds[c.id].state.files.find(function (x) { return x.id === g.f; }), st = c.steps[f.step], vals = Object.keys(f.values || {});
      return nav(st.reaction) + '<div class="body"><div class="cells">' + cell({ p: 'thing', c: c.id }, '', c.title, '这件事', '') + cell({ p: 'one', id: f.owner }, av(f.owner), N(f.owner), '做这一步的人', '') + '</div><div class="gap"></div>' +
        '<div class="cells"><div class="cell text"><small>' + esc(N(f.from)) + '说</small>' + esc(st.message) + '</div></div><div class="gap"></div>' +
        '<div class="cells"><div class="cell text"><small>交出的材料</small><b>' + esc(f.name) + '</b>' + esc(f.body) + '</div>' + vals.map(function (k) { return '<div class="cell"><span class="t"><b>' + esc(k) + '</b></span><span class="r">' + esc(E.show(f.values[k])) + '</span></div>'; }).join('') + '</div></div>';
    }
  };
  function draw() {
    var g = stack[stack.length - 1], h = g ? PAGE[g.p](g) : PAGE[tab]();
    if (!g) { var n = dsl.cases.filter(function (c) { return status(c)[1] === 'you'; }).length; h += '<div class="tabs">' + TABS.map(function (t) { return '<button data-tab="' + t[0] + '" aria-current="' + (t[0] === tab) + '">' + t[2] + t[1] + (t[0] === 'things' && n ? '<em>' + n + '</em>' : '') + '</button>'; }).join('') + '</div>'; }
    document.getElementById('app').innerHTML = h;
  }
  var DO = {
    next: function (d) { var w = worlds[d.c], c = E.caseOf(w); E.act(w, { bot: c.market[0] }); while (E.advance(w)); },
    assign: function (d) { var c = dsl.cases.find(function (x) { return x.id === d.c; }); reassign(c, d.id); owners[c.id] = d.id; stack.pop(); },
    prompt: function (d) { prompts[d.id] = document.getElementById('pt').value.trim(); stack.pop(); },
    role: function (d) { var v = document.getElementById('f1').value.trim(); if (v) book.skills[d.id] = v; stack.pop(); },
    add: function () {
      var name = document.getElementById('f0').value.trim(), role = document.getElementById('f1').value.trim(); if (!name || !role) return;
      var b = { id: 'n' + Date.now().toString(36), name: name, team: 'new', skills: role, available: false, devices: { phone: true, computer: { work: true, send: true, hire: true, review: '' } } };
      newTeam(); added.push(b); dsl.bots.push(b); stack.pop(); stack.push({ p: 'one', id: b.id });
    },
    drop: function (d) { removed.push(d.id); added = added.filter(function (b) { return b.id !== d.id; }); dsl.bots = dsl.bots.filter(function (b) { return b.id !== d.id; }); stack.pop(); stack.pop(); },
    addc: function (d) { book.contacts.push(E.pairKey(d.id, d.b)); book.grants[d.id + '>' + d.b] = true; book.grants[d.b + '>' + d.id] = true; stack.pop(); }
  };
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-go],[data-tab],[data-do]'); if (!el) return;
    if (el.dataset.do) { DO[el.dataset.do](el.dataset); save(); }
    else if (el.dataset.tab) tab = el.dataset.tab;
    else if (el.dataset.go === 'back') stack.pop();
    else stack.push(JSON.parse(el.dataset.go));
    draw();
  });
  document.addEventListener('change', function (e) {
    var d = e.target.dataset; if (!d.sw) return;
    if (d.sw === 'grant') book.grants[d.id + '>' + d.b] = e.target.checked;
    else { var o = book.comp[d.id] = book.comp[d.id] || {}; o.work = e.target.checked; o.send = e.target.checked; }
    save(); draw();
  });
  draw();
  window.__matter = { worlds: worlds, owners: owners };
})();
