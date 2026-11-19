/* 老板看员工：一列员工 → 这个人的手机（聊天记录）和电脑（做过的事）。数据来自引擎跑完一遍示例事项。 */
(function () {
  'use strict';
  var E = window.MatterEngine, dsl = E.validate(E.clone(window.MATTER_DSL));
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m14.500 5-7 7 7 7"/></svg>';
  var GO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9.500 5 7 7-7 7"/></svg>';

  var c = dsl.cases[0], w = E.makeWorld(dsl, E.emptyBook(), E.newRun(dsl, c.id, 1, 'run'), 'real');
  E.settle(w, function () { return { bot: c.market[0] }; });
  var s = w.state, stack = [{ p: 'staff' }];
  var team = E.botOf(w, c.owner).team, staff = dsl.bots.filter(function (b) { return b.team === team || b.id === s.hired; }).map(function (b) { return b.id; });

  function N(id) { return E.nameOf(w, id); }
  function av(id, cls) { var b = E.botOf(w, id), t = b && dsl.teams.find(function (x) { return x.id === b.team; }); return '<span class="av ' + (cls || '') + '"' + (t ? ' style="--tc:' + t.color + '"' : '') + '>' + esc(N(id).slice(-1)) + '</span>'; }
  function between(a, b) { return s.messages.filter(function (m) { return (m.from === a && m.to === b) || (m.from === b && m.to === a); }); }
  function chatsOf(id) { var o = []; s.messages.forEach(function (m) { var x = m.from === id ? m.to : m.to === id ? m.from : null; if (x && o.indexOf(x) < 0) o.push(x); }); return o; }
  function jobsOf(id) { return s.files.filter(function (f) { return f.owner === id && f.kind !== 'submission'; }); }
  function nav(title) { return '<div class="nav">' + (stack.length > 1 ? '<button data-go="back" aria-label="返回">' + BACK + '</button>' : '<i></i>') + '<h1>' + esc(title) + '</h1><i></i></div>'; }
  function cell(go, left, title, sub, right) { return '<button class="cell' + (left ? ' a' : '') + '" data-go=\'' + esc(JSON.stringify(go)) + '\'>' + left + '<span class="t"><b>' + esc(title) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</span><span class="r">' + esc(right || '') + GO + '</span></button>'; }

  var PAGE = {
    staff: function () {
      var busy = staff.filter(function (id) { return jobsOf(id).length; }), idle = staff.filter(function (id) { return !jobsOf(id).length; });
      return nav('员工') + '<div class="cells">' + busy.concat(idle).map(function (id) {
        var j = jobsOf(id).pop();
        return cell({ p: 'one', id: id }, av(id), N(id), j ? '刚做完：' + c.steps[j.step].reaction : E.skillsOf(w, id), '');
      }).join('') + '</div>';
    },
    one: function (g) {
      return nav(N(g.id)) + '<div class="cells"><div class="cell big a">' + av(g.id, 'l') + '<span class="t"><b>' + esc(N(g.id)) + '</b><span>' + esc(E.skillsOf(w, g.id)) + '</span></span></div></div>' +
        '<div class="cells">' + cell({ p: 'phone', id: g.id }, '', '手机', '', chatsOf(g.id).length + ' 个聊天') + cell({ p: 'pc', id: g.id }, '', '电脑', '', jobsOf(g.id).length + ' 件事') + '</div>';
    },
    phone: function (g) {
      var list = chatsOf(g.id);
      return nav(N(g.id) + '的手机') + (list.length ? '<div class="cells">' + list.map(function (o) { return cell({ p: 'chat', id: g.id, o: o }, av(o), N(o), between(g.id, o).pop().text, ''); }).join('') + '</div>' : '<p class="none">还没有聊天记录</p>');
    },
    chat: function (g) {
      return nav(N(g.o)) + '<div class="chat">' + between(g.id, g.o).map(function (m) { var me = m.from === g.id; return '<div class="line' + (me ? ' me' : '') + '">' + av(m.from, 's') + '<div class="msg">' + esc(m.text) + '</div></div>'; }).join('') + '</div>' +
        '<p class="foot">你在看' + esc(N(g.id)) + '的手机，绿色是' + esc(N(g.id)) + '发的</p>';
    },
    pc: function (g) {
      var list = jobsOf(g.id);
      return nav(N(g.id) + '的电脑') + (list.length ? '<div class="cells">' + list.slice().reverse().map(function (f) { return cell({ p: 'job', id: g.id, f: f.id }, '', c.steps[f.step].reaction, N(f.from) + '交办', '已完成'); }).join('') + '</div>' : '<p class="none">还没有做过事</p>');
    },
    job: function (g) {
      var f = s.files.find(function (x) { return x.id === g.f; }), st = c.steps[f.step], vals = Object.keys(f.values || {});
      return nav(st.reaction) + '<div class="cells"><div class="cell text"><small>' + esc(N(f.from)) + '说</small>' + esc(st.message) + '</div></div>' +
        '<div class="cells"><div class="cell text"><small>交出的材料</small><b>' + esc(f.name) + '</b>' + esc(f.body) + '</div>' +
        vals.map(function (k) { return '<div class="cell"><span class="t"><b>' + esc(k) + '</b></span><span class="r">' + esc(E.show(f.values[k])) + '</span></div>'; }).join('') + '</div>';
    }
  };
  function draw() { var g = stack[stack.length - 1]; document.getElementById('app').innerHTML = PAGE[g.p](g); window.scrollTo(0, 0); }
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-go]'); if (!el) return;
    if (el.dataset.go === 'back') stack.pop(); else stack.push(JSON.parse(el.dataset.go));
    draw();
  });
  draw();
})();
