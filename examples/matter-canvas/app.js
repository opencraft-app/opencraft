/* 老板的三个标签：事情（一张待办清单，每件事可以分配负责人）、员工（可以管理）、动态（谁刚做了什么）。员工自己推进事情，老板只分配、验收、管许可。版式照聊天应用。 */
(function () {
  'use strict';
  var E = window.MatterEngine, dsl = E.validate(E.clone(window.MATTER_DSL)), KEY = 'opencraft.matter-canvas.v4';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  function svg(d) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; }
  var BACK = svg('<path d="m14.500 5-7 7 7 7"/>'), GO = svg('<path d="m9.500 5 7 7-7 7"/>');
  var TABS = [['things', '事情', svg('<rect x="4.500" y="4" width="15" height="16" rx="2.500"/><path d="m8 9.500 1.500 1.500L12 8.500M8 15l1.500 1.500L12 14M14.500 10h2M14.500 15.500h2"/>')],
    ['staff', '员工', svg('<path d="M12 4.500c-4.700 0-8.500 3.100-8.500 7 0 2.200 1.200 4.100 3.100 5.400L6 20l3.400-1.600c.8.200 1.700.300 2.600.300 4.700 0 8.500-3.100 8.500-7s-3.800-7.200-8.500-7.200z"/>')],
    ['feed', '动态', svg('<circle cx="12" cy="12" r="8.500"/><path d="m15.500 8.500-2 5-5 2 2-5z"/>')]];

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
  var custom = saved.custom || [], notes = saved.notes || [], tick = 0;
  function makeCase(id, title) { /* 老板自己加的事：交给负责人处理，做完等老板验收 */
    var o = dsl.bots[0].id, S = function (kind, status, summary, action, message, envelope, reaction, file, body) { return { kind: kind, status: status, summary: summary, action: action, source: 'user', target: o, message: message, envelope: envelope, reaction: reaction, desktop: { operator: o, file: file, body: body, input: envelope } }; };
    return { id: id, title: title, tag: '待办', owner: o, peer: null, market: [], nodes: [], artifact: title + ' · 结果', headline: title, desktop: { title: title, body: title },
      steps: [S('receive', '待处理', '还没开始。', '开始处理', '请处理：' + title, '交办', '处理「' + title + '」', title + ' · 结果', '已处理完，请验收。'), S('confirm', '等你验收', '已处理完，请验收。', '确认完成', '确认完成：' + title, '确认', '归档「' + title + '」', title + ' · 归档', '已归档。'), { kind: 'done', status: '已完成', summary: '已完成：' + title }] };
  }
  custom.forEach(function (x) { dsl.cases.push(makeCase(x.id, x.title)); });
  function stamp(w) { w.run.events.forEach(function (ev) { if (!ev.ts) ev.ts = Date.now() + (tick++); }); }
  function note(who, text, c) { notes.push({ ts: Date.now() + (tick++), who: who, text: text, c: c }); }
  function boot(c, i) {
    if (owners[c.id]) reassign(c, owners[c.id]);
    var run = E.newRun(dsl, c.id, 1, c.id); run.events = (saved.runs || {})[c.id] || [];
    var w = worlds[c.id] = E.makeWorld(dsl, book, run, 'real');
    if (!saved.runs && i < 2) E.settle(w, function (x) { var k = c.steps[x.state.idx].kind; return k === (i ? 'deliver' : 'confirm') ? false : { bot: c.market[0] }; });
    stamp(w);
  }
  dsl.cases.forEach(boot);
  function save() { var runs = {}; dsl.cases.forEach(function (c) { runs[c.id] = worlds[c.id].run.events; }); try { localStorage.setItem(KEY, JSON.stringify({ owners: owners, prompts: prompts, runs: runs, book: book, added: added, removed: removed, custom: custom, notes: notes })); } catch (e) { /* ignore */ } }
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
  function jobsOf(id) { var o = []; each(function (c, w, s) { s.files.forEach(function (f) { if (f.owner === id) o.push({ c: c, f: f }); }); }); return o; }
  function did(c, f) { var sb = E.nodeOf(c, 'sandbox'); return f.kind === 'submission' ? (sb ? sb.text.replace(/。$/, '') : f.name) : c.steps[f.step].reaction; }
  function ownsOf(id) { return dsl.cases.filter(function (c) { return ownerOf(c) === id; }); }
  function onDuty(id) { return E.comp(W0, id).work; }
  function doing(id) { var o = []; each(function (c, w, s) { if (s.working && s.working.operator === id) o.push({ c: c, text: s.working.reaction }); }); return o; }
  function matesOf(id) { var o = []; each(function (c, w, st) { if (c.steps[st.idx].kind === 'done') return; var x = st.hired === id ? ownerOf(c) : ownerOf(c) === id ? st.hired : null; if (x && o.indexOf(x) < 0 && !E.knows(W0, id, x)) o.push(x); }); return o; }
  var ALLOW = [['work', '处理文件', '关掉后，他收到消息也不会开工'], ['send', '对外发消息', '关掉后，他做完也发不出去'], ['hire', '找帮手', '关掉后，他不能请临时帮手'], ['web', '用浏览器', '打开网页查资料'], ['cloud', '用云电脑', '在云端桌面里操作软件']];
  function allowed(id, k) { var c = E.comp(W0, id); return k in c ? !!c[k] : k === 'web'; }
  function busyIn(id) { return dsl.cases.some(function (c) { return castOf(c).indexOf(id) >= 0; }); }
  function status(c) { /* 待办跟着事情走 */
    var w = worlds[c.id], st = c.steps[w.state.idx];
    if (!ownerOf(c)) return ['待分配负责人', 'you'];
    if (st.kind === 'done') return ['已完成', 'ok'];
    if (st.kind === 'confirm') return w.state.cur.accepted ? ['归档中', ''] : ['等你验收', 'you'];
    if (w.state.halt) return ['卡住了', 'you'];
    return [w.state.log.length ? st.status : '待开始', ''];
  }
  function subsOf(c) {
    var s = worlds[c.id].state, o = ownerOf(c), out = [];
    c.steps.forEach(function (st, i) {
      var sub = null, f;
      if (st.kind === 'send' && st.source === o && (s.idx > i || (s.idx === i && s.cur.sent))) sub = { owner: st.target, title: st.envelope, ask: st.message, state: s.idx > i + 1 ? 'ok' : 'doing', f: s.files.filter(function (x) { return x.step === i; })[0] };
      else if (st.kind === 'hire' && s.hired) { f = s.files.filter(function (x) { return x.kind === 'submission'; })[0]; sub = { owner: s.hired, title: st.message.replace(/。$/, ''), ask: st.message, state: s.files.some(function (x) { return x.kind === 'artifact'; }) ? 'ok' : f ? 'wait' : 'doing', f: f || s.files.filter(function (x) { return x.step === i; })[0] }; }
      else if (st.kind === 'review' && s.idx >= i) sub = { owner: st.source, title: st.status.replace(/^待/, ''), ask: st.summary, state: s.idx > i ? 'ok' : 'doing', f: s.files.filter(function (x) { return x.step === i; })[0] };
      if (sub) { sub.i = i; sub.from = o; out.push(sub); }
    });
    return out;
  }
  function subState(x) { return x.state === 'ok' ? [N(x.from) + '已验收', 'ok'] : x.state === 'wait' ? ['等' + N(x.from) + '验收', ''] : ['进行中', '']; }
  function hhmm(ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function feed() {
    var o = notes.slice();
    each(function (c, w, s) { s.log.forEach(function (ev) {
      var t = ev.type === 'sent' ? [ev.from, '对' + N(ev.to) + '说：' + ev.text] : ev.type === 'file' ? [ev.operator, '做完了：' + c.steps[ev.step].reaction + '，交出「' + ev.name + '」'] : ev.type === 'hired' ? [ev.bot, '被请来帮忙'] :
        ev.type === 'blocked' || ev.type === 'stalled' || (ev.type === 'checked' && !ev.ok) ? [ev.from || ev.operator || c.owner, E.describe(w, ev), 1] : null;
      if (t) o.push({ ts: ev.ts || 0, who: t[0], text: t[1], c: c.id, bad: t[2] });
    }); });
    return o.sort(function (a, b) { return b.ts - a.ts; });
  }

  /* ---------- 界面 ---------- */
  var tab = saved.tab || 'things', stack = [];
  function av(id, cls) { if (!id) return '<span class="av q ' + (cls || '') + '">?</span>'; var b = E.botOf(W0, id), t = b && dsl.teams.find(function (x) { return x.id === b.team; }); return '<span class="av ' + (cls || '') + '"' + (t ? ' style="--tc:' + t.color + '"' : '') + '>' + esc(id === 'user' ? '老' : N(id).slice(-1)) + '</span>'; }
  function nav(title) { return '<div class="nav">' + (stack.length ? '<button data-go="back" aria-label="返回">' + BACK + '</button>' : '<i></i>') + '<h1>' + esc(title) + '</h1><i></i></div>'; }
  function go(o) { return ' data-go=\'' + esc(JSON.stringify(o)) + '\''; }
  function cell(o, left, title, sub, right) { return '<button class="cell' + (left ? ' a' : '') + '"' + go(o) + '>' + left + '<span class="t"><b>' + esc(title) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</span><span class="r">' + esc(right || '') + GO + '</span></button>'; }
  function botRow(id, sub, o) { return '<button class="cell chatrow"' + go(o || { p: 'one', id: id }) + '>' + av(id, 'x') + '<span class="t"><b>' + esc(N(id)) + '</b><span>' + esc(sub) + '</span></span></button>'; }

  var PAGE = {
    things: function () {
      var mine = dsl.cases.filter(function (c) { return status(c)[1] === 'you'; }), out = dsl.cases.filter(function (c) { return status(c)[1] === ''; }), done = dsl.cases.filter(function (c) { return status(c)[1] === 'ok'; });
      function row(c) {
        var st = status(c), o = ownerOf(c), ok = st[1] === 'ok', n = subsOf(c).filter(function (x) { return x.state !== 'ok'; }).length;
        return '<button class="cell todo' + (ok ? ' done' : '') + '"' + go({ p: 'thing', c: c.id }) + '><span class="box">' + (ok ? '✓' : '') + '</span><span class="t"><b>' + esc(c.title) + '</b><span class="' + st[1] + '">' + st[0] + (n && !ok ? ' · ' + n + ' 件子事情在办' : '') + '</span></span>' +
          (o ? '<span class="who">' + esc(N(o)) + av(o) + '</span>' : '<span class="pillb">分配</span>') + '</button>';
      }
      function sec(title, list, none) { return '<div class="sec">' + title + ' ' + list.length + '</div><div class="cells">' + (list.map(row).join('') || '<p class="none" style="padding:20px 16px">' + none + '</p>') + '</div>'; }
      return nav('事情') + '<div class="body"><div class="newt"><input id="nt" placeholder="添加一件事…" aria-label="添加一件事"><button data-do="newthing">添加</button></div>' +
        sec('要我出手的', mine, '现在没有要你出手的事') + sec('别人在办的', out, '没有在办的事') + (done.length ? sec('已完成', done, '') : '') + '</div>';
    },
    thing: function (g) {
      var c = dsl.cases.find(function (x) { return x.id === g.c; }), w = worlds[c.id], s = w.state, st = c.steps[s.idx], o = ownerOf(c), sta = status(c), act = '', look = '';
      var files = s.files.filter(function (f) { return f.kind !== 'submission'; }), art = files.filter(function (f) { return f.kind === 'artifact'; }).pop() || files[files.length - 1], subs = subsOf(c);
      var log = feed().filter(function (x) { return x.c === c.id; });
      if (!o) act = '<button class="go"' + go({ p: 'pick', c: c.id }) + '>分配负责人</button>';
      else if (sta[0] === '等你验收') { look = art ? '<div class="sec">先看一眼他交出的东西</div><div class="cells">' + cell({ p: 'job', c: c.id, f: art.id, t: 'file' }, '', art.name, N(art.owner) + '交出', '') + '</div>' : ''; act = '<button class="go" data-do="accept" data-c="' + c.id + '">' + esc(st.action) + '</button>'; }
      else if (s.halt) act = '<button class="go alt" data-do="retry" data-c="' + c.id + '">再试一次</button>';
      return nav(c.title) + '<div class="body"><div class="cells"><div class="cell text"><small><span class="st ' + sta[1] + '">' + sta[0] + '</span></small><b style="font-size:20px">' + esc(st.kind === 'done' ? '办完了' : c.headline) + '</b><p>' + esc(o ? st.summary : '还没有人负责，分配后才会开始。') + '</p>' + (s.halt && o ? '<p class="warn">' + esc(E.describe(w, s.halt)) + '</p>' : '') + '</div></div>' + look + (act ? '<div class="act">' + act + '</div>' : '<div class="gap"></div>') +
        '<div class="cells">' + (o ? '<button class="cell a"' + go({ p: 'one', id: o }) + '>' + av(o) + '<span class="t"><b>' + esc(N(o)) + '</b><span>负责人 · ' + esc(job(o)) + '</span></span><span class="r">' + GO + '</span></button>' : '') +
        (o && st.kind !== 'done' ? cell({ p: 'pick', c: c.id }, '', '换一位负责人', '', '') : '') + '</div>' +
        (subs.length ? '<div class="sec">子事情 · 谁派的谁验收</div><div class="cells">' + subs.map(function (x) { var ss = subState(x); return '<button class="cell todo' + (ss[1] === 'ok' ? ' done' : '') + '"' + go({ p: 'sub', c: c.id, i: x.i }) + '><span class="box">' + (ss[1] === 'ok' ? '✓' : '') + '</span><span class="t"><b>' + esc(x.title) + '</b><span>' + ss[0] + '</span></span><span class="who">' + esc(N(x.owner)) + av(x.owner) + '</span></button>'; }).join('') + '</div>' : '') +
        (files.length ? '<div class="sec">交出的材料</div><div class="cells">' + files.map(function (f) { return cell({ p: 'job', c: c.id, f: f.id, t: 'file' }, '', f.name, N(f.owner), ''); }).join('') + '</div>' : '') +
        (log.length ? '<div class="sec">经过 · 最新的在上</div><div class="cells">' + log.map(function (x) { return '<div class="cell a">' + av(x.who) + '<span class="t"><b>' + esc(N(x.who)) + '</b><span class="wrap' + (x.bad ? ' warn' : '') + '">' + esc(x.text) + '</span></span><time>' + hhmm(x.ts) + '</time></div>'; }).join('') + '</div>' : '') + '<div class="gap"></div></div>';
    },
    sub: function (g) {
      var c = dsl.cases.find(function (x) { return x.id === g.c; }), x = subsOf(c).filter(function (k) { return k.i === g.i; })[0], ss = subState(x);
      return nav(x.title) + '<div class="body"><div class="cells"><div class="cell text"><small>子事情 · <span class="st ' + ss[1] + '">' + ss[0] + '</span></small><b style="font-size:20px">' + esc(x.title) + '</b><p>' + esc(x.ask) + '</p></div></div><div class="gap"></div>' +
        '<div class="cells">' + cell({ p: 'one', id: x.owner }, av(x.owner), N(x.owner), '负责人 · ' + job(x.owner), '') + cell({ p: 'one', id: x.from }, av(x.from), N(x.from), '派的人，也由他验收', '') + cell({ p: 'thing', c: c.id }, '', c.title, '属于这件事', '') + '</div>' +
        (x.f ? '<div class="sec">交回的材料</div><div class="cells">' + cell({ p: 'job', c: c.id, f: x.f.id }, '', x.f.name, N(x.f.owner) + '的电脑', '') + '</div>' : '') +
        '<p class="foot">这件子事情不是你派的，所以不用你验收。</p></div>';
    },
    pick: function (g) {
      var c = dsl.cases.find(function (x) { return x.id === g.c; });
      return nav('分配负责人') + '<div class="body"><div class="sec">' + esc(c.title) + ' · 选一位来负责</div>' + dsl.teams.filter(function (t) { return t.id !== 'market'; }).map(function (t) {
        return '<div class="sec">' + esc(t.name) + '</div><div class="cells">' + dsl.bots.filter(function (b) { return b.team === t.id; }).map(function (b) { return '<button class="cell a" data-do="assign" data-c="' + c.id + '" data-id="' + b.id + '">' + av(b.id) + '<span class="t"><b>' + esc(b.name) + '</b><span>' + esc(b.skills) + '</span></span></button>'; }).join('') + '</div>';
      }).join('') + '</div>';
    },
    staff: function () {
      var busy = []; dsl.cases.forEach(function (c) { if (status(c)[1] !== 'ok') castOf(c).forEach(function (id) { if (busy.indexOf(id) < 0) busy.push(id); }); });
      function row(id) { var own = ownsOf(id).filter(function (c) { return status(c)[1] !== 'ok'; }); return '<button class="cell a"' + go({ p: 'one', id: id }) + '>' + av(id) + '<span class="t"><b>' + esc(N(id)) + '</b><span>' + (doing(id).length ? '<span class="run">正在' + esc(doing(id)[0].text) + '</span>' : esc(own.length ? '负责：' + own.map(function (c) { return c.title; }).join('、') : job(id)) + (onDuty(id) ? '' : ' · 已停工')) + '</span></span></button>'; }
      return nav('员工') + '<div class="body"><div class="cells">' + cell({ p: 'add' }, '<span class="av q">+</span>', '新增员工', '', '') + '</div>' +
        (busy.length ? '<div class="sec">手上有事</div><div class="cells">' + busy.map(row).join('') + '</div>' : '') +
        dsl.teams.map(function (t) { var m = dsl.bots.filter(function (b) { return b.team === t.id && busy.indexOf(b.id) < 0; }); return m.length ? '<div class="sec">' + esc(t.name) + '</div><div class="cells">' + m.map(function (b) { return row(b.id); }).join('') + '</div>' : ''; }).join('') + '<p class="foot">' + dsl.bots.length + ' 位员工</p></div>';
    },
    feed: function () {
      var list = feed();
      return nav('动态') + '<div class="body"><div class="cells">' + (list.map(function (x) {
        var c = dsl.cases.find(function (k) { return k.id === x.c; });
        return '<button class="cell a"' + go(c ? { p: 'thing', c: c.id } : { p: 'one', id: x.who }) + '>' + av(x.who) + '<span class="t"><b>' + esc(N(x.who)) + (c ? ' <small style="color:var(--ink-2)">· ' + esc(c.title) + '</small>' : '') + '</b><span class="wrap' + (x.bad ? ' warn' : '') + '">' + esc(x.text) + '</span></span><time>' + hhmm(x.ts) + '</time></button>';
      }).join('') || '<p class="none">还没有动态</p>') + '</div></div>';
    },
    one: function (g) {
      var own = ownsOf(g.id), on = onDuty(g.id);
      return nav('') + '<div class="body"><div class="cells"><div class="cell big a">' + av(g.id, 'l') + '<span class="t"><b>' + esc(N(g.id)) + '</b><span>' + (on ? '' : '已停工 · ') + esc(job(g.id)) + '</span></span></div></div>' +
        (own.length ? '<div class="sec">负责的事</div><div class="cells">' + own.map(function (c) { var st = status(c); return cell({ p: 'thing', c: c.id }, '', c.title, '', st[0]); }).join('') + '</div>' : '') +
        '<div class="sec">手机</div><div class="cells">' + cell({ p: 'phone', id: g.id }, '', '他在联系谁', '', chatsOf(g.id).length + ' 个聊天') + cell({ p: 'reach', id: g.id }, '', '他能联系谁', '', (E.contactsOf(W0, g.id).filter(function (o) { return E.granted(W0, g.id, o); }).length + matesOf(g.id).length) + ' 人') + '</div>' +
        '<div class="sec">电脑</div><div class="cells">' + cell({ p: 'pc', id: g.id }, '', '他在做什么', '', doing(g.id).length ? '正在干活' : jobsOf(g.id).length + ' 个任务') + cell({ p: 'allow', id: g.id }, '', '允许他做什么', '', ALLOW.filter(function (x) { return allowed(g.id, x[0]); }).length + ' / ' + ALLOW.length + ' 项') + '</div>' +
        '<div class="sec">岗位</div><div class="cells">' + cell({ p: 'role', id: g.id }, '', '岗位', '', job(g.id)) +
        '<button class="cell text"' + go({ p: 'prompt', id: g.id }) + '><small>岗位提示 · 点开修改</small><p>' + esc(promptOf(g.id)) + '</p></button></div>' +
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
    phone: function (g) { /* 他在联系谁 */
      var list = chatsOf(g.id);
      return nav(N(g.id) + '在联系谁') + '<div class="body">' + (list.length ? '<div class="cells">' + list.map(function (o) { return botRow(o, msgsOf(g.id, o).pop().text, { p: 'chat', id: g.id, o: o }); }).join('') + '</div>' : '<p class="none">还没有聊天记录</p>') + '</div>';
    },
    reach: function (g) { /* 他能联系谁 */
      var people = E.contactsOf(W0, g.id);
      return nav(N(g.id) + '能联系谁') + '<div class="body"><div class="sec">打开的人，他可以主动发消息</div><div class="cells">' + people.map(function (o) { return '<label class="cell a sw">' + av(o) + '<span class="t"><b>' + esc(N(o)) + '</b><span>' + esc(job(o)) + '</span></span><input type="checkbox" data-sw="grant" data-id="' + g.id + '" data-b="' + o + '"' + (E.granted(W0, g.id, o) ? ' checked' : '') + '></label>'; }).join('') +
        matesOf(g.id).map(function (o) { return '<div class="cell a">' + av(o) + '<span class="t"><b>' + esc(N(o)) + '</b><span>只为这次委托：交办和回传结果</span></span><span class="r">临时</span></div>'; }).join('') +
        cell({ p: 'addc', id: g.id }, '<span class="av q">+</span>', '添加联系人', '', '') + '</div><div class="gap"></div></div>';
    },
    allow: function (g) { /* 允许他做什么 */
      return nav('允许' + N(g.id) + '做什么') + '<div class="body"><div class="gap"></div><div class="cells">' + ALLOW.map(function (x) { return '<label class="cell sw"><span class="t"><b>' + x[1] + '</b><span>' + x[2] + '</span></span><input type="checkbox" data-sw="comp" data-id="' + g.id + '" data-b="' + x[0] + '"' + (allowed(g.id, x[0]) ? ' checked' : '') + '></label>'; }).join('') + '</div><p class="foot">前三项会直接影响他手上的事；浏览器和云电脑还没有接通，这里先记下你的决定。</p></div>';
    },
    chat: function (g) {
      return nav(N(g.o)) + '<div class="body"><div class="chat">' + msgsOf(g.id, g.o).map(function (m) { return '<div class="line' + (m.from === g.id ? ' me' : '') + '">' + av(m.from) + '<div class="msg">' + esc(m.text) + '</div></div>'; }).join('') + '</div><p class="foot">这是' + esc(N(g.id)) + '的手机，绿色是' + esc(N(g.id)) + '发的。</p></div>';
    },
    pc: function (g) { /* Codex 式：任务列表 + 底部派任务 */
      var list = jobsOf(g.id), now = doing(g.id);
      return nav(N(g.id) + '的电脑') + '<div class="body codex"><div class="sec mono">Codex · ' + (list.length + now.length) + ' 个任务</div>' +
        now.map(function (x) { return '<button class="tk"' + go({ p: 'thing', c: x.c.id }) + '><span class="t"><b>' + esc(x.text) + '</b><span>' + esc(x.c.title) + '</span></span><em class="go">运行中…</em></button>'; }).join('') +
        (list.length || now.length ? list.slice().reverse().map(function (j) { return '<button class="tk"' + go({ p: 'job', c: j.c.id, f: j.f.id }) + '><span class="t"><b>' + esc(did(j.c, j.f)) + '</b><span>' + esc(j.c.title) + '</span></span><em>✓ 完成</em></button>'; }).join('') : '<p class="none">这台电脑还没有接到任务</p>') +
        '</div><div class="composer"><input id="task" placeholder="交给' + esc(N(g.id)) + '一件事…" aria-label="派一个任务"><button data-do="task" data-id="' + g.id + '" aria-label="发送">↑</button></div>';
    },
    job: function (g) { /* 一个任务：对话、文件、浏览器、云电脑 */
      var c = dsl.cases.find(function (x) { return x.id === g.c; }), w = worlds[c.id], s = w.state, f = s.files.find(function (x) { return x.id === g.f; }), st = c.steps[f.step], t = g.t || 'chat', sub = f.kind === 'submission', body;
      var from = sub ? c.owner : f.from, askText = sub ? (c.steps.find(function (x) { return x.kind === 'hire'; }) || st).message : st.message, vals = Object.keys(f.values || {});
      var lines = sub ? ['run sandbox  # 本地模拟'].concat(vals.map(function (k) { return 'check ' + k + ' = ' + E.show(f.values[k]); })) : ['read 「' + f.input + '」'].concat(f.kind === 'artifact' ? ['read ' + N(f.submitter) + ' 的提交件 ' + f.version] : []);
      if (t === 'chat') body = '<div class="thread"><div class="ask"><small>' + esc(N(from)) + '</small>' + esc(askText) + '</div>' +
        '<details class="work mono" open><summary>处理了 ' + (lines.length + 1) + ' 步</summary><div>' + lines.map(function (x) { return '<p>' + esc(x) + '</p>'; }).join('') + '<p class="ok">write ' + esc(f.name) + '</p></div></details>' +
        '<p style="margin:0">' + esc(did(c, f)) + '，已完成。' + (sub ? '核对通过，结果交回给' + esc(N(c.owner)) + '。' : '') + '</p>' +
        '<button class="diff" data-t="file"><span class="mono">+ 新文件</span><b>' + esc(f.name) + '</b>' + GO.replace('<svg', '<svg width="16" height="16"') + '</button></div>';
      else if (t === 'file') body = '<div class="doc"><h2>' + esc(f.name) + '</h2><p>' + esc(f.body) + '</p>' + (vals.length ? '<table>' + vals.map(function (k) { return '<tr><td>' + esc(k) + '</td><td>' + esc(E.show(f.values[k])) + '</td></tr>'; }).join('') + '</table>' : '') + '</div>';
      else if (t === 'web') body = '<div class="frame"><div class="bar"><i></i><i></i><i></i><span class="mono">about:blank</span></div><div class="blank">' + (allowed(f.owner, 'web') ? '这个任务没有用到浏览器。<br>接通后，他打开过的网页会显示在这里。' : '你没有允许' + esc(N(f.owner)) + '用浏览器。') + '</div></div>';
      else if (!allowed(f.owner, 'cloud')) body = '<div class="frame"><div class="blank">你没有允许' + esc(N(f.owner)) + '用云电脑。<br>在「允许他做什么」里可以打开。</div></div>';
      else body = '<div class="frame"><div class="desk"><div class="winx"><div class="bar"><i></i><i></i><i></i><span class="mono">' + esc(f.name) + '</span></div><p>' + esc(f.body) + '</p></div><div class="dockx"></div></div></div><p class="foot">示意画面：云电脑还没有接通。接通后可以在这里看他的屏幕。</p>';
      return nav(did(c, f)) + '<div class="body codex"><div class="tools">' + [['chat', '对话'], ['file', '文件'], ['web', '浏览器'], ['cloud', '云电脑']].map(function (x) { return '<button data-t="' + x[0] + '" aria-current="' + (t === x[0]) + '">' + x[1] + '</button>'; }).join('') + '</div>' + body +
        '<div class="cells" style="margin-top:auto;border-top:1px solid var(--line)">' + cell({ p: 'thing', c: c.id }, '', c.title, '这件事', '') + '</div></div>';
    }
  };
  function draw(keep) {
    var old = document.querySelector('.body'), top = keep && old ? old.scrollTop : 0;
    var g = stack[stack.length - 1], h = g ? PAGE[g.p](g) : PAGE[tab]();
    if (!g) { var n = dsl.cases.filter(function (c) { return status(c)[1] === 'you'; }).length; h += '<div class="tabs">' + TABS.map(function (t) { return '<button data-tab="' + t[0] + '" aria-current="' + (t[0] === tab) + '">' + t[2] + t[1] + (t[0] === 'things' && n ? '<em>' + n + '</em>' : '') + '</button>'; }).join('') + '</div>'; }
    document.getElementById('app').innerHTML = h;
    var body = document.querySelector('.body'); if (body) body.scrollTop = g && (g.p === 'chat') && !keep ? 1e6 : top;
  }
  var DO = {
    accept: function (d) { var w = worlds[d.c]; E.act(w); stamp(w); note('user', '验收了这件事', d.c); },
    retry: function (d) { var w = worlds[d.c], c = E.caseOf(w); E.act(w, { bot: c.market[0] }); stamp(w); },
    assign: function (d) { var c = dsl.cases.find(function (x) { return x.id === d.c; }); reassign(c, d.id); owners[c.id] = d.id; note('user', '把这件事交给了' + N(d.id), c.id); stack.pop(); },
    task: function (d) {
      var el = document.getElementById('task'), title = el.value.trim(); if (!title) { el.focus(); return; }
      var x = { id: 't' + Date.now().toString(36), title: title }; custom.push(x); var c = makeCase(x.id, x.title); dsl.cases.push(c); boot(c, 9); reassign(c, d.id); owners[c.id] = d.id; note('user', '交给' + N(d.id) + '一件事', c.id);
    },
    newthing: function () {
      var el = document.getElementById('nt'), title = el.value.trim(); if (!title) { el.focus(); return; }
      var x = { id: 't' + Date.now().toString(36), title: title }; custom.push(x); var c = makeCase(x.id, x.title); dsl.cases.push(c); owners[c.id] = null; boot(c, 9); note('user', '加了一件事', c.id);
    },
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
    var el = e.target.closest('[data-go],[data-tab],[data-do],[data-t]'); if (!el) return;
    if (el.dataset.t) { stack[stack.length - 1].t = el.dataset.t; draw(); return; }
    if (el.dataset.do) { DO[el.dataset.do](el.dataset); save(); }
    else if (el.dataset.tab) { tab = el.dataset.tab; saved.tab = tab; }
    else if (el.dataset.go === 'back') stack.pop();
    else stack.push(JSON.parse(el.dataset.go));
    draw();
  });
  document.addEventListener('keydown', function (e) { if (e.key !== 'Enter') return; if (e.target.id === 'nt') { DO.newthing(); save(); draw(); } else if (e.target.id === 'task') { DO.task({ id: stack[stack.length - 1].id }); save(); draw(); } });
  document.addEventListener('change', function (e) {
    var d = e.target.dataset; if (!d.sw) return;
    if (d.sw === 'grant') { book.grants[d.id + '>' + d.b] = e.target.checked; notes.push({ ts: Date.now() + (tick++), who: d.id, text: (e.target.checked ? '被允许' : '不再被允许') + '主动联系' + N(d.b) }); }
    else { var o = book.comp[d.id] = book.comp[d.id] || {}; o[d.b] = e.target.checked; var lab = ALLOW.filter(function (x) { return x[0] === d.b; })[0]; notes.push({ ts: Date.now() + (tick++), who: d.id, text: (e.target.checked ? '被允许' : '不再被允许') + lab[1] }); }
    dsl.cases.forEach(function (c) { var w = worlds[c.id]; if (w.state.halt && ownerOf(c)) { E.act(w, { bot: c.market[0] }); stamp(w); } });
    save(); draw();
  });
  /* 员工自己干活：每隔一会儿，每件有负责人的事往前走一小步；轮到老板或卡住时停下 */
  function tickOne(c) {
    var w = worlds[c.id], s = w.state, p = E.plan(w);
    if (!ownerOf(c) || !p || s.halt) return false;
    if (p.user) { if (c.steps[s.idx].kind === 'confirm' && !s.cur.accepted) return false; E.act(w, { bot: c.market[0] }); }
    else E.advance(w);
    stamp(w); return true;
  }
  function step() {
    var moved = false; dsl.cases.forEach(function (c) { if (tickOne(c)) moved = true; });
    if (!moved) return;
    save(); var a = document.activeElement; if (!(a && /INPUT|TEXTAREA/.test(a.tagName) && a.type !== 'checkbox')) draw(true);
  }
  var timer = setInterval(function () { if (!window.__matter.paused) step(); }, 1300);
  draw();
  window.__matter = { worlds: worlds, owners: owners, paused: false, tick: step, settle: function (id) { var c = dsl.cases.find(function (x) { return x.id === id || x.title === id; }), n = 0; while (tickOne(c) && n++ < 200); save(); draw(true); } };
})();
