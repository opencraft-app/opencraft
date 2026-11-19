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
    w = E.makeWorld(dsl, E.emptyBook(), run, 'real'); ui.auto = false; ui.held = false; ui.clock = 0; ui.hot = null; ui.sheet = null; ui.key = '';
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify({ caseId: w.run.caseId, events: w.run.events })); } catch (e) { /* 没有存储也能用 */ } }
  function load() { try { var d = JSON.parse(localStorage.getItem(KEY)); if (d && dsl.cases.some(function (c) { return c.id === d.caseId; })) return d; } catch (e) { /* ignore */ } return null; }
  function C() { return E.caseOf(w); }
  function N(id) { return E.nameOf(w, id); }
  function step() { return C().steps[w.state.idx]; }

  /* ---------- 谁在场、站哪里 ---------- */
  function cast() {
    var c = C(), s = w.state, ids = [c.owner], st = step();
    function add(id) { if (id && id !== 'user' && id !== 'contract' && ids.indexOf(id) < 0) ids.push(id); }
    s.log.forEach(function (ev) { add(ev.from); add(ev.to); add(ev.bot); add(ev.operator); });
    if (s.log.length && st.source) { add(E.resolve(s, st.source)); add(E.resolve(s, st.target)); }
    return ids;
  }
  function partner() {
    var c = C(), s = w.state, i, st, o;
    for (i = s.idx; i >= 0; i--) { st = c.steps[i]; if (!st.source) continue; o = [E.resolve(s, st.source), E.resolve(s, st.target)].filter(function (x) { return x && x !== 'user' && x !== c.owner; })[0]; if (o) return o; }
    return null;
  }
  function layout() {
    var c = C(), ids = cast(), pos = {}, narrow = $('#canvas').clientWidth <= 760, slots = [[400, -130], [400, 150], [-400, 150], [-400, -130]], n = 0;
    if (narrow) { var p = partner(); ids = p ? [c.owner, p] : [c.owner]; }
    ids.forEach(function (id) {
      var at = id === c.owner ? (narrow ? [-56, 0] : [0, 0]) : narrow ? [66, 230] : slots[n++ % 4];
      pos[id] = { x: at[0], y: at[1], flip: id !== c.owner };
    });
    return { ids: ids, pos: pos };
  }
  function phoneAt(id) { var P = L.pos[id]; return { x: P.x + (P.flip ? -114 : 102), y: P.y }; }
  function role(id) {
    var c = C(), h = c.steps.find(function (x) { return x.kind === 'hire'; });
    return id === c.owner ? '负责人' : id === w.state.hired ? '临时帮手' + (h ? ' · ' + h.envelope : '') : E.skillsOf(w, id);
  }
  function screen(id) {
    var s = w.state, f;
    if (s.working && s.working.operator === id) return '正在' + s.working.reaction + '…';
    f = s.files.filter(function (x) { return x.owner === id; }).pop();
    return f ? f.name : id === C().owner ? C().desktop.title : '空闲';
  }

  /* ---------- 画 ---------- */
  function flying() { var p = E.plan(w); return p && p.flight ? w.state.messages[w.state.messages.length - 1] : null; }
  function drawCanvas() {
    var s = w.state, c = C(), fly = flying(), hot = ui.hot || {}, lines = '', html = '';
    L = layout();
    L.ids.forEach(function (id) {
      if (id === c.owner) return;
      var a = phoneAt(c.owner), b = phoneAt(id), on = fly && (fly.from === id || fly.to === id);
      lines += '<path class="' + (on ? 'lit' + (ui.held ? ' paused' : '') : '') + '" d="M' + a.x + ' ' + a.y + 'L' + b.x + ' ' + b.y + '"/>';
    });
    $('#lines').innerHTML = lines;
    L.ids.forEach(function (id) {
      var P = L.pos[id], busy = s.working && s.working.operator === id, got = s.messages.filter(function (m) { return m.to === id && m.state === 'delivered'; }).length;
      html += '<div class="bot' + (P.flip ? ' flip' : '') + '" style="left:' + P.x + 'px;top:' + P.y + 'px"><div class="name">' + esc(N(id)) + '<small>' + esc(role(id)) + '</small></div>' +
        '<button class="pc' + (busy ? ' busy' : '') + (hot.type === 'file' && hot.operator === id ? ' new' : '') + '" data-a="pc" data-id="' + id + '" aria-label="' + esc(N(id)) + '的电脑"><span>' + esc(screen(id)) + '</span></button>' +
        '<button class="ph' + (hot.type === 'delivered' && hot.to === id ? ' ping' : '') + '" data-a="phone" data-id="' + id + '" aria-label="' + esc(N(id)) + '的手机">' + (got || '') + '</button>' +
        '<div class="cap">电脑</div><div class="cap p">手机</div></div>';
    });
    $('#nodes').innerHTML = html;
    var key = L.ids.join() + $('#canvas').clientWidth;
    if (key !== ui.key) { ui.key = key; fit(true); }
    drawChip();
  }
  function drawChip() {
    var fly = flying(), chip = $('#chip'), p = E.plan(w);
    if (!fly || !L || !L.pos[fly.from] || !L.pos[fly.to]) { chip.hidden = true; return; }
    var a = phoneAt(fly.from), b = phoneAt(fly.to), calm = still && still.matches, t = calm ? .5 : Math.min(1, ui.clock / p.delay);
    var text = calm ? N(fly.from) + ' → ' + N(fly.to) + '：' + fly.envelope : fly.envelope;
    if (chip.textContent !== text) chip.textContent = text;
    chip.style.left = a.x + (b.x - a.x) * t + 'px'; chip.style.top = a.y + (b.y - a.y) * t + 'px'; chip.hidden = false;
  }
  function fit(glide) {
    var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    L.ids.forEach(function (id) { var P = L.pos[id]; x0 = Math.min(x0, P.x - (P.flip ? 140 : 86)); x1 = Math.max(x1, P.x + (P.flip ? 76 : 128)); y0 = Math.min(y0, P.y - 84); y1 = Math.max(y1, P.y + 80); });
    var top = $('#head').getBoundingClientRect().bottom + 12, bottom = $('#dock').getBoundingClientRect().top - 12, cw = $('#canvas').clientWidth;
    var k = Math.min(1.1, (cw - 32) / (x1 - x0), Math.max(120, bottom - top) / (y1 - y0));
    ui.view = { k: k, x: cw / 2 - k * (x0 + x1) / 2, y: (top + bottom) / 2 - k * (y0 + y1) / 2 };
    var el = $('#world'); el.classList.toggle('glide', !!glide && !(still && still.matches));
    el.style.transform = 'translate(' + ui.view.x + 'px,' + ui.view.y + 'px) scale(' + k + ')';
  }
  function drawHead() {
    var c = C(), st = step();
    $('#head').innerHTML = '<div class="tabs">' + dsl.cases.map(function (x) { return '<button data-a="case" data-id="' + x.id + '" aria-pressed="' + (x.id === c.id) + '">' + esc(x.title) + '</button>'; }).join('') + '</div>' +
      '<h1>' + esc(st.kind === 'done' ? '办完了' : c.headline) + '</h1><p>' + esc(st.status + '。' + st.summary) + '</p>';
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
  function drawSheet() {
    var el = $('#sheet'), pg = ui.sheet, s = w.state, c = C(), body = '';
    el.hidden = !pg; $('#scrim').hidden = !pg; if (!pg) return;
    var open = Array.prototype.map.call(el.querySelectorAll('details[open]'), function (d) { return d.dataset.id; });
    if (pg.t === 'phone') {
      var peers = [];
      s.messages.forEach(function (m) { var o = m.from === pg.id ? m.to : m.to === pg.id ? m.from : null; if (o && peers.indexOf(o) < 0) peers.push(o); });
      peers.forEach(function (o) {
        body += '<div class="who">' + esc(N(o)) + '</div>';
        s.messages.forEach(function (m) {
          if (!((m.from === pg.id && m.to === o) || (m.from === o && m.to === pg.id))) return;
          body += '<div class="msg' + (m.from === pg.id ? ' me' : '') + (m.state === 'delivered' ? '' : ' way') + '">' + esc(m.text) + '</div>';
          if (m.state !== 'delivered') body += '<div class="note" style="align-self:' + (m.from === pg.id ? 'flex-end' : 'flex-start') + '">还在路上</div>';
        });
      });
      body = body || '<p class="note">还没有消息。</p>';
    } else {
      var busy = s.working && s.working.operator === pg.id, files = s.files.filter(function (f) { return f.owner === pg.id; });
      body += '<p>' + (busy ? '正在' + esc(s.working.reaction) + '，因为收到了「' + esc(s.working.input) + '」。' : '现在空闲。') + '</p>';
      if (pg.id === c.owner) files = [{ id: 'desk', name: c.desktop.title, body: c.desktop.body }].concat(files);
      files.forEach(function (f) {
        var vals = Object.keys(f.values || {}).map(function (k) { return '<tr><td>' + esc(k) + '</td><td>' + esc(E.show(f.values[k])) + '</td></tr>'; }).join('');
        body += '<details data-id="' + esc(f.id) + '"' + (open.indexOf(f.id) >= 0 || (f.kind === 'artifact' && step().kind === 'confirm') ? ' open' : '') + '><summary>' + esc(f.name) + '</summary><div><p>' + esc(f.body) + '</p>' + (vals ? '<table>' + vals + '</table>' : '') +
          (f.from ? '<p class="note">' + esc(f.kind === 'artifact' ? N(f.submitter) + '提交，已核对通过。' : '收到' + N(f.from) + '的「' + f.input + '」后产生。') + '</p>' : '') + '</div></details>';
      });
      if (!files.length) body += '<p class="note">还没有材料。</p>';
    }
    el.innerHTML = '<div class="sh-head"><h2>' + esc(N(pg.id)) + '的' + (pg.t === 'phone' ? '手机' : '电脑') + '</h2><button class="x" data-a="close" aria-label="关闭">×</button></div><div class="sh-body">' + body + '</div>';
  }
  function draw() { drawHead(); drawDock(); drawCanvas(); drawSheet(); }

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
  window.addEventListener('resize', function () { ui.key = ''; drawCanvas(); });

  var saved = load(); start(saved ? saved.caseId : dsl.cases[0].id, saved && saved.events); draw();
  requestAnimationFrame(frame);
  window.__matter = { get w() { return w; }, ui: ui, E: E };
})();
