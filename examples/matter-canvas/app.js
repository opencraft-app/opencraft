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
    play: '<path d="M8 5.5v13l10-6.5z" fill="currentColor"/>', pause: '<path d="M8 5.5v13M16 5.5v13"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>', back: '<path d="m14 6-6 6 6 6"/>', down: '<path d="m7 10 5 5 5-5"/>',
    fit: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>', plus: '<path d="M12 6v12M6 12h12"/>', minus: '<path d="M6 12h12"/>',
    doc: '<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z"/><path d="M14 3.5v4h4M10 12h5M10 15.5h5"/>',
    scene: '<path d="M4 7h16M4 12h16M4 17h10"/>'
  };
  function ic(n) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + I[n] + '</svg>'; }

  /* ---------- 存取 ---------- */
  var data, dsl, real, demo = null;
  var ui = { level: 'doing', sheet: [], paused: false, clock: 0, view: { x: 0, y: 0, k: 1 }, fold: false, demoEnd: null, castKey: '', fresh: {}, hot: null, userMoved: false };
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
    real = E.makeWorld(dsl, data.book, run, 'real'); demo = null; ui.demoEnd = null; ui.clock = 0;
  }
  function W() { return demo || real; }
  function C() { return E.caseOf(W()); }
  function N(id) { return E.nameOf(W(), id); }
  function locked() { return !!demo; }

  /* ---------- 画布布局 ---------- */
  function cast(w) {
    var c = E.caseOf(w), s = w.state, set = [c.owner];
    function add(id) { if (id && id !== 'user' && id !== 'contract' && set.indexOf(id) < 0) set.push(id); }
    s.log.forEach(function (ev) { add(ev.from); add(ev.to); add(ev.bot); add(ev.operator); });
    if (w.mode === 'demo' || s.log.length) { var st = c.steps[s.idx]; if (st && st.source) { add(E.resolve(s, st.source)); add(E.resolve(s, st.target)); } }
    return set;
  }
  var SLOT = { owner: [-130, 0], peer: [150, 0], hired: [150, 270], extra: [-320, 250] };
  function layout(w) {
    var c = E.caseOf(w), s = w.state, pos = {}, list = [], ids = cast(w), extra = 0;
    ids.forEach(function (id) {
      var p = id === c.owner ? SLOT.owner : id === c.peer ? SLOT.peer : id === s.hired ? SLOT.hired : [SLOT.extra[0] - 170 * extra++, SLOT.extra[1]];
      pos[id] = { x: p[0], y: p[1], stage: true }; list.push(id);
    });
    if (ui.level === 'contacts') {
      var rest = E.contactsOf(w, c.owner).filter(function (id) { return !pos[id]; });
      rest.forEach(function (id, i) { var a = (125 + 110 * (rest.length > 1 ? i / (rest.length - 1) : .5)) * Math.PI / 180; pos[id] = { x: SLOT.owner[0] + 215 * Math.cos(a), y: 40 + 215 * Math.sin(a) }; list.push(id); });
    }
    var teams = [];
    if (ui.level === 'all') {
      var centers = [[-560, -230], [580, -230], [-600, 330], [620, 350], [0, 640]];
      w.dsl.teams.forEach(function (t, ti) {
        var ctr = centers[ti % centers.length], members = w.dsl.bots.filter(function (b) { return b.team === t.id && !pos[b.id]; });
        teams.push({ name: t.name, x: ctr[0], y: ctr[1] });
        members.forEach(function (b, i) { var a = (i / members.length) * 2 * Math.PI - Math.PI / 2; pos[b.id] = { x: ctr[0] + 125 * Math.cos(a), y: ctr[1] + 115 * Math.sin(a) }; list.push(b.id); });
      });
    }
    return { pos: pos, list: list, matter: { x: 10, y: -175 }, teams: teams, cast: ids };
  }
  function color(id) { var b = E.botOf(W(), id), t = b && W().dsl.teams.find(function (x) { return x.id === b.team; }); return t ? t.color : '#667'; }
  function face(id, cls) { return '<span class="av ' + (cls || '') + '" style="--tc:' + color(id) + '">' + esc(N(id).slice(-1)) + '</span>'; }
  function roleOf(w, id) {
    var c = E.caseOf(w), s = w.state;
    if (id === c.owner) return '负责人';
    if (id === s.hired) { var h = c.steps.find(function (x) { return x.kind === 'hire'; }); return '受托：' + (h ? h.envelope : '帮手') + (s.hiredVia === 'contacts' ? '' : ' · 临时工'); }
    if ((c.nodes || []).some(function (n) { return n.id === id && n.kind === 'reviewer'; })) return '独立复核';
    return E.skillsOf(w, id);
  }
  function countMsgs(w, a, b) { return w.state.messages.filter(function (m) { return m.from === a && m.to === b; }).length; }

  var L = null;
  function renderCanvas() {
    var w = W(), s = w.state, c = C(); L = layout(w);
    var p = E.plan(w), flying = p && p.flight ? s.messages[s.messages.length - 1] : null;
    var html = '', paths = '', seen = {};
    function line(a, b, cls) { return '<path class="' + cls + '" d="M' + a.x + ' ' + a.y + 'L' + b.x + ' ' + b.y + '"/>'; }
    var own = L.pos[c.owner];
    paths += line(L.matter, own, 'owns');
    L.list.forEach(function (a) { L.list.forEach(function (b) {
      if (a >= b) return; var A = L.pos[a], B = L.pos[b], k = a + '|' + b;
      var commission = s.hired && E.pairKey(a, b) === E.pairKey(c.owner, s.hired), kn = E.knows(w, a, b);
      if (!kn && !commission) return;
      if (ui.level !== 'all' && !(A.stage && B.stage) && a !== c.owner && b !== c.owner) return;
      seen[k] = 1;
      var lit = flying && E.pairKey(flying.from, flying.to) === E.pairKey(a, b);
      paths += line(A, B, lit ? 'lit' + (ui.paused ? ' paused' : '') : kn ? 'contact' + (A.stage && B.stage ? '' : ' faint') : 'commission');
      if (A.stage && B.stage) {
        var mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2, ab = countMsgs(w, a, b), ba = countMsgs(w, b, a);
        if (!kn) html += '<div class="nd" style="left:' + mx + 'px;top:' + (my - 22) + 'px"><span class="tag"><b>本次委托</b></span></div>';
        html += '<div class="nd" style="left:' + mx + 'px;top:' + my + 'px"><button class="pair" data-a="rel" data-id="' + a + '" data-b="' + b + '" aria-label="' + esc(N(a) + '和' + N(b) + '的联系') + '">' +
          (ab + ba ? (A.x <= B.x ? '→' + ab + ' ←' + ba : '←' + ab + ' →' + ba) : kn ? '可联系' : '委托') + '</button></div>';
      }
    }); });
    if (flying && L.pos[flying.from] && L.pos[flying.to]) {
      var F = L.pos[flying.from], T = L.pos[flying.to], ang = Math.atan2(T.y - F.y, T.x - F.x) * 180 / Math.PI, d = 44;
      var ax = T.x - d * Math.cos(ang * Math.PI / 180), ay = T.y - d * Math.sin(ang * Math.PI / 180);
      paths += '<path class="arrow" transform="translate(' + ax + ' ' + ay + ') rotate(' + ang + ')" d="M0 0-13-7v14z"/>';
    }
    $('#lines').innerHTML = paths;

    html += '<div class="nd" style="left:' + L.matter.x + 'px;top:' + L.matter.y + 'px"><button class="matter" data-a="hud"><small>' + esc(c.tag) + (w.run.n ? ' · 第 ' + w.run.n + ' 轮' : ' · 演示') + '</small><strong>' + esc(c.title) + '</strong>' + statusChip(w) + '</button></div>';
    L.teams.forEach(function (t) { html += '<div class="nd" style="left:' + t.x + 'px;top:' + t.y + 'px"><span class="team">' + esc(t.name) + '</span></div>'; });
    L.list.forEach(function (id) {
      var P = L.pos[id], enter = ui.fresh[id] ? ' enter' : '';
      if (!P.stage) { html += '<div class="nd mini" style="left:' + P.x + 'px;top:' + P.y + 'px"><button class="av" data-a="bot" data-id="' + id + '" style="--tc:' + color(id) + '" aria-label="' + esc(N(id)) + '">' + esc(N(id).slice(-1)) + '</button><span class="nm">' + esc(N(id)) + '</span><span class="rl">' + esc(E.skillsOf(w, id)) + '</span></div>'; return; }
      var inbox = s.messages.filter(function (m) { return m.to === id && m.state === 'delivered'; }).length, files = s.files.filter(function (f) { return f.owner === id; }).length;
      var busy = s.working && s.working.operator === id, cp = E.comp(w, id), hot = ui.hot || {};
      var say = busy ? '<span class="say"><b>正在：' + esc(s.working.reaction) + '</b></span>' : hot.type === 'file' && hot.operator === id ? '<span class="say new"><b>新材料：' + esc(hot.name) + '</b></span>' : '';
      html += '<div class="nd' + enter + '" style="left:' + P.x + 'px;top:' + P.y + 'px">' +
        '<button class="av" data-a="bot" data-id="' + id + '" style="--tc:' + color(id) + '" aria-label="' + esc(N(id)) + '">' + esc(N(id).slice(-1)) + '</button>' +
        '<span class="nm">' + esc(N(id)) + '</span><span class="rl">' + esc(roleOf(w, id)) + '</span>' +
        '<span class="dv"><button class="d' + (hot.type === 'delivered' && hot.to === id ? ' ping' : '') + '" data-a="phone" data-id="' + id + '" aria-label="' + esc(N(id)) + '的手机">' + ic('phone') + '手机' + (inbox ? '<i class="bdg">' + inbox + '</i>' : '') + '</button>' +
        '<button class="d' + (busy ? ' busy' : '') + (cp.work ? '' : ' off') + '" data-a="pc" data-id="' + id + '" aria-label="' + esc(N(id)) + '的电脑">' + ic('pc') + (cp.work ? '电脑' : '已停工') + (files ? '<i class="bdg">' + files + '</i>' : '') + '</button></span>' + say + '</div>';
    });
    $('#nodes').innerHTML = html; ui.fresh = {};
    var key = L.list.join(',') + ui.level;
    if (key !== ui.castKey) { ui.castKey = key; fit(true); }
    placeChip();
  }
  function phoneAt(id) { var P = L.pos[id]; return P.stage ? { x: P.x - 30, y: P.y + 100 } : P; }
  function placeChip() {
    var w = W(), s = w.state, p = E.plan(w), chip = $('#chip');
    if (!p || !p.flight || !L) { chip.hidden = true; return; }
    var m = s.messages[s.messages.length - 1], A = L.pos[m.from], B = L.pos[m.to];
    if (!A || !B) { chip.hidden = true; return; }
    var still = reduced && reduced.matches, t = still ? .5 : Math.min(1, ui.clock / p.delay);
    var pts = still ? [A, B] : [phoneAt(m.from), A, B, phoneAt(m.to)], cuts = still ? [0, 1] : [0, .14, .86, 1], i = 1;
    while (i < cuts.length - 1 && t > cuts[i]) i++;
    var u = (t - cuts[i - 1]) / (cuts[i] - cuts[i - 1]), x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * u, y = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * u;
    var label = ic('mail') + esc(m.envelope) + (still ? ' · ' + esc(N(m.from) + ' → ' + N(m.to)) + (ui.paused ? ' · 已暂停' : ' · 传递中') : ' → ' + esc(N(m.to)));
    if (chip.dataset.k !== label) { chip.innerHTML = label; chip.dataset.k = label; }
    chip.className = still ? 'still' : ''; chip.style.left = x + 'px'; chip.style.top = (still ? y - 26 : y) + 'px'; chip.hidden = false;
  }
  function applyView(glide) {
    var el = $('#world'); el.classList.toggle('glide', !!glide && !(reduced && reduced.matches));
    el.style.transform = 'translate(' + ui.view.x + 'px,' + ui.view.y + 'px) scale(' + ui.view.k + ')';
  }
  function freeRect() {
    var cw = $('#canvas').clientWidth, ch = $('#canvas').clientHeight, hud = $('#hud').getBoundingClientRect(), top = $('#top').getBoundingClientRect().bottom + 6;
    if (cw > 760) return { x: hud.right + 16, y: top, w: cw - hud.right - 32 - 60, h: ch - top - 12 };
    return { x: 8, y: top, w: cw - 16 - 52, h: Math.max(140, hud.top - top - 6) };
  }
  function fit(glide) {
    if (!L) return;
    var x0 = L.matter.x - 115, x1 = L.matter.x + 115, y0 = L.matter.y - 52, y1 = L.matter.y + 52;
    L.list.forEach(function (id) { var P = L.pos[id], rx = P.stage ? 95 : 55; x0 = Math.min(x0, P.x - rx); x1 = Math.max(x1, P.x + rx); y0 = Math.min(y0, P.y - 44); y1 = Math.max(y1, P.y + (P.stage ? 152 : 60)); });
    var r = freeRect(), k = Math.min(1.15, r.w / (x1 - x0), r.h / (y1 - y0)); k = Math.max(.18, k);
    ui.view = { k: k, x: r.x + r.w / 2 - k * (x0 + x1) / 2, y: r.y + r.h / 2 - k * (y0 + y1) / 2 };
    applyView(glide);
  }
  function zoomBy(f, cx, cy) {
    var v = ui.view, k = Math.max(.18, Math.min(2.2, v.k * f)); cx = cx == null ? $('#canvas').clientWidth / 2 : cx; cy = cy == null ? $('#canvas').clientHeight / 2 : cy;
    v.x = cx - (cx - v.x) * k / v.k; v.y = cy - (cy - v.y) * k / v.k; v.k = k; applyView(false);
  }

  /* ---------- 顶栏与事项卡 ---------- */
  function statusChip(w) {
    var s = w.state, st = E.caseOf(w).steps[s.idx], h = s.halt;
    if (h) return '<span class="chip warn">' + (h.type === 'checked' ? '返工：校验没过' : h.type === 'blocked' ? '没发出去' : h.type === 'stalled' ? '停工中' : h.type === 'askhuman' ? '等你判断' : '返工') + '</span>';
    return '<span class="chip ' + (st.kind === 'done' ? 'ok' : st.kind === 'confirm' ? 'sig' : '') + '">' + esc(st.status) + '</span>';
  }
  function renderTop() {
    var lv = [['doing', '在办的人'], ['contacts', '联系人'], ['all', '全部 ' + dsl.bots.length]];
    $('#top').innerHTML = '<span class="brand">事项画布</span>' +
      '<button class="pill grow" data-a="runs" aria-label="切换事项"><span>' + esc(E.caseOf(real).title) + ' · 第 ' + real.run.n + ' 轮</span>' + ic('down') + '</button>' +
      '<span class="sim" title="所有执行都在本机模拟">本地模拟</span>' +
      '<div class="seg" role="group" aria-label="看多少人">' + lv.map(function (l) { return '<button data-a="level" data-id="' + l[0] + '" aria-pressed="' + (ui.level === l[0]) + '">' + l[1] + '</button>'; }).join('') + '</div>' +
      '<button class="pill" data-a="scene">' + ic('scene') + '<span>现场</span></button>';
    $('#zoom').innerHTML = '<button data-a="zin" aria-label="放大">' + ic('plus') + '</button><button data-a="zout" aria-label="缩小">' + ic('minus') + '</button><button data-a="fit" aria-label="回到全览">' + ic('fit') + '</button>';
  }
  function narration(w) {
    var s = w.state, last = s.log[s.log.length - 1];
    if (!last) return '';
    return E.describe(w, last);
  }
  function needYou(w) {
    var s = w.state, c = E.caseOf(w), st = c.steps[s.idx], h = s.halt, own = N(c.owner);
    if (st.kind === 'done') return s.hired && !s.kept && !E.knows(w, c.owner, s.hired) ? '事情办完了。觉得' + N(s.hired) + '好用，可以留下。' : '不用，已经办完。';
    if (h) return h.type === 'askhuman' ? '要。有一句叮嘱得你来判断。' : '要。卡住了，看下面的说明。';
    if (st.kind === 'confirm') return '要。看一眼「' + c.artifact + '」，没问题就确认。';
    if (st.kind === 'hire' && !s.cur.hired) return '要。帮' + own + '挑一位帮手。';
    var p = E.plan(w);
    return p && p.user ? '暂时不用。想推一把可以点下面的按钮。' : '不用，正在进行。';
  }
  function whoLine(w) {
    var c = E.caseOf(w), s = w.state, t = '<button class="lnk" data-a="bot" data-id="' + c.owner + '">' + esc(N(c.owner)) + '</button>';
    if (s.hired) t += '，<button class="lnk" data-a="bot" data-id="' + s.hired + '">' + esc(N(s.hired)) + '</button> 受托帮忙';
    return t;
  }
  function renderHud() {
    var w = W(), s = w.state, c = C(), st = c.steps[s.idx], p = E.plan(w), h = s.halt, own = N(c.owner), html = '', acts = '';
    var hud = $('#hud'); hud.className = (demo ? 'demo ' : '') + (ui.fold ? 'fold' : '');
    var started = real.state.log.length > 0;
    if (demo) html += '<div class="ribbon"><span>演示 · 模拟，不动你的进度</span>' +
      (ui.demoEnd ? '' : '<button class="btn" data-a="pause">' + ic(ui.paused ? 'play' : 'pause') + (ui.paused ? '继续' : '暂停') + '</button>') + '<button class="btn" data-a="demo-exit">退出</button></div>';
    html += '<h1 class="hl">' + esc(st.kind === 'done' ? '办完了：' + st.summary : c.headline) + '</h1>';
    html += '<div class="sub"><span>' + esc(c.title) + '</span>' + statusChip(w) + '</div>';
    html += '<div class="steps" aria-hidden="true">' + c.steps.map(function (x, i) { return '<i class="' + (i < s.idx || x.kind === 'done' && i === s.idx ? 'done' : i === s.idx ? 'now' : '') + '"></i>'; }).join('') + '</div>';
    html += '<dl class="kv more"><dt>现在</dt><dd>' + esc(st.summary) + '</dd><dt>谁在办</dt><dd>' + whoLine(w) + '</dd><dt>要我出手吗</dt><dd>' + esc(needYou(w)) + '</dd></dl>';
    var nar = narration(w);
    if (p && p.flight && ui.paused) nar += '（已暂停，消息停在半路）';
    if (nar && !h) html += '<p class="now">' + esc(nar) + '</p>';

    if (h) {
      var fix = '';
      if (h.type === 'blocked' && h.reason === 'grant') fix = '<button class="btn" data-a="phone" data-id="' + h.from + '">打开' + esc(N(h.from)) + '的手机，看发送许可</button>';
      else if (h.type === 'blocked') fix = '<button class="btn" data-a="pc" data-id="' + h.from + '">打开' + esc(N(h.from)) + '的电脑</button>';
      else if (h.type === 'stalled') fix = '<button class="btn" data-a="pc" data-id="' + h.operator + '">打开' + esc(N(h.operator)) + '的电脑</button>';
      else if (h.type === 'checked') fix = '<button class="btn" data-a="scene">去现场看沙盒和栅栏</button>';
      else if (h.type === 'held') fix = '<button class="btn" data-a="act" data-o="revise">让' + esc(N(s.hired)) + '补上再交</button><button class="btn" data-a="pc" data-id="' + h.by + '">改' + esc(N(h.by)) + '的叮嘱</button>';
      else if (h.type === 'askhuman') fix = '<blockquote>' + esc(st.message) + '</blockquote><button class="btn primary" data-a="act" data-o="approve">符合，放行</button><button class="btn" data-a="act" data-o="reject">不符合，退回</button>';
      html += '<div class="halt"><span>' + esc(E.describe(w, h)) + '</span>' + (demo ? '<span>演示停在这里。</span>' : '<div class="row">' + fix + '</div>') + '</div>';
    }

    if (demo) {
      if (ui.demoEnd || h) acts = '<button class="btn primary big" data-a="demo-exit">回到我的进度</button><button class="btn" data-a="demo">再看一遍</button>';
    } else if (st.kind === 'done') {
      if (s.hired && !E.knows(w, c.owner, s.hired)) {
        var sk = E.skillsOf(w, s.hired).split(/[和与、，]/)[0];
        acts += '<input class="inp" id="keepnote" aria-label="备注" value="' + esc('擅长' + sk) + '"><button class="btn primary" data-a="keep">留下' + esc(N(s.hired)) + '</button>';
      } else if (s.hired) acts += '<span class="chip ok">' + esc(N(s.hired)) + '已在' + esc(own) + '的通讯录</span>';
      acts += '<button class="btn" data-a="newrun" data-id="' + c.id + '">另开一轮相似的事</button><button class="btn" data-a="file" data-id="artifact">' + ic('doc') + '看' + esc(c.artifact) + '</button>';
    } else if (p && !p.user) {
      acts = '<button class="btn big" data-a="pause">' + ic(ui.paused ? 'play' : 'pause') + (ui.paused ? '继续' : '暂停') + '</button>';
    } else if (p) {
      var main = st.kind === 'hire' && !s.cur.hired ? '<button class="btn primary big" data-a="hire-open">' + esc(st.action) + '</button>'
        : h && h.type === 'askhuman' ? '' : '<button class="btn ' + (started || h ? 'primary big' : '') + '" data-a="act">' + esc(h ? '再试一次' : (started ? '' : '我自己来：') + st.action) + '</button>';
      if (st.kind === 'confirm' && !h) main = '<button class="btn primary big" data-a="file" data-id="artifact">' + ic('doc') + '打开' + esc(c.artifact) + '</button><button class="btn" data-a="act">' + esc(st.action) + '</button>';
      acts = (started ? '' : '<button class="btn primary big" data-a="demo">' + ic('play') + '看' + esc(own) + '怎么做</button>') + main;
    }
    html += '<div class="row">' + acts + '</div>';
    html += '<div class="links">' + (!demo && started ? '<button class="btn quiet" data-a="demo">' + ic('play') + '看演示</button>' : '') +
      '<button class="btn quiet" data-a="log">经过 ' + s.log.length + '</button><button class="btn quiet" data-a="scene">现场</button>' +
      '<button class="btn quiet only-m" data-a="fold">' + (ui.fold ? '展开' : '收起') + '</button></div>';
    hud.innerHTML = html;
  }

  /* ---------- 抽屉 ---------- */
  function open(page, replace) { if (replace) ui.sheet.pop(); ui.sheet.push(page); renderSheet(true); }
  function closeSheet() { ui.sheet = []; renderSheet(true); }
  function head(title) { return '<div class="sh-head">' + (ui.sheet.length > 1 ? '<button class="ib" data-a="back" aria-label="返回">' + ic('back') + '</button>' : '') + '<h2>' + title + '</h2><button class="ib" data-a="close" aria-label="关闭">' + ic('close') + '</button></div>'; }
  function dis() { return locked() ? ' disabled' : ''; }
  function lockNote() { return locked() ? '<p class="hint">演示中只能看，不能改设置。退出演示后可以调整。</p>' : ''; }
  function fileBtn(f) { return '<button class="filebtn" data-a="file" data-id="' + esc(f.id) + '">' + ic('doc') + '<div><b>' + esc(f.name) + '</b>' + (f.version ? ' <span class="chip mute">' + esc(f.version) + '</span>' : '') + '<small>' + esc(f.input ? '来自「' + f.input + '」' : '') + '</small></div></button>'; }

  function pagePhone(id, other) {
    var w = W(), s = w.state, c = C(), h = '';
    if (other) {
      var msgs = s.messages.filter(function (m) { return (m.from === id && m.to === other) || (m.from === other && m.to === id); }), body = '';
      s.log.forEach(function (ev) {
        if (ev.type === 'blocked' && ev.from === id && ev.to === other) body += '<div class="sys">没发出去：' + esc(ev.reason === 'grant' ? '没有发送许可' : ev.reason === 'device' ? '电脑关了对外发消息' : '没有联系方式') + '</div>';
        if (ev.type !== 'sent') return;
        var m = msgs.find(function (x) { return x.id === ev.delivery; }); if (!m) return;
        var f = s.files.find(function (x) { return x.step === m.step && x.kind !== 'submission'; }), st = c.steps[m.step];
        body += '<div class="msg ' + (m.from === id ? 'me' : '') + '"><div>' + esc(m.text) + '</div><div class="meta"><span class="chip mute">' + esc(m.envelope) + '</span><span>' + esc(N(m.from)) + ' → ' + esc(N(m.to)) + '</span><span>' + (m.state === 'delivered' ? '已送达' : '在路上') + '</span><span>第 ' + (m.step + 1) + ' 步</span>' +
          (m.from === id && m.from !== 'user' && !locked() ? '<button class="lnk" data-a="redeliver" data-id="' + esc(m.id) + '">重投这一条</button>' : '') + '</div></div>';
        if (m.state === 'delivered') body += '<div class="then">' + esc(N(E.resolve(s, st.desktop.operator))) + '接着：' + esc(st.reaction) + (f ? ' → <button class="lnk" data-a="file" data-id="' + esc(f.id) + '">' + esc(f.name) + '</button>' : s.working ? '（进行中）' : '（还没开始）') + '</div>';
      });
      return head(esc(N(id)) + '的手机 · 和' + esc(N(other))) + '<div class="sh-body"><div class="device phone"><div class="msgs">' + (body || '<p class="hint">这件事里，两人还没有真的发过消息。</p>') + '</div></div></div>';
    }
    var list = E.contactsOf(w, id), partner = s.hired && (id === c.owner ? s.hired : id === s.hired ? c.owner : null);
    if (partner && list.indexOf(partner) < 0) list.unshift(partner);
    if (id === c.owner && s.messages.some(function (m) { return m.from === 'user'; })) list.unshift('user');
    list.forEach(function (o) {
      var n = s.messages.filter(function (m) { return (m.from === id && m.to === o) || (m.from === o && m.to === id); }).length, kn = o !== 'user' && E.knows(w, id, o);
      h += '<div class="card"><div class="top">' + (o === 'user' ? '' : face(o, 'sm')) + '<div><b>' + esc(N(o)) + '</b><br><small>' + esc(o === 'user' ? '这件事的主人' : E.skillsOf(w, o)) + '</small></div><button class="btn" data-a="thread" data-id="' + id + '" data-b="' + o + '">往来 ' + n + '</button></div>';
      if (o !== 'user') {
        h += '<div class="facts"><span class="chip ' + (kn ? 'mute' : 'sig') + '">' + (kn ? '有联系方式' : '仅本次委托') + '</span><span class="chip ' + (E.granted(w, o, id) ? 'mute' : 'warn') + '">' + (E.granted(w, o, id) ? '对方可发给我' : kn ? '对方不能主动发来' : '只回传委托结果') + '</span></div>';
        if (kn) h += '<label class="sw"><span>允许发到' + esc(N(o)) + '的收件会话</span><input type="checkbox" id="g-' + id + '-' + o + '" data-c="grant" data-id="' + id + '" data-b="' + o + '"' + (E.granted(w, id, o) ? ' checked' : '') + dis() + '></label>' +
          '<input class="inp" id="n-' + id + '-' + o + '" data-c="note" data-id="' + id + '" data-b="' + o + '" placeholder="给' + esc(N(o)) + '写句备注" value="' + esc(w.book.notes[id + '>' + o] || '') + '"' + dis() + '>';
      }
      h += '</div>';
    });
    return h || '<p class="hint">通讯录还是空的。</p>';
  }
  function pagePc(id) {
    var w = W(), s = w.state, c = C(), cp = E.comp(w, id), busy = s.working && s.working.operator === id, h = '';
    var files = s.files.filter(function (f) { return f.owner === id; }), elsewhere = 0;
    data.runs.forEach(function (r) { if (r.id !== w.run.id) elsewhere += E.reduce(null, r.events).files.filter(function (f) { return f.owner === id; }).length; });
    h += '<h3>正在处理</h3><p>' + (busy ? '<span class="chip">进行中</span> ' + esc(s.working.reaction) + '（因为收到「' + esc(s.working.input) + '」）' : cp.work ? '现在空着。收到消息后会在这里开工。' : '<span class="chip warn">已停工</span> 「处理文件」关着，收到消息也不会动。') + '</p>';
    h += '<h3>这件事里的材料</h3>';
    if (id === c.owner) h += '<button class="filebtn" data-a="file" data-id="desk">' + ic('doc') + '<div><b>' + esc(c.desktop.title) + '</b><small>手头的任务单</small></div></button>';
    h += files.map(fileBtn).join('') || (id === c.owner ? '' : '<p class="hint">还没有材料。</p>');
    if (elsewhere && !demo) h += '<p class="hint">另有 ' + elsewhere + ' 份材料留在别的事项里，切换事项可以看到。</p>';
    h += '<h3>能做的事</h3><div>' + [['work', '处理文件'], ['send', '对外发消息'], ['hire', '找帮手']].map(function (k) {
      return '<label class="sw"><span>' + k[1] + '</span><input type="checkbox" id="c-' + id + '-' + k[0] + '" data-c="comp" data-id="' + id + '" data-b="' + k[0] + '"' + (cp[k[0]] ? ' checked' : '') + dis() + '></label>'; }).join('') + '</div>';
    h += '<h3>交付前的叮嘱</h3><textarea class="inp" rows="2" id="rv-' + id + '" data-c="review" data-id="' + id + '" placeholder="例如：必须包含：签字"' + dis() + '>' + esc(cp.review) + '</textarea>' +
      '<p class="hint">写成「必须包含：某个词」会在交付时自动检查，缺了就拦下。其他的话，交付时原样拿给你判断。</p>';
    return h;
  }
  function pageBot(pg) {
    var w = W(), id = pg.id, b = E.botOf(w, id), team = w.dsl.teams.find(function (t) { return t.id === b.team; });
    if (pg.thread) return pagePhone(id, pg.thread);
    return head(esc(b.name)) + '<div class="sh-body"><div class="who">' + face(id) + '<div style="flex:1;min-width:0"><small class="hint">' + esc(team ? team.name : '') + ' · ' + esc(roleOf(w, id)) + '</small>' +
      '<input class="inp" id="sk-' + id + '" data-c="skills" data-id="' + id + '" aria-label="职责备注" value="' + esc(E.skillsOf(w, id)) + '"' + dis() + '></div></div>' +
      '<div class="tabs" role="tablist"><button role="tab" data-a="tab" data-id="phone" aria-selected="' + (pg.tab === 'phone') + '">' + ic('phone') + '手机</button><button role="tab" data-a="tab" data-id="pc" aria-selected="' + (pg.tab === 'pc') + '">' + ic('pc') + '电脑</button></div>' + lockNote() +
      '<div class="device ' + pg.tab + '">' + (pg.tab === 'phone' ? '<h3>通讯录</h3>' + pagePhone(id) : pagePc(id)) + '</div></div>';
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
        '<dt>怎么来的</dt><dd>' + esc(N(f.from)) + ' → ' + esc(N(f.owner)) + '的消息「' + esc(f.input) + '」（第 ' + (f.step + 1) + ' 步）</dd><dt>校验</dt><dd><span class="chip ok">栅栏通过</span> 本地模拟执行</dd></dl>';
    } else if (f.kind === 'submission') {
      src = '<dl class="kv"><dt>谁提交</dt><dd>' + esc(N(f.owner)) + '</dd><dt>版本</dt><dd><span class="chip mute">' + esc(f.version) + '</span></dd><dt>依据</dt><dd>沙盒输出（本地模拟），已过栅栏</dd></dl>';
    } else if (f.kind === 'receipt') {
      src = '<dl class="kv"><dt>怎么来的</dt><dd>' + esc(N(f.from)) + '发来「' + esc(f.input) + '」后，' + esc(N(f.owner)) + '的电脑' + esc(st ? st.reaction : '') + '（第 ' + (f.step + 1) + ' 步）</dd></dl>';
    } else src = '<p class="hint">' + esc(N(f.owner)) + '手头的任务单，这件事从这里开始。</p>';
    var canConfirm = !demo && f.kind === 'artifact' && c.steps[s.idx].kind === 'confirm' && !s.halt && !s.cur.accepted;
    return head(esc(f.name)) + '<div class="sh-body"><div class="paper"><h4>' + esc(f.name) + '</h4><p>' + esc(f.body) + '</p>' + valuesTable(f) + '</div><h3>来源</h3>' + src +
      (canConfirm ? '<button class="btn primary big" data-a="act" data-close="1">' + esc(c.steps[s.idx].action) + '</button>' : '') +
      (f.kind === 'artifact' && s.accepted ? '<p><span class="chip ' + (s.accepted.by === 'demo' ? 'sig' : 'ok') + '">' + (s.accepted.by === 'demo' ? '模拟验收' : '你已验收') + '</span></p>' : '') + '</div>';
  }
  function pageHire() {
    var w = W(), c = C(), st = c.steps[w.state.idx], groups = { contacts: [], market: [], other: [] }, names = { contacts: '通讯录里的熟人', market: '临时工市场 · 适合这件事', other: '市场上的其他人' }, h = '';
    E.candidates(w).forEach(function (k) { groups[k.via].push(k); });
    ['contacts', 'market', 'other'].forEach(function (g) {
      if (!groups[g].length) return; h += '<h3>' + names[g] + '</h3>';
      groups[g].forEach(function (k) {
        h += '<div class="card"><div class="top">' + face(k.id, 'sm') + '<div><b>' + esc(N(k.id)) + '</b><br><small>' + esc(E.skillsOf(w, k.id)) + '</small></div><button class="btn ' + (g === 'other' ? '' : 'primary') + '" data-a="hire" data-id="' + k.id + '">' + (g === 'contacts' ? '直接邀请' : '请来帮忙') + '</button></div>' +
          (k.note ? '<div><span class="chip ok">备注</span> ' + esc(k.note) + '</div>' : '') + '</div>';
      });
    });
    return head('给' + esc(N(c.owner)) + '找帮手') + '<div class="sh-body"><p>要交办的事：' + esc(st.message) + '</p><p class="hint">请来只建立这一次的委托，够交办和回传结果。之后想长期联系，办完再点「留下」。</p>' + h + '</div>';
  }
  function pageRel(pg) {
    var w = W(), s = w.state, c = C(), a = pg.id, b = pg.b, kn = E.knows(w, a, b), com = s.hired && E.pairKey(a, b) === E.pairKey(c.owner, s.hired);
    function dir(x, y) { return '<label class="sw"><span>' + esc(N(x)) + ' 可以发给 ' + esc(N(y)) + '</span><input type="checkbox" id="g-' + x + '-' + y + '" data-c="grant" data-id="' + x + '" data-b="' + y + '"' + (E.granted(w, x, y) ? ' checked' : '') + (kn ? dis() : ' disabled') + '></label>'; }
    return head(esc(N(a)) + ' 和 ' + esc(N(b))) + '<div class="sh-body">' + lockNote() +
      '<h3>知道怎么联系</h3><p>' + (kn ? '<span class="chip ok">有联系方式</span> 画布上的虚线就是这个意思。' : '<span class="chip sig">仅本次委托</span> 两人没有互留联系方式。') + '</p>' +
      '<h3>获准发消息</h3><div>' + dir(a, b) + dir(b, a) + '</div>' + (com ? '<p class="hint">这次委托期间，交办和回传结果不受上面开关限制。</p>' : '') +
      '<h3>这件事里真的发过</h3><div class="row"><button class="btn" data-a="thread" data-id="' + a + '" data-b="' + b + '">' + esc(N(a)) + ' → ' + esc(N(b)) + '：' + countMsgs(w, a, b) + ' 条</button><button class="btn" data-a="thread" data-id="' + b + '" data-b="' + a + '">' + esc(N(b)) + ' → ' + esc(N(a)) + '：' + countMsgs(w, b, a) + ' 条</button></div></div>';
  }
  function pageLog() {
    var w = W();
    return head('经过') + '<div class="sh-body"><p class="hint">每一行是一次实际发生的事件，手机往来、电脑材料和进度都从这里来。</p><div class="log">' + (w.state.log.map(function (ev) { return '<div><i>' + ev.seq + '</i><span>' + esc(E.describe(w, ev)) + '</span></div>'; }).join('') || '<p class="hint">还没有开始。</p>') + '</div></div>';
  }
  function pageRuns() {
    var h = '<h3>已有的事项</h3>';
    data.runs.forEach(function (r) {
      var c = dsl.cases.find(function (x) { return x.id === r.caseId; }), s = E.reduce(c, r.events), st = c.steps[s.idx];
      h += '<button class="filebtn" data-a="switch" data-id="' + r.id + '"><div><b>' + esc(c.title) + ' · 第 ' + r.n + ' 轮</b><small>' + esc(st.status) + ' · ' + s.messages.length + ' 条消息 · ' + s.files.length + ' 份材料</small></div>' + (r.id === real.run.id ? '<span class="chip">当前</span>' : '') + '</button>';
    });
    h += '<h3>新开一轮</h3>' + dsl.cases.map(function (c) { return '<button class="filebtn" data-a="newrun" data-id="' + c.id + '"><div><b>' + esc(c.title) + '</b><small>' + esc(c.headline) + ' · ' + esc(N(c.owner)) + '负责</small></div></button>'; }).join('');
    return head('事项') + '<div class="sh-body">' + h + '<p class="hint">联系人备注、发送许可和电脑习惯跟着 Bot 走；消息、材料和验收留在各自事项里。</p></div>';
  }
  function pageScene() {
    var w = W(), s = w.state, c = C(), cur = s.cur, gate = E.nodeOf(c, 'gate'), sb = E.nodeOf(c, 'sandbox'), h = s.halt;
    var art = s.files.some(function (f) { return f.kind === 'artifact'; });
    var st = [cur.sent, cur.sent, cur.delivered, cur.working, s.lastCheck && s.lastCheck.ok, art, s.accepted];
    var pipe = E.PIPELINE.map(function (n, i) { var bad = (i === 0 && h && h.type === 'blocked') || (i === 3 && h && h.type === 'stalled') || (i === 4 && h && (h.type === 'checked' || h.type === 'held' || h.type === 'rejected')); return '<span class="chip ' + (bad ? 'warn' : st[i] ? 'ok' : 'mute') + '">' + (i + 1) + ' ' + n + '</span>'; }).join('');
    function fields(obj, kind) { return Object.keys(obj || {}).map(function (k) { return '<label class="sw"><span>' + esc(k) + '</span><input class="inp mono" style="width:120px" id="' + kind + '-' + esc(k) + '" data-c="' + kind + '" data-id="' + esc(k) + '" value="' + esc(JSON.stringify(obj[k])) + '"></label>'; }).join(''); }
    var body = '<p><span class="chip sig">本地模拟</span> 这一版没有连真实的沙盒和 Bot，下面的输出来自场景数据。改这里的值，演示和实际办理都会跟着变。</p>' +
      '<h3>这一步走到哪</h3><div class="pipe">' + pipe + '</div>';
    if (sb) body += '<h3>沙盒输出（通用工作，E2B 的位置）</h3><p class="hint">' + esc(sb.text) + '</p><div class="card">' + fields(sb.fixture, 'fx') + '</div>';
    if (gate) body += '<h3>栅栏要求（确定性规则）</h3><p class="hint">' + esc(gate.text) + '</p><div class="card">' + fields(gate.equals, 'gate') + '</div><pre>' + esc(E.gateSource(gate)) + '</pre>';
    if (s.lastCheck) body += '<h3>最近一次校验</h3><table><tr><th>核对项</th><th>要求</th><th>实际</th></tr>' + Object.keys(s.lastCheck.expected).map(function (k) { var bad = s.lastCheck.diffs.some(function (d) { return d.key === k; }); return '<tr><td>' + esc(k) + '</td><td>' + esc(E.show(s.lastCheck.expected[k])) + '</td><td class="' + (bad ? 'bad' : '') + '">' + esc(k in s.lastCheck.actual ? E.show(s.lastCheck.actual[k]) : '（缺失）') + (bad ? ' ✕' : ' ✓') + '</td></tr>'; }).join('') + '</table>';
    body += '<details><summary>VFS（' + Object.keys(s.vfs).length + ' 个文件）</summary><pre>' + esc(Object.keys(s.vfs).map(function (k) { return k + '\n  ' + (typeof s.vfs[k] === 'string' ? s.vfs[k] : JSON.stringify(s.vfs[k])); }).join('\n') || '空') + '</pre></details>' +
      '<details><summary>事件流（' + w.run.events.length + '）</summary><pre>' + esc(w.run.events.map(function (e) { return JSON.stringify(e); }).join('\n') || '空') + '</pre></details>' +
      '<details' + (ui.dslOpen ? ' open' : '') + '><summary>场景 DSL</summary><p class="hint">Bot、联系方式、发送许可、消息、接收后的动作、产物和检查条件都在这一份数据里。改完点应用。</p>' +
      '<textarea class="inp mono" id="dsltext" rows="14" spellcheck="false">' + esc(JSON.stringify(dsl, null, 1)) + '</textarea><div class="row"><button class="btn primary" data-a="dsl-apply">应用</button><button class="btn" data-a="dsl-reset">恢复默认场景</button><button class="btn" data-a="reset-all">清空全部进度和设置</button></div></details>';
    return head('现场') + '<div class="sh-body">' + body + '</div>';
  }
  function renderSheet(force) {
    var el = $('#sheet'), pg = ui.sheet[ui.sheet.length - 1], act = document.activeElement;
    if (!force && act && el.contains(act) && /INPUT|TEXTAREA/.test(act.tagName) && act.type !== 'checkbox') { ui.sheetDirty = true; return; }
    ui.sheetDirty = false; el.hidden = !pg; $('#scrim').hidden = !pg; if (!pg) return;
    var keep = el.querySelector('.sh-body'), top = !force && keep ? keep.scrollTop : 0;
    el.innerHTML = pg.t === 'bot' ? pageBot(pg) : pg.t === 'file' ? pageFile(pg) : pg.t === 'hire' ? pageHire() : pg.t === 'rel' ? pageRel(pg) : pg.t === 'log' ? pageLog() : pg.t === 'runs' ? pageRuns() : pageScene();
    var body = el.querySelector('.sh-body'); if (body) body.scrollTop = top;
  }
  function render() {
    renderTop(); renderHud(); renderCanvas(); renderSheet(false);
    var hh = $('#hud').offsetHeight; if (Math.abs(hh - (ui.hudH || hh)) > 24 && $('#canvas').clientWidth <= 760) fit(true); ui.hudH = hh;
  }
  var toastT;
  function toast(t) { var el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { el.hidden = true; }, 3200); }

  /* ---------- 推进 ---------- */
  function fired(ev) {
    if (!ev) return;
    ui.clock = 0; ui.hot = ev;
    if (ev.type === 'hired') ui.fresh[ev.bot] = 1;
    if (!demo) save();
    render();
  }
  function userAct(opts) { var before = cast(W()).length; var ev = E.act(W(), opts); if (ev && cast(W()).length > before) cast(W()).forEach(function (id) { if (!L.pos[id]) ui.fresh[id] = 1; }); fired(ev); return ev; }
  function startDemo() { demo = E.demoWorld(dsl, real.run.caseId); ui.demoEnd = null; ui.paused = false; ui.clock = 0; ui.hot = null; ui.sheet = []; ui.level = 'doing'; ui.fresh = {}; ui.fold = $('#canvas').clientWidth <= 760; render(); }
  function exitDemo() { demo = null; ui.fold = false; ui.demoEnd = null; ui.paused = false; ui.clock = 0; ui.hot = null; ui.sheet = []; render(); }
  var last = 0;
  function frame(ts) {
    var dt = Math.min(100, ts - last || 0); last = ts;
    var w = W(), p = E.plan(w);
    if (!ui.paused && !ui.demoEnd) {
      if (p && !p.user) { ui.clock += dt; if (ui.clock >= p.delay) fired(E.advance(w)); }
      else if (demo && p && p.user) {
        if (w.state.halt) { ui.demoEnd = 'stuck'; render(); }
        else { ui.clock += dt; if (ui.clock >= 1300) { cast(w).forEach(function (id) { if (L && !L.pos[id]) ui.fresh[id] = 1; }); fired(E.act(w, { bot: E.caseOf(w).market[0] })); } }
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
    act: function (d) { var o = d.o ? (function () { var x = {}; x[d.o] = true; return x; })() : undefined; if (d.close) closeSheet(); var ev = userAct(o); if (ev && ev.type === 'blocked') toast('没发出去，原因写在事项卡上。'); },
    bot: function (d) { open({ t: 'bot', id: d.id, tab: 'phone' }); }, phone: function (d) { open({ t: 'bot', id: d.id, tab: 'phone' }); }, pc: function (d) { open({ t: 'bot', id: d.id, tab: 'pc' }); },
    tab: function (d) { var pg = ui.sheet[ui.sheet.length - 1]; pg.tab = d.id; renderSheet(true); },
    thread: function (d) { open({ t: 'bot', id: d.id, tab: 'phone', thread: d.b }); },
    file: function (d) { open({ t: 'file', id: d.id }); }, rel: function (d) { open({ t: 'rel', id: d.id, b: d.b }); },
    log: function () { open({ t: 'log' }); }, scene: function () { open({ t: 'scene' }); }, runs: function () { if (demo) exitDemo(); open({ t: 'runs' }); },
    'hire-open': function () { open({ t: 'hire' }); },
    hire: function (d) { closeSheet(); ui.fresh[d.id] = 1; fired(E.act(W(), { bot: d.id })); },
    back: function () { ui.sheet.pop(); renderSheet(true); }, close: closeSheet,
    level: function (d) { ui.level = d.id; render(); }, fit: function () { fit(true); }, zin: function () { zoomBy(1.25); }, zout: function () { zoomBy(.8); },
    hud: function () { ui.fold = false; renderHud(); }, fold: function () { ui.fold = !ui.fold; renderHud(); fit(true); },
    redeliver: function (d) { var ev = E.redeliver(real, d.id); save(); render(); toast(ev && ev.type === 'dedup' ? '同一次投递，没有生成第二份收件。' : '已重投。'); },
    keep: function () { var s = real.state, note = $('#keepnote').value.trim(); if (E.keep(real, s.hired, note)) { save(); render(); toast('已留下' + N(s.hired) + '。日后能不能自由发消息，在手机里单独决定。'); } },
    newrun: function (d) { var n = data.runs.filter(function (r) { return r.caseId === d.id; }).length + 1, run = E.newRun(dsl, d.id, n); data.runs.push(run); A['switch']({ id: run.id }); },
    'switch': function (d) { var run = data.runs.find(function (r) { return r.id === d.id; }); real = E.makeWorld(dsl, data.book, run, 'real'); ui.clock = 0; ui.hot = null; ui.paused = false; ui.sheet = []; ui.castKey = ''; save(); render(); },
    'dsl-apply': function () { try { var next = E.validate(JSON.parse($('#dsltext').value)); data.dsl = next; save(); boot(); ui.castKey = ''; ui.sheet = []; render(); toast('已按新的场景数据重建画布。'); } catch (e) { toast('这份数据用不了：' + e.message); } },
    'dsl-reset': function () { data.dsl = null; save(); boot(); ui.castKey = ''; ui.sheet = []; render(); toast('已恢复默认场景。'); },
    'reset-all': function () { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } boot(); ui.castKey = ''; ui.sheet = []; render(); toast('已清空，回到第一次打开的样子。'); }
  };
  var CH = {
    grant: function (d, el) { real.book.grants[d.id + '>' + d.b] = el.checked; toast(N(d.id) + (el.checked ? '现在可以' : '不能再') + '发给' + N(d.b) + '。联系方式不受影响。'); },
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
    CH[el.dataset.c](el.dataset, el); save(); renderTop(); renderHud(); renderCanvas();
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
  window.addEventListener('resize', function () { fit(false); });

  boot(); ui.fold = false; render(); fit(false);
  requestAnimationFrame(frame);
  window.__matter = { get real() { return real; }, get demo() { return demo; }, ui: ui, E: E };
})();
