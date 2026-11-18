import test from 'node:test';
import assert from 'node:assert/strict';
import { placeAnnotationCard, stepStyleNumber, ratioStyleValue, parseStyleNumber } from '../../apps/workbench-web/src/browser-annotation/annotation-polish';

test('card prefers adjacent non-overlapping placement and stays below toolbar', () => {
  const target = { x: 20, y: 180, width: 100, height: 50 };
  const box = placeAnnotationCard({width: 1100, height: 800}, {width: 360, height: 460}, target, 130);
  assert.ok(box.x >= target.x + target.width); assert.ok(box.y >= 142);
  assert.ok(box.x + box.width <= 1088); assert.ok(box.y + box.height <= 788);
});
test('narrow/short viewport cannot put actions outside available area', () => {
  for (const width of [240, 320, 390, 1100]) for (const height of [250, 450, 844]) {
    const box = placeAnnotationCard({width, height}, {width: 360, height: 600}, {x: 30,y: 180,width:100,height:200}, 100);
    assert.ok(box.x >= 0 && box.y >= 0); assert.ok(box.x + box.width <= width); assert.ok(box.y + box.height <= height);
  }
});
test('numeric increments preserve units and reject CSS expressions rather than guessing', () => {
  assert.equal(stepStyleNumber('12px', 1), '13px'); assert.equal(stepStyleNumber('1.2rem', 1), '1.3rem');
  assert.equal(stepStyleNumber('0px', -1), '0px'); assert.equal(stepStyleNumber('25%', 10), '35%');
  for (const value of ['auto', 'calc(100% - 5px)', 'var(--size)', '12px 8px', 'Infinity']) assert.equal(parseStyleNumber(value), null);
  assert.equal(stepStyleNumber('12px', NaN), null);
});
test('ratio linking requires compatible absolute units and nonzero dimensions', () => {
  assert.equal(ratioStyleValue('200px','100px','50px'), '100px');
  for (const [a,b,c] of [['50%', '25%', '100%'], ['12px','0px','10px'], ['10px','2rem','3rem'], ['auto','100px','50px']]) assert.equal(ratioStyleValue(a!, b!, c!), null);
});
