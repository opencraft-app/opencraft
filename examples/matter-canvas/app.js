/* 管理 Bot：选一个 Bot，看它的手机（联系人和聊天记录）和它的电脑（做过的任务和产出）。数据来自引擎跑完一遍示例事项。 */
(function () {
  'use strict';
  var E = window.MatterEngine, dsl = E.validate(E.clone(window.MATTER_DSL));
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  var c = dsl.cases[0], w = E.makeWorld(dsl, E.emptyBook(), E.newRun(dsl, c.id, 1, 'run'), 'real');
  E.settle(w, function () { return { bot: c.market[0] }; });
  var s = w.state, bots = [c.owner, c.peer, s.hired], sel = c.owner, chat = null;

  function N(id) { return E.nameOf(w, id); }
  function av(id) { return '<span class="av">' + esc(N(id).slice(-1)) + '</span>'; }
  function between(a, b) { return s.messages.filter(function (m) { return (m.from === a && m.to === b) || (m.from === b && m.to === a); }); }

  function drawBots() {
    $('#bots').innerHTML = bots.map(function (id) { return '<button data-a="bot" data-id="' + id + '" aria-pressed="' + (id === sel) + '">' + av(id) + esc(N(id)) + '</button>'; }).join('');
  }
  function drawPhone() {
    var h;
    if (chat) {
      var list = between(sel, chat);
      h = '<h2><button class="back" data-a="chat" data-id="" aria-label="返回">‹</button>' + esc(N(chat)) + '</h2><div class="msgs">' +
        (list.map(function (m) { return '<div class="msg' + (m.from === sel ? ' me' : '') + '">' + esc(m.text) + '</div>'; }).join('') || '<p class="none">还没有聊过。</p>') + '</div>';
    } else {
      var people = E.contactsOf(w, sel);
      bots.concat(sel === c.owner ? ['user'] : []).forEach(function (id) { if (id !== sel && people.indexOf(id) < 0 && between(sel, id).length) people.push(id); });
      people.sort(function (a, b) { return between(sel, b).length - between(sel, a).length; });
      h = '<h2>手机</h2>' + people.map(function (id) {
        var last = between(sel, id).pop();
        return '<button class="row" data-a="chat" data-id="' + id + '">' + av(id) + '<span class="t"><b>' + esc(N(id)) + '</b><span>' + esc(last ? last.text : E.skillsOf(w, id)) + '</span></span></button>';
      }).join('');
    }
    $('#phone').innerHTML = h;
  }
  function drawPc() {
    var files = s.files.filter(function (f) { return f.owner === sel && f.kind !== 'submission'; });
    $('#pc').innerHTML = '<h2>电脑</h2>' + (files.map(function (f) {
      var st = c.steps[f.step], vals = Object.keys(f.values || {}).map(function (k) { return k + '：' + E.show(f.values[k]); }).join('，');
      return '<details><summary>' + esc(st.reaction) + '<small>' + esc(N(f.from)) + '交办</small></summary><div><b>' + esc(f.name) + '</b><span>' + esc(f.body) + '</span>' + (vals ? '<span>' + esc(vals) + '</span>' : '') + '</div></details>';
    }).join('') || '<p class="none">还没有做过任务。</p>');
  }
  function draw() { drawBots(); drawPhone(); drawPc(); }
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-a]'); if (!el) return;
    if (el.dataset.a === 'bot') { sel = el.dataset.id; chat = null; draw(); } else { chat = el.dataset.id || null; drawPhone(); }
  });
  draw();
})();
