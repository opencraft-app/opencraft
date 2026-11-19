// 运行：node --test examples/matter-canvas/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const here = new URL('.', import.meta.url);
globalThis.window = globalThis;
for (const f of ['scenario.js', 'engine.js']) vm.runInThisContext(readFileSync(new URL(f, here), 'utf8'), { filename: f });
const E = globalThis.MatterEngine;
const fresh = () => E.validate(E.clone(globalThis.MATTER_DSL));
const world = (dsl, caseId = 'release', book = E.emptyBook(), n = 1) => E.makeWorld(dsl, book, E.newRun(dsl, caseId, n), 'real');
const auto = (w) => { while (E.advance(w)); return w; };
const pickFirst = (w) => ({ bot: E.caseOf(w).market[0] });
const types = (w) => w.run.events.map((e) => e.type);

test('默认条件下演示一口气跑完，并标明是模拟验收', () => {
  for (const id of ['release', 'reward', 'expo']) {
    const w = E.settle(E.demoWorld(fresh(), id), pickFirst);
    assert.equal(E.caseOf(w).steps[w.state.idx].kind, 'done', id);
    assert.equal(w.state.accepted.by, 'demo');
    assert.equal(E.keep(w, w.state.hired, 'x'), false, '演示不能留下联系人');
    assert.deepEqual(w.book, E.emptyBook());
  }
});

test('消息送达之后，对方电脑才出现动作和材料', () => {
  const w = world(fresh());
  E.act(w);
  assert.deepEqual(types(w), ['sent']);
  assert.equal(w.state.messages[0].state, 'sent');
  assert.equal(w.state.files.length, 0);
  assert.equal(w.state.working, null);
  E.advance(w); E.advance(w);
  assert.equal(w.state.working.operator, 'yan');
  E.advance(w);
  assert.deepEqual(w.state.files.map((f) => [f.owner, f.name]), [['yan', '签字页索引']]);
  assert.equal(w.state.idx, 1);
});

test('联系方式、发送许可、实际发送是三件事；许可有方向', () => {
  const w = world(fresh());
  w.book.grants['alan>yan'] = false;
  const ev = E.act(w);
  assert.equal(ev.type, 'blocked'); assert.equal(ev.reason, 'grant');
  assert.ok(E.knows(w, 'alan', 'yan'), '虚线仍在');
  assert.ok(E.granted(w, 'yan', 'alan'), '反方向不受影响');
  assert.equal(w.state.messages.length, 0, '言禾的手机没有新消息');
  w.book.grants['alan>yan'] = true;
  assert.equal(E.act(w).type, 'sent');
});

test('电脑开关影响执行：关闭文件处理，相关步骤停下', () => {
  const w = world(fresh());
  w.book.comp.yan = { work: false };
  E.act(w); auto(w);
  assert.equal(w.state.halt.type, 'stalled');
  assert.equal(w.state.files.length, 0);
  w.book.comp.yan = { work: true };
  E.act(w); auto(w);
  assert.equal(w.state.idx, 1);
});

test('沙盒页码为 2 而栅栏要求 3：指出不符并留在返工；恢复后可重试交付', () => {
  const dsl = fresh();
  const w = world(dsl);
  E.settle(w, (x) => (E.caseOf(x).steps[x.state.idx].kind === 'deliver' ? false : pickFirst(x)));
  E.nodeOf(E.caseOf(w), 'sandbox').fixture['签字页码'] = 2;
  E.act(w); auto(w);
  assert.equal(w.state.halt.type, 'checked');
  assert.deepEqual(w.state.halt.diffs, [{ key: '签字页码', expected: 3, actual: 2 }]);
  assert.equal(E.caseOf(w).steps[w.state.idx].kind, 'deliver');
  assert.ok(!w.state.messages.some((m) => m.envelope === '核签结果'));
  E.nodeOf(E.caseOf(w), 'sandbox').fixture['签字页码'] = 3;
  E.act(w); auto(w);
  assert.equal(E.caseOf(w).steps[w.state.idx].kind, 'confirm');
  const art = w.state.files.find((f) => f.kind === 'artifact');
  const sub = w.state.files.find((f) => f.kind === 'submission');
  assert.equal(art.submitter, 'fold'); assert.equal(art.values['签字页码'], 3);
  assert.equal(art.version, sub.version, '提交件与收件是同一版本');
});

