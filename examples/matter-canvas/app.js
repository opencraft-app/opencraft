/* 管理 Bot：选一个 Bot，看它的手机（联系人、聊天记录）和它的电脑（Codex 式的任务记录）。界面只读引擎状态；每一步都先成为事件。 */
(function () {
  'use strict';
  var E = window.MatterEngine, KEY = 'opencraft.matter-canvas.v3';
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  var dsl = E.validate(E.clone(window.MATTER_DSL)), w;
  var ui = { auto: false, held: false, clock: 0, sel: null, tab: 'chats', thread: null, dev: 'phone', q: '' };

  function start(caseId, events) {
    var run = E.newRun(dsl, caseId, 1, 'run'); run.events = events || [];
    w = E.makeWorld(dsl, E.emptyBook(), run, 'real'); ui.auto = false; ui.held = false; ui.clock = 0; ui.sel = E.caseOf(w).owner; ui.thread = null; ui.tab = 'chats';
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify({ caseId: w.run.caseId, events: w.run.events })); } catch (e) { /* 没有存储也能用 */ } }
  function load() { try { var d = JSON.parse(localStorage.getItem(KEY)); if (d && dsl.cases.some(function (c) { return c.id === d.caseId; })) return d; } catch (e) { /* ignore */ } return null; }
  function C() { return E.caseOf(w); }
  function N(id) { return E.nameOf(w, id); }
  function step() { return C().steps[w.state.idx]; }
  function ico(id, cls) { var b = E.botOf(w, id), t = b && dsl.teams.find(function (x) { return x.id === b.team; }); return '<span class="ico ' + (cls || '') + (id === 'user' ? ' you' : '') + '"' + (t ? ' style="--tc:' + t.color + '"' : '') + '></span>'; }
  function clock(seq) { var m = 12 + seq; return '09:' + ('0' + m % 60).slice(-2); }
  function between(a, b) { return w.state.messages.filter(function (m) { return (m.from === a && m.to === b) || (m.from === b && m.to === a); }); }
  function busy(id) { return w.state.working && w.state.working.operator === id; }

  /* ---------- 顶栏 ---------- */
  function nextLabel() {
    var c = C(), s = w.state, st = step();
    if (s.halt) return '再试一次';
    if (st.kind === 'hire' && !s.cur.hired) return '请' + N(c.market[0]) + '帮忙';
    return st.action;
  }
  function drawTop() {
    var c = C(), s = w.state, st = step(), p = E.plan(w), last = s.log[s.log.length - 1], moving = p && !p.user, acts, text;
    if (s.halt) text = E.describe(w, s.halt);
    else if (st.kind === 'done') text = '办完了。' + st.summary;
    else if (!last) text = c.headline + '。' + N(c.owner) + '在办，暂时不用你出手。';
    else if (st.kind === 'confirm' && !moving) text = '轮到你了：在' + N(c.owner) + '的电脑里看「' + c.artifact + '」，没问题就确认。';
    else text = E.describe(w, last);
    if (st.kind === 'done') acts = '<button class="btn primary" data-a="reset">再来一遍</button>';
    else if (moving && ui.held) acts = '<button class="btn primary" data-a="resume">继续</button>';
    else if (ui.auto || moving) acts = '<button class="btn" data-a="hold">暂停</button>';
    else acts = (last ? '' : '<button class="btn primary" data-a="auto">看' + esc(N(c.owner)) + '怎么做</button>') + '<button class="btn' + (last ? ' primary' : '') + '" data-a="next">' + esc(nextLabel()) + '</button>' +
      (last ? '<button class="btn plain" data-a="auto">自动播放</button><button class="btn plain" data-a="reset">重来</button>' : '');
    $('#top').innerHTML = '<div class="cases">' + dsl.cases.map(function (x) { return '<button data-a="case" data-id="' + x.id + '" aria-pressed="' + (x.id === c.id) + '">' + esc(x.title) + '</button>'; }).join('') + '</div>' +
      '<p' + (s.halt ? ' class="bad"' : '') + '><span class="m">' + esc(st.status) + ' · 本地模拟</span><br>' + esc(text) + '</p><div class="acts">' + acts + '</div>';
  }

  /* ---------- Bot 列表 ---------- */
  function involved() {
    var c = C(), s = w.state, ids = [c.owner];
    function add(id) { if (id && id !== 'user' && id !== 'contract' && ids.indexOf(id) < 0) ids.push(id); }
    add(c.peer); s.log.forEach(function (ev) { add(ev.from); add(ev.to); add(ev.bot); add(ev.operator); });
    return ids;
  }
  function botRow(id) {
    var s = w.state, unread = s.messages.some(function (m) { return m.to === id && m.state === 'delivered' && m.step === s.idx; });
    var tag = busy(id) ? '<span class="tagb o">工作中</span>' : unread ? '<span class="tagb b">新消息</span>' : '';
    return '<button class="rowb" data-a="sel" data-id="' + id + '" aria-current="' + (ui.sel === id) + '">' + ico(id) + '<span class="t"><b>' + esc(N(id)) + '</b><span>' + esc(E.skillsOf(w, id)) + '</span></span><span class="r">' + tag + '</span></button>';
  }
  function drawBots() {
    var q = ui.q.trim(), act = involved(), h = '';
    var hit = function (id) { return !q || (N(id) + E.skillsOf(w, id)).indexOf(q) >= 0; };
    var a = act.filter(hit), rest = dsl.bots.map(function (b) { return b.id; }).filter(function (id) { return act.indexOf(id) < 0 && hit(id); });
    if (a.length) h += '<div class="grp m">这件事里</div>' + a.map(botRow).join('');
    if (rest.length) h += '<div class="grp m">其他 Bot · ' + rest.length + '</div>' + rest.map(botRow).join('');
    var el = $('#bots'), keep = el.querySelector('.search'), top = el.querySelector('.list') ? el.querySelector('.list').scrollTop : 0;
    if (!keep) { el.innerHTML = '<div class="hd"><h2>Bot</h2><span class="m">' + dsl.bots.length + '</span></div><input class="search" id="q" placeholder="搜索 Bot" aria-label="搜索 Bot"><div class="list"></div>'; }
    el.querySelector('.list').innerHTML = h || '<div class="empty">没有找到。</div>'; el.querySelector('.list').scrollTop = top;
  }

  /* ---------- 手机 ---------- */
  function drawPhone() {
    var id = ui.sel, s = w.state, c = C(), el = $('#phone'), o = ui.thread, h, rows = '';
    var contacts = E.contactsOf(w, id), mate = s.hired && (id === c.owner ? s.hired : id === s.hired ? c.owner : null);
    if (mate && contacts.indexOf(mate) < 0) contacts.unshift(mate);
    if (o) {
      var body = between(id, o).map(function (m) {
        var me = m.from === id, ev = s.log.find(function (e) { return e.type === 'sent' && e.delivery === m.id; });
        return '<div class="msg' + (me ? ' me' : '') + (m.state === 'delivered' ? '' : ' way') + '">' + esc(m.text) + '</div><div class="m meta' + (me ? ' me' : '') + '">' + clock(ev ? ev.seq : 0) + ' · ' + (m.state === 'delivered' ? '已送达' : '发送中') + '</div>';
      }).join('');
      h = '<div class="hd"><button class="back" data-a="thread" data-id="" aria-label="返回">‹</button>' + ico(o, 's') + '<h2>' + esc(N(o)) + '</h2><span class="m">' + esc(N(id)) + '的手机</span></div><div class="thread">' + (body || '<div class="empty">这件事里还没有聊过。</div>') + '</div>';
    } else {
      if (ui.tab === 'chats') {
        var peers = contacts.concat(id === c.owner ? ['user'] : []).filter(function (x) { return between(id, x).length; });
        peers.sort(function (a, b) { return between(id, b).pop().seq - between(id, a).pop().seq; });
        peers.forEach(function (x) { var lm = between(id, x).pop(); rows += '<button class="rowb" data-a="thread" data-id="' + x + '">' + ico(x) + '<span class="t"><b>' + esc(N(x)) + '</b><span>' + esc(lm.text) + '</span></span><span class="r">' + clock(lm.seq) + '</span></button>'; });
        rows = rows || '<div class="empty">还没有聊天记录。</div>';
      } else {
        contacts.forEach(function (x) { rows += '<button class="rowb" data-a="thread" data-id="' + x + '">' + ico(x) + '<span class="t"><b>' + esc(N(x)) + '</b><span>' + esc(E.skillsOf(w, x)) + '</span></span><span class="r">' + (E.knows(w, id, x) ? '联系人' : '临时委托') + '</span></button>'; });
        rows = rows || '<div class="empty">没有联系人。</div>';
      }
      h = '<div class="hd"><h2>' + esc(N(id)) + '的手机</h2></div><div class="seg"><button data-a="tab" data-id="chats" aria-pressed="' + (ui.tab === 'chats') + '">聊天</button><button data-a="tab" data-id="contacts" aria-pressed="' + (ui.tab === 'contacts') + '">联系人 ' + contacts.length + '</button></div><div class="list">' + rows + '</div>';
    }
    el.innerHTML = h; var t = el.querySelector('.thread'); if (t) t.scrollTop = 1e6;
  }

  /* ---------- 电脑（Codex） ---------- */
  function tasksOf(id) {
    var s = w.state, c = C(), list = [], cur = null;
    s.log.forEach(function (ev) {
      if (ev.type === 'working' && ev.operator === id) { cur = { title: ev.reaction, ask: N(c.steps[ev.step].source === 'contract' ? s.hired : c.steps[ev.step].source) + '：' + c.steps[ev.step].message, steps: ['读取 「' + ev.input + '」'], seq: ev.seq, state: 'run' }; list.push(cur); }
      else if (ev.type === 'sandbox' && ev.operator === id) { cur = { title: ev.text.replace(/。$/, ''), ask: '继续这次委托', steps: ['运行 沙盒（本地模拟）'], seq: ev.seq, state: 'run' }; list.push(cur); }
      else if (ev.type === 'checked' && cur && s.hired === id) { cur.steps.push(ev.ok ? '校验 通过：' + Object.keys(ev.actual).map(function (k) { return k + '=' + E.show(ev.actual[k]); }).join('，') : '校验 没过：' + ev.diffs.map(function (d) { return d.key + ' 应为 ' + E.show(d.expected) + '，实际 ' + E.show(d.actual); }).join('；')); if (!ev.ok) cur.state = 'bad'; }
      else if ((ev.type === 'file' || ev.type === 'submitted') && ev.operator === id && cur) { cur.steps.push('写入 ' + ev.name); cur.file = s.files.find(function (f) { return f.owner === id && f.name === ev.name; }); cur.state = 'done'; }
    });
    return list;
  }
  function fileBox(f, open) {
    var vals = Object.keys(f.values || {}).map(function (k) { return '<tr><td>' + esc(k) + '</td><td>' + esc(E.show(f.values[k])) + '</td></tr>'; }).join('');
    return '<details data-id="' + esc(f.id) + '"' + (open ? ' open' : '') + '><summary>' + esc(f.name) + '</summary><div><p>' + esc(f.body) + '</p>' + (vals ? '<table>' + vals + '</table>' : '') + '</div></details>';
  }
  function drawPc() {
    var id = ui.sel, c = C(), el = $('#pc'), list = tasksOf(id), h = '';
    var open = Array.prototype.map.call(el.querySelectorAll('details[open]'), function (d) { return d.dataset.id; }), top = el.querySelector('.tasks') ? el.querySelector('.tasks').scrollTop : 0;
    list.slice().reverse().forEach(function (t) {
      var last = t.steps.length - 1;
      h += '<div class="task' + (t.state === 'run' ? ' run' : '') + '"><div class="tt"><b>' + esc(t.title) + '</b><span class="' + (t.state === 'done' ? 'ok' : t.state === 'bad' ? 'no' : 'go') + '">' + (t.state === 'done' ? '✓ 完成' : t.state === 'bad' ? '✕ 待返工' : '运行中') + '</span><span class="m">' + clock(t.seq) + '</span></div>' +
        '<div class="ask">' + esc(t.ask) + '</div><div class="steps">' + t.steps.map(function (x, i) { return '<div' + (t.state === 'run' && i === last ? ' class="cur"' : '') + '><i>•</i>' + esc(x) + '</div>'; }).join('') + '</div>' +
        (t.file ? fileBox(t.file, open.indexOf(t.file.id) >= 0 || (t.file.kind === 'artifact' && step().kind === 'confirm')) : '') + '</div>';
    });
    if (id === c.owner) h += '<div class="task"><div class="tt"><b>' + esc(c.desktop.title) + '</b><span class="m">手头的任务单</span></div><div class="steps">' + esc(c.desktop.body) + '</div></div>';
    el.innerHTML = '<div class="hd"><h2>' + esc(N(id)) + '的电脑</h2><span class="m">Codex · ' + list.length + ' 个任务</span></div><div class="tasks">' + (h || '<div class="empty">这台电脑还没有接到任务。</div>') + '</div>';
    el.querySelector('.tasks').scrollTop = top;
  }
  function drawDevs() {
    var el = $('#devs'); if (!el) { el = document.createElement('div'); el.id = 'devs'; $('#main').insertBefore(el, $('#phone')); }
    el.innerHTML = '<button data-a="dev" data-id="phone" aria-pressed="' + (ui.dev === 'phone') + '">手机</button><button data-a="dev" data-id="pc" aria-pressed="' + (ui.dev === 'pc') + '">电脑</button>';
    $('#main').className = ui.dev;
  }
  function draw() { drawTop(); drawBots(); drawDevs(); drawPhone(); drawPc(); }

  /* ---------- 推进 ---------- */
  function fired(ev) { if (!ev) return; ui.clock = 0; save(); draw(); }
  function next() { fired(E.act(w, { bot: C().market[0] })); }
  var last = 0;
  function frame(ts) {
    var dt = Math.min(100, ts - last || 0), p = E.plan(w); last = ts;
    if (p && !p.user && !ui.held) { ui.clock += dt; if (ui.clock >= p.delay) fired(E.advance(w)); }
    else if (p && p.user && ui.auto) { if (w.state.halt) { ui.auto = false; draw(); } else { ui.clock += dt; if (ui.clock >= 1200) next(); } }
    else if (!p && ui.auto) { ui.auto = false; draw(); }
    requestAnimationFrame(frame);
  }
  var A = {
    next: function () { ui.held = false; next(); },
    auto: function () { ui.auto = true; ui.held = false; draw(); },
    hold: function () { ui.auto = false; ui.held = true; draw(); },
    resume: function () { ui.held = false; draw(); },
    reset: function () { start(w.run.caseId); save(); draw(); },
    'case': function (d) { start(d.id); save(); draw(); },
    sel: function (d) { ui.sel = d.id; ui.thread = null; draw(); },
    tab: function (d) { ui.tab = d.id; drawPhone(); },
    thread: function (d) { ui.thread = d.id || null; drawPhone(); },
    dev: function (d) { ui.dev = d.id; drawDevs(); }
  };
  document.addEventListener('click', function (e) { var el = e.target.closest('[data-a]'); if (el && A[el.dataset.a]) A[el.dataset.a](el.dataset); });
  document.addEventListener('input', function (e) { if (e.target.id === 'q') { ui.q = e.target.value; drawBots(); } });

  var saved = load(); start(saved ? saved.caseId : dsl.cases[0].id, saved && saved.events); draw();
  requestAnimationFrame(frame);
  window.__matter = { get w() { return w; }, ui: ui, E: E };
})();
