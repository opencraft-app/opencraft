import test from 'node:test';
import assert from 'node:assert/strict';
import { screenshotCrop } from '../../apps/workbench-web/src/browser-annotation/screenshot-geometry';
test('crop bounds round inward and preserve only target pixels', () => {
  assert.deepEqual(screenshotCrop({left:.1,right:.3,top:.2,bottom:.4},1000,500),{x:100,y:100,w:200,h:100,width:200,height:100});
});
test('missing, invisible, inverted or nonfinite target never becomes full-page capture', () => {
  for(const region of [{top:0,bottom:1},{left:0,right:0,top:0,bottom:1},{left:-.1,right:1,top:0,bottom:1},{left:0,right:1,top:NaN,bottom:1}]) assert.throws(()=>screenshotCrop(region,1000,500));
});
test('large crops cap both dimensions', () => {
  const crop=screenshotCrop({left:0,right:1,top:0,bottom:1},2000,6000);
  assert.equal(crop.height,1024);assert.ok(crop.width<=1024);
});
