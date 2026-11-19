/* 老板管理 Bot 员工。结构是微信那一套：底部三个标签，点进去是整页。
   消息：老板自己的手机，直属下属的对话列表，招募从这里发起。通讯录：所有人，进去看资料。办公室：三维画面（scene.js），只占这一个标签。
   员工资料三个页签：手机（他在联系谁 / 他能联系谁）、电脑（他在做什么 / 他能做什么）、岗位。
   这是结构原型，没有接真实的 Bot：你发出去的话不会有人回。示例内容是一份静态快照，清空后各处如实显示为空。 */
(function () {
  'use strict';
  var KEY = 'opencraft.matter-canvas.v7', $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var KIND = { pc: ['电脑', '例如：办公室的 Mac mini'], env: ['云环境', '例如：测试环境'], conn: ['连接器', '例如：飞书、邮箱'] };
  var TABS = [['talk', '对话'], ['phone', '手机'], ['pc', '电脑'], ['role', '岗位']];

  function blank() { return { people: [], outs: [], msgs: [], res: { pc: [], env: [], conn: [] }, n: 0, sample: false }; }
  function sample() { /* 一家小工作室老板眼里的某个下午 */
    var d = blank(), now = Date.now(), look = 0;
    [['pc', 'r1', '办公室的 Mac mini'], ['pc', 'r2', '机房的 Linux 主机'], ['env', 'r3', '测试环境'], ['env', 'r4', '客户演示环境'], ['conn', 'r5', '飞书'], ['conn', 'r6', '企业邮箱'], ['conn', 'r7', 'GitHub'], ['conn', 'r8', '公司网盘']].forEach(function (r) { d.res[r[0]].push({ id: r[1], name: r[2] }); });
    d.outs.push({ id: 'o1', name: '客户周姐' });
    function person(id, name, role, boss, prompt, pc, env, conn, reach, doing) { d.people.push({ id: id, name: name, role: role, boss: boss, prompt: prompt, pc: pc, env: env, conn: conn, reach: reach, doing: doing || '', look: look++ }); }
    person('a', '阿岚', '项目交付', 'me', '你负责把版本按时交到客户手里。缺什么材料自己找同事要，拿不准的事先问老板。交付前一定让人核对签字页。', 'r1', 'r4', ['r5', 'r6', 'r8'], ['y', 'o1'], '');
    person('y', '言禾', '合同与验收', 'me', '你保管合同和验收文件。别人来要文件，先确认是哪个版本，再给盖章的那一份。', 'r1', null, ['r5', 'r8'], ['a', 'c'], '');
    person('c', '沐川', '行政与账号', 'me', '你负责开账号、订会议室、收报销单。办完告诉交办的人。', 'r2', null, ['r5', 'r6', 'r7'], ['y'], '在企业邮箱里翻 10 月的报销邮件，一封封登记到表里');
    person('z', '小折', '文档核对', 'a', '你只做核对：版本、页码、签章。核完写清楚看的是哪一份、结论是什么。', 'r2', 'r3', ['r8'], [], '');
    person('t', '秋池', '对账', 'c', '你核对每一笔报销和发票是否对得上，对不上的列出来交给沐川。', null, null, ['r6'], ['n'], '');
    person('n', '北野', '采购', 'c', '你负责买办公用品和订场地。超过预算先问沐川。', null, null, [], ['t'], '');
    function msg(min, from, to, text, more) { d.msgs.push(Object.assign({ id: 'm' + d.msgs.length, ts: now - min * 60000, who: from, to: to, text: text }, more || {})); }
    msg(200, 'me', 'c', '周三下午客户来访，订个大会议室，要能投影。'); msg(170, 'c', 'me', '周三下午 2 点到 4 点的大会议室订好了，投影也借了。');
    msg(94, 'me', 'a', '周五要把 2.3 版本交给客户，你来负责。缺什么自己找人。');
    msg(80, 'a', 'y', '言禾，客户盖章的验收签字页在你那吗？周五交付要用。'); msg(62, 'y', 'a', '在，发你了。有两个附件页码不一样，盖章的是其中一份，你最好找人核一下。');
    msg(55, 'a', 'z', '帮我核一下这两份签字页：哪份是盖章的，版本对不对。'); msg(30, 'z', 'a', '核完了。盖章的是第 3 页那份，版本 2.3，和交付清单一致。');
    msg(26, 'a', 'o1', '周姐，2.3 版本周五上午发您，签字页我们已经核对过了。');
    msg(49, 'me', 'c', '下周一有新同事入职，账号提前开好。'); msg(22, 'c', 'me', '邮箱和飞书开好了。GitHub 要等他把用户名发我，我已经问了。');
    msg(17, 'a', 'me', '签字页核对好了，交付包齐了。你看一眼核对单，没问题我就发给客户。', { ask: 'open', file: '2.3 版本签字页核对单', body: '盖章的是第 3 页那一份。\n版本号 2.3，和交付清单一致。\n核对人：小折。\n交付包里的三样都齐了：安装包、测试回执、验收签字页。' });
    msg(40, 'me', 'c', '把 10 月的报销单整理一下，周五前给我。'); msg(12, 'c', 't', '10 月的报销我登记到一半，登完发你对账。');
    d.n = 100; d.sample = true; return d;
  }
  var db = sample();
  try { var raw = JSON.parse(localStorage.getItem(KEY)); if (raw && raw.people && raw.msgs && raw.v === 3) db = raw; } catch (e) { /* 没有存储也能用 */ }
  function save() { db.v = 3; try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ } }
  function uid(p) { db.n += 1; return p + db.n; }
  function P(id) { return db.people.filter(function (x) { return x.id === id; })[0]; }
  function O(id) { return db.outs.filter(function (x) { return x.id === id; })[0]; }
  function N(id) { return id === 'me' ? '你' : (P(id) || O(id) || {}).name || '已移出的人'; }
  function R(k, id) { return db.res[k].filter(function (x) { return x.id === id; })[0]; }
  function thread(a, b) { return db.msgs.filter(function (x) { return (x.who === a && x.to === b) || (x.who === b && x.to === a); }).sort(function (x, y) { return x.ts - y.ts; }); }
  function partners(id) { var o = []; db.msgs.slice().sort(function (x, y) { return y.ts - x.ts; }).forEach(function (x) { var p = x.who === id ? x.to : x.to === id ? x.who : null; if (p && o.indexOf(p) < 0) o.push(p); }); return o; }
  function kin(id) { var p = P(id), o = []; if (p && p.boss) o.push(p.boss); db.people.forEach(function (x) { if (x.boss === id) o.push(x.id); }); return o; } /* 上级和直接下属：归谁管就总能联系 */
  function below(id) { var o = []; db.people.forEach(function (x) { if (x.boss === id) o.push(x.id); }); o.slice().forEach(function (j) { o = o.concat(below(j)); }); return o; }
  function canTalk(id, j) { return kin(id).indexOf(j) >= 0 || ((P(id) || {}).reach || []).indexOf(j) >= 0; }
  function asks(id) { return db.msgs.filter(function (x) { return x.to === 'me' && x.ask === 'open' && (!id || x.who === id); }); }
  function hhmm(ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }

  /* ---------- 界面：微信的结构。三个标签（消息、通讯录、办公室），点进去是整页，左上角返回。 ---------- */
  var TABBAR = [['chats', '消息', '<path d="M12 4.500c-4.700 0-8.500 3.100-8.500 7 0 2.200 1.200 4.100 3.100 5.400L6 20l3.400-1.600c.8.200 1.700.300 2.600.300 4.700 0 8.500-3.100 8.500-7s-3.800-7.200-8.500-7.200z"/>'], ['people', '通讯录', '<circle cx="9" cy="9" r="3.200"/><path d="M3.500 19c.6-3 2.800-4.800 5.500-4.800s4.900 1.800 5.500 4.800M16 6.500a2.800 2.800 0 0 1 0 5.400M17.500 14.600c1.600.7 2.700 2.200 3 4.400"/>'], ['office', '办公室', '<path d="M12 3.500 4 8v8l8 4.500 8-4.500V8z"/><path d="M4 8l8 4.500L20 8M12 12.500v8"/>']];
  var AVC = ['#a9dcc9', '#c3b5ee', '#a9c8f2', '#fbe39c', '#f9cdb0', '#bfe3ee', '#d9e8a6'];
  var ui = { tab: 'chats', stack: [], sel: null, sub: null }, has3d = false;
  function top() { return ui.stack[ui.stack.length - 1]; }
  function cur() { var t = top(); return t && (t.k === 'chat' || t.k === 'profile') ? P(t.id) : null; }
  function reachOf(id) { var p = P(id), o = kin(id); if (p) p.reach.forEach(function (j) { if (o.indexOf(j) < 0) o.push(j); }); return o; }
  function toScene() {
    var nodes = [{ id: 'me', name: '你', kind: 'me', pc: true }], links = [], boss = [];
    db.people.forEach(function (p) { nodes.push({ id: p.id, name: p.name, kind: 'bot', look: p.look, badge: asks(p.id).length, busy: !!p.doing, pc: !!(p.pc || p.env) }); boss.push([p.boss, p.id]); links.push([p.boss, p.id]); p.reach.forEach(function (j) { if (P(j) || O(j)) links.push([p.id, j]); }); });
    db.outs.forEach(function (o) { nodes.push({ id: o.id, name: o.name, kind: 'out' }); });
    return { nodes: nodes, links: links, boss: boss };
  }
  function sync() { if (has3d) { window.Office.sync(toScene()); window.Office.select(ui.sel, ui.sel ? reachOf(ui.sel) : []); } }
  function pick(id) { if (id && id !== 'me' && !P(id) && !O(id)) id = null; ui.sel = id; if (has3d) window.Office.select(id, id ? reachOf(id) : []); draw(); }
  function go(page) { ui.sub = null; var prev = ui.stack[ui.stack.length - 2]; if (prev && prev.id === page.id && prev.k === page.k) ui.stack.pop(); else ui.stack.push(page); draw(); } /* 对话和资料来回点，不越叠越深 */

  function av(id) { var p = P(id); return '<span class="av" style="--c:' + (id === 'me' ? '#f4f1f6' : p ? AVC[(p.look || 0) % AVC.length] : '#f6c1c7') + '"></span>'; }
  function nav(title, right) { return '<header class="nav"><button class="back" data-do="back">‹ 返回</button><h1>' + esc(title) + '</h1><span class="r">' + (right || '') + '</span></header>'; }
  function sec(cls, title, body) { return '<section class="sec ' + cls + '"><h3>' + title + '</h3>' + body + '</section>'; }
  function none(t) { return '<p class="none">' + t + '</p>'; }
  function cell(page, id, title, sub, right) { return '<button class="cell" data-go=\'' + esc(JSON.stringify(page)) + '\'>' + av(id) + '<span class="t"><b>' + title + '</b>' + (sub ? '<span>' + sub + '</span>' : '') + '</span>' + (right ? '<span class="rt">' + right + '</span>' : '') + '</button>'; }
  function bubble(m, self) { return '<div class="msg' + (m.who === self ? ' out' : '') + '"><div class="bub">' + esc(m.text) + (m.file ? '<details class="file"><summary>' + esc(m.file) + '</summary><pre>' + esc(m.body) + '</pre></details>' : '') + '</div><time>' + (m.who !== self && self !== 'me' ? esc(N(m.who)) + ' · ' : '') + hhmm(m.ts) + '</time>' +
    (m.ask === 'open' && self === 'me' ? '<div class="ask"><button class="btn ok" data-do="accept" data-id="' + m.id + '">可以</button><button class="btn" data-do="reject" data-id="' + m.id + '">不行，退回</button></div>' : m.ask && self === 'me' ? '<div class="asked">' + (m.ask === 'ok' ? '你说了可以' : '你退回了') + '</div>' : '') + '</div>'; }

  /* 标签一：消息。老板自己的手机，只有直接归你管的人 */
  function chats() {
    var mine = db.people.filter(function (p) { return p.boss === 'me' || thread('me', p.id).length; });
    function last(p) { var l = thread('me', p.id).pop(); return l ? l.ts : 0; }
    mine.sort(function (a, b) { return (asks(b.id).length - asks(a.id).length) || (last(b) - last(a)); });
    return '<header class="bar"><h1>消息</h1><button class="btn ok" data-go=\'{"k":"recruit"}\'>招募</button></header><div class="body">' + (mine.length ? mine.map(function (p) { var l = thread('me', p.id).pop(), n = asks(p.id).length;
      return cell({ k: 'chat', id: p.id }, p.id, esc(p.name) + '<em>' + esc(p.boss === 'me' ? p.role || '未填岗位' : '归' + N(p.boss) + '管') + '</em>', (n ? '<i class="dot">' + n + '</i>' : '') + esc(l ? (l.who === 'me' ? '你：' : '') + l.text : '还没有说过话'), l ? hhmm(l.ts) : ''); }).join('') : sec('', '还没有人', none('手机里还没有人。点右上角「招募」，招第一位员工。'))) +
      '<p class="foot">这是原型，没有接真实的 Bot，你发出去的话不会有人回。<button class="lk" data-do="' + (db.sample ? 'clear">清空示例' : 'sample">放回示例') + '</button></p></div>';
  }
  /* 标签二：通讯录。所有人都在，管理从这里进 */
  function people() {
    var mine = db.people.filter(function (p) { return p.boss === 'me'; }), rest = db.people.filter(function (p) { return p.boss !== 'me'; });
    function rows(list) { return list.map(function (p) { return cell({ k: 'profile', id: p.id, tab: 'phone' }, p.id, esc(p.name), esc(p.role || '未填岗位'), p.boss === 'me' ? '' : '归' + esc(N(p.boss)) + '管'); }).join(''); }
    return '<header class="bar"><h1>通讯录</h1></header><div class="body"><button class="cell" data-go=\'{"k":"recruit"}\'><span class="av plus">+</span><span class="t"><b>招募新员工</b><span>给个名字和岗位，他就入职</span></span></button>' +
      (mine.length ? '<h4>直接归你管</h4>' + rows(mine) : '') + (rest.length ? '<h4>其他员工</h4>' + rows(rest) : '') + (db.outs.length ? '<h4>公司外的人</h4>' + db.outs.map(function (o) { return cell({ k: 'out', id: o.id }, o.id, esc(o.name), '公司外'); }).join('') : '') + (db.people.length ? '' : none('通讯录还是空的。')) + '</div>';
  }
  /* 标签三：办公室。三维画面在 .stage 里，这里只出底部那张卡片 */
  function card() {
    var id = ui.sel, p = P(id), o = O(id);
    if (!id) return '<p class="hint">点一个小家伙看他能联系谁。拖动、双指缩放可以凑近看。</p>';
    if (id === 'me') return '<div class="pcard">' + av('me') + '<span class="t"><b>你</b><span>这间办公室的老板</span></span><button class="btn ok" data-do="tab" data-id="chats">看消息</button></div>';
    if (o) return '<div class="pcard">' + av(o.id) + '<span class="t"><b>' + esc(o.name) + '</b><span>公司外的人</span></span><button class="btn" data-go=\'' + esc(JSON.stringify({ k: 'out', id: o.id })) + '\'>查看</button></div>';
    return '<div class="pcard">' + av(p.id) + '<span class="t"><b>' + esc(p.name) + '</b><span>' + esc(p.role || '未填岗位') + ' · 归' + esc(N(p.boss)) + '管</span></span>' + (p.boss === 'me' ? '<button class="btn ok" data-go=\'' + esc(JSON.stringify({ k: 'chat', id: p.id })) + '\'>对话</button>' : '') + '<button class="btn" data-go=\'' + esc(JSON.stringify({ k: 'profile', id: p.id, tab: 'phone' })) + '\'>手机和电脑</button></div>';
  }

  /* 整页：对话 */
  function chat(p) { var t = thread('me', p.id);
    return nav(p.name, '<button class="lk" data-go=\'' + esc(JSON.stringify({ k: 'profile', id: p.id, tab: 'phone' })) + '\'>资料</button>') + '<div class="body chat" id="chat">' + (t.length ? t.map(function (m) { return bubble(m, 'me'); }).join('') : none('还没有对话。对他说第一件要办的事。')) + '</div>' + (p.boss === 'me' ? '<form class="say" data-do="say"><input id="say" autocomplete="off" placeholder="对' + esc(p.name) + '说要办什么" aria-label="对' + esc(p.name) + '说"><button class="btn ok">发送</button></form>' : '<p class="say cap">' + esc(p.name) + '现在归' + esc(N(p.boss)) + '管。以前的话还在，新的事请对' + esc(N(p.boss)) + '说。</p>'); }
  /* 整页：员工资料。手机 / 电脑 / 岗位 */
  function profile(p, page) {
    var body = ({ phone: phone, pc: pc, role: role })[page.tab](p);
    return nav('员工资料') + '<div class="who">' + av(p.id) + '<span class="t"><b>' + esc(p.name) + '</b><span>' + esc(p.role || '未填岗位') + ' · 归' + esc(N(p.boss)) + '管</span></span></div><div class="acts pad">' + (p.boss === 'me' || thread('me', p.id).length ? '<button class="btn ok" data-go=\'' + esc(JSON.stringify({ k: 'chat', id: p.id })) + '\'>' + (p.boss === 'me' ? '发消息' : '看你们以前的对话') + '</button>' : '') + (p.boss === 'me' ? '' : '<span class="cap">他归' + esc(N(p.boss)) + '管，要交办事情请对' + esc(N(p.boss)) + '说。</span>') + '<button class="btn" data-do="see" data-id="' + p.id + '">在办公室里看他</button></div>' +
      '<div class="tabs" role="tablist">' + [['phone', '手机'], ['pc', '电脑'], ['role', '岗位']].map(function (t) { return '<button role="tab" aria-selected="' + (page.tab === t[0]) + '" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>' + body;
  }
  function phone(p) {
    if (ui.sub) { var t = thread(p.id, ui.sub); return '<div class="body chat"><button class="lk" data-do="sub" data-id="">‹ 回到他的手机</button><p class="cap">' + esc(p.name) + ' 和 ' + esc(N(ui.sub)) + ' 的聊天记录（只读）</p>' + t.map(function (m) { return bubble(m, p.id); }).join('') + '</div>'; }
    var ps = partners(p.id), k = kin(p.id), all = db.people.filter(function (x) { return x.id !== p.id && k.indexOf(x.id) < 0; }).concat(db.outs);
    function tagOf(j) { return j === p.boss ? '<em>他的上级</em>' : k.indexOf(j) >= 0 ? '<em>他的下属</em>' : O(j) ? '<em>公司外</em>' : ''; }
    return '<div class="body">' + sec('mint', '他在联系谁', ps.length ? ps.map(function (j) { var l = thread(p.id, j).pop(); return '<button class="row" data-do="sub" data-id="' + j + '"><b>' + esc(N(j)) + tagOf(j) + (canTalk(p.id, j) ? '' : '<em>现在不能联系</em>') + '</b><span>' + esc((l.who === p.id ? '他：' : '') + l.text) + '</span></button>'; }).join('') : none('他还没有联系过别人。')) +
      sec('mint', '他能联系谁', k.map(function (j) { return '<div class="sw fixed"><input type="checkbox" checked disabled><span>' + esc(N(j)) + tagOf(j) + '</span></div>'; }).join('') + (k.length ? '<p class="cap">上级和下属总能互相联系，不用勾。</p>' : '') + (all.length ? all.map(function (x) { return '<label class="sw"><input type="checkbox" data-sw="reach" data-id="' + x.id + '"' + (p.reach.indexOf(x.id) >= 0 ? ' checked' : '') + '><span>' + esc(x.name) + (O(x.id) ? '<em>公司外</em>' : '') + '</span></label>'; }).join('') : none('还没有别人可以联系。')) +
        '<form class="inl" data-do="out"><input id="out" autocomplete="off" placeholder="加一位公司外的人，例如：客户周姐" aria-label="公司外的人"><button class="btn">添加</button></form><p class="cap">勾选后，办公室里他会自己挪到这些人附近。</p>') + '</div>';
  }
  function pc(p) {
    function one(k) { return '<label class="fld"><span>' + KIND[k][0] + '</span><select data-sw="' + k + '"><option value="">不分配</option>' + db.res[k].map(function (r) { return '<option value="' + r.id + '"' + (p[k] === r.id ? ' selected' : '') + '>' + esc(r.name) + '</option>'; }).join('') + '</select></label>'; }
    return '<div class="body">' + sec('sky', '他在做什么', p.doing ? '<div class="doing"><i></i>' + esc(p.doing) + '</div><p class="cap">用的是：' + esc([R('pc', p.pc), R('env', p.env)].filter(Boolean).map(function (r) { return r.name; }).join('、') || '还没有分配电脑') + '</p>' : none('他的电脑现在空着。')) +
      sec('sky', '他能做什么', one('pc') + one('env') + '<div class="fld"><span>连接器</span><div class="chips">' + (db.res.conn.map(function (r) { return '<label class="chip ck"><input type="checkbox" data-sw="conn" data-id="' + r.id + '"' + (p.conn.indexOf(r.id) >= 0 ? ' checked' : '') + '>' + esc(r.name) + '</label>'; }).join('') || '<span class="none">还没有登记连接器。</span>') + '</div></div>' +
        '<form class="inl" data-do="res"><select id="resk" aria-label="类型">' + Object.keys(KIND).map(function (k) { return '<option value="' + k + '">' + KIND[k][0] + '</option>'; }).join('') + '</select><input id="resn" autocomplete="off" placeholder="登记一个新的给他" aria-label="名称"><button class="btn">登记</button></form>') + '</div>';
  }
  function role(p) {
    return '<form class="body" data-do="role"><label class="fld"><span>名字</span><input id="rname" value="' + esc(p.name) + '" autocomplete="off"></label><label class="fld"><span>岗位</span><input id="rrole" value="' + esc(p.role) + '" autocomplete="off" placeholder="例如：项目交付"></label><label class="fld"><span>归谁管</span><select id="rboss"><option value="me">你</option>' +
      db.people.filter(function (x) { return x.id !== p.id && below(p.id).indexOf(x.id) < 0; }).map(function (x) { return '<option value="' + x.id + '"' + (p.boss === x.id ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select></label><label class="fld col"><span>岗位提示</span><textarea id="rprompt" rows="5" placeholder="告诉他这个岗位该怎么做事">' + esc(p.prompt) + '</textarea></label><div class="acts"><button class="btn ok">保存</button><button type="button" class="btn danger" data-do="drop">移出办公室</button></div></form>';
  }
  function outside(o) { var who = db.people.filter(function (p) { return p.reach.indexOf(o.id) >= 0; });
    return nav(o.name) + '<div class="who">' + av(o.id) + '<span class="t"><b>' + esc(o.name) + '</b><span>公司外的人</span></span></div><div class="body">' + sec('mint', '谁能联系他', who.length ? who.map(function (p) { return cell({ k: 'profile', id: p.id, tab: 'phone' }, p.id, esc(p.name), esc(p.role || '未填岗位')); }).join('') : none('现在没有人能联系他。')) + '<p><button class="btn danger" data-do="dropout" data-id="' + o.id + '">从门外移走</button></p></div>'; }
  function recruit() { return nav('招募新员工') + '<form class="body" data-do="add"><p class="cap">先给个名字和岗位。入职后他会出现在办公室里，其余的进去再配。</p><label class="fld"><span>名字</span><input id="nname" autocomplete="off" placeholder="例如：青柚"></label><label class="fld"><span>岗位</span><input id="nrole" autocomplete="off" placeholder="例如：客服"></label><label class="fld"><span>归谁管</span><select id="nboss"><option value="me">你</option>' + db.people.map(function (x) { return '<option value="' + x.id + '">' + esc(x.name) + '</option>'; }).join('') + '</select></label><div class="acts"><button class="btn ok">让他入职</button></div></form>'; }

  function draw() {
    var t = top(), view = $('view'), b = view.querySelector('.body'), keep = b ? b.scrollTop : 0, key = JSON.stringify(t || ui.tab) + ui.sub, same = view.getAttribute('data-key') === key;
    while (t && ((t.k === 'chat' || t.k === 'profile') && !P(t.id) || t.k === 'out' && !O(t.id))) { ui.stack.pop(); t = top(); }
    var office = !t && ui.tab === 'office';
    view.innerHTML = t ? (t.k === 'chat' ? chat(P(t.id)) : t.k === 'profile' ? profile(P(t.id), t) : t.k === 'out' ? outside(O(t.id)) : recruit()) : ui.tab === 'chats' ? chats() : ui.tab === 'people' ? people() : '';
    view.setAttribute('data-key', key); view.hidden = office; $('office').hidden = !office; $('card').innerHTML = office ? card() : '';
    var n = asks().length; $('tabbar').hidden = !!t; $('tabbar').innerHTML = TABBAR.map(function (x) { return '<button data-do="tab" data-id="' + x[0] + '" aria-current="' + (ui.tab === x[0] ? 'page' : 'false') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + x[2] + '</svg>' + x[1] + (x[0] === 'chats' && n ? '<i class="dot">' + n + '</i>' : '') + '</button>'; }).join('');
    var nb = view.querySelector('.body'); if (nb && same) nb.scrollTop = keep; var c = $('chat'); if (c && !same) c.scrollTop = c.scrollHeight;
    if (office && has3d) window.Office.resize();
  }

  var DO = {
    tab: function (el) { ui.tab = el.getAttribute('data-id'); ui.stack = []; draw(); },
    back: function () { if (ui.sub && top() && top().k === 'profile') ui.sub = null; else ui.stack.pop(); draw(); },
    see: function (el) { ui.stack = []; ui.tab = 'office'; draw(); pick(el.getAttribute('data-id')); },
    sub: function (el) { ui.sub = el.getAttribute('data-id') || null; draw(); },
    say: function () { var v = $('say').value.trim(), p = cur(); if (!v || !p || p.boss !== 'me') return; db.msgs.push({ id: uid('m'), ts: Date.now(), who: 'me', to: p.id, text: v }); save(); $('view').removeAttribute('data-key'); draw(); $('say').focus(); },
    accept: function (el) { answer(el.getAttribute('data-id'), 'ok', '可以，就这样。'); },
    reject: function (el) { answer(el.getAttribute('data-id'), 'no', '不行，退回，再看看。'); },
    out: function () { var v = $('out').value.trim(), p = cur(); if (!v || !p) return; var o = { id: uid('o'), name: v }; db.outs.push(o); p.reach.push(o.id); save(); sync(); draw(); },
    res: function () { var v = $('resn').value.trim(), k = $('resk').value, p = cur(); if (!v) return; var r = { id: uid('r'), name: v }; db.res[k].push(r); if (p) { if (k === 'conn') p.conn.push(r.id); else p[k] = r.id; } save(); sync(); draw(); },
    role: function () { var p = cur(); if (!p) return; p.name = $('rname').value.trim() || p.name; p.role = $('rrole').value.trim(); p.prompt = $('rprompt').value.trim(); p.boss = $('rboss').value; save(); sync(); draw(); },
    drop: function () { var p = cur(); if (!p || !window.confirm('把' + p.name + '移出办公室？他的聊天记录也会一起删掉。')) return; var id = p.id; db.people = db.people.filter(function (x) { return x.id !== id; }); db.people.forEach(function (x) { if (x.boss === id) x.boss = p.boss; x.reach = x.reach.filter(function (j) { return j !== id; }); }); db.msgs = db.msgs.filter(function (m) { return m.who !== id && m.to !== id; }); if (ui.sel === id) ui.sel = null; ui.stack = []; ui.tab = 'people'; save(); sync(); draw(); },
    dropout: function (el) { var id = el.getAttribute('data-id'); db.outs = db.outs.filter(function (x) { return x.id !== id; }); db.people.forEach(function (x) { x.reach = x.reach.filter(function (j) { return j !== id; }); }); db.msgs = db.msgs.filter(function (m) { return m.who !== id && m.to !== id; }); if (ui.sel === id) ui.sel = null; ui.stack = []; save(); sync(); draw(); },
    add: function () { var v = $('nname').value.trim(); if (!v) { $('nname').focus(); return; } var p = { id: uid('p'), name: v, role: $('nrole').value.trim(), boss: $('nboss').value, prompt: '', pc: null, env: null, conn: [], reach: [], doing: '', look: db.n }; db.people.push(p); ui.stack = [{ k: 'profile', id: p.id, tab: 'role' }]; ui.tab = 'people'; save(); sync(); draw(); },
    clear: function () { if (!window.confirm('清空示例？办公室会变成空的。')) return; db = blank(); ui.sel = null; save(); sync(); draw(); },
    sample: function () { db = sample(); ui.sel = null; save(); sync(); draw(); }
  };
  function answer(id, state, text) { var m = db.msgs.filter(function (x) { return x.id === id; })[0]; if (!m) return; m.ask = state; db.msgs.push({ id: uid('m'), ts: Date.now(), who: 'me', to: m.who, text: text }); save(); sync(); $('view').removeAttribute('data-key'); draw(); }
  var SW = {
    reach: function (el, p) { var id = el.getAttribute('data-id'); p.reach = p.reach.filter(function (j) { return j !== id; }); if (el.checked) p.reach.push(id); sync(); draw(); },
    conn: function (el, p) { var id = el.getAttribute('data-id'); p.conn = p.conn.filter(function (j) { return j !== id; }); if (el.checked) p.conn.push(id); },
    pc: function (el, p) { p.pc = el.value || null; sync(); }, env: function (el, p) { p.env = el.value || null; sync(); }
  };

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-tab]'); if (t && top()) { top().tab = t.getAttribute('data-tab'); ui.sub = null; draw(); return; }
    var g = e.target.closest('[data-go]'); if (g) { go(JSON.parse(g.getAttribute('data-go'))); return; }
    var d = e.target.closest('button[data-do]'); if (d) { e.preventDefault(); DO[d.getAttribute('data-do')](d); }
  });
  document.addEventListener('submit', function (e) { var f = e.target.closest('form[data-do]'); if (f) { e.preventDefault(); DO[f.getAttribute('data-do')](f); } });
  document.addEventListener('change', function (e) { var el = e.target.closest('[data-sw]'), p = cur(); if (!el || !p) return; SW[el.getAttribute('data-sw')](el, p); save(); });

  has3d = !!(window.Office && window.Office.init($('stage'), $('labels'), pick));
  if (!has3d) $('fail').hidden = false;
  draw(); sync();
  window.__app = { pick: pick, go: go, db: function () { return db; } };
})();
