/* 老板的三个标签：事情（待办，每件一个负责人）、员工（手机：在联系谁/能联系谁；电脑：在做什么/能做什么）、动态。
   这是结构原型，没有接真实的 Bot。里面的示例内容是一份静态快照，全部按老板会看到的样子写：他派的事、员工之间说的话、交到他手里的东西。
   没有任何东西会自己往前走；清空示例后，各处如实显示为空。 */
(function () {
  'use strict';
  var KEY = 'opencraft.matter-canvas.v5';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  function svg(d) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; }
  var BACK = svg('<path d="m14.500 5-7 7 7 7"/>'), GO = svg('<path d="m9.500 5 7 7-7 7"/>'), DOTS = '<svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22" aria-hidden="true"><circle cx="5" cy="12" r="1.700"/><circle cx="12" cy="12" r="1.700"/><circle cx="19" cy="12" r="1.700"/></svg>';
  var TABS = [['staff', '员工', svg('<path d="M12 4.500c-4.700 0-8.500 3.100-8.500 7 0 2.200 1.200 4.100 3.100 5.400L6 20l3.400-1.600c.8.200 1.700.300 2.600.300 4.700 0 8.500-3.100 8.500-7s-3.800-7.200-8.500-7.200z"/>')],
    ['things', '事情', svg('<rect x="4.500" y="4" width="15" height="16" rx="2.500"/><path d="m8 9.500 1.500 1.500L12 8.500M8 15l1.500 1.500L12 14M14.500 10h2M14.500 15.500h2"/>')],
    ['feed', '动态', svg('<circle cx="12" cy="12" r="8.500"/><path d="m15.500 8.500-2 5-5 2 2-5z"/>')]];
  var KIND = { pc: ['电脑', '台', '例如：办公室的 Mac mini'], env: ['云环境', '个', '例如：测试环境沙盒'], conn: ['连接器', '个', '例如：飞书、邮箱、GitHub'] };
  var HUES = ['#4c7868', '#8471ac', '#ac734e', '#5a8397', '#b58239', '#7a6f9b', '#5f8a5a', '#a35d6a'];

  function blank() { return { people: [], things: [], notes: [], files: [], res: { pc: [], env: [], conn: [] }, tab: 'staff', n: 0, sample: false }; }
  function sample() { /* 一家小工作室老板眼里的某个下午 */
    var d = blank(), now = Date.now(), m = function (min) { return now - min * 60000; };
    function res(k, id, name) { d.res[k].push({ id: id, name: name }); }
    res('pc', 'r1', '办公室的 Mac mini'); res('pc', 'r2', '机房的 Linux 主机'); res('env', 'r3', '测试环境'); res('env', 'r4', '客户演示环境');
    res('conn', 'r5', '飞书'); res('conn', 'r6', '企业邮箱'); res('conn', 'r7', 'GitHub'); res('conn', 'r8', '公司网盘');
    function person(id, name, role, prompt, pc, env, conn, reach) { d.people.push({ id: id, name: name, role: role, prompt: prompt, pc: pc, env: env, conn: conn, reach: reach }); }
    person('a', '阿岚', '项目交付', '你负责把版本按时交到客户手里。缺什么材料自己找同事要，拿不准的事先问老板。交付前一定让人核对签字页。', 'r1', 'r4', ['r5', 'r6', 'r8'], ['y', 'z', 'c']);
    person('y', '言禾', '合同与验收', '你保管合同和验收文件。别人来要文件，先确认是哪个版本，再给盖章的那一份。', 'r1', null, ['r5', 'r8'], ['a']);
    person('z', '小折', '文档核对', '你只做核对：版本、页码、签章。核完写清楚看的是哪一份、结论是什么。', 'r2', 'r3', ['r8'], ['a']);
    person('c', '沐川', '行政与账号', '你负责开账号、订会议室、收报销单。办完告诉交办的人。', 'r2', null, ['r5', 'r6', 'r7'], ['a']);
    function thing(id, title, owner, from, state, more) { d.things.push(Object.assign({ id: id, title: title, owner: owner, from: from, state: state }, more || {})); }
    thing('t1', '周五把 2.3 版本交给客户', 'a', 'me', 'open', { wait: true });
    thing('t2', '找出客户盖章的验收签字页', 'y', 'a', 'done', { parent: 't1' });
    thing('t3', '核对签字页的版本和页码', 'z', 'a', 'done', { parent: 't1' });
    thing('t4', '给下周入职的新同事开好账号', 'c', 'me', 'open');
    thing('t5', '等新同事发来 GitHub 用户名', 'c', 'c', 'open', { parent: 't4' });
    thing('t6', '整理 10 月的报销单', 'c', 'me', 'open');
    thing('t7', '订周三客户来访的会议室', 'c', 'me', 'done');
    d.files.push({ id: 'f1', name: '2.3 版本签字页核对单', owner: 'a', t: 't1', ts: m(18), body: '盖章的是第 3 页那一份。\n版本号 2.3，和交付清单一致。\n核对人：小折。\n交付包里的三样都齐了：安装包、测试回执、验收签字页。' });
    d.files.push({ id: 'f2', name: '签字页核对记录', owner: 'z', t: 't3', ts: m(31), body: '看了两份附件。\n第 2 页那份没有盖章，是草稿。\n第 3 页那份有客户公章，版本号 2.3。' });
    function msg(min, t, from, to, text) { d.notes.push({ ts: m(min), who: from, to: to, text: text, t: t, k: 'msg' }); }
    function log(min, t, who, text, f) { d.notes.push({ ts: m(min), who: who, text: text, t: t, f: f || null }); }
    log(190, 't7', 'me', '把这件事交给了沐川'); msg(170, 't7', 'c', 'me', '周三下午 2 点到 4 点的大会议室订好了，投影也借了。'); log(165, 't7', 'me', '把这件事标为办完');
    log(95, 't1', 'me', '把这件事交给了阿岚'); msg(94, 't1', 'me', 'a', '周五要把 2.3 版本交给客户，你来负责。缺什么自己找人。');
    msg(80, 't2', 'a', 'y', '言禾，客户盖章的验收签字页在你那吗？周五交付要用。'); msg(62, 't2', 'y', 'a', '在，发你了。有两个附件页码不一样，盖章的是其中一份，你最好找人核一下。'); log(60, 't2', 'a', '收下了，这件子事情办完');
    msg(55, 't3', 'a', 'z', '帮我核一下这两份签字页：哪份是盖章的，版本对不对。'); log(31, 't3', 'z', '交出「签字页核对记录」', 'f2'); msg(30, 't3', 'z', 'a', '核完了。盖章的是第 3 页那份，版本 2.3，和交付清单一致。'); log(28, 't3', 'a', '收下了，这件子事情办完');
    log(18, 't1', 'a', '交出「2.3 版本签字页核对单」', 'f1'); msg(17, 't1', 'a', 'me', '签字页核对好了，交付包齐了。你看一眼核对单，没问题我就发给客户。');
    log(50, 't4', 'me', '把这件事交给了沐川'); msg(49, 't4', 'me', 'c', '下周一有新同事入职，账号提前开好。'); msg(22, 't4', 'c', 'me', '邮箱和飞书开好了。GitHub 要等他把用户名发我，我已经问了。');
    msg(8, 't6', 'me', 'c', '把 10 月的报销单整理一下，周五前给我。');
    d.n = 100; d.sample = true; return d;
  }
  var db = sample();
  try { var raw = JSON.parse(localStorage.getItem(KEY)); if (raw && raw.people && raw.files && raw.v === 2) db = raw; } catch (e) { /* 没有存储也能用 */ }
  function save() { db.v = 2; try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ } }
  function uid(p) { db.n += 1; return p + db.n; }
  function P(id) { return db.people.filter(function (x) { return x.id === id; })[0]; }
  function T(id) { return db.things.filter(function (x) { return x.id === id; })[0]; }
  function N(id) { return id === 'me' ? '老板' : (P(id) || {}).name || '已移出的员工'; }
  function staff() { return db.people.filter(function (p) { return !p.gone; }); }
  function note(who, text, t) { db.notes.push({ ts: Date.now(), who: who, text: text, t: t || null }); }
  function open(t) { return t.state === 'open'; }
  function owned(id) { return db.things.filter(function (t) { return t.owner === id && open(t); }); }
  function subs(t) { return db.things.filter(function (x) { return x.parent === t.id; }); }
  function tops() { return db.things.filter(function (t) { return !t.parent; }); }
  function mine(t) { return open(t) && (!t.owner || (t.wait && t.from === 'me')); }
  function status(t) { return t.state === 'done' ? ['已办完', 'ok'] : t.state === 'cancel' ? ['已取消', 'ok'] : !t.owner ? ['待分配负责人', 'you'] : t.wait ? (t.from === 'me' ? ['等你验收', 'you'] : ['等' + N(t.from) + '验收', '']) : ['在办', '']; }
  function F(id) { return db.files.filter(function (x) { return x.id === id; })[0]; }
  function msgs(a, b) { return db.notes.filter(function (x) { return x.k === 'msg' && ((x.who === a && x.to === b) || (x.who === b && x.to === a)); }).sort(function (x, y) { return x.ts - y.ts; }); }
  function lastTs(id) { var l = msgs('me', id).pop(); return l ? l.ts : 0; }
  function chats(id) { var o = []; db.notes.forEach(function (x) { if (x.k !== 'msg') return; var p = x.who === id ? x.to : x.to === id ? x.who : null; if (p && o.indexOf(p) < 0) o.push(p); }); return o; }
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
  function logRow(x) {
    var t = x.t && T(x.t), inner = av(x.who) + '<span class="t"><b>' + esc(N(x.who)) + (x.showT && t ? ' <small>· ' + esc(t.title) + '</small>' : '') + '</b><span class="wrap">' + esc(x.k === 'msg' ? '对' + N(x.to) + '说：' + x.text : x.text) + '</span></span><time>' + hhmm(x.ts) + '</time>';
    return x.f ? '<button class="cell a"' + go({ p: 'file', f: x.f }) + '>' + inner + '</button>' : x.showT && t ? '<button class="cell a"' + go({ p: 'thing', t: t.id }) + '>' + inner + '</button>' : '<div class="cell a">' + inner + '</div>';
  }
  function personRow(p, sub) { return '<button class="cell a"' + go({ p: 'one', id: p.id }) + '>' + av(p.id) + '<span class="t"><b>' + esc(p.name) + '</b><span>' + esc(sub || p.role) + '</span></span></button>'; }

  var PAGE = {
    things: function () {
      var all = tops(), me = all.filter(mine), out = all.filter(function (t) { return open(t) && !mine(t); }), ended = all.filter(function (t) { return !open(t); });
      return nav('事情') + '<div class="body">' +
        (!all.length ? empty('还没有事情', '事情是从人开始的：去「员工」里选一位，对他说要办什么，这里就会多一件。', '<button class="go" data-tab="staff">去选人</button>') :
          (me.length ? '<div class="sec">要我出手的 ' + me.length + '</div><div class="cells">' + me.map(todo).join('') + '</div>' : '') +
          (out.length ? '<div class="sec">别人在办的 ' + out.length + '</div><div class="cells">' + out.map(todo).join('') + '</div>' : '') +
          (!me.length && !out.length ? empty('没有在办的事', '都结束了。') : '') +
          (ended.length ? '<div class="gap"></div><div class="cells">' + cell({ p: 'ended' }, '', '已结束', '', ended.length + ' 件') + '</div>' : '')) +
        (db.sample ? '<p class="foot">现在看到的是示例内容。<button class="lk" data-do="clear">清空，从头开始</button></p>' : '') + '</div>';
    },
    ended: function () { return nav('已结束') + '<div class="body"><div class="cells">' + tops().filter(function (t) { return !open(t); }).map(todo).join('') + '</div></div>'; },
    thing: function (g) {
      var t = T(g.t), st = status(t), log = db.notes.filter(function (x) { return x.t === t.id; }).sort(function (x, y) { return y.ts - x.ts; }), kids = subs(t), par = t.parent && T(t.parent);
      var art = db.files.filter(function (f) { return f.t === t.id; }).pop(), act = '', look = '';
      if (!open(t)) act = '';
      else if (!t.owner) act = '<button class="go"' + go({ p: 'pick', t: t.id }) + '>分配负责人</button>';
      else if (st[0] === '等你验收') { look = art ? '<div class="sec">先看一眼他交出的东西</div><div class="cells">' + cell({ p: 'file', f: art.id }, '', art.name, N(art.owner) + '交出', '') + '</div>' : ''; act = '<button class="go" data-do="accept" data-t="' + t.id + '">可以，确认</button><button class="go alt" data-do="reject" data-t="' + t.id + '">不行，退回重做</button>'; }
      return nav(par ? '子事情' : '事情', open(t) && t.owner ? { p: 'tmore', t: t.id } : null) + '<div class="body"><div class="cells"><div class="cell text"><small><span class="st ' + st[1] + '">' + st[0] + '</span></small><b style="font-size:20px">' + esc(t.title) + '</b></div></div>' + look + (act ? '<div class="act">' + act + '</div>' : '<div class="gap"></div>') +
        '<div class="cells">' + (t.owner ? '<button class="cell a"' + go({ p: 'one', id: t.owner }) + '>' + av(t.owner) + '<span class="t"><b>' + esc(N(t.owner)) + '</b><span>负责人</span></span><span class="r">' + GO + '</span></button>' : '') +
        (par ? cell({ p: 'thing', t: par.id }, '', par.title, '属于这件事 · ' + N(t.from) + '派的，由' + N(t.from) + '验收', '') : '') + '</div>' +
        (par || (!t.owner && !kids.length) ? '' : '<div class="sec">子事情</div>' + (kids.length ? '<div class="cells">' + kids.map(todo).join('') + '</div>' : empty('还没有子事情', (t.owner ? esc(N(t.owner)) : '负责人') + '把一部分交给别人办时，会出现在这里，由他自己验收。'))) +
        (!t.owner && log.length < 2 ? '<p class="foot">这件事还没有人负责。分配之后，负责人说了什么、交给了谁、交出了什么，都会出现在这一页。</p>' : '<div class="sec">经过</div>' + (log.length ? '<div class="cells">' + log.map(logRow).join('') + '</div>' : empty('还没有经过', '有人说了什么、交出了什么，会按时间出现在这里。'))) + '<div class="gap"></div></div>';
    },
    file: function (g) {
      var f = F(g.f), t = T(f.t);
      return nav('交出的东西') + '<div class="body"><div class="cells"><div class="cell text"><b style="font-size:20px">' + esc(f.name) + '</b><p>' + esc(f.body) + '</p></div></div><div class="gap"></div><div class="cells">' + cell({ p: 'one', id: f.owner }, av(f.owner), N(f.owner), '交出的人', hhmm(f.ts)) + (t ? cell({ p: 'thing', t: t.id }, '', t.title, '属于这件事', '') : '') + '</div></div>';
    },
    tmore: function (g) {
      var t = T(g.t);
      return nav(t.title) + '<div class="body"><div class="gap"></div><div class="cells">' + (t.owner && !t.wait ? '<button class="cell" data-do="tick" data-t="' + t.id + '" data-back="1"><span class="t"><b>已经办完了，打勾</b></span></button>' : '') + (t.owner ? cell({ p: 'pick', t: t.id }, '', '换一位负责人', '', '') : '') + '<button class="cell" data-do="cancel" data-t="' + t.id + '"><span class="t"><b class="warn">不办了，取消这件事</b></span></button></div></div>';
    },
    pick: function (g) {
      var t = T(g.t), list = staff();
      return nav('分配负责人') + '<div class="body"><div class="sec">' + esc(t.title) + '</div>' + (list.length ? '<div class="cells">' + list.map(function (p) { return '<button class="cell a" data-do="assign" data-t="' + t.id + '" data-id="' + p.id + '">' + av(p.id) + '<span class="t"><b>' + esc(p.name) + '</b><span>' + esc(p.role) + '</span></span>' + (p.pc ? '' : '<span class="st">没有电脑</span>') + '</button>'; }).join('') + '</div>' :
        empty('还没有员工', '先新增一位员工，才能把事情交出去。', '<button class="go"' + go({ p: 'add' }) + '>新增员工</button>')) + '</div>';
    },
    staff: function () {
      var list = staff().slice().sort(function (a, b) { return lastTs(b.id) - lastTs(a.id); });
      if (!list.length) return nav('员工') + '<div class="body">' + empty('还没有员工', '员工是替你办事的 Bot。先有人，才能对他说要办什么。', '<button class="go"' + go({ p: 'add' }) + '>新增员工</button><button class="go alt" data-do="sample">填入示例内容</button>') + '</div>';
      return nav('员工') + '<div class="body"><div class="cells">' + list.map(function (p) {
        var last = msgs('me', p.id).pop(), n = owned(p.id).length, wait = owned(p.id).filter(function (t) { return t.wait && t.from === 'me'; }).length;
        return '<button class="cell chatrow"' + go({ p: 'talk', id: p.id }) + '>' + av(p.id, 'x') + (wait ? '<i class="dotr"></i>' : '') + '<span class="t"><b>' + esc(p.name) + ' <small>' + esc(p.role) + '</small></b><span>' + esc(last ? (last.who === 'me' ? '你：' : '') + last.text : '还没有对他说过什么') + '</span></span><time>' + (last ? hhmm(last.ts) : '') + (n ? '<br>' + n + ' 件在办' : '') + '</time></button>';
      }).join('') + cell({ p: 'add' }, '<span class="av q x">+</span>', '新增员工', '', '') + '</div>' + (db.sample ? '<p class="foot">现在看到的是示例内容。<button class="lk" data-do="clear">清空，从头开始</button></p>' : '') + '</div>';
    },
    talk: function (g) { /* 选了人，对他说要办什么：说出去的每一句就是一件交给他的事 */
      var p = P(g.id), h = '', lastT = null;
      msgs('me', p.id).forEach(function (x) {
        var t = x.t && T(x.t);
        if (t && lastT !== t.id) { var st = status(t); h += '<button class="tcard"' + go({ p: 'thing', t: t.id }) + '><b>' + esc(t.title) + '</b><span class="st ' + st[1] + '">' + st[0] + '</span>' + GO + '</button>'; lastT = t.id; }
        h += '<div class="line' + (x.who === 'me' ? ' me' : '') + '">' + av(x.who) + '<div class="msg">' + esc(x.text) + '</div></div>';
      });
      return nav(p.name, { p: 'one', id: p.id }) + '<div class="body"><div class="chat">' + (h || '') + '</div>' + (h ? '' : empty('还没有对' + esc(p.name) + '说过什么', '在下面写一件要办的事，发出去就交给他了。')) + '</div>' +
        '<div class="composer"><input id="say" placeholder="对' + esc(p.name) + '说要办什么…" aria-label="要办什么"><button data-do="say" data-id="' + p.id + '" aria-label="发送">↑</button></div>';
    },
    one: function (g) {
      var p = P(g.id), own = owned(p.id), reach = staff().filter(function (o) { return o.id !== p.id && p.reach.indexOf(o.id) >= 0; }).length;
      return nav('', { p: 'emore', id: p.id }) + '<div class="body"><div class="cells"><div class="cell big a">' + av(p.id, 'l') + '<span class="t"><b>' + esc(p.name) + '</b><span>' + esc(p.role) + '</span></span></div></div>' +
        (own.length ? '<div class="sec">负责的事</div><div class="cells">' + own.map(function (t) { return cell({ p: 'thing', t: t.id }, '', t.title, t.parent ? '子事情 · 属于「' + T(t.parent).title + '」' : '', status(t)[0]); }).join('') + '</div>' : '') +
        '<div class="sec">手机</div><div class="cells">' + cell({ p: 'phone', id: p.id }, '', '他在联系谁', '', chats(p.id).length + ' 个聊天') + cell({ p: 'reach', id: p.id }, '', '他能联系谁', '', reach + ' 人') + '</div>' +
        '<div class="sec">电脑</div><div class="cells">' + cell({ p: 'pc', id: p.id }, '', '他在做什么', '', own.length ? own.length + ' 件在办' : '手上没有事') + cell({ p: 'can', id: p.id }, '', '他能做什么', '', canLine(p)) + '</div>' +
        '<div class="gap"></div><div class="cells">' + cell({ p: 'role', id: p.id }, '', '岗位和提示', '', p.role) + '</div><div class="gap"></div></div>';
    },
    emore: function (g) { return nav(N(g.id)) + '<div class="body"><div class="gap"></div><div class="cells">' + (owned(g.id).length ? '<div class="cell"><span class="t"><b>移出团队</b><span>他手上还有事，先换负责人或取消</span></span></div>' : '<button class="cell" data-do="drop" data-id="' + g.id + '"><span class="t"><b class="warn">移出团队</b></span></button>') + '</div></div>'; },
    phone: function (g) {
      var list = chats(g.id).sort(function (a, b) { return msgs(g.id, b).pop().ts - msgs(g.id, a).pop().ts; });
      return nav(N(g.id) + '在联系谁') + '<div class="body">' + (list.length ? '<div class="cells">' + list.map(function (o) { var last = msgs(g.id, o).pop(); return '<button class="cell chatrow"' + go({ p: 'chat', id: g.id, o: o }) + '>' + av(o, 'x') + '<span class="t"><b>' + esc(N(o)) + '</b><span>' + esc(last.text) + '</span></span><time>' + hhmm(last.ts) + '</time></button>'; }).join('') + '</div>' :
        empty('还没有聊天记录', esc(N(g.id)) + '开始和别人联系后，每个对象一行，点进去能翻聊天记录。')) + '</div>';
    },
    chat: function (g) {
      var h = '', lastT = null;
      msgs(g.id, g.o).forEach(function (x) { var t = x.t && T(x.t); if (t && lastT !== t.id) { h += '<button class="stamp"' + go({ p: 'thing', t: t.id }) + '>' + esc(t.title) + ' ›</button>'; lastT = t.id; } h += '<div class="line' + (x.who === g.id ? ' me' : '') + '">' + av(x.who) + '<div class="msg">' + esc(x.text) + '</div></div>'; });
      return nav(N(g.o)) + '<div class="body"><div class="chat">' + h + '</div><p class="foot">这是' + esc(N(g.id)) + '的手机，绿色是' + esc(N(g.id)) + '发的。灰字是这段话属于哪件事。</p></div>';
    },
    reach: function (g) {
      var p = P(g.id), others = staff().filter(function (o) { return o.id !== p.id; });
      return nav(p.name + '能联系谁') + '<div class="body">' + (others.length ? '<div class="sec">打开的人，他可以主动发消息</div><div class="cells">' + others.map(function (o) { return '<label class="cell a sw">' + av(o.id) + '<span class="t"><b>' + esc(o.name) + '</b><span>' + esc(o.role) + '</span></span><input type="checkbox" data-sw="reach" data-id="' + p.id + '" data-b="' + o.id + '"' + (p.reach.indexOf(o.id) >= 0 ? ' checked' : '') + '></label>'; }).join('') + '</div>' : empty('还没有别的员工', '团队里有了其他人，才能决定他能联系谁。')) + '</div>';
    },
    pc: function (g) {
      var p = P(g.id), own = owned(p.id);
      return nav(p.name + '在做什么') + '<div class="body codex">' + (p.pc ? '<div class="sec">' + esc(resName('pc', p.pc)) + '</div>' : '<button class="cell"' + go({ p: 'res', id: p.id, k: 'pc' }) + '><span class="t"><b class="warn">还没有分配电脑</b><span>没有电脑，他接到事情也没法开工</span></span><span class="r">去分配' + GO + '</span></button>') +
        (own.length ? '<div class="sec">手上的</div>' + own.map(function (t) { return '<button class="tk"' + go({ p: 'thing', t: t.id }) + '><span class="t"><b>' + esc(t.title) + '</b><span>' + esc(t.parent ? '子事情 · ' + T(t.parent).title : '') + '</span></span><em' + (t.wait ? '' : ' class="doing"') + '>' + status(t)[0] + '</em></button>'; }).join('') : empty('手上没有事', '回到和' + esc(p.name) + '的对话里，对他说要办什么。')) +
        (function () { var fs = db.files.filter(function (f) { return f.owner === p.id; }); return fs.length ? '<div class="sec">交出过的东西</div>' + fs.map(function (f) { return '<button class="tk"' + go({ p: 'file', f: f.id }) + '><span class="t"><b>' + esc(f.name) + '</b><span>' + esc((T(f.t) || {}).title || '') + '</span></span><em>' + hhmm(f.ts) + '</em></button>'; }).join('') : ''; })() +
        '</div>';
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
      var list = db.notes.slice().sort(function (a, b) { return b.ts - a.ts; });
      return nav('动态') + '<div class="body">' + (list.length ? '<div class="cells">' + list.map(function (x) { x = Object.assign({ showT: 1 }, x); return logRow(x); }).join('') + '</div>' : empty('还没有动态', '谁说了什么、做完了什么、你把哪件事交给了谁，都会按时间出现在这里。')) + '</div>';
    }
  };
  function resName(k, id) { var r = db.res[k].filter(function (x) { return x.id === id; })[0]; return r ? r.name : '已删除'; }

  var DO = {
    say: function (d) { var el = document.getElementById('say'), v = el.value.trim(); if (!v) { el.focus(); return; } var t = { id: uid('t'), title: v, owner: d.id, from: 'me', state: 'open' }; db.things.push(t); db.notes.push({ ts: Date.now(), who: 'me', to: d.id, text: v, t: t.id, k: 'msg' }); },
    assign: function (d) { var t = T(d.t), prev = t.owner; t.owner = d.id; note('me', prev && prev !== d.id ? '把这件事从' + N(prev) + '换给了' + N(d.id) : '把这件事交给了' + N(d.id), t.id); while (stack.length && stack[stack.length - 1].p !== 'thing') stack.pop(); if (!stack.length) stack.push({ p: 'thing', t: t.id }); },
    tick: function (d) { var t = T(d.t); if (t.state === 'open') { t.state = 'done'; t.wait = false; note('me', '把这件事标为办完', t.id); } else { t.state = 'open'; note('me', '重新打开了这件事', t.id); } if (d.back) stack.pop(); },
    accept: function (d) { var t = T(d.t); t.state = 'done'; t.wait = false; note('me', '看过了，确认办完', t.id); },
    reject: function (d) { var t = T(d.t); t.wait = false; db.notes.push({ ts: Date.now(), who: 'me', to: t.owner, text: '这次不行，退回重做。', t: t.id, k: 'msg' }); },
    clear: function () { db = blank(); stack = []; },
    cancel: function (d) { T(d.t).state = 'cancel'; note('me', '取消了这件事', d.t); stack.pop(); stack.pop(); },
    add: function () { var n = document.getElementById('f0').value.trim(), r = document.getElementById('f1').value.trim(); if (!n || !r) return; var p = { id: uid('p'), name: n, role: r, prompt: '', reach: [], pc: null, env: null, conn: [] }; db.people.push(p); note('me', '新增了员工' + n + '（' + r + '）'); stack.pop(); stack.push({ p: 'talk', id: p.id }); },
    sample: function () { db = sample(); stack = []; },
    drop: function (d) { P(d.id).gone = true; note('me', '把' + N(d.id) + '移出了团队'); stack = []; },
    role: function (d) { var p = P(d.id), r = document.getElementById('f1').value.trim(); if (r) p.role = r; p.prompt = document.getElementById('pt').value.trim(); note('me', '改了' + p.name + '的岗位和提示'); stack.pop(); },
    addres: function (d) { var el = document.getElementById('rn'), v = el.value.trim(); if (!v) { el.focus(); return; } var r = { id: uid('r'), name: v }, p = P(d.id); db.res[d.k].push(r); if (d.k === 'conn') p.conn.push(r.id); else p[d.k] = r.id; note('me', '登记了' + KIND[d.k][0] + '「' + v + '」，并分配给' + p.name); }
  };
  function draw() {
    var g = stack[stack.length - 1], h = g ? PAGE[g.p](g) : PAGE[db.tab]();
    if (!g) { var n = tops().filter(mine).length; h += '<div class="tabs">' + TABS.map(function (t) { return '<button data-tab="' + t[0] + '" aria-current="' + (t[0] === db.tab) + '">' + t[2] + t[1] + (t[0] === 'things' && n ? '<em>' + n + '</em>' : '') + '</button>'; }).join('') + '</div>'; }
    document.getElementById('app').innerHTML = h;
    var bd = document.querySelector('.body'); if (bd && g && (g.p === 'talk' || g.p === 'chat')) bd.scrollTop = 1e6;
  }
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-go],[data-tab],[data-do]'); if (!el) return;
    if (el.dataset.do) DO[el.dataset.do](el.dataset);
    else if (el.dataset.tab) { db.tab = el.dataset.tab; stack = []; }
    else if (el.dataset.go === 'back') stack.pop();
    else stack.push(JSON.parse(el.dataset.go));
    save(); draw();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return; var m = { say: 'say', rn: 'addres' }[e.target.id]; if (!m) return;
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