test('叮嘱：必须包含的词缺失会拦住；自然语言叮嘱请人确认', () => {
  const w = world(fresh());
  w.book.comp.fold = { review: '必须包含：签字' };
  w.book.comp.alan = { review: '语气要客气' };
  E.settle(w, (x) => pickFirst(x));
  assert.equal(w.state.halt.type, 'held'); assert.equal(w.state.halt.term, '签字');
  E.act(w, { revise: true }); auto(w);
  assert.equal(w.state.halt.type, 'askhuman'); assert.equal(w.state.halt.review, '语气要客气');
  E.act(w, { approve: true }); auto(w);
  assert.equal(E.caseOf(w).steps[w.state.idx].kind, 'confirm');
  assert.match(w.state.files.find((f) => f.kind === 'artifact').version, /^v2·/);
});

test('重试同一次投递，只有一份收件和结果', () => {
  const w = world(fresh());
  E.act(w); auto(w);
  const id = w.state.messages[0].id;
  assert.equal(E.redeliver(w, id).type, 'dedup');
  assert.equal(w.state.messages.length, 1); assert.equal(w.state.files.length, 1);
  const again = E.makeWorld(w.dsl, w.book, JSON.parse(JSON.stringify(w.run)), 'real');
  assert.deepEqual(again.state.files, w.state.files, '由事件重放可恢复');
});

test('留下小折后另开一轮：凭备注直接邀请，文件留在原事项，授权单独管理', () => {
  const dsl = fresh(), book = E.emptyBook();
  const w1 = E.settle(world(dsl, 'release', book), (x) => pickFirst(x));
  assert.equal(E.candidates(w1)[0].via, 'market');
  E.keep(w1, 'fold', '擅长核对签字页');
  const w2 = world(dsl, 'release', book, 2);
  assert.deepEqual(E.candidates(w2)[0], { id: 'fold', via: 'contacts', note: '擅长核对签字页' });
  assert.ok(E.knows(w2, 'alan', 'fold')); assert.ok(!E.granted(w2, 'alan', 'fold'), '留下不等于获准自由发消息');
  assert.equal(w2.state.files.length, 0); assert.equal(w1.state.files.length, 6);
  E.settle(w2, (x) => ({ bot: 'fold' }));
  assert.equal(w2.state.hiredVia, 'contacts'); assert.equal(w2.state.accepted.by, 'user');
});

test('实际办理与演示各有进度', () => {
  const dsl = fresh(), real = world(dsl);
  E.act(real); auto(real);
  const before = JSON.stringify(real.run);
  E.settle(E.demoWorld(dsl, 'release'), pickFirst);
  assert.equal(JSON.stringify(real.run), before);
  assert.equal(real.state.messages.filter((m) => m.from === 'alan' && m.to === 'yan').length, 1);
  assert.equal(E.caseOf(real).steps[real.state.idx].status, '等回复');
});

test('领奖联调：帮手复测后由雷鸣独立复核；展览换场：场馆先来信', () => {
  const r = E.settle(world(fresh(), 'reward'), pickFirst);
  const art = r.state.files.find((f) => f.kind === 'artifact');
  assert.deepEqual(art.values, { 连点请求数: 1, 重复弹窗数: 0 });
  assert.ok(r.state.messages.some((m) => m.from === 'lei' && m.to === 'xi'));
  assert.match(r.state.messages.at(-1).text, /可安排进真机联调/);
  const x = world(fresh(), 'expo');
  assert.equal(E.act(x).from, 'shan');
  E.settle(x, pickFirst);
  assert.deepEqual(x.state.files.find((f) => f.kind === 'artifact').values, { 'A 组入场': '14:30', 'B 组入场': '14:45' });
});

test('改一份 DSL 就能换负责人', () => {
  const dsl = fresh(), c = dsl.cases[0];
  c.owner = 'su'; c.steps.forEach((s) => { for (const k of ['source', 'target']) if (s[k] === 'alan') s[k] = 'su'; if (s.desktop && s.desktop.operator === 'alan') s.desktop.operator = 'su'; });
  const w = world(dsl);
  assert.equal(E.act(w).reason, 'contact', '苏木没有言禾的联系方式');
  dsl.contacts.push(['su', 'yan']); dsl.grants.push(['su', 'yan'], ['yan', 'su']);
  E.settle(w, pickFirst);
  assert.equal(w.state.files.find((f) => f.kind === 'artifact').owner, 'su');
});
