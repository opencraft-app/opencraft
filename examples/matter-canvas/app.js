/* 老板看员工：消息列表 → 和某位员工的对话（他的汇报）→ 名片 → 他的手机（聊天记录）和电脑（做过的事）。数据来自引擎跑完一遍示例事项。 */
(function () {
  'use strict';
  var E = window.MatterEngine, dsl = E.validate(E.clone(window.MATTER_DSL));
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  function svg(d) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; }
  var BACK = svg('<path d="m14.500 5-7 7 7 7"/>'), GO = svg('<path d="m9.500 5 7 7-7 7"/>'), MORE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.700"/><circle cx="12" cy="12" r="1.700"/><circle cx="19" cy="12" r="1.700"/></svg>';
  var TABS = [['msgs', '消息', svg('<path d="M12 4.500c-4.700 0-8.500 3.100-8.500 7 0 2.200 1.200 4.100 3.100 5.400L6 20l3.400-1.600c.8.200 1.700.300 2.600.300 4.700 0 8.500-3.100 8.500-7s-3.800-7.200-8.500-7.200z"/>')],
    ['book', '通讯录', svg('<circle cx="9.500" cy="8.500" r="3.500"/><path d="M3 19.500c.600-3.400 3.200-5.500 6.500-5.500s5.900 2.100 6.500 5.500M17 9h4M17 12.500h4M18.500 16h2.500"/>')],
    ['feed', '动态', svg('<circle cx="12" cy="12" r="8.500"/><path d="m15.500 8.500-2 5-5 2 2-5z"/>')],
    ['me', '我', svg('<circle cx="12" cy="8.500" r="4"/><path d="M4 20c.800-3.800 4-6 8-6s7.200 2.200 8 6"/>')]];

  var c = dsl.cases[0], w = E.makeWorld(dsl, E.emptyBook(), E.newRun(dsl, c.id, 1, 'run'), 'real');
  E.settle(w, function () { return { bot: c.market[0] }; });
  var s = w.state, tab = 'msgs', stack = [], seen = {};
  var staff = [c.owner, c.peer, s.hired];

  function N(id) { return E.nameOf(w, id); }
  function av(id, cls, dot) { var b = E.botOf(w, id), t = b && dsl.teams.find(function (x) { return x.id === b.team; }); return '<span class="av ' + (cls || '') + '"' + (t ? ' style="--tc:' + t.color + '"' : '') + '>' + esc(id === 'user' ? '老' : N(id).slice(-1)) + (dot ? '<u></u>' : '') + '</span>'; }
  function clock(step, add) { var m = 5 + step * 6 + (add || 0); return '22:' + ('0' + m).slice(-2); }
  function between(a, b) { return s.messages.filter(function (m) { return (m.from === a && m.to === b) || (m.from === b && m.to === a); }); }
  function chatsOf(id) { var o = []; s.messages.forEach(function (m) { var x = m.from === id ? m.to : m.to === id ? m.from : null; if (x && o.indexOf(x) < 0) o.push(x); }); return o; }
  function jobsOf(id) { return s.files.filter(function (f) { return f.owner === id && f.kind !== 'submission'; }); }
  function did(f) { return c.steps[f.step].reaction; }
  function nav(title, right) { return '<div class="nav">' + (stack.length ? '<button data-go="back" aria-label="返回">' + BACK + '</button>' : '<i></i>') + '<h1>' + esc(title) + '</h1>' + (right || '<i></i>') + '</div>'; }
  function go(o) { return ' data-go=\'' + esc(JSON.stringify(o)) + '\''; }
  function cell(o, left, title, sub, right) { return '<button class="cell' + (left ? ' a' : '') + '"' + go(o) + '>' + left + '<span class="t"><b>' + esc(title) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</span><span class="r">' + esc(right || '') + GO + '</span></button>'; }
  function unread() { return staff.filter(function (id) { return !seen[id]; }).length; }

  var PAGE = {
    msgs: function () {
      var rows = staff.slice().sort(function (a, b) { return jobsOf(b).pop().step - jobsOf(a).pop().step; }).map(function (id) {
        var j = jobsOf(id).pop();
        return '<button class="cell chatrow"' + go({ p: 'talk', id: id }) + '>' + av(id, 'x', !seen[id]) + '<span class="t"><b>' + esc(N(id)) + '</b><span>' + esc(did(j)) + '，做好了。</span></span><time>' + clock(j.step, 2) + '</time></button>';
      }).join('');
      return nav('消息' + (unread() ? ' (' + unread() + ')' : '')) + '<div class="body"><div class="cells">' + rows + '</div></div>';
    },
    book: function () {
      return nav('通讯录') + '<div class="body">' + dsl.teams.map(function (t) {
        return '<div class="sec">' + esc(t.name) + '</div><div class="cells">' + dsl.bots.filter(function (b) { return b.team === t.id; }).map(function (b) { return '<button class="cell a"' + go({ p: 'one', id: b.id }) + '>' + av(b.id) + '<span class="t"><b>' + esc(b.name) + '</b></span></button>'; }).join('') + '</div>';
      }).join('') + '<p class="foot">' + dsl.bots.length + ' 位员工</p></div>';
    },
    feed: function () {
      var jobs = s.files.filter(function (f) { return f.kind !== 'submission'; }).slice().reverse();
      return nav('动态') + '<div class="body"><div class="cells">' + jobs.map(function (f) {
        return '<button class="cell a"' + go({ p: 'job', f: f.id }) + '>' + av(f.owner) + '<span class="t"><b>' + esc(N(f.owner)) + '</b><span>' + esc(did(f)) + ' → ' + esc(f.name) + '</span></span><span class="r">' + clock(f.step, 2) + '</span></button>';
      }).join('') + '</div></div>';
    },
    me: function () {
      return nav('我') + '<div class="body"><div class="cells"><div class="cell big a"><span class="av l">我</span><span class="t"><b>老板</b><span>' + esc(c.title) + '</span></span></div></div><div class="gap"></div>' +
        '<div class="cells"><div class="cell"><span class="t"><b>员工</b></span><span class="r">' + dsl.bots.length + ' 位</span></div><div class="cell"><span class="t"><b>数据</b></span><span class="r">本地模拟，时间为示意</span></div></div></div>';
    },
    talk: function (g) {
      var items = jobsOf(g.id).map(function (f) { return { step: f.step, k: 1, f: f }; }).concat(between('user', g.id).map(function (m) { return { step: m.step, k: 0, m: m }; }));
      items.sort(function (a, b) { return a.step - b.step || a.k - b.k; });
      return nav(N(g.id), '<button' + go({ p: 'one', id: g.id }) + ' aria-label="' + esc(N(g.id)) + '的名片">' + MORE + '</button>') + '<div class="body"><div class="chat">' + items.map(function (it, i) {
        var t = i ? '' : '<span class="stamp">' + clock(it.step) + '</span>';
        if (it.m) return t + '<div class="line me"><span class="av">我</span><div class="msg">' + esc(it.m.text) + '</div></div>';
        return t + '<div class="line">' + av(g.id) + '<div class="msg">' + esc(did(it.f)) + '，做好了。</div></div><div class="line">' + av(g.id) + '<button class="file"' + go({ p: 'job', f: it.f.id }) + '><span><b>' + esc(it.f.name) + '</b><small>点开查看</small></span><i></i></button></div>';
      }).join('') + '</div><p class="foot">汇报由' + esc(N(g.id)) + '的工作记录生成。右上角可以看他的手机和电脑。</p></div>';
    },
    one: function (g) {
      return nav('') + '<div class="body"><div class="cells"><div class="cell big a">' + av(g.id, 'l') + '<span class="t"><b>' + esc(N(g.id)) + '</b><span>' + esc(E.skillsOf(w, g.id)) + '</span></span></div></div><div class="gap"></div>' +
        '<div class="cells">' + cell({ p: 'phone', id: g.id }, '', '手机', '', chatsOf(g.id).length + ' 个聊天') + cell({ p: 'pc', id: g.id }, '', '电脑', '', jobsOf(g.id).length + ' 件事') + '</div></div>';
    },
    phone: function (g) {
      var list = chatsOf(g.id);
      return nav(N(g.id) + '的手机') + '<div class="body">' + (list.length ? '<div class="cells">' + list.map(function (o) { var m = between(g.id, o).pop(); return '<button class="cell chatrow"' + go({ p: 'chat', id: g.id, o: o }) + '>' + av(o, 'x') + '<span class="t"><b>' + esc(o === 'user' ? '老板' : N(o)) + '</b><span>' + esc(m.text) + '</span></span><time>' + clock(m.step) + '</time></button>'; }).join('') + '</div>' : '<p class="none">还没有聊天记录</p>') + '</div>';
    },
    chat: function (g) {
      return nav(g.o === 'user' ? '老板' : N(g.o)) + '<div class="body"><div class="chat">' + between(g.id, g.o).map(function (m) { var me = m.from === g.id; return '<div class="line' + (me ? ' me' : '') + '">' + (m.from === 'user' ? '<span class="av">我</span>' : av(m.from)) + '<div class="msg">' + esc(m.text) + '</div></div>'; }).join('') + '</div>' +
        '<p class="foot">这是' + esc(N(g.id)) + '的手机，绿色是' + esc(N(g.id)) + '发的。</p></div>';
    },
    pc: function (g) {
      var list = jobsOf(g.id);
      return nav(N(g.id) + '的电脑') + '<div class="body">' + (list.length ? '<div class="cells">' + list.slice().reverse().map(function (f) { return cell({ p: 'job', f: f.id }, '', did(f), (f.from === 'user' ? '老板' : N(f.from)) + '交办', '已完成'); }).join('') + '</div>' : '<p class="none">还没有做过事</p>') + '</div>';
    },
    job: function (g) {
      var f = s.files.find(function (x) { return x.id === g.f; }), st = c.steps[f.step], vals = Object.keys(f.values || {});
      return nav(did(f)) + '<div class="body"><div class="cells"><div class="cell a">' + av(f.owner) + '<span class="t"><b>' + esc(N(f.owner)) + '</b><span>' + clock(f.step, 2) + ' 完成</span></span></div></div><div class="gap"></div>' +
        '<div class="cells"><div class="cell text"><small>' + esc(f.from === 'user' ? '老板' : N(f.from)) + '说</small>' + esc(st.message) + '</div></div><div class="gap"></div>' +
        '<div class="cells"><div class="cell text"><small>交出的材料</small><b>' + esc(f.name) + '</b>' + esc(f.body) + '</div>' +
        vals.map(function (k) { return '<div class="cell"><span class="t"><b>' + esc(k) + '</b></span><span class="r">' + esc(E.show(f.values[k])) + '</span></div>'; }).join('') + '</div></div>';
    }
  };
  function draw() {
    var g = stack[stack.length - 1], h = g ? PAGE[g.p](g) : PAGE[tab]();
    if (!g) h += '<div class="tabs">' + TABS.map(function (t) { return '<button data-tab="' + t[0] + '" aria-current="' + (t[0] === tab) + '">' + t[2] + t[1] + (t[0] === 'msgs' && unread() ? '<em>' + unread() + '</em>' : '') + '</button>'; }).join('') + '</div>';
    document.getElementById('app').innerHTML = h;
    var b = document.querySelector('.body'); if (b && g && (g.p === 'talk' || g.p === 'chat')) b.scrollTop = 1e6;
  }
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-go],[data-tab]'); if (!el) return;
    if (el.dataset.tab) tab = el.dataset.tab;
    else if (el.dataset.go === 'back') stack.pop();
    else { var o = JSON.parse(el.dataset.go); if (o.p === 'talk') seen[o.id] = 1; stack.push(o); }
    draw();
  });
  draw();
})();
