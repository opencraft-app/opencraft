import assert from 'node:assert/strict';
import test from 'node:test';
import {retainRightPanelPresentation} from '../../apps/workbench-web/src/components/panel-presentation-admission';
const empty={open:false,tabCount:0,hostActive:false};
test('never-opened empty panel defers presentation without hiding restored tabs or Host intent',()=>{
 assert.equal(retainRightPanelPresentation(false,empty),false);
 for(const demand of [{...empty,open:true},{...empty,tabCount:1},{...empty,hostActive:true}])assert.equal(retainRightPanelPresentation(false,demand),true);
});
test('admitted presentation remains resident after close, last-tab removal and owner changes',()=>{
 let visited=false;
 const expected=[false,true,true,true,true];let index=0;
 for(const demand of [empty,{...empty,tabCount:2},empty,{...empty,tabCount:1},empty]){
  visited=retainRightPanelPresentation(visited,demand);
  assert.equal(visited,expected[index++]);
 }
 assert.equal(retainRightPanelPresentation(true,empty),true);
});
