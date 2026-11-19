/* 事项画布界面：只读引擎状态并发起意图；所有变化都先成为事件。 */
(function () {
  'use strict';
  var E = window.MatterEngine, KEY = 'opencraft.matter-canvas.v1';
  var $ = function (s) { return document.querySelector(s); };
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)');
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  var I = {
    phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 17.5h2"/>',
    pc: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/>',
    mail: '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="m4.5 7.5 7.5 6 7.5-6"/>',
    chat: '<path d="M5 5.5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4.5 3.5v-3.500H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/>',
    play: '<path d="M8 5.5v13l10-6.5z" fill="currentColor"/>', pause: '<path d="M8 5.5v13M16 5.5v13"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>', back: '<path d="m14 6-6 6 6 6"/>', next: '<path d="m10 6 6 6-6 6"/>', down: '<path d="m7 10 5 5 5-5"/>',
    fit: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>', plus: '<path d="M12 6v12M6 12h12"/>', minus: '<path d="M6 12h12"/>',
    doc: '<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z"/><path d="M14 3.5v4h4M10 12h5M10 15.5h5"/>',
    layers: '<path d="m12 4 8 4.500-8 4.500-8-4.500z"/><path d="m4 13 8 4.500 8-4.500"/>'
  };
  function ic(n) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + I[n] + '</svg>'; }
  var STAT = '<span><svg viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx=".7"/><rect x="5" y="5.500" width="3" height="6.500" rx=".7"/><rect x="10" y="3" width="3" height="9" rx=".7"/><rect x="15" y="0" width="3" height="12" rx=".7"/></svg>' +
    '<svg viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M1.500 4.500a9.500 9.500 0 0 1 13 0M4 7.200a5.800 5.800 0 0 1 8 0"/><circle cx="8" cy="10" r="1" fill="currentColor" stroke="none"/></svg>' +
    '<svg viewBox="0 0 27 12" fill="none"><rect x=".5" y=".5" width="22" height="11" rx="3.200" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="17" height="8" rx="1.800" fill="currentColor"/><path d="M24.500 4v4" stroke="currentColor" stroke-width="1.500" stroke-linecap="round" opacity=".5"/></svg></span>';

  /* ---------- 存取 ---------- */
  var data, dsl, real, demo = null;
  var ui = { level: 'doing', sheet: [], paused: false, clock: 0, view: { x: 0, y: 0, k: 1 }, demoEnd: null, viewKey: '', fresh: {}, hot: null };
  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify({ dsl: data.dsl, book: data.book, runs: data.runs, active: real.run.id })); } catch (e) { /* 无存储时照常运行 */ } }
  function boot() {
    data = load();
    try { dsl = E.validate(data.dsl ? data.dsl : E.clone(window.MATTER_DSL)); } catch (e) { data.dsl = null; dsl = E.validate(E.clone(window.MATTER_DSL)); }
    data.dsl = data.dsl ? dsl : null;
    data.book = Object.assign(E.emptyBook(), data.book || {});
    data.runs = (data.runs || []).filter(function (r) { return dsl.cases.some(function (c) { return c.id === r.caseId; }); });
    if (!data.runs.length) data.runs.push(E.newRun(dsl, dsl.cases[0].id, 1));
    var run = data.runs.find(function (r) { return r.id === data.active; }) || data.runs[data.runs.length - 1];
    real = E.makeWorld(dsl, data.book, run, 'real'); demo = null; ui.demoEnd = null; ui.clock = 0; ui.viewKey = ''; ui.sheet = [];
  }
  function W() { return demo || real; }
  function C() { return E.caseOf(W()); }
  function N(id) { return E.nameOf(W(), id); }
  function locked() { return !!demo; }
  function narrow() { return $('#canvas').clientWidth <= 760; }

  /* ---------- 角色与布局 ---------- */
  function color(id) { var b = E.botOf(W(), id), t = b && W().dsl.teams.find(function (x) { return x.id === b.team; }); return t ? t.color : '#777'; }
  function face(id, cls) {
    var h = 0, i; for (i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 97;
    var mouth = ['M9 15.500q3 2.600 6 0', 'M9.500 15.500h5', 'M9 15q3 3.400 6 0'][h % 3];
    return '<span class="face v' + (h % 3) + ' ' + (cls || '') + '" style="--tc:' + color(id) + '"><svg viewBox="0 0 24 24" fill="none" stroke="#1d1a14" stroke-width="1.700" stroke-linecap="round"><circle cx="8.500" cy="10.500" r="1.300" fill="#1d1a14" stroke="none"/><circle cx="15.500" cy="10.500" r="1.300" fill="#1d1a14" stroke="none"/><path d="' + mouth + '"/></svg></span>';
  }
  function cast(w) {
    var c = E.caseOf(w), s = w.state, set = [c.owner];
    function add(id) { if (id && id !== 'user' && id !== 'contract' && set.indexOf(id) < 0) set.push(id); }
    s.log.forEach(function (ev) { add(ev.from); add(ev.to); add(ev.bot); add(ev.operator); });
    if (w.mode === 'demo' || s.log.length) { var st = c.steps[s.idx]; if (st && st.source) { add(E.resolve(s, st.source)); add(E.resolve(s, st.target)); } }
    return set;
  }
  function partner(w) { /* 眼下和负责人打交道的那一位 */
    var c = E.caseOf(w), s = w.state, i, st, o;
    for (i = s.idx; i >= 0; i--) { st = c.steps[i]; if (!st || !st.source) continue; o = [E.resolve(s, st.source), E.resolve(s, st.target)].filter(function (x) { return x && x !== 'user' && x !== c.owner; })[0]; if (o) return o; }
    return null;
  }
  function roleOf(w, id) {
    var c = E.caseOf(w), s = w.state;
    if (id === c.owner) return '这件事的负责人';
    if (id === s.hired) { var h = c.steps.find(function (x) { return x.kind === 'hire'; }); return (s.hiredVia === 'contacts' ? '受托 · ' : '临时工 · ') + (h ? h.envelope : ''); }
    if ((c.nodes || []).some(function (n) { return n.id === id && n.kind === 'reviewer'; })) return '独立复核';
    return E.skillsOf(w, id);
  }
  function dutiesOf(w, id) { var b = E.botOf(w, id); return b.duties && !(id in w.book.skills) ? b.duties : E.skillsOf(w, id).split(/[、，,]/).filter(Boolean).map(function (x) { return { name: x.trim(), text: '' }; }); }
  function layout(w) {
    var c = E.caseOf(w), s = w.state, pos = {}, list = [], ids = cast(w), nar = narrow(), pt = partner(w), extra = 0, mini = 0, matter;
    if (nar) {
      matter = { x: 0, y: -265 };
      ids.forEach(function (id) {
        if (id === c.owner) pos[id] = { x: -62, y: 0, stage: true };
        else if (id === pt || (!pt && id === ids[1])) pos[id] = { x: 70, y: 300, stage: true };
        else pos[id] = { x: -100 + 150 * (mini++ % 2), y: 520 + 70 * Math.floor((mini - 1) / 2) };
        list.push(id);
      });
    } else {
      matter = { x: -470, y: -40 };
      var slot = { peer: [440, -170], hired: [440, 200] }, ex = [[-20, 390], [-470, 330], [440, 560]];
      ids.forEach(function (id) {
        var p = id === c.owner ? [0, 0] : id === c.peer ? slot.peer : id === s.hired ? slot.hired : ex[extra++ % ex.length];
        pos[id] = { x: p[0], y: p[1], stage: true }; list.push(id);
      });
    }
    if (ui.level === 'contacts') {
      var rest = E.contactsOf(w, c.owner).filter(function (id) { return !pos[id]; });
      rest.forEach(function (id, i) { pos[id] = nar ? { x: -100 + 150 * (i % 2), y: 700 + 70 * Math.floor(i / 2) } : { x: -330 + 200 * i, y: -330 }; list.push(id); });
    }
    var teams = [];
    if (ui.level === 'all') {
      var centers = nar ? [[0, 900], [0, 1300], [0, 1700], [0, 2100], [0, 2500]] : [[-960, -440], [960, -440], [-960, 620], [960, 620], [0, 900]];
      w.dsl.teams.forEach(function (t, ti) {
        var ctr = centers[ti % centers.length], members = w.dsl.bots.filter(function (b) { return b.team === t.id && !pos[b.id]; });
        teams.push({ name: t.name, x: ctr[0], y: ctr[1] - 20 });
        members.forEach(function (b, i) { var col = nar ? 2 : 3; pos[b.id] = { x: ctr[0] + (i % col - (col - 1) / 2) * 172, y: ctr[1] + 40 + Math.floor(i / col) * 70 }; list.push(b.id); });
      });
    }
    list.forEach(function (id) { var P = pos[id]; if (P.stage && id !== c.owner && P.x > pos[c.owner].x) P.flip = true; });
    return { pos: pos, list: list, matter: matter, teams: teams, cast: ids, narrow: nar, alone: ids.length === 1 && ui.level === 'doing' };
  }
  function phoneAt(id) { var P = L.pos[id]; return P.stage ? { x: P.x + (P.flip ? -114 : 100), y: P.y + 34 } : { x: P.x, y: P.y }; }

  var L = null;
  function screenText(w, id) {
    var s = w.state, c = E.caseOf(w), cp = E.comp(w, id);
    if (!cp.work) return '已停工';
    if (s.working && s.working.operator === id) return '正在' + s.working.reaction + '…';
    var f = s.files.filter(function (x) { return x.owner === id; }).pop();
    return f ? f.name : id === c.owner ? c.desktop.title : '等待新材料';
  }
  function renderCanvas() {
    var w = W(), s = w.state, c = C(); L = layout(w);
    var p = E.plan(w), flying = p && p.flight ? s.messages[s.messages.length - 1] : null, st = c.steps[s.idx], hot = ui.hot || {};
    var html = '', paths = '';
    function seg(a, b, cls) { return '<path class="' + cls + '" d="M' + a.x + ' ' + a.y + 'L' + b.x + ' ' + b.y + '"/>'; }
    var own = L.pos[c.owner], m = L.matter;
    if (L.narrow) paths += '<path class="owns" d="M' + (m.x - 110) + ' ' + (m.y + 96) + 'C' + (m.x - 110) + ' ' + (m.y + 130) + ' ' + (own.x - 30) + ' ' + (own.y - 170) + ' ' + (own.x - 30) + ' ' + (own.y - 122) + '"/>';
    else paths += '<path class="owns" d="M' + (m.x + 165) + ' ' + (m.y + 30) + 'C' + (m.x + 250) + ' ' + (m.y + 30) + ' ' + (own.x - 190) + ' ' + (own.y - 92) + ' ' + (own.x - 86) + ' ' + (own.y - 92) + '"/>';
    L.list.forEach(function (a) { L.list.forEach(function (b) {
      if (a >= b) return; var A = L.pos[a], B = L.pos[b];
      var commission = s.hired && E.pairKey(a, b) === E.pairKey(c.owner, s.hired), kn = E.knows(w, a, b);
      if (!kn && !commission) return;
      if (ui.level !== 'all' && a !== c.owner && b !== c.owner) return;
      var pa = phoneAt(a), pb = phoneAt(b), lit = flying && E.pairKey(flying.from, flying.to) === E.pairKey(a, b);
      paths += seg(pa, pb, lit ? 'lit' + (ui.paused ? ' paused' : '') : kn ? 'contact' + (A.stage && B.stage ? '' : ' faint') : 'commission');
      if (!kn && A.stage && B.stage) html += '<div class="nd" style="left:' + (pa.x + (pb.x - pa.x) * .32) + 'px;top:' + (pa.y + (pb.y - pa.y) * .32) + 'px"><span class="tag"><b>临时委托</b></span></div>';
    }); });
    if (flying && L.pos[flying.from] && L.pos[flying.to]) {
      var F = phoneAt(flying.from), T = phoneAt(flying.to), ang = Math.atan2(T.y - F.y, T.x - F.x), d = 36;
      paths += '<path class="arrow" transform="translate(' + (T.x - d * Math.cos(ang)) + ' ' + (T.y - d * Math.sin(ang)) + ') rotate(' + ang * 180 / Math.PI + ')" d="M0 0-14-8v16z"/>';
    }
    $('#lines').innerHTML = paths;

    var art = s.files.some(function (f) { return f.kind === 'artifact'; });
    html += '<div class="nd" style="left:' + m.x + 'px;top:' + m.y + 'px"><div class="mcard"><div class="mtop">' + ic('chat') + '<span>' + esc(c.title) + (w.run.n > 1 ? ' · 第 ' + w.run.n + ' 轮' : '') + '</span>' + statusChip(w) + '</div>' +
      '<h1>' + esc(st.kind === 'done' ? st.summary.replace(/。$/, '') : c.headline) + '</h1><p>' + esc(st.kind === 'done' ? '已验收归档。' : st.summary) + '</p>' +
      '<button class="lnk" data-a="basis">' + (art ? '查看' + esc(c.artifact) : '查看经过') + ic('next') + '</button></div></div>';
    L.teams.forEach(function (t) { html += '<div class="nd" style="left:' + t.x + 'px;top:' + t.y + 'px"><span class="team">' + esc(t.name) + '</span></div>'; });
    L.list.forEach(function (id) {
      var P = L.pos[id], enter = ui.fresh[id] ? ' enter' : '';
      if (!P.stage) { html += '<div class="nd mini" style="left:' + P.x + 'px;top:' + P.y + 'px"><button class="tagc" data-a="bot" data-id="' + id + '">' + face(id, 'sm') + '<span><b>' + esc(N(id)) + '</b><small>' + esc(roleOf(w, id)) + '</small></span></button></div>'; return; }
      var busy = s.working && s.working.operator === id, cp = E.comp(w, id), got = hot.type === 'delivered' && hot.to === id, unread = s.messages.some(function (x) { return x.to === id && x.state === 'delivered' && x.step === s.idx; });
      html += '<div class="nd bot' + (id === c.owner ? ' owner' : '') + (P.flip ? ' flip' : '') + enter + '" style="left:' + P.x + 'px;top:' + P.y + 'px">' +
        '<button class="tagc" data-a="bot" data-id="' + id + '">' + face(id) + '<span><b>' + esc(N(id)) + '</b><small>' + esc(roleOf(w, id)) + '</small></span></button>' +
        '<button class="pc' + (busy ? ' busy' : '') + (cp.work ? '' : ' off') + (hot.type === 'file' && hot.operator === id ? ' fresh' : '') + '" data-a="pc" data-id="' + id + '" aria-label="' + esc(N(id)) + '的电脑"><span class="scr"><span class="glass"><em>' + esc(screenText(w, id)) + '</em></span></span><span class="base">电脑<i></i></span><span class="kbd"></span></button>' +
        '<button class="ph' + (got ? ' ping' : '') + '" data-a="phone" data-id="' + id + '" aria-label="' + esc(N(id)) + '的手机">' + ic('mail') + '手机' + (unread ? '<i class="dot"></i>' : '') + (got ? '<span class="pop">' + esc((s.messages.find(function (x) { return x.id === hot.delivery; }) || {}).envelope || '新消息') + '</span>' : '') + '</button>';
      if (id === c.owner && L.alone) dutiesOf(w, id).slice(0, 2).forEach(function (d, i) { html += '<div class="duty" style="left:' + (-164 + 160 * i) + 'px"><b>' + esc(d.name) + '</b><span>' + esc(d.text) + '</span></div>'; });
      html += '</div>';
    });
    $('#nodes').innerHTML = html; ui.fresh = {};
    var key = L.list.join(',') + ui.level + L.narrow + (L.narrow ? focusIds().join() + inMotion() : '');
    if (key !== ui.viewKey) { ui.viewKey = key; fit(true); }
    placeChip();
  }
  function placeChip() {
    var w = W(), s = w.state, p = E.plan(w), chip = $('#chip');
    if (!p || !p.flight || !L) { chip.hidden = true; return; }
    var m = s.messages[s.messages.length - 1];
    if (!L.pos[m.from] || !L.pos[m.to]) { chip.hidden = true; return; }
    var A = phoneAt(m.from), B = phoneAt(m.to), still = reduced && reduced.matches, t = still ? .5 : Math.min(1, ui.clock / p.delay);
    t = t < .5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    var label = ic('mail') + esc(m.envelope) + (still ? ' · ' + esc(N(m.from) + ' → ' + N(m.to)) + (ui.paused ? ' · 已暂停' : ' · 传递中') : '');
    if (chip.dataset.k !== label) { chip.innerHTML = label; chip.dataset.k = label; }
    chip.style.left = A.x + (B.x - A.x) * t + 'px'; chip.style.top = A.y + (B.y - A.y) * t - 22 + 'px'; chip.hidden = false;
  }
  function applyView(glide) {
    var el = $('#world'); el.classList.toggle('glide', !!glide && !(reduced && reduced.matches));
    el.style.transform = 'translate(' + ui.view.x + 'px,' + ui.view.y + 'px) scale(' + ui.view.k + ')';
  }
  function inMotion() { var p = E.plan(W()); return !!(p && !p.user) || !!(demo && !ui.demoEnd); }
  function focusIds() { var w = W(), c = E.caseOf(w), pt = partner(w), ids = [c.owner]; if (pt && L && L.pos[pt] && L.pos[pt].stage) ids.push(pt); return ids; }
  function freeRect() {
    var cw = $('#canvas').clientWidth, top = $('#top').getBoundingClientRect().bottom + 10, dock = $('#dock').getBoundingClientRect();
    return { x: 12, y: top, w: cw - 24 - (cw > 760 ? 50 : 0), h: Math.max(160, dock.top - top - 14) };
  }
  function fit(glide, all) {
    if (!L) return;
    var m = L.matter, x0 = m.x - 172, x1 = m.x + 172, y0 = m.y - 106, y1 = m.y + 110, ids = L.list;
    if (L.narrow && !all && ui.level === 'doing') { ids = focusIds(); if (ids.length > 1 && inMotion()) { x0 = 1e9; x1 = -1e9; y0 = 1e9; y1 = -1e9; } }
    ids.forEach(function (id) { var P = L.pos[id]; x0 = Math.min(x0, P.x - (P.stage ? (L.alone ? 172 : P.flip ? 146 : 92) : 78)); x1 = Math.max(x1, P.x + (P.stage ? (L.alone ? 154 : 132) : 90)); y0 = Math.min(y0, P.y - (P.stage ? 128 : 32)); y1 = Math.max(y1, P.y + (P.stage ? (L.alone ? 176 : 86) : 32)); });
    var r = freeRect(), k = Math.max(.16, Math.min(1.1, r.w / (x1 - x0), r.h / (y1 - y0)));
    ui.view = { k: k, x: r.x + r.w / 2 - k * (x0 + x1) / 2, y: r.y + r.h / 2 - k * (y0 + y1) / 2 };
    applyView(glide);
  }
  function zoomBy(f, cx, cy) {
    var v = ui.view, k = Math.max(.16, Math.min(2.2, v.k * f)); cx = cx == null ? $('#canvas').clientWidth / 2 : cx; cy = cy == null ? $('#canvas').clientHeight / 2 : cy;
    v.x = cx - (cx - v.x) * k / v.k; v.y = cy - (cy - v.y) * k / v.k; v.k = k; applyView(false);
  }

  /* ---------- 顶栏与操作栏 ---------- */
  function statusChip(w) {
    var s = w.state, st = E.caseOf(w).steps[s.idx], h = s.halt;
    if (h) return '<span class="chip warn">' + (h.type === 'checked' ? '返工' : h.type === 'blocked' ? '没发出去' : h.type === 'stalled' ? '停工中' : h.type === 'askhuman' ? '等你判断' : '返工') + '</span>';
    return '<span class="chip ' + (st.kind === 'done' ? 'ok' : st.kind === 'confirm' ? 'sig' : 'mute') + '">' + esc(st.status) + '</span>';
  }
  function renderTop() {
    $('#top').innerHTML = '<button class="pill" data-a="runs" aria-label="切换事项"><span>' + esc(E.caseOf(real).title) + (real.run.n > 1 ? ' · 第 ' + real.run.n + ' 轮' : '') + '</span>' + ic('down') + '</button>' +
      '<span class="sim">本地模拟</span><button class="pill" data-a="more">' + ic('layers') + '<span>多看一层</span></button>';
    $('#zoom').innerHTML = '<button class="z" data-a="zin" aria-label="放大">' + ic('plus') + '</button><button class="z" data-a="zout" aria-label="缩小">' + ic('minus') + '</button><button data-a="fit" aria-label="回到全览">' + ic('fit') + '</button>';
  }
  function needYou(w) {
    var s = w.state, c = E.caseOf(w), st = c.steps[s.idx], own = N(c.owner);
    if (st.kind === 'done') return s.hired && !E.knows(w, c.owner, s.hired) ? '觉得' + N(s.hired) + '好用，可以留下，下次直接找。' : '办完了，不用再管。';
    if (st.kind === 'confirm') return '轮到你了：看一眼「' + c.artifact + '」，没问题就确认。';
    if (st.kind === 'hire' && !s.cur.hired) return '帮' + own + '挑一位帮手。';
    if (!s.log.length) return own + '在办，暂时不用你出手。';
    return '现在' + st.status + '。' + own + '在办，暂时不用你出手。';
  }
  function renderDock() {
    var w = W(), s = w.state, c = C(), st = c.steps[s.idx], p = E.plan(w), h = s.halt, own = N(c.owner), acts = '', halt = '', label = '', text;
    var started = real.state.log.length > 0, last = s.log[s.log.length - 1], total = c.steps.length - 1;
    var moving = p && !p.user;
    text = moving || (demo && last && !ui.demoEnd) ? E.describe(w, last) : needYou(w);
    if (p && p.flight && ui.paused) text += '（已暂停，消息停在半路）';
    if (demo) label = ui.demoEnd === 'done' ? '演示结束 · 刚才是模拟验收，没动你的进度' : '正在演示 <b>' + Math.min(s.idx + 1, total) + ' / ' + total + '</b>';
    if (h) {
      var fix = '';
      if (h.type === 'blocked' && h.reason === 'grant') fix = '<button class="btn" data-a="thread" data-id="' + h.from + '" data-b="' + h.to + '">打开' + esc(N(h.from)) + '的手机</button>';
      else if (h.type === 'blocked') fix = '<button class="btn" data-a="pc" data-id="' + h.from + '">打开' + esc(N(h.from)) + '的电脑</button>';
      else if (h.type === 'stalled') fix = '<button class="btn" data-a="pc" data-id="' + h.operator + '">打开' + esc(N(h.operator)) + '的电脑</button>';
      else if (h.type === 'checked') fix = '<button class="btn" data-a="scene">去现场看沙盒和栅栏</button>';
      else if (h.type === 'held') fix = '<button class="btn" data-a="act" data-o="revise">让' + esc(N(s.hired)) + '补上再交</button><button class="btn" data-a="pc" data-id="' + h.by + '">改' + esc(N(h.by)) + '的叮嘱</button>';
      else if (h.type === 'askhuman') fix = '<blockquote>' + esc(st.message) + '</blockquote><button class="btn primary" data-a="act" data-o="approve">符合，放行</button><button class="btn" data-a="act" data-o="reject">不符合，退回</button>';
      halt = '<div class="halt"><span>' + esc(E.describe(w, h)) + '</span>' + (demo ? '<span>演示停在这里。</span>' : '<div class="row">' + fix + '</div>') + '</div>';
      text = '卡住了，需要你处理。';
    }
    if (demo) {
      acts = ui.demoEnd || h ? '<button class="btn" data-a="demo">再看一遍</button><button class="btn primary" data-a="demo-exit">回到我的进度</button>'
        : '<button class="btn" data-a="pause">' + ic(ui.paused ? 'play' : 'pause') + (ui.paused ? '继续' : '暂停') + '</button><button class="btn" data-a="demo-exit">退出</button>';
    } else if (st.kind === 'done') {
      if (s.hired && !E.knows(w, c.owner, s.hired)) acts = '<input class="inp" id="keepnote" aria-label="备注" value="' + esc('擅长' + E.skillsOf(w, s.hired).split(/[和与、，]/)[0]) + '"><button class="btn primary" data-a="keep">留下' + esc(N(s.hired)) + '</button>';
      acts += '<button class="btn" data-a="newrun" data-id="' + c.id + '">另开一轮</button>';
    } else if (moving) {
      acts = '<button class="btn" data-a="pause">' + ic(ui.paused ? 'play' : 'pause') + (ui.paused ? '继续' : '暂停') + '</button>';
    } else if (p) {
      if (st.kind === 'hire' && !s.cur.hired) acts = '<button class="btn primary" data-a="hire-open">' + esc(st.action) + '</button>';
      else if (st.kind === 'confirm' && !h) acts = '<button class="btn" data-a="file" data-id="artifact">' + ic('doc') + '打开' + esc(c.artifact) + '</button><button class="btn primary" data-a="act">' + esc(st.action) + '</button>';
      else if (!started && !h) acts = '<button class="btn quiet" data-a="act">我自己来</button><button class="btn primary" data-a="demo">' + ic('play') + '看' + esc(own) + '怎么做</button>';
      else if (!(h && h.type === 'askhuman')) acts = '<button class="btn primary" data-a="act">' + esc(h ? '再试一次' : st.action) + '</button>';
    }
    var dock = $('#dock'); dock.className = demo ? 'demo' : '';
    dock.innerHTML = halt + '<div class="dmain"><div class="dtext">' + (label ? '<small>' + label + '</small>' : '') + '<span>' + esc(text) + '</span></div><div class="dacts">' + acts + '</div></div>';
  }

  /* ---------- 抽屉 ---------- */
  function open(page) { ui.sheet.push(page); renderSheet(true); }
  function closeSheet() { ui.sheet = []; renderSheet(true); }
  function head(title) { return '<div class="sh-head">' + (ui.sheet.length > 1 ? '<button class="ib" data-a="back" aria-label="返回">' + ic('back') + '</button>' : '') + '<h2>' + title + '</h2><button class="ib" data-a="close" aria-label="关闭">' + ic('close') + '</button></div>'; }
  function dis() { return locked() ? ' disabled' : ''; }
  function lockNote() { return locked() ? '<p class="hint">演示中只能看，不能改设置。退出演示后可以调整。</p>' : ''; }

  function between(s, a, b) { return s.messages.filter(function (m) { return (m.from === a && m.to === b) || (m.from === b && m.to === a); }); }
  function phoneFrame(inner) { return '<div class="iphone"><button class="xclose" data-a="close" aria-label="放下手机">' + ic('close') + '</button><div class="ios"><div class="island"></div><div class="stat"><span>9:41</span>' + STAT + '</div>' + inner + '<div class="home"></div></div></div>'; }
  function pagePhone(pg) {
    var w = W(), s = w.state, c = C(), id = pg.id, o = pg.thread;
    if (o) {
      var msgs = between(s, id, o), body = '', kn = o !== 'user' && E.knows(w, id, o), com = s.hired && o !== 'user' && E.pairKey(id, o) === E.pairKey(c.owner, s.hired);
      s.log.forEach(function (ev) {
        if (ev.type === 'blocked' && ev.from === id && ev.to === o) {
          body += '<div class="msg me fail">' + esc(c.steps[ev.step].message) + '</div><div class="mmeta me bad">未发送 · ' + (ev.reason === 'grant' ? '没有发送许可' : ev.reason === 'device' ? '电脑关了对外发消息' : '没有联系方式') + '</div>';
        }
        if (ev.type !== 'sent') return;
        var m = msgs.find(function (x) { return x.id === ev.delivery; }); if (!m) return;
        var f = s.files.find(function (x) { return x.step === m.step && x.kind !== 'submission'; }), st = c.steps[m.step], me = m.from === id;
        body += '<div class="msg' + (me ? ' me' : '') + '">' + esc(m.text) + '</div><div class="mmeta' + (me ? ' me' : '') + '"><span>' + (m.state === 'delivered' ? '已送达' : '发送中…') + '</span>' +
          (me && id !== 'user' && !locked() ? '<button data-a="redeliver" data-id="' + esc(m.id) + '">重新投递</button>' : '') + '</div>';
        if (m.state === 'delivered') body += '<div class="sys">' + esc(N(E.resolve(s, st.desktop.operator))) + '的电脑随后' + esc(st.reaction) + (f ? '，产出 <button class="lnk" data-a="file" data-id="' + esc(f.id) + '">' + esc(f.name) + '</button>' : '（还没做完）') + '</div>';
      });
      var bar = o === 'user' ? '' : kn ? '<label class="ibar sw"><span>允许发消息给' + esc(N(o)) + '</span><input type="checkbox" id="g-' + id + '-' + o + '" data-c="grant" data-id="' + id + '" data-b="' + o + '"' + (E.granted(w, id, o) ? ' checked' : '') + dis() + '></label>'
        : '<div class="ibar sw"><span>' + (com ? '本次委托：只用来交办和回传结果' : '没有对方的联系方式') + '</span></div>';
      return phoneFrame('<div class="inav"><button class="bk" data-a="back" aria-label="返回通讯录">' + ic('back') + '</button><div class="ttl">' + (o === 'user' ? '' : face(o, 'sm')) + '<b>' + esc(N(o)) + '</b>' +
        (kn ? '<input class="inote" id="n-' + id + '-' + o + '" data-c="note" data-id="' + id + '" data-b="' + o + '" placeholder="添加备注" aria-label="备注" value="' + esc(w.book.notes[id + '>' + o] || '') + '"' + dis() + '>' : '') + '</div><span class="sp"></span></div>' +
        '<div class="iscroll"><div class="msgs"><div class="sys">' + esc(c.title) + '</div>' + (body || '<div class="sys">这件事里，两人还没有发过消息。</div>') + '</div></div>' + bar);
    }
    var list = E.contactsOf(w, id), pt = s.hired && (id === c.owner ? s.hired : id === s.hired ? c.owner : null), rows = '';
    if (pt && list.indexOf(pt) < 0) list.unshift(pt);
    if (id === c.owner && s.messages.some(function (m) { return m.from === 'user'; })) list.unshift('user');
    list.sort(function (a, b) { return between(s, id, b).length - between(s, id, a).length; });
    list.forEach(function (x) {
      var n = between(s, id, x), lastM = n[n.length - 1], kn = x !== 'user' && E.knows(w, id, x), note = w.book.notes[id + '>' + x];
      rows += '<button class="irow" data-a="thread" data-id="' + id + '" data-b="' + x + '">' + (x === 'user' ? '<span class="face sm" style="--tc:#8a8a8e"></span>' : face(x, 'sm')) + '<span class="t"><b>' + esc(N(x)) + '</b><span>' + esc(lastM ? lastM.text : note ? '备注：' + note : x === 'user' ? '这件事的主人' : E.skillsOf(w, x)) + '</span></span>' +
        '<span class="r' + (x !== 'user' && kn && !E.granted(w, id, x) ? ' no' : '') + '">' + (x === 'user' ? '' : !kn ? '本次委托' : E.granted(w, id, x) ? '可发消息' : '未获准') + ic('next') + '</span></button>';
    });
    return phoneFrame('<div class="inav"></div><div class="big">通讯录</div><div class="bigsub">' + esc(N(id)) + '的手机' + (locked() ? ' · 演示中只能看' : '') + '</div><div class="iscroll"><div class="igroup">' + (rows || '<div class="irow"><span class="t"><span>通讯录还是空的</span></span></div>') + '</div><div class="ilabel">有联系方式不等于能发消息。点开一位，可以翻往来、写备注、决定是否允许发给对方。</div></div>');
  }
  function pagePc(pg) {
    var w = W(), s = w.state, c = C(), id = pg.id, cp = E.comp(w, id), busy = s.working && s.working.operator === id;
    var files = s.files.filter(function (f) { return f.owner === id; }), elsewhere = 0, icons = '';
    data.runs.forEach(function (r) { if (r.id !== w.run.id) elsewhere += E.reduce(null, r.events).files.filter(function (f) { return f.owner === id; }).length; });
    if (id === c.owner) icons += '<button class="icon" data-a="file" data-id="desk">' + ic('doc') + esc(c.desktop.title) + '<small>任务单</small></button>';
    files.forEach(function (f) { icons += '<button class="icon" data-a="file" data-id="' + esc(f.id) + '">' + ic('doc') + esc(f.name) + (f.version ? '<small>' + esc(f.version) + '</small>' : '') + '</button>'; });
    return head(esc(N(id)) + '的电脑') + '<div class="sh-body">' + lockNote() + '<div class="win"><div class="term">' + (busy ? '<b>&gt; 正在' + esc(s.working.reaction) + '</b><br>因为收到「' + esc(s.working.input) + '」' : cp.work ? '&gt; 空闲。收到消息后会在这里开工。' : '<b>&gt; 已停工</b><br>「处理文件」关着，收到消息也不会动。') + '</div>' +
      '<div class="icons">' + (icons || '<span class="hint" style="padding:8px">桌面上还没有材料。</span>') + '</div></div>' +
      (elsewhere && !demo ? '<p class="hint">另有 ' + elsewhere + ' 份材料留在别的事项里，切换事项可以看到。</p>' : '') +
      '<h3>能做的事</h3><div class="card">' + [['work', '处理文件'], ['send', '对外发消息'], ['hire', '找帮手']].map(function (k) {
        return '<label class="sw"><span>' + k[1] + '</span><input type="checkbox" id="c-' + id + '-' + k[0] + '" data-c="comp" data-id="' + id + '" data-b="' + k[0] + '"' + (cp[k[0]] ? ' checked' : '') + dis() + '></label>'; }).join('') + '</div>' +
      '<h3>交付前的叮嘱</h3><textarea class="inp sticky" rows="2" id="rv-' + id + '" data-c="review" data-id="' + id + '" placeholder="例如：必须包含：签字"' + dis() + '>' + esc(cp.review) + '</textarea>' +
      '<p class="hint">写成「必须包含：某个词」会在交付时自动检查，缺了就拦下。其他的话，交付时原样拿给你判断。</p></div>';
  }
  function pageBot(pg) {
    var w = W(), id = pg.id, b = E.botOf(w, id), team = w.dsl.teams.find(function (t) { return t.id === b.team; });
    return head('') + '<div class="sh-body"><div class="who">' + face(id, 'lg') + '<div><b>' + esc(b.name) + '</b><div class="hint">' + esc(team ? team.name : '') + ' · ' + esc(roleOf(w, id)) + '</div></div></div>' +
      '<div class="two"><button class="devbtn" data-a="phone" data-id="' + id + '">' + ic('phone') + '手机</button><button class="devbtn" data-a="pc" data-id="' + id + '">' + ic('pc') + '电脑</button></div>' +
      '<h3>能做的事</h3><div class="two">' + dutiesOf(w, id).map(function (d) { return '<div class="dutyc"><b>' + esc(d.name) + '</b><span>' + esc(d.text) + '</span></div>'; }).join('') + '</div>' +
      '<h3>一句话备注</h3>' + lockNote() + '<input class="inp" id="sk-' + id + '" data-c="skills" data-id="' + id + '" aria-label="职责备注" value="' + esc(E.skillsOf(w, id)) + '"' + dis() + '>' +
      '<p class="hint">同一个 Bot 可以有几种职责，用顿号隔开。换一件事，联系人和习惯都还在。</p></div>';
  }
  function findFile(id) {
    var s = W().state, c = C();
    if (id === 'artifact') return s.files.find(function (f) { return f.kind === 'artifact'; });
    if (id === 'desk') return { id: 'desk', name: c.desktop.title, body: c.desktop.body, owner: c.owner, kind: 'desk' };
    return s.files.find(function (f) { return f.id === id; });
  }
  function valuesTable(f) {
    var keys = Object.keys(f.values || {}); if (!keys.length) return '';
    return '<table><tr><th>核对项</th><th>实际核对值</th>' + (f.expected ? '<th>要求</th>' : '') + '</tr>' + keys.map(function (k) {
      return '<tr><td>' + esc(k) + '</td><td>' + esc(E.show(f.values[k])) + '</td>' + (f.expected ? '<td>' + esc(k in f.expected ? E.show(f.expected[k]) : '—') + '</td>' : '') + '</tr>'; }).join('') + '</table>';
  }
  function pageFile(pg) {
    var w = W(), s = w.state, c = C(), f = findFile(pg.id);
    if (!f) return head('材料') + '<div class="sh-body"><p class="hint">这份材料还没产生。</p></div>';
    var st = f.step != null ? c.steps[f.step] : null, src = '', sub;
    if (f.kind === 'artifact') {
      sub = s.files.find(function (x) { return x.kind === 'submission' && x.version === f.version; });
      var base = s.files.filter(function (x) { return x.owner === f.owner && x.kind === 'receipt' && x.step < f.step; }).pop();
      src = '<dl class="kv"><dt>谁提交</dt><dd>' + esc(N(f.submitter)) + '（受' + esc(N(c.owner)) + '委托）</dd><dt>核的是哪一版</dt><dd><span class="chip mute">' + esc(f.version) + '</span> ' +
        (sub ? '与<button class="lnk" data-a="file" data-id="' + esc(sub.id) + '">' + esc(N(sub.owner)) + '的提交件</button>是同一版' : '') + '</dd>' +
        (base ? '<dt>核对对象</dt><dd><button class="lnk" data-a="file" data-id="' + esc(base.id) + '">' + esc(base.name) + '</button></dd>' : '') +
        '<dt>怎么来的</dt><dd>' + esc(N(f.from)) + ' → ' + esc(N(f.owner)) + '的消息「' + esc(f.input) + '」</dd><dt>校验</dt><dd><span class="chip ok">栅栏通过</span> 本地模拟执行</dd></dl>';
    } else if (f.kind === 'submission') {
      src = '<dl class="kv"><dt>谁提交</dt><dd>' + esc(N(f.owner)) + '</dd><dt>版本</dt><dd><span class="chip mute">' + esc(f.version) + '</span></dd><dt>依据</dt><dd>沙盒输出（本地模拟），已过栅栏</dd></dl>';
    } else if (f.kind === 'receipt') {
      src = '<dl class="kv"><dt>怎么来的</dt><dd>' + esc(N(f.from)) + '发来「' + esc(f.input) + '」后，' + esc(N(f.owner)) + '的电脑' + esc(st ? st.reaction : '') + '</dd></dl>';
    } else src = '<p class="hint">' + esc(N(f.owner)) + '手头的任务单，这件事从这里开始。</p>';
    var canConfirm = !demo && f.kind === 'artifact' && c.steps[s.idx].kind === 'confirm' && !s.halt && !s.cur.accepted;
    return head(esc(N(f.owner)) + '的电脑') + '<div class="sh-body"><div class="paper"><h4>' + esc(f.name) + '</h4><p>' + esc(f.body) + '</p>' + valuesTable(f) + '</div><h3>来源</h3>' + src +
      (f.kind === 'artifact' && s.accepted ? '<p><span class="chip ' + (s.accepted.by === 'demo' ? 'sig' : 'ok') + '">' + (s.accepted.by === 'demo' ? '模拟验收' : '你已验收') + '</span></p>' : '') +
      (canConfirm ? '<button class="btn primary wide" data-a="act" data-close="1">' + esc(c.steps[s.idx].action) + '</button>' : '') + '</div>';
  }
  function pageHire() {
    var w = W(), c = C(), st = c.steps[w.state.idx], groups = { contacts: [], market: [], other: [] }, names = { contacts: '通讯录里的熟人', market: '临时工市场 · 适合这件事', other: '市场上的其他人' }, h = '';
    E.candidates(w).forEach(function (k) { groups[k.via].push(k); });
    ['contacts', 'market', 'other'].forEach(function (g) {
      if (!groups[g].length) return; h += '<h3>' + names[g] + '</h3>';
      groups[g].forEach(function (k) {
        h += '<div class="card"><div class="top">' + face(k.id) + '<div><b>' + esc(N(k.id)) + '</b><br><small>' + esc(E.skillsOf(w, k.id)) + '</small></div><button class="btn ' + (g === 'other' ? '' : 'primary') + '" data-a="hire" data-id="' + k.id + '">' + (g === 'contacts' ? '直接邀请' : '请来帮忙') + '</button></div>' +
          (k.note ? '<div><span class="chip ok">备注</span> ' + esc(k.note) + '</div>' : '') + '</div>';
      });
    });
    return head('给' + esc(N(c.owner)) + '找帮手') + '<div class="sh-body"><p>要交办的事：' + esc(st.message) + '</p><p class="hint">请来只建立这一次的委托，够交办和回传结果。想长期联系，办完再点「留下」。</p>' + h + '</div>';
  }
  function pageLog() {
    var w = W();
    return head('经过') + '<div class="sh-body"><p class="hint">每一行是一次实际发生的事。手机往来、电脑材料和进度都从这里来。</p><div class="log">' + (w.state.log.map(function (ev) { return '<div><i>' + ev.seq + '</i><span>' + esc(E.describe(w, ev)) + '</span></div>'; }).join('') || '<p class="hint">还没有开始。</p>') + '</div></div>';
  }
  function pageMore() {
    var lv = [['doing', '在办的人'], ['contacts', '联系人'], ['all', '全部 ' + dsl.bots.length]];
    return head('多看一层') + '<div class="sh-body"><h3>画布上看谁</h3><div class="seg" role="group">' + lv.map(function (l) { return '<button data-a="level" data-id="' + l[0] + '" aria-pressed="' + (ui.level === l[0]) + '">' + l[1] + '</button>'; }).join('') + '</div>' +
      '<h3>这件事</h3><button class="filebtn" data-a="log">' + ic('chat') + '<div><b>经过</b><small>谁告诉谁什么，对方接着干了什么</small></div></button>' +
      '<button class="filebtn" data-a="scene">' + ic('layers') + '<div><b>现场</b><small>沙盒输出、栅栏规则、文件和场景数据</small></div></button>' +
      (demo ? '' : '<button class="filebtn" data-a="demo">' + ic('play') + '<div><b>看演示</b><small>从头演一遍，不动你的进度</small></div></button>') + '</div>';
  }
  function pageRuns() {
    var h = '<h3>已有的事项</h3>';
    data.runs.forEach(function (r) {
      var c = dsl.cases.find(function (x) { return x.id === r.caseId; }), s = E.reduce(c, r.events), st = c.steps[s.idx];
      h += '<button class="filebtn" data-a="switch" data-id="' + r.id + '"><div><b>' + esc(c.title) + ' · 第 ' + r.n + ' 轮</b><small>' + esc(st.status) + ' · ' + s.messages.length + ' 条消息 · ' + s.files.length + ' 份材料</small></div>' + (r.id === real.run.id ? '<span class="chip">当前</span>' : '') + '</button>';
    });
    h += '<h3>新开一轮</h3>' + dsl.cases.map(function (c) { return '<button class="filebtn" data-a="newrun" data-id="' + c.id + '">' + face(c.owner, 'sm') + '<div><b>' + esc(c.title) + '</b><small>' + esc(c.headline) + ' · ' + esc(N(c.owner)) + '负责</small></div></button>'; }).join('');
    return head('事项') + '<div class="sh-body">' + h + '<p class="hint">联系人备注、发送许可和电脑习惯跟着 Bot 走；消息、材料和验收留在各自事项里。</p></div>';
  }
  function pageScene() {
    var w = W(), s = w.state, c = C(), cur = s.cur, gate = E.nodeOf(c, 'gate'), sb = E.nodeOf(c, 'sandbox'), h = s.halt;
    var art = s.files.some(function (f) { return f.kind === 'artifact'; });
    var st = [cur.sent, cur.sent, cur.delivered, cur.working, s.lastCheck && s.lastCheck.ok, art, s.accepted];
    var pipe = E.PIPELINE.map(function (n, i) { var bad = (i === 0 && h && h.type === 'blocked') || (i === 3 && h && h.type === 'stalled') || (i === 4 && h && (h.type === 'checked' || h.type === 'held' || h.type === 'rejected')); return '<span class="chip ' + (bad ? 'warn' : st[i] ? 'ok' : 'mute') + '">' + (i + 1) + ' ' + n + '</span>'; }).join('');
    function fields(obj, kind) { return Object.keys(obj || {}).map(function (k) { return '<label class="sw"><span>' + esc(k) + '</span><input class="inp mono" style="width:120px" id="' + kind + '-' + esc(k) + '" data-c="' + kind + '" data-id="' + esc(k) + '" value="' + esc(JSON.stringify(obj[k])) + '"></label>'; }).join(''); }
    var body = '<p><span class="chip sig">本地模拟</span> 这一版没有连真实的沙盒和 Bot，下面的输出来自场景数据。改这里的值，演示和实际办理都会跟着变。</p><h3>这一步走到哪</h3><div class="pipe">' + pipe + '</div>';
    if (sb) body += '<h3>沙盒输出（通用工作，E2B 的位置）</h3><p class="hint">' + esc(sb.text) + '</p><div class="card">' + fields(sb.fixture, 'fx') + '</div>';
    if (gate) body += '<h3>栅栏要求（确定性规则）</h3><p class="hint">' + esc(gate.text) + '</p><div class="card">' + fields(gate.equals, 'gate') + '</div><pre>' + esc(E.gateSource(gate)) + '</pre>';
    if (s.lastCheck) body += '<h3>最近一次校验</h3><table><tr><th>核对项</th><th>要求</th><th>实际</th></tr>' + Object.keys(s.lastCheck.expected).map(function (k) { var bad = s.lastCheck.diffs.some(function (d) { return d.key === k; }); return '<tr><td>' + esc(k) + '</td><td>' + esc(E.show(s.lastCheck.expected[k])) + '</td><td class="' + (bad ? 'bad' : '') + '">' + esc(k in s.lastCheck.actual ? E.show(s.lastCheck.actual[k]) : '（缺失）') + (bad ? ' ✕' : ' ✓') + '</td></tr>'; }).join('') + '</table>';
    body += '<details><summary>VFS（' + Object.keys(s.vfs).length + ' 个文件）</summary><pre>' + esc(Object.keys(s.vfs).map(function (k) { return k + '\n  ' + (typeof s.vfs[k] === 'string' ? s.vfs[k] : JSON.stringify(s.vfs[k])); }).join('\n') || '空') + '</pre></details>' +
      '<details><summary>事件流（' + w.run.events.length + '）</summary><pre>' + esc(w.run.events.map(function (e) { return JSON.stringify(e); }).join('\n') || '空') + '</pre></details>' +
      '<details' + (ui.dslOpen ? ' open' : '') + '><summary>场景 DSL</summary><p class="hint">Bot、联系方式、发送许可、消息、接收后的动作、产物和检查条件都在这一份数据里。改完点应用。</p>' +
      '<textarea class="inp mono" id="dsltext" rows="14" spellcheck="false">' + esc(JSON.stringify(dsl, null, 1)) + '</textarea><div class="row"><button class="btn primary" data-a="dsl-apply">应用</button><button class="btn" data-a="dsl-reset">恢复默认场景</button><button class="btn" data-a="reset-all">清空全部进度和设置</button></div></details>';
    return head('现场') + '<div class="sh-body">' + body + '</div>';
  }
  var PAGES = { phone: pagePhone, pc: pagePc, bot: pageBot, file: pageFile, hire: pageHire, log: pageLog, more: pageMore, runs: pageRuns, scene: pageScene };
  function renderSheet(force) {
    var el = $('#sheet'), pg = ui.sheet[ui.sheet.length - 1], act = document.activeElement;
    if (!force && act && el.contains(act) && /INPUT|TEXTAREA/.test(act.tagName) && act.type !== 'checkbox') { ui.sheetDirty = true; return; }
    ui.sheetDirty = false; el.hidden = !pg; $('#scrim').hidden = !pg; if (!pg) return;
    var sc = el.querySelector('.sh-body, .iscroll'), top = !force && sc ? sc.scrollTop : null;
    el.className = pg.t === 'phone' ? 'device' : '';
    el.innerHTML = PAGES[pg.t](pg);
    sc = el.querySelector('.sh-body, .iscroll'); if (sc) sc.scrollTop = top == null ? (pg.t === 'phone' && pg.thread ? 1e6 : 0) : top;
  }
  function render() { renderTop(); renderDock(); renderCanvas(); renderSheet(false); }
  var toastT;
  function toast(t) { var el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { el.hidden = true; }, 3200); }

  /* ---------- 推进 ---------- */
  function markFresh(w) { cast(w).forEach(function (id) { if (L && (!L.pos[id] || !L.pos[id].stage)) ui.fresh[id] = 1; }); }
  function fired(ev) { if (!ev) return; ui.clock = 0; ui.hot = ev; markFresh(W()); if (!demo) save(); render(); }
  function startDemo() { demo = E.demoWorld(dsl, real.run.caseId); ui.demoEnd = null; ui.paused = false; ui.clock = 0; ui.hot = null; ui.sheet = []; ui.level = 'doing'; ui.fresh = {}; markFresh(demo); render(); }
  function exitDemo() { demo = null; ui.demoEnd = null; ui.paused = false; ui.clock = 0; ui.hot = null; ui.sheet = []; render(); }
  var last = 0;
  function frame(ts) {
    var dt = Math.min(100, ts - last || 0); last = ts;
    var w = W(), p = E.plan(w);
    if (!ui.paused && !ui.demoEnd) {
      if (p && !p.user) { ui.clock += dt; if (ui.clock >= p.delay) fired(E.advance(w)); }
      else if (demo && p && p.user) {
        if (w.state.halt) { ui.demoEnd = 'stuck'; render(); }
        else { ui.clock += dt; if (ui.clock >= 1400) fired(E.act(w, { bot: E.caseOf(w).market[0] })); }
      } else if (demo && !p) { ui.demoEnd = 'done'; render(); }
    }
    placeChip();
    requestAnimationFrame(frame);
  }

  /* ---------- 交互 ---------- */
  function coerce(v) { v = String(v).trim(); try { return JSON.parse(v); } catch (e) { return v; } }
  var A = {
    demo: startDemo, 'demo-exit': exitDemo,
    pause: function () { ui.paused = !ui.paused; render(); },
    act: function (d) { var o; if (d.o) { o = {}; o[d.o] = true; } if (d.close) closeSheet(); var ev = E.act(W(), o); fired(ev); },
    bot: function (d) { open({ t: 'bot', id: d.id }); },
    phone: function (d) { if ((ui.sheet[ui.sheet.length - 1] || {}).t === 'bot') ui.sheet.pop(); open({ t: 'phone', id: d.id }); },
    pc: function (d) { if ((ui.sheet[ui.sheet.length - 1] || {}).t === 'bot') ui.sheet.pop(); open({ t: 'pc', id: d.id }); },
    thread: function (d) { var topPg = ui.sheet[ui.sheet.length - 1]; if (!topPg || topPg.t !== 'phone' || topPg.id !== d.id) ui.sheet.push({ t: 'phone', id: d.id }); open({ t: 'phone', id: d.id, thread: d.b }); },
    file: function (d) { open({ t: 'file', id: d.id }); },
    basis: function () { open(W().state.files.some(function (f) { return f.kind === 'artifact'; }) ? { t: 'file', id: 'artifact' } : { t: 'log' }); },
    log: function () { open({ t: 'log' }); }, scene: function () { open({ t: 'scene' }); }, more: function () { open({ t: 'more' }); }, runs: function () { if (demo) exitDemo(); open({ t: 'runs' }); },
    'hire-open': function () { open({ t: 'hire' }); },
    hire: function (d) { closeSheet(); fired(E.act(W(), { bot: d.id })); },
    back: function () { ui.sheet.pop(); renderSheet(true); }, close: closeSheet,
    level: function (d) { ui.level = d.id; closeSheet(); render(); }, fit: function () { fit(true, true); }, zin: function () { zoomBy(1.25); }, zout: function () { zoomBy(.8); },
    redeliver: function (d) { var ev = E.redeliver(real, d.id); save(); render(); toast(ev && ev.type === 'dedup' ? '同一次投递，没有生成第二份收件。' : '已重投。'); },
    keep: function () { var s = real.state, note = $('#keepnote').value.trim(); if (E.keep(real, s.hired, note)) { save(); render(); toast('已留下' + N(s.hired) + '。能不能自由发消息，在手机里单独决定。'); } },
    newrun: function (d) { var n = data.runs.filter(function (r) { return r.caseId === d.id; }).length + 1, run = E.newRun(dsl, d.id, n); data.runs.push(run); A['switch']({ id: run.id }); },
    'switch': function (d) { var run = data.runs.find(function (r) { return r.id === d.id; }); real = E.makeWorld(dsl, data.book, run, 'real'); ui.clock = 0; ui.hot = null; ui.paused = false; ui.sheet = []; ui.viewKey = ''; ui.level = 'doing'; save(); render(); },
    'dsl-apply': function () { try { var next = E.validate(JSON.parse($('#dsltext').value)); data.dsl = next; save(); boot(); render(); toast('已按新的场景数据重建画布。'); } catch (e) { toast('这份数据用不了：' + e.message); } },
    'dsl-reset': function () { data.dsl = null; save(); boot(); render(); toast('已恢复默认场景。'); },
    'reset-all': function () { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } boot(); render(); toast('已清空，回到第一次打开的样子。'); }
  };
  var CH = {
    grant: function (d, el) { real.book.grants[d.id + '>' + d.b] = el.checked; toast(N(d.id) + (el.checked ? '现在可以' : '不能再') + '发给' + N(d.b) + '。联系方式还在。'); },
    note: function (d, el) { real.book.notes[d.id + '>' + d.b] = el.value.trim(); },
    comp: function (d, el) { var o = real.book.comp[d.id] = real.book.comp[d.id] || {}; o[d.b] = el.checked; },
    review: function (d, el) { var o = real.book.comp[d.id] = real.book.comp[d.id] || {}; o.review = el.value.trim(); },
    skills: function (d, el) { real.book.skills[d.id] = el.value.trim(); },
    fx: function (d, el) { E.nodeOf(E.caseOf(real), 'sandbox').fixture[d.id] = coerce(el.value); data.dsl = dsl; },
    gate: function (d, el) { E.nodeOf(E.caseOf(real), 'gate').equals[d.id] = coerce(el.value); data.dsl = dsl; }
  };
  var suppress = false;
  document.addEventListener('click', function (e) {
    if (suppress) { suppress = false; e.preventDefault(); return; }
    var el = e.target.closest('[data-a]'); if (!el || el.disabled) return;
    var fn = A[el.dataset.a]; if (fn) fn(el.dataset);
  });
  document.addEventListener('change', function (e) {
    var el = e.target.closest('[data-c]'); if (!el || locked()) return;
    CH[el.dataset.c](el.dataset, el); save(); renderTop(); renderDock(); renderCanvas();
  });
  document.addEventListener('focusout', function () { if (ui.sheetDirty) setTimeout(function () { renderSheet(false); }, 0); });
  document.addEventListener('toggle', function (e) { if (e.target.querySelector && e.target.querySelector('#dsltext')) ui.dslOpen = e.target.open; }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ui.sheet.length) closeSheet(); });

  var pts = {}, pinch = 0, moved = 0, cv = $('#canvas');
  cv.addEventListener('pointerdown', function (e) { pts[e.pointerId] = { x: e.clientX, y: e.clientY }; moved = 0; pinch = 0; $('#world').classList.remove('glide'); });
  window.addEventListener('pointermove', function (e) {
    var p = pts[e.pointerId]; if (!p) return;
    var ids = Object.keys(pts), dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (ids.length === 1) { moved += Math.abs(dx) + Math.abs(dy); if (moved > 8) { ui.view.x += dx; ui.view.y += dy; cv.classList.add('drag'); applyView(false); } }
    p.x = e.clientX; p.y = e.clientY;
    if (ids.length === 2) { var a = pts[ids[0]], b = pts[ids[1]], dist = Math.hypot(a.x - b.x, a.y - b.y); if (pinch) zoomBy(dist / pinch, (a.x + b.x) / 2, (a.y + b.y) / 2); pinch = dist; moved = 99; }
  });
  function up(e) { if (!pts[e.pointerId]) return; delete pts[e.pointerId]; pinch = 0; cv.classList.remove('drag'); if (moved > 8 && e.type === 'pointerup' && e.pointerType === 'mouse') { suppress = true; setTimeout(function () { suppress = false; }, 0); } }
  window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', function (e) { e.preventDefault(); zoomBy(Math.exp(-e.deltaY * .0015), e.clientX, e.clientY); }, { passive: false });
  window.addEventListener('resize', function () { ui.viewKey = ''; renderCanvas(); });

  boot(); render(); fit(false);
  requestAnimationFrame(frame);
  window.__matter = { get real() { return real; }, get demo() { return demo; }, ui: ui, E: E };
})();
