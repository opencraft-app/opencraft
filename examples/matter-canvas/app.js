/* 老板的三个标签：事情（待办，每件一个负责人）、员工（手机：在联系谁/能联系谁；电脑：在做什么/能做什么）、动态。
   这是结构原型：没有接真实的 Bot，所以不编造任何聊天、任务或进度，没有内容的地方如实显示为空。 */
(function () {
  'use strict';
  var KEY = 'opencraft.matter-canvas.v5';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  function svg(d) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; }
  var BACK = svg('<path d="m14.500 5-7 7 7 7"/>'), GO = svg('<path d="m9.500 5 7 7-7 7"/>'), DOTS = '<svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22" aria-hidden="true"><circle cx="5" cy="12" r="1.700"/><circle cx="12" cy="12" r="1.700"/><circle cx="19" cy="12" r="1.700"/></svg>';
  var TABS = [['things', '事情', svg('<rect x="4.500" y="4" width="15" height="16" rx="2.500"/><path d="m8 9.500 1.500 1.500L12 8.500M8 15l1.500 1.500L12 14M14.500 10h2M14.500 15.500h2"/>')],
    ['staff', '员工', svg('<path d="M12 4.500c-4.700 0-8.500 3.100-8.500 7 0 2.200 1.200 4.100 3.100 5.400L6 20l3.400-1.600c.8.200 1.700.300 2.600.300 4.700 0 8.500-3.100 8.500-7s-3.800-7.200-8.500-7.200z"/>')],
    ['feed', '动态', svg('<circle cx="12" cy="12" r="8.500"/><path d="m15.500 8.500-2 5-5 2 2-5z"/>')]];
  var KIND = { pc: ['电脑', '台', '例如：办公室的 Mac mini'], env: ['云环境', '个', '例如：测试环境沙盒'], conn: ['连接器', '个', '例如：飞书、邮箱、GitHub'] };
  var HUES = ['#4c7868', '#8471ac', '#ac734e', '#5a8397', '#b58239', '#7a6f9b', '#5f8a5a', '#a35d6a'];

  var db = { people: [], things: [], notes: [], res: { pc: [], env: [], conn: [] }, tab: 'things', n: 0 };
  try { var raw = JSON.parse(localStorage.getItem(KEY)); if (raw && raw.people) db = raw; } catch (e) { /* 没有存储也能用 */ }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ } }
  function uid(p) { db.n += 1; return p + db.n; }
  function P(id) { return db.people.filter(function (x) { return x.id === id; })[0]; }
  function T(id) { return db.things.filter(function (x) { return x.id === id; })[0]; }
  function N(id) { return id === 'me' ? '老板' : (P(id) || {}).name || '已移出的员工'; }
  function staff() { return db.people.filter(function (p) { return !p.gone; }); }
  function note(who, text, t) { db.notes.push({ ts: Date.now(), who: who, text: text, t: t || null }); }
  function open(t) { return t.state === 'open'; }
  function owned(id) { return db.things.filter(function (t) { return t.owner === id && open(t); }); }
  function status(t) { return t.state === 'done' ? ['已办完', 'ok'] : t.state === 'cancel' ? ['已取消', 'ok'] : !t.owner ? ['待分配负责人', 'you'] : ['在办', '']; }
  function canLine(p) { var a = []; if (p.pc) a.push('电脑'); if (p.env) a.push('云环境'); if (p.conn.length) a.push(p.conn.length + ' 个连接器'); return a.join(' · ') || '还没有分配'; }
  function hhmm(ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }

  var stack = [];
  function av(id, cls) { if (!id) return '<span class="av q ' + (cls || '') + '">?</span>'; if (id === 'me') return '<span class="av ' + (cls || '') + '">我</span>'; var p = P(id), i = db.people.indexOf(p); return '<span class="av ' + (cls || '') + '" style="--tc:' + HUES[(i < 0 ? 0 : i) % HUES.length] + '">' + esc(N(id).slice(-1)) + '</span>'; }
  function nav(title, right) { return '<div class="nav">' + (stack.length ? '<button data-go="back" aria-label="返回">' + BACK + '</button>' : '<i></i>') + '<h1>' + esc(title) + '</h1>' + (right ? '<button' + go(right) + ' aria-label="更多">' + DOTS + '</button>' : '<i></i>') + '</div>'; }
  function go(o) { return ' data-go=\'' + esc(JSON.stringify(o)) + '\''; }
  function cell(o, left, title, sub, right) { return '<button class="cell' + (left ? ' a' : '') + '"' + go(o) + '>' + left + '<span class="t"><b>' + esc(title) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</span><span class="r">' + esc(right || '') + GO + '</span></button>'; }
  function empty(title, text, btn) { return '<div class="none"><b>' + title + '</b><p>' + text + '</p>' + (btn || '') + '</div>'; }
  function todo(t) {
    var st = status(t), ok = st[1] === 'ok';
    return '<div class="cell todo' + (ok ? ' done' : '') + '"><button class="box" data-do="tick" data-t="' + t.id + '" aria-label="' + (ok ? '重新打开' : '标为办完') + '">' + (t.state === 'done' ? '✓' : '') + '</button><button class="t"' + go({ p: 'thing', t: t.id }) + '><b>' + esc(t.title) + '</b><span class="' + st[1] + '">' + st[0] + '</span></button>' +
      (t.owner ? '<span class="who">' + esc(N(t.owner)) + av(t.owner) + '</span>' : open(t) ? '<button class="pillb"' + go({ p: 'pick', t: t.id }) + '>分配</button>' : '') + '</div>';
  }
  function logRow(x) { var t = x.t && T(x.t); return '<div class="cell a">' + av(x.who) + '<span class="t"><b>' + esc(N(x.who)) + (x.showT && t ? ' <small>· ' + esc(t.title) + '</small>' : '') + '</b><span class="wrap">' + esc(x.text) + '</span></span><time>' + hhmm(x.ts) + '</time></div>'; }
  function personRow(p, sub) { return '<button class="cell a"' + go({ p: 'one', id: p.id }) + '>' + av(p.id) + '<span class="t"><b>' + esc(p.name) + '</b><span>' + esc(sub || p.role) + '</span></span></button>'; }

  var PAGE = {
    things: function () {
      var mine = db.things.filter(function (t) { return open(t) && !t.owner; }), out = db.things.filter(function (t) { return open(t) && t.owner; }), ended = db.things.filter(function (t) { return !open(t); });
      return nav('事情') + '<div class="body"><div class="newt"><input id="nt" placeholder="添加一件事…" aria-label="添加一件事"><button data-do="newthing">添加</button></div>' +
        (!db.things.length ? empty('还没有事情', '在上面写下一件要办的事，再交给一位员工负责。') :
          (mine.length ? '<div class="sec">要我出手的 ' + mine.length + '</div><div class="cells">' + mine.map(todo).join('') + '</div>' : '') +
          (out.length ? '<div class="sec">别人在办的 ' + out.length + '</div><div class="cells">' + out.map(todo).join('') + '</div>' : '') +
          (!mine.length && !out.length ? empty('没有在办的事', '都结束了。') : '') +
          (ended.length ? '<div class="gap"></div><div class="cells">' + cell({ p: 'ended' }, '', '已结束', '', ended.length + ' 件') + '</div>' : '')) + '</div>';
    },
    ended: function () { return nav('已结束') + '<div class="body"><div class="cells">' + db.things.filter(function (t) { return !open(t); }).map(todo).join('') + '</div></div>'; },
    thing: function (g) {
      var t = T(g.t), st = status(t), log = db.notes.filter(function (x) { return x.t === t.id; }).reverse();
      return nav(t.title, open(t) ? { p: 'tmore', t: t.id } : null) + '<div class="body"><div class="cells"><div class="cell text"><small><span class="st ' + st[1] + '">' + st[0] + '</span></small><b style="font-size:20px">' + esc(t.title) + '</b></div></div>' +
        (!open(t) ? '<div class="gap"></div>' : !t.owner ? '<div class="act"><button class="go"' + go({ p: 'pick', t: t.id }) + '>分配负责人</button></div>' : '<div class="act"><button class="go" data-do="tick" data-t="' + t.id + '">办完了，打勾</button></div>') +
        (t.owner ? '<div class="cells"><button class="cell a"' + go({ p: 'one', id: t.owner }) + '>' + av(t.owner) + '<span class="t"><b>' + esc(N(t.owner)) + '</b><span>负责人</span></span><span class="r">' + GO + '</span></button></div>' : '') +
        '<div class="sec">子事情</div>' + empty('还没有子事情', (t.owner ? esc(N(t.owner)) : '负责人') + '把一部分交给别人办时，会出现在这里，由他自己验收。') +
        '<div class="sec">经过</div>' + (log.length ? '<div class="cells">' + log.map(logRow).join('') + '</div>' : '') +
        (open(t) && t.owner ? '<p class="foot">' + esc(N(t.owner)) + '还没有动静。接上真实的 Bot 后，他说的话和交出的东西会出现在这里。</p>' : '') + '<div class="gap"></div></div>';
    },
    tmore: function (g) {
      var t = T(g.t);
      return nav(t.title) + '<div class="body"><div class="gap"></div><div class="cells">' + (t.owner ? cell({ p: 'pick', t: t.id }, '', '换一位负责人', '', '') : '') + '<button class="cell" data-do="cancel" data-t="' + t.id + '"><span class="t"><b class="warn">不办了，取消这件事</b></span></button></div></div>';
    },
    pick: function (g) {
      var t = T(g.t), list = staff();
      return nav('分配负责人') + '<div class="body"><div class="sec">' + esc(t.title) + '</div>' + (list.length ? '<div class="cells">' + list.map(function (p) { return '<button class="cell a" data-do="assign" data-t="' + t.id + '" data-id="' + p.id + '">' + av(p.id) + '<span class="t"><b>' + esc(p.name) + '</b><span>' + esc(p.role) + '</span></span>' + (p.pc ? '' : '<span class="st">没有电脑</span>') + '</button>'; }).join('') + '</div>' :
        empty('还没有员工', '先新增一位员工，才能把事情交出去。', '<button class="go"' + go({ p: 'add' }) + '>新增员工</button>')) + '</div>';
    },
    staff: function (g) {
      var list = staff(), busy = list.filter(function (p) { return owned(p.id).length; });
      if (!list.length) return nav('员工') + '<div class="body">' + empty('还没有员工', '员工是替你办事的 Bot。每位有一个岗位、一部手机和一台电脑。', '<button class="go"' + go({ p: 'add' }) + '>新增员工</button><button class="go alt" data-do="sample">填入三位示例员工</button>') + '</div>';
      if (g && g.all) return nav('全部员工') + '<div class="body"><div class="cells">' + cell({ p: 'add' }, '<span class="av q">+</span>', '新增员工', '', '') + list.map(function (p) { return personRow(p); }).join('') + '</div><div class="gap"></div></div>';
      return nav('员工') + '<div class="body"><div class="sec">手上有事</div>' + (busy.length ? '<div class="cells">' + busy.map(function (p) { return personRow(p, '负责：' + owned(p.id).map(function (t) { return t.title; }).join('、')); }).join('') + '</div>' : empty('现在没有人手上有事', '把一件事交给某位员工后，他会出现在这里。')) +
        '<div class="gap"></div><div class="cells">' + cell({ p: 'staff', all: 1 }, '', '全部员工', '', list.length + ' 位') + '</div></div>';
    },
    one: function (g) {
      var p = P(g.id), own = owned(p.id), reach = staff().filter(function (o) { return o.id !== p.id && p.reach.indexOf(o.id) >= 0; }).length;
      return nav('', { p: 'emore', id: p.id }) + '<div class="body"><div class="cells"><div class="cell big a">' + av(p.id, 'l') + '<span class="t"><b>' + esc(p.name) + '</b><span>' + esc(p.role) + '</span></span></div></div>' +
        (own.length ? '<div class="sec">负责的事</div><div class="cells">' + own.map(function (t) { return cell({ p: 'thing', t: t.id }, '', t.title, '', '在办'); }).join('') + '</div>' : '') +
        '<div class="sec">手机</div><div class="cells">' + cell({ p: 'phone', id: p.id }, '', '他在联系谁', '', '0 个聊天') + cell({ p: 'reach', id: p.id }, '', '他能联系谁', '', reach + ' 人') + '</div>' +
        '<div class="sec">电脑</div><div class="cells">' + cell({ p: 'pc', id: p.id }, '', '他在做什么', '', own.length + ' 件') + cell({ p: 'can', id: p.id }, '', '他能做什么', '', canLine(p)) + '</div>' +
        '<div class="gap"></div><div class="cells">' + cell({ p: 'role', id: p.id }, '', '岗位和提示', '', p.role) + '</div><div class="gap"></div></div>';
    },
    emore: function (g) { return nav(N(g.id)) + '<div class="body"><div class="gap"></div><div class="cells">' + (owned(g.id).length ? '<div class="cell"><span class="t"><b>移出团队</b><span>他手上还有事，先换负责人或取消</span></span></div>' : '<button class="cell" data-do="drop" data-id="' + g.id + '"><span class="t"><b class="warn">移出团队</b></span></button>') + '</div></div>'; },
    phone: function (g) { return nav(N(g.id) + '在联系谁') + '<div class="body">' + empty('还没有聊天记录', esc(N(g.id)) + '开始和别人联系后，每个对象一行，点进去能翻聊天记录。') + '</div>'; },
    reach: function (g) {
      var p = P(g.id), others = staff().filter(function (o) { return o.id !== p.id; });
      return nav(p.name + '能联系谁') + '<div class="body">' + (others.length ? '<div class="sec">打开的人，他可以主动发消息</div><div class="cells">' + others.map(function (o) { return '<label class="cell a sw">' + av(o.id) + '<span class="t"><b>' + esc(o.name) + '</b><span>' + esc(o.role) + '</span></span><input type="checkbox" data-sw="reach" data-id="' + p.id + '" data-b="' + o.id + '"' + (p.reach.indexOf(o.id) >= 0 ? ' checked' : '') + '></label>'; }).join('') + '</div>' : empty('还没有别的员工', '团队里有了其他人，才能决定他能联系谁。')) + '</div>';
    },
    pc: function (g) {
      var p = P(g.id), own = owned(p.id);
      return nav(p.name + '在做什么') + '<div class="body codex">' + (p.pc ? '<div class="sec">' + esc(resName('pc', p.pc)) + '</div>' : '<button class="cell"' + go({ p: 'res', id: p.id, k: 'pc' }) + '><span class="t"><b class="warn">还没有分配电脑</b><span>没有电脑，他接到事情也没法开工</span></span><span class="r">去分配' + GO + '</span></button>') +
        (own.length ? own.map(function (t) { return '<button class="tk"' + go({ p: 'thing', t: t.id }) + '><span class="t"><b>' + esc(t.title) + '</b><span>还没有开始</span></span></button>'; }).join('') : empty('还没有任务', '把一件事交给' + esc(p.name) + '，或者在下面直接写。')) +
        '</div><div class="composer"><input id="task" placeholder="交给' + esc(p.name) + '一件事…" aria-label="派一件事"><button data-do="task" data-id="' + p.id + '" aria-label="发送">↑</button></div>';
    },
    can: function (g) {
      var p = P(g.id);
      return nav(p.name + '能做什么') + '<div class="body"><div class="gap"></div><div class="cells">' +
        cell({ p: 'res', id: p.id, k: 'pc' }, '', '电脑', '他干活的地方', p.pc ? resName('pc', p.pc) : '未分配') +
        cell({ p: 'res', id: p.id, k: 'env' }, '', '云环境', '在云端跑程序、开浏览器和桌面', p.env ? resName('env', p.env) : '未分配') +
        cell({ p: 'res', id: p.id, k: 'conn' }, '', '连接器', '他能用的外部账号和工具', p.conn.length ? p.conn.length + ' 个' : '未分配') + '</div>' +
        '<p class="foot">他能做什么，取决于给了他哪台电脑、哪个云环境、哪些连接器。</p></div>';
    },
    res: function (g) {
      var p = P(g.id), k = KIND[g.k], list = db.res[g.k], multi = g.k === 'conn';
      function on(r) { return multi ? p.conn.indexOf(r.id) >= 0 : p[g.k] === r.id; }
      return nav(k[0]) + '<div class="body">' + (list.length ? '<div class="sec">' + (multi ? '可以选多个' : '选一' + k[1]) + '</div><div class="cells">' + list.map(function (r) { return '<label class="cell sw"><span class="t"><b>' + esc(r.name) + '</b></span><input type="checkbox" data-sw="res" data-id="' + p.id + '" data-k="' + g.k + '" data-b="' + r.id + '"' + (on(r) ? ' checked' : '') + '></label>'; }).join('') + '</div>' : empty('公司还没有登记' + k[0], '先登记一' + k[1] + '，再分配给' + esc(p.name) + '。')) +
        '<div class="sec">登记新的' + k[0] + '</div><div class="newt"><input id="rn" placeholder="' + k[2] + '" aria-label="名称"><button data-do="addres" data-k="' + g.k + '" data-id="' + p.id + '">登记</button></div></div>';
    },
    role: function (g) {
      var p = P(g.id);
      return nav(p.name + '的岗位') + '<div class="body"><div class="gap"></div><div class="field"><label for="f1">岗位</label><input id="f1" value="' + esc(p.role) + '"></div><div class="sec">岗位提示：告诉他这个岗位该怎么做事</div><textarea id="pt" aria-label="岗位提示" placeholder="还没有写。例如：收到事情先确认要交付什么，拿不准先问负责人。">' + esc(p.prompt) + '</textarea><div class="act"><button class="go" data-do="role" data-id="' + p.id + '">保存</button></div></div>';
    },
    add: function () { return nav('新增员工') + '<div class="body"><div class="gap"></div><div class="field"><label for="f0">名字</label><input id="f0" placeholder="例如：阿岚"></div><div class="field"><label for="f1">岗位</label><input id="f1" placeholder="例如：盯交付"></div><div class="act"><button class="go" data-do="add">加入团队</button></div></div>'; },
    feed: function () {
      var list = db.notes.slice().reverse();
      return nav('动态') + '<div class="body">' + (list.length ? '<div class="cells">' + list.map(function (x) { x = Object.assign({ showT: 1 }, x); return logRow(x); }).join('') + '</div>' : empty('还没有动态', '谁说了什么、做完了什么、你把哪件事交给了谁，都会按时间出现在这里。')) + '</div>';
    }
  };
  function resName(k, id) { var r = db.res[k].filter(function (x) { return x.id === id; })[0]; return r ? r.name : '已删除'; }

  var DO = {
    newthing: function () { var el = document.getElementById('nt'), v = el.value.trim(); if (!v) { el.focus(); return; } var t = { id: uid('t'), title: v, owner: null, state: 'open' }; db.things.push(t); note('me', '加了一件事', t.id); },
    task: function (d) { var el = document.getElementById('task'), v = el.value.trim(); if (!v) { el.focus(); return; } var t = { id: uid('t'), title: v, owner: d.id, state: 'open' }; db.things.push(t); note('me', '交给' + N(d.id) + '一件事', t.id); },
    assign: function (d) { var t = T(d.t), prev = t.owner; t.owner = d.id; note('me', prev && prev !== d.id ? '把这件事从' + N(prev) + '换给了' + N(d.id) : '把这件事交给了' + N(d.id), t.id); while (stack.length && stack[stack.length - 1].p !== 'thing') stack.pop(); if (!stack.length) stack.push({ p: 'thing', t: t.id }); },
    tick: function (d) { var t = T(d.t); if (t.state === 'open') { t.state = 'done'; note('me', '把这件事标为办完', t.id); } else { t.state = 'open'; note('me', '重新打开了这件事', t.id); } },
    cancel: function (d) { T(d.t).state = 'cancel'; note('me', '取消了这件事', d.t); stack.pop(); stack.pop(); },
    add: function () { var n = document.getElementById('f0').value.trim(), r = document.getElementById('f1').value.trim(); if (!n || !r) return; var p = { id: uid('p'), name: n, role: r, prompt: '', reach: [], pc: null, env: null, conn: [] }; db.people.push(p); note('me', '新增了员工' + n + '（' + r + '）'); stack.pop(); stack.push({ p: 'one', id: p.id }); },
    sample: function () { [['阿岚', '盯交付、管交接'], ['言禾', '验收签字'], ['小折', '核对签字页和交付清单']].forEach(function (x) { db.people.push({ id: uid('p'), name: x[0], role: x[1], prompt: '', reach: [], pc: null, env: null, conn: [] }); }); note('me', '填入了三位示例员工'); },
    drop: function (d) { P(d.id).gone = true; note('me', '把' + N(d.id) + '移出了团队'); stack = []; },
    role: function (d) { var p = P(d.id), r = document.getElementById('f1').value.trim(); if (r) p.role = r; p.prompt = document.getElementById('pt').value.trim(); note('me', '改了' + p.name + '的岗位和提示'); stack.pop(); },
    addres: function (d) { var el = document.getElementById('rn'), v = el.value.trim(); if (!v) { el.focus(); return; } var r = { id: uid('r'), name: v }, p = P(d.id); db.res[d.k].push(r); if (d.k === 'conn') p.conn.push(r.id); else p[d.k] = r.id; note('me', '登记了' + KIND[d.k][0] + '「' + v + '」，并分配给' + p.name); }
  };
  function draw() {
    var g = stack[stack.length - 1], h = g ? PAGE[g.p](g) : PAGE[db.tab]();
    if (!g) { var n = db.things.filter(function (t) { return open(t) && !t.owner; }).length; h += '<div class="tabs">' + TABS.map(function (t) { return '<button data-tab="' + t[0] + '" aria-current="' + (t[0] === db.tab) + '">' + t[2] + t[1] + (t[0] === 'things' && n ? '<em>' + n + '</em>' : '') + '</button>'; }).join('') + '</div>'; }
    document.getElementById('app').innerHTML = h;
  }
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-go],[data-tab],[data-do]'); if (!el) return;
    if (el.dataset.do) DO[el.dataset.do](el.dataset);
    else if (el.dataset.tab) db.tab = el.dataset.tab;
    else if (el.dataset.go === 'back') stack.pop();
    else stack.push(JSON.parse(el.dataset.go));
    save(); draw();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return; var m = { nt: 'newthing', rn: 'addres', task: 'task' }[e.target.id]; if (!m) return;
    var b = document.querySelector('[data-do=' + m + ']'); if (b) b.click();
  });
  document.addEventListener('change', function (e) {
    var d = e.target.dataset, p; if (!d.sw) return; p = P(d.id);
    if (d.sw === 'reach') { if (e.target.checked) p.reach.push(d.b); else p.reach = p.reach.filter(function (x) { return x !== d.b; }); note('me', (e.target.checked ? '允许' : '不再允许') + p.name + '主动联系' + N(d.b)); }
    else if (d.k === 'conn') { if (e.target.checked) p.conn.push(d.b); else p.conn = p.conn.filter(function (x) { return x !== d.b; }); note('me', (e.target.checked ? '给了' : '收回了') + p.name + '连接器「' + resName('conn', d.b) + '」'); }
    else { p[d.k] = e.target.checked ? d.b : null; note('me', (e.target.checked ? '给' : '收回了') + p.name + (e.target.checked ? '分配了' : '的') + KIND[d.k][0] + '「' + resName(d.k, d.b) + '」'); }
    save(); draw();
  });
  draw();
})();
