/* 事项画布：一件事，几个 Bot，每个 Bot 一台电脑一部手机。界面只读引擎状态；每一步都先成为事件。 */
(function () {
  'use strict';
  var E = window.MatterEngine, KEY = 'opencraft.matter-canvas.v2';
  var $ = function (s) { return document.querySelector(s); };
  var still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)');
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  var dsl = E.validate(E.clone(window.MATTER_DSL)), w, L;
  var ui = { auto: false, clock: 0, sheet: null, view: { x: 0, y: 0, k: 1 }, key: '', hot: null };

  function start(caseId, events) {
    var run = E.newRun(dsl, caseId, 1, 'run'); run.events = events || [];
    w = E.makeWorld(dsl, E.emptyBook(), run, 'real'); ui.auto = false; ui.held = false; ui.clock = 0; ui.hot = null; ui.sheet = null; L = null;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify({ caseId: w.run.caseId, events: w.run.events })); } catch (e) { /* 没有存储也能用 */ } }
  function load() { try { var d = JSON.parse(localStorage.getItem(KEY)); if (d && dsl.cases.some(function (c) { return c.id === d.caseId; })) return d; } catch (e) { /* ignore */ } return null; }
  function C() { return E.caseOf(w); }
  function N(id) { return E.nameOf(w, id); }
  function step() { return C().steps[w.state.idx]; }

  /* ---------- 谁在场、站哪里 ---------- */
  var PC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.500" width="18" height="12" rx="2"/><path d="M9 20h6"/></svg>';
  var PH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="3" width="10" height="18" rx="2.500"/><path d="M11 17.500h2"/></svg>';
  function cast() {
    var c = C(), s = w.state, ids = [c.owner], st = step();
    function add(id) { if (id && id !== 'user' && id !== 'contract' && ids.indexOf(id) < 0) ids.push(id); }
    s.log.forEach(function (ev) { add(ev.from); add(ev.to); add(ev.bot); add(ev.operator); });
    if (s.log.length && st.source) { add(E.resolve(s, st.source)); add(E.resolve(s, st.target)); }
    return ids;
  }
  function layout() {
    var c = C(), ids = cast(), pos = {}, narrow = $('#stagewrap').clientWidth < 600, n = 0;
    var W = narrow ? 350 : 800, others = ids.length - 1, H = narrow ? 300 + Math.ceil(others / 2) * 150 : (others > 2 ? 470 : 300);
    var slots = narrow ? [[90, 372], [260, 372], [90, 522], [260, 522]] : [[110, 120], [690, 120], [110, 320], [690, 320]];
    ids.forEach(function (id) { var at = id === c.owner ? [W / 2, narrow ? 100 : 104] : slots[n++ % 4]; pos[id] = { x: at[0], y: at[1] }; });
    return { ids: ids, pos: pos, W: W, H: H, narrow: narrow };
  }
  function ends(id) { /* 线的两端：负责人的圆盘边缘 → 对方卡片边缘 */
    var o = L.pos[C().owner], p = L.pos[id], dx = p.x - o.x, dy = p.y - o.y, d = Math.hypot(dx, dy), ux = dx / d, uy = dy / d;
    var t = Math.min(84 / Math.abs(ux || 1e-6), 68 / Math.abs(uy || 1e-6)), r = L.narrow && uy > .5 ? 186 : 62;
    return { a: { x: o.x + ux * r, y: o.y + uy * r }, b: { x: p.x - ux * t, y: p.y - uy * t } };
  }
  function role(id) {
    var c = C(), h = c.steps.find(function (x) { return x.kind === 'hire'; });
    return id === c.owner ? '负责人 · ' + E.skillsOf(w, id) : id === w.state.hired ? '临时帮手' + (h ? ' · ' + h.envelope : '') : E.skillsOf(w, id);
  }
  function screen(id) {
    var s = w.state, f;
    if (s.working && s.working.operator === id) return '正在' + s.working.reaction;
    f = s.files.filter(function (x) { return x.owner === id; }).pop();
    return f ? f.name : id === C().owner ? C().desktop.title : '空闲';
  }

  /* ---------- 画 ---------- */
  function flying() { var p = E.plan(w); return p && p.flight ? w.state.messages[w.state.messages.length - 1] : null; }
  function devs(id) {
    var s = w.state, hot = ui.hot || {}, busy = s.working && s.working.operator === id, got = s.messages.filter(function (m) { return m.to === id && m.state === 'delivered'; }).length, fly = flying();
    var ping = (hot.type === 'delivered' && hot.to === id) || (fly && fly.from === id);
    return '<button class="dev' + (busy ? ' busy' : hot.type === 'file' && hot.operator === id ? ' new' : '') + '" data-a="pc" data-id="' + id + '" aria-label="' + esc(N(id)) + '的电脑">' + PC + '<span>' + esc(screen(id)) + '</span></button>' +
      '<button class="dev' + (ping ? ' ping' : '') + '" data-a="phone" data-id="' + id + '" aria-label="' + esc(N(id)) + '的手机">' + PH + '<span>手机</span><b>' + got + '</b></button>';
  }
  function drawCanvas() {
    var c = C(), fly = flying(), lines = '', html = '', before = L ? L.ids : [];
    L = layout();
    L.ids.forEach(function (id) {
      var P = L.pos[id], fresh = before.length && before.indexOf(id) < 0 ? ' in' : '';
      if (id === c.owner) { html += '<div class="nd hub" style="left:' + P.x + 'px;top:' + P.y + 'px"><div class="dial"></div><span class="ico l"></span><div class="nm"><b>' + esc(N(id)) + '</b><span class="m">' + esc(role(id)) + '</span></div><div class="devs">' + devs(id) + '</div></div>'; return; }
      var e = ends(id), on = fly && (fly.from === id || fly.to === id);
      lines += '<path class="' + (on ? 'lit' + (ui.held ? ' paused' : '') : '') + '" d="M' + e.a.x + ' ' + e.a.y + 'L' + e.b.x + ' ' + e.b.y + '"/>';
      html += '<div class="nd' + fresh + '" style="left:' + P.x + 'px;top:' + P.y + 'px"><div class="bot"><div class="top"><span class="ico s"></span><div><b>' + esc(N(id)) + '</b><span class="m">' + esc(role(id)) + '</span></div></div>' + devs(id) + '</div></div>';
    });
    $('#lines').innerHTML = lines; $('#nodes').innerHTML = html;
    var wrap = $('#stagewrap'), k = Math.min(1.15, wrap.clientWidth / L.W);
    wrap.style.height = L.H * k + 'px';
    $('#stage').style.transform = 'translate(' + (wrap.clientWidth - L.W * k) / 2 + 'px,0) scale(' + k + ')';
    drawChip();
  }
  function drawChip() {
    var fly = flying(), chip = $('#chip'), p = E.plan(w), c = C();
    var other = fly && (fly.from === c.owner ? fly.to : fly.from);
    if (!fly || !L || !L.pos[other]) { chip.hidden = true; return; }
    var e = ends(other), a = fly.from === c.owner ? e.a : e.b, b = fly.from === c.owner ? e.b : e.a, calm = still && still.matches, t = calm ? .5 : Math.min(1, ui.clock / p.delay);
    var text = calm ? N(fly.from) + ' → ' + N(fly.to) + '：' + fly.envelope : fly.envelope;
    if (chip.textContent !== text) chip.textContent = text;
    chip.style.left = a.x + (b.x - a.x) * t + 'px'; chip.style.top = a.y + (b.y - a.y) * t + 'px'; chip.hidden = false;
  }
  function bars(n) { var h = ''; for (var i = 0; i < Math.min(n, 12); i++) h += '<i style="height:' + (3 + (i * 7 % 3)) + 'px"></i>'; return '<div class="bars">' + h + '</div>'; }
  function drawHead() {
    var c = C(), s = w.state, st = step(), p = E.plan(w), total = c.steps.length - 1, you = st.kind === 'confirm' && p && p.user ? 1 : 0;
    $('#tabs').innerHTML = dsl.cases.map(function (x) { return '<button data-a="case" data-id="' + x.id + '" aria-pressed="' + (x.id === c.id) + '">' + esc(x.title) + '</button>'; }).join('');
    $('#head').innerHTML = '<div class="brand"><span class="ico"></span><div><div class="m">' + esc(c.tag) + ' · ' + esc(N(c.owner)) + '负责 · 本地模拟</div><h1>' + esc(c.title) + '</h1>' +
      '<div class="st"><span class="live' + (s.halt ? ' bad' : you ? ' wait' : '') + '">' + esc(s.halt ? '卡住了' : st.status) + '</span><span class="track">' + c.steps.slice(0, total).map(function (x, i) { return '<i class="' + (i < s.idx ? 'd' : i === s.idx ? 'n' : '') + '"></i>'; }).join('') + '</span></div></div></div>' +
      '<div class="stats"><div class="stat"><span class="m">步骤</span><b>' + Math.min(s.idx, total) + '/' + total + '</b>' + bars(s.idx) + '</div><div class="stat q"><span class="m">消息</span><b>' + s.messages.length + '</b>' + bars(s.messages.length) + '</div>' +
      '<div class="stat g"><span class="m">材料</span><b>' + s.files.length + '</b>' + bars(s.files.length) + '</div><div class="stat r"><span class="m">等你</span><b>' + you + '</b>' + bars(you) + '</div></div>';
    $('#lead').innerHTML = '<b>' + esc(st.kind === 'done' ? '办完了' : c.headline) + '</b><span>' + esc(st.summary) + '</span>';
  }
  function nextLabel() {
    var c = C(), s = w.state, st = step();
    if (s.halt) return '再试一次';
    if (st.kind === 'hire' && !s.cur.hired) return '请' + N(c.market[0]) + '帮忙';
    return st.action;
  }
  function drawDock() {
    var s = w.state, st = step(), p = E.plan(w), last = s.log[s.log.length - 1], acts = '', text;
    var moving = p && !p.user;
    if (s.halt) text = E.describe(w, s.halt);
    else if (st.kind === 'done') text = st.summary;
    else if (!last) text = N(C().owner) + '在办，暂时不用你出手。';
    else if (st.kind === 'confirm' && !moving) text = '轮到你了：点开' + N(C().owner) + '的电脑看「' + C().artifact + '」，没问题就确认。';
    else text = E.describe(w, last);
    if (st.kind === 'done') acts = '<button class="btn primary" data-a="reset">再来一遍</button>';
    else if (moving && ui.held) acts = '<button class="btn primary" data-a="resume">继续</button>';
    else if (ui.auto || moving) acts = '<button class="btn" data-a="hold">暂停</button>';
    else acts = (last ? '' : '<button class="btn primary" data-a="auto">看' + esc(N(C().owner)) + '怎么做</button>') +
      '<button class="btn' + (last ? ' primary' : '') + '" data-a="next">' + esc(nextLabel()) + '</button>' +
      (last ? '<button class="btn plain" data-a="auto">自动播放</button><button class="btn plain" data-a="reset">重来</button>' : '');
    $('#dock').innerHTML = '<p' + (s.halt ? ' class="bad"' : '') + '>' + esc(text) + '</p><div class="acts">' + acts + '</div>';
  }
  var TAG = { sent: ['发出', 'b'], delivered: ['送达', 'b'], working: ['处理', 'o'], sandbox: ['处理', 'o'], file: ['材料', 'g'], submitted: ['材料', 'g'], checked: ['校验', 'g'], hired: ['加入', ''], accepted: ['验收', 'g'] };
  function drawLog() {
    var s = w.state, rows = s.log.slice().reverse().map(function (ev) {
      var t = TAG[ev.type] || ['注意', 'r'], m = 12 + ev.seq;
      return '<div class="row"><span>09:' + ('0' + m % 60).slice(-2) + '</span><span class="tg">' + t[0] + '</span><i class="' + (ev.type === 'checked' && !ev.ok ? 'r' : t[1]) + '"></i><span>' + esc(E.describe(w, ev)) + '</span></div>';
    }).join('');
    $('#log').innerHTML = '<div class="hd"><span class="m">日志</span><span class="m">' + s.log.length + ' 条 · 时间为示意</span></div><div class="rows">' + (rows || '<div class="row"><span></span><span></span><i></i><span>还没有开始。</span></div>') + '</div>';
  }
  function drawSheet() {
    var el = $('#sheet'), pg = ui.sheet, s = w.state, c = C(), body = '';
    el.hidden = !pg; $('#scrim').hidden = !pg; if (!pg) return;
    var open = Array.prototype.map.call(el.querySelectorAll('details[open]'), function (d) { return d.dataset.id; });
    if (pg.t === 'phone') {
      var peers = [];
      s.messages.forEach(function (m) { var o = m.from === pg.id ? m.to : m.to === pg.id ? m.from : null; if (o && peers.indexOf(o) < 0) peers.push(o); });
      peers.forEach(function (o) {
        body += '<div class="who m">' + esc(N(o)) + '</div>';
        s.messages.forEach(function (m) {
          if (!((m.from === pg.id && m.to === o) || (m.from === o && m.to === pg.id))) return;
          body += '<div class="msg' + (m.from === pg.id ? ' me' : '') + (m.state === 'delivered' ? '' : ' way') + '">' + esc(m.text) + '</div>';
          if (m.state !== 'delivered') body += '<div class="m" style="align-self:' + (m.from === pg.id ? 'flex-end' : 'flex-start') + '">还在路上</div>';
        });
      });
      body = body || '<p class="m">还没有消息。</p>';
    } else {
      var busy = s.working && s.working.operator === pg.id, files = s.files.filter(function (f) { return f.owner === pg.id; });
      body += '<p>' + (busy ? '正在' + esc(s.working.reaction) + '，因为收到了「' + esc(s.working.input) + '」。' : '现在空闲。') + '</p>';
      if (pg.id === c.owner) files = [{ id: 'desk', name: c.desktop.title, body: c.desktop.body }].concat(files);
      files.forEach(function (f) {
        var vals = Object.keys(f.values || {}).map(function (k) { return '<tr><td>' + esc(k) + '</td><td>' + esc(E.show(f.values[k])) + '</td></tr>'; }).join('');
        body += '<details data-id="' + esc(f.id) + '"' + (open.indexOf(f.id) >= 0 || (f.kind === 'artifact' && step().kind === 'confirm') ? ' open' : '') + '><summary>' + esc(f.name) + '</summary><div><p>' + esc(f.body) + '</p>' + (vals ? '<table>' + vals + '</table>' : '') +
          (f.from ? '<p class="m">' + esc(f.kind === 'artifact' ? N(f.submitter) + '提交，已核对通过。' : '收到' + N(f.from) + '的「' + f.input + '」后产生。') + '</p>' : '') + '</div></details>';
      });
      if (!files.length) body += '<p class="m">还没有材料。</p>';
    }
    el.innerHTML = '<div class="sh-head"><span class="ico s"></span><h2>' + esc(N(pg.id)) + '的' + (pg.t === 'phone' ? '手机' : '电脑') + '</h2><button class="x" data-a="close" aria-label="关闭">×</button></div><div class="sh-body">' + body + '</div>';
  }
  function draw() { drawHead(); drawDock(); drawCanvas(); drawLog(); drawSheet(); }

  /* ---------- 推进 ---------- */
  function fired(ev) { if (!ev) return; ui.clock = 0; ui.hot = ev; save(); draw(); }
  function next() { fired(E.act(w, { bot: C().market[0] })); }
  var last = 0;
  function frame(ts) {
    var dt = Math.min(100, ts - last || 0), p = E.plan(w); last = ts;
    if (p && !p.user && !ui.held) { ui.clock += dt; if (ui.clock >= p.delay) fired(E.advance(w)); }
    else if (p && p.user && ui.auto) {
      if (w.state.halt) { ui.auto = false; draw(); }
      else { ui.clock += dt; if (ui.clock >= 1200) next(); }
    } else if (!p && ui.auto) { ui.auto = false; draw(); }
    drawChip();
    requestAnimationFrame(frame);
  }
  var A = {
    next: function () { ui.held = false; next(); },
    auto: function () { ui.auto = true; ui.held = false; draw(); },
    hold: function () { ui.auto = false; ui.held = true; draw(); },
    resume: function () { ui.held = false; draw(); },
    reset: function () { start(w.run.caseId); save(); draw(); },
    'case': function (d) { start(d.id); save(); draw(); },
    phone: function (d) { ui.sheet = { t: 'phone', id: d.id }; drawSheet(); },
    pc: function (d) { ui.sheet = { t: 'pc', id: d.id }; drawSheet(); },
    close: function () { ui.sheet = null; drawSheet(); }
  };
  document.addEventListener('click', function (e) { var el = e.target.closest('[data-a]'); if (el && A[el.dataset.a]) A[el.dataset.a](el.dataset); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ui.sheet) A.close(); });
  window.addEventListener('resize', drawCanvas);

  var saved = load(); start(saved ? saved.caseId : dsl.cases[0].id, saved && saved.events); draw();
  requestAnimationFrame(frame);
  window.__matter = { get w() { return w; }, ui: ui, E: E };
})();
