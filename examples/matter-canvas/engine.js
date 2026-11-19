/* 事项画布运行时：读取 DSL，先产生事件，再由事件归并出状态。不依赖 DOM，可在 Node 中测试。 */
(function (root, factory) {
  root.MatterEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PIPELINE = ['满足发送条件', '发出', '送达', '接收方处理', '校验', '交付', '验收'];
  var DELAY = { flight: 2600, work: 1500, settle: 500, hire: 1100, check: 1500, submit: 800, user: 350 };
  var ONCE = { sent: 1, delivered: 1, file: 1, submitted: 1, hired: 1, accepted: 1, working: 1 };

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }
  function emptyBook() { return { grants: {}, contacts: [], notes: {}, comp: {}, skills: {} }; }

  function caseOf(w) { return w.dsl.cases.find(function (c) { return c.id === w.run.caseId; }); }
  function botOf(w, id) { return w.dsl.bots.find(function (b) { return b.id === id; }); }
  function nameOf(w, id) { if (id === 'user') return '你'; var b = botOf(w, id); return b ? b.name : id; }
  function nodeOf(c, kind) { return (c.nodes || []).find(function (n) { return n.kind === kind; }); }

  function knows(w, a, b) {
    var k = pairKey(a, b);
    return w.book.contacts.indexOf(k) >= 0 || w.dsl.contacts.some(function (p) { return pairKey(p[0], p[1]) === k; });
  }
  function granted(w, a, b) {
    var k = a + '>' + b;
    if (k in w.book.grants) return !!w.book.grants[k];
    return w.dsl.grants.some(function (g) { return g[0] === a && g[1] === b; });
  }
  function comp(w, id) {
    var b = botOf(w, id), base = (b && b.devices && b.devices.computer) || {};
    return Object.assign({ work: true, send: true, hire: true, review: '' }, base, w.book.comp[id] || {});
  }
  function skillsOf(w, id) { var b = botOf(w, id); return id in w.book.skills ? w.book.skills[id] : (b ? b.skills : ''); }
  function contactsOf(w, id) {
    return w.dsl.bots.map(function (b) { return b.id; }).filter(function (o) { return o !== id && knows(w, id, o); });
  }

  /* 叮嘱：「必须包含：X」是确定性规则；其余自然语言交给人确认。 */
  function parseReview(text) {
    var must = [], free = [];
    String(text || '').split(/[\n；;。]/).forEach(function (line) {
      line = line.trim(); if (!line) return;
      var m = line.match(/^必须包含\s*[：:]\s*(.+)$/);
      if (m) m[1].split(/[、,，]/).forEach(function (t) { t = t.trim(); if (t) must.push(t); });
      else free.push(line);
    });
    return { must: must, free: free.join('；') };
  }

  function digest(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ('0000' + (h >>> 0).toString(16)).slice(-4); }

  function runGate(gate, vfs) {
    if (!gate) return { ok: true, diffs: [], expected: {}, actual: {} };
    var out = vfs['/sandbox/output.json'], expected = gate.equals || {}, diffs = [];
    if (gate.js) {
      try {
        var r = new Function('vfs', 'expect', gate.js)(vfs, expected);
        if (r !== true) diffs.push({ key: '自定义检查', expected: '通过', actual: r === false || r == null ? '未通过' : String(r) });
      } catch (e) { diffs.push({ key: '自定义检查', expected: '可执行', actual: '规则出错：' + e.message }); }
    }
    Object.keys(expected).forEach(function (k) {
      var a = out ? out[k] : undefined;
      if (a !== expected[k]) diffs.push({ key: k, expected: expected[k], actual: a === undefined ? '（缺失）' : a });
    });
    return { ok: !diffs.length, diffs: diffs, expected: clone(expected), actual: out ? clone(out) : {} };
  }
  function gateSource(gate) {
    if (!gate) return '';
    return 'const out = vfs["/sandbox/output.json"];\n' + Object.keys(gate.equals || {}).map(function (k) {
      return 'check(out[' + JSON.stringify(k) + '] === ' + JSON.stringify(gate.equals[k]) + ');';
    }).join('\n') + (gate.js ? '\n// 自定义\n' + gate.js : '');
  }

  /* ---------- 事件归并 ---------- */
  function initial() {
    return { idx: 0, cur: {}, hired: null, hiredVia: null, messages: [], files: [], vfs: {}, halt: null, working: null,
      accepted: null, revisions: [], lastCheck: null, kept: null, log: [] };
  }
  function resolve(s, id) { return id === 'contract' ? s.hired : id; }

  function apply(s, ev, c) {
    var m;
    s.log.push(ev);
    switch (ev.type) {
      case 'blocked': case 'stalled': case 'held': case 'askhuman': case 'rejected':
        s.halt = ev; break;
      case 'hired': s.hired = ev.bot; s.hiredVia = ev.via; s.cur.hired = true; s.halt = null; break;
      case 'sent':
        s.cur.sent = true; s.halt = null;
        s.messages.push({ id: ev.delivery, step: ev.step, from: ev.from, to: ev.to, text: ev.text, envelope: ev.envelope, state: 'sent', seq: ev.seq });
        break;
      case 'delivered':
        s.cur.delivered = true; m = s.messages.find(function (x) { return x.id === ev.delivery; }); if (m) m.state = 'delivered'; break;
      case 'working': s.cur.working = true; s.halt = null; s.working = { operator: ev.operator, reaction: ev.reaction, input: ev.input }; break;
      case 'sandbox':
        s.cur.sandbox = true; s.halt = null; s.vfs['/sandbox/output.json'] = ev.output;
        s.working = { operator: ev.operator, reaction: ev.text, input: '沙盒（模拟）' }; break;
      case 'checked':
        s.lastCheck = ev; s.working = null;
        if (ev.ok) { s.cur.checked = true; s.halt = null; } else { s.cur.sandbox = false; s.halt = ev; }
        break;
      case 'revised': s.revisions.push(ev.term); s.halt = null; break;
      case 'humanok': s.cur.humanOk = s.cur.humanOk || {}; s.cur.humanOk[ev.by] = true; s.halt = null; break;
      case 'submitted':
        s.cur.submitted = true; s.halt = null;
        s.files.push({ id: ev.delivery + '/submit', step: ev.step, owner: ev.operator, name: ev.name, body: ev.body, kind: 'submission', version: ev.version, input: '沙盒输出', values: ev.values });
        s.vfs['/' + ev.operator + '/' + ev.name] = ev.body; break;
      case 'accepted': s.accepted = { by: ev.by }; s.cur.accepted = true; s.halt = null; break;
      case 'file':
        s.files.push({ id: ev.delivery + '/file', step: ev.step, owner: ev.operator, name: ev.name, body: ev.body, input: ev.input, from: ev.from,
          kind: ev.kind, version: ev.version, values: ev.values, expected: ev.expected, submitter: ev.submitter });
        s.vfs['/' + ev.operator + '/' + ev.name] = ev.body;
        s.working = null; s.idx += 1; s.cur = {}; s.halt = null; break;
      case 'kept': s.kept = { bot: ev.bot, note: ev.note }; break;
      default: break; /* dedup 等只进入记录 */
    }
    return s;
  }
  function reduce(c, events) { var s = initial(); events.forEach(function (e) { apply(s, e, c); }); return s; }

  /* ---------- 世界 ---------- */
  function newRun(dsl, caseId, n, id) { return { id: id || 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1e3), caseId: caseId, n: n || 1, events: [] }; }
  function makeWorld(dsl, book, run, mode) {
    var w = { dsl: dsl, book: book || emptyBook(), run: run, mode: mode || 'real' };
    w.state = reduce(caseOf(w), run.events);
    return w;
  }
  function demoWorld(dsl, caseId) { return makeWorld(dsl, emptyBook(), newRun(dsl, caseId, 0, 'demo'), 'demo'); }

  function emit(w, ev) {
    var s = w.state;
    ev.step = ev.step == null ? s.idx : ev.step;
    ev.delivery = ev.delivery || w.run.id + '#' + (ev.step + 1);
    if (ONCE[ev.type] && w.run.events.some(function (e) { return e.type === ev.type && e.delivery === ev.delivery; })) {
      ev = { type: 'dedup', of: ev.type, delivery: ev.delivery, step: ev.step };
    }
    ev.seq = w.run.events.length + 1;
    w.run.events.push(ev);
    apply(s, ev, caseOf(w));
    return ev;
  }

  function precheck(w, st, src, tgt) {
    if (src === 'user') return null;
    var s = w.state, c = caseOf(w), A = nameOf(w, src), B = nameOf(w, tgt);
    var commission = s.hired && pairKey(src, tgt) === pairKey(c.owner, s.hired);
    if (!commission && !knows(w, src, tgt)) return { reason: 'contact', text: A + '没有' + B + '的联系方式，消息无处可发。' };
    if (!comp(w, src).send) return { reason: 'device', text: A + '的电脑关掉了「对外发消息」，这一步停在发出之前。' };
    if (!commission && !granted(w, src, tgt)) return { reason: 'grant', text: A + '有' + B + '的联系方式，但没获准向' + B + '的收件会话发消息。' + B + '的手机没有新消息。' };
    return null;
  }

  function deliverText(w, st) {
    var extra = w.state.revisions.map(function (t) { return '补充：已对照「' + t + '」。'; }).join('');
    return { message: st.message + extra, body: st.desktop.body + extra };
  }
  function versionOf(w, st) { var t = deliverText(w, st); return 'v' + (w.state.revisions.length + 1) + '·' + digest(t.message + t.body + JSON.stringify(w.state.vfs['/sandbox/output.json'] || {})); }

  /* 计算下一步：返回 {user, delay, label, make(opts)}；make 只产生一个事件。 */
  function plan(w) {
    var c = caseOf(w), s = w.state, st = c.steps[s.idx];
    if (!st || st.kind === 'done') return null;
    var cur = s.cur, src = resolve(s, st.source), tgt = resolve(s, st.target), op = resolve(s, st.desktop.operator);
    var first = !Object.keys(cur).length;
    var mv;
    function ev(delay, make) { return { delay: delay, make: make }; }

    if (st.kind === 'hire' && !cur.hired) {
      mv = ev(0, function (o) {
        if (!comp(w, c.owner).hire) return { type: 'blocked', reason: 'hire', from: c.owner, text: nameOf(w, c.owner) + '的电脑关掉了「找帮手」，没法发起委托。' };
        var bot = (o && o.bot) || c.market[0];
        return { type: 'hired', bot: bot, via: knows(w, c.owner, bot) ? 'contacts' : 'market', text: st.message };
      });
    } else if (st.kind === 'deliver' && !cur.checked) {
      if (!cur.sandbox) mv = ev(DELAY.settle, function () {
        if (!comp(w, src).work) return { type: 'stalled', operator: src, text: nameOf(w, src) + '的电脑关掉了「处理文件」，核对没有开始。' };
        var sb = nodeOf(c, 'sandbox');
        return { type: 'sandbox', operator: src, text: sb ? sb.text : st.reaction, output: sb ? clone(sb.fixture) : {} };
      });
      else mv = ev(DELAY.check, function () { var r = runGate(nodeOf(c, 'gate'), s.vfs); r.type = 'checked'; return r; });
    } else if (st.kind === 'deliver' && !cur.submitted) {
      mv = ev(DELAY.submit, function (o) {
        o = o || {};
        var t = deliverText(w, st), text = t.message + ' ' + t.body, halt = s.halt, i, by, r, miss;
        if (halt && halt.type === 'held' && o.revise) return { type: 'revised', term: halt.term, by: halt.by };
        if (halt && halt.type === 'askhuman' && o.approve) return { type: 'humanok', by: halt.by };
        if (halt && halt.type === 'askhuman' && o.reject) return { type: 'rejected', by: halt.by, text: '你判断交付不符合叮嘱「' + halt.review + '」，退回返工。' };
        var who = [src, tgt];
        for (i = 0; i < who.length; i++) {
          by = who[i]; r = parseReview(comp(w, by).review);
          miss = r.must.filter(function (term) { return text.indexOf(term) < 0; })[0];
          if (miss) return { type: 'held', by: by, term: miss, text: nameOf(w, by) + '的叮嘱要求「必须包含：' + miss + '」，这份交付里没有，被拦下了。' };
          if (r.free && !(cur.humanOk && cur.humanOk[by])) return { type: 'askhuman', by: by, review: r.free, text: nameOf(w, by) + '交付前的叮嘱需要你来判断：「' + r.free + '」' };
        }
        return { type: 'submitted', operator: src, name: st.envelope + '（提交件）', body: t.message, version: versionOf(w, st), values: clone(s.vfs['/sandbox/output.json'] || {}) };
      });
    } else if (st.kind === 'confirm' && !cur.accepted) {
      mv = ev(0, function () { return { type: 'accepted', by: w.mode === 'demo' ? 'demo' : 'user' }; });
    } else if (!cur.sent) {
      mv = ev(st.kind === 'hire' ? DELAY.hire : DELAY.user, function () {
        var b = precheck(w, st, src, tgt);
        if (b) return { type: 'blocked', reason: b.reason, text: b.text, from: src, to: tgt };
        var text = st.kind === 'deliver' ? deliverText(w, st).message : st.message;
        return { type: 'sent', from: src, to: tgt, text: text, envelope: st.envelope };
      });
    } else if (!cur.delivered) {
      mv = ev(src === 'user' ? DELAY.settle : DELAY.flight, function () { return { type: 'delivered', from: src, to: tgt }; });
      mv.flight = src !== 'user';
    } else if (!cur.working) {
      mv = ev(DELAY.settle, function () {
        if (!comp(w, op).work) return { type: 'stalled', operator: op, text: nameOf(w, op) + '收到了消息，但电脑关掉了「处理文件」，「' + st.reaction + '」没有开始。' };
        return { type: 'working', operator: op, reaction: st.reaction, input: st.desktop.input };
      });
    } else {
      mv = ev(DELAY.work, function () {
        var f = { type: 'file', operator: op, name: st.desktop.file, body: st.desktop.body, input: st.desktop.input, from: src, kind: 'receipt' };
        if (st.kind === 'deliver') {
          f.body = deliverText(w, st).body; f.kind = 'artifact'; f.version = versionOf(w, st); f.submitter = src;
          f.values = clone(s.vfs['/sandbox/output.json'] || {}); f.expected = s.lastCheck ? s.lastCheck.expected : {};
        }
        return f;
      });
    }
    mv.user = first || !!s.halt;
    mv.label = st.action;
    return mv;
  }

  function act(w, opts) { var p = plan(w); if (!p || !p.user) return null; return emit(w, p.make(opts)); }
  function advance(w) { var p = plan(w); if (!p || p.user) return null; return emit(w, p.make()); }
  /* 重试同一次投递：不会生成第二份收件。 */
  function redeliver(w, delivery) {
    var m = w.state.messages.find(function (x) { return x.id === delivery; }); if (!m) return null;
    return emit(w, { type: 'delivered', delivery: delivery, step: m.step, from: m.from, to: m.to });
  }
  function settle(w, pick) { /* 测试用：把自动环节一口气走完 */
    var p, n = 0;
    while ((p = plan(w)) && n++ < 200) { if (p.user) { if (!pick) break; var o = pick(w); if (o === false) break; var e = act(w, o); if (!e || w.state.halt) break; } else advance(w); }
    return w;
  }

  function keep(w, bot, note) {
    if (w.mode !== 'real') return false;
    var c = caseOf(w), k = pairKey(c.owner, bot);
    if (w.book.contacts.indexOf(k) < 0 && !knows(w, c.owner, bot)) w.book.contacts.push(k);
    w.book.notes[c.owner + '>' + bot] = note || '';
    emit(w, { type: 'kept', bot: bot, note: note || '', step: w.state.idx });
    return true;
  }
  function candidates(w) {
    var c = caseOf(w), seen = {}, out = [];
    function add(id, via) { if (seen[id]) return; var b = botOf(w, id); if (!b || !b.available) return; seen[id] = 1; out.push({ id: id, via: via, note: w.book.notes[c.owner + '>' + id] || '' }); }
    contactsOf(w, c.owner).forEach(function (id) { add(id, 'contacts'); });
    (c.market || []).forEach(function (id) { add(id, 'market'); });
    w.dsl.bots.forEach(function (b) { add(b.id, 'other'); });
    return out;
  }

  function describe(w, ev) {
    var n = function (id) { return nameOf(w, id); }, fmt = function (o) { return Object.keys(o).map(function (k) { return k + '=' + show(o[k]); }).join('，'); };
    switch (ev.type) {
      case 'sent': return n(ev.from) + ' → ' + n(ev.to) + '：「' + ev.envelope + '」已发出，正在路上。';
      case 'delivered': return n(ev.to) + '的手机收到了' + n(ev.from) + '的消息。';
      case 'working': return n(ev.operator) + '的电脑开始：' + ev.reaction + '。';
      case 'file': return n(ev.operator) + '的电脑上多了一份「' + ev.name + '」' + (ev.version ? '（' + ev.version + '）' : '') + '。';
      case 'hired': return n(ev.bot) + (ev.via === 'contacts' ? '从通讯录接受邀请' : '从临时工市场接下委托') + '：' + ev.text;
      case 'sandbox': return n(ev.operator) + '在沙盒里执行（本地模拟）：' + ev.text;
      case 'checked': return ev.ok ? '栅栏校验通过：' + fmt(ev.actual) + '。' : '校验没过：' + ev.diffs.map(function (d) { return d.key + ' 应为 ' + show(d.expected) + '，实际是 ' + show(d.actual); }).join('；') + '。留在返工。';
      case 'revised': return n(ev.by) + '的叮嘱被照办：提交件补上了「' + ev.term + '」。';
      case 'humanok': return '你确认交付符合' + n(ev.by) + '的叮嘱，放行。';
      case 'submitted': return n(ev.operator) + '提交了「' + ev.name + '」（' + ev.version + '）。';
      case 'accepted': return ev.by === 'demo' ? '模拟验收：演示替你点了确认，实际办理不受影响。' : '你确认了这次交付。';
      case 'kept': return '你把' + n(ev.bot) + '留在了通讯录，备注「' + ev.note + '」。';
      case 'dedup': return '同一次投递被重试，没有生成第二份（' + ev.delivery + '）。';
      default: return ev.text || ev.type;
    }
  }
  function show(v) { return v === true ? '是' : v === false ? '否' : String(v); }

  function validate(dsl) {
    if (!dsl || !Array.isArray(dsl.bots) || !Array.isArray(dsl.cases) || !dsl.cases.length) throw new Error('需要 bots 和至少一个 cases');
    dsl.contacts = dsl.contacts || []; dsl.grants = dsl.grants || []; dsl.teams = dsl.teams || [];
    dsl.cases.forEach(function (c) {
      if (!c.id || !c.owner || !Array.isArray(c.steps)) throw new Error('事项缺少 id / owner / steps');
      if (!dsl.bots.some(function (b) { return b.id === c.owner; })) throw new Error('事项「' + c.title + '」的负责人 ' + c.owner + ' 不在 bots 里');
      c.market = c.market || []; c.nodes = c.nodes || [];
    });
    return dsl;
  }

  return { PIPELINE: PIPELINE, DELAY: DELAY, clone: clone, pairKey: pairKey, emptyBook: emptyBook, caseOf: caseOf, botOf: botOf, nameOf: nameOf, nodeOf: nodeOf,
    knows: knows, granted: granted, comp: comp, skillsOf: skillsOf, contactsOf: contactsOf, parseReview: parseReview, runGate: runGate, gateSource: gateSource,
    reduce: reduce, resolve: resolve, newRun: newRun, makeWorld: makeWorld, demoWorld: demoWorld, plan: plan, act: act, advance: advance, redeliver: redeliver,
    settle: settle, keep: keep, candidates: candidates, describe: describe, show: show, validate: validate };
});
