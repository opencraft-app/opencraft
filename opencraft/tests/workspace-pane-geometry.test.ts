import assert from "node:assert/strict";
import test from "node:test";
import { workspacePaneGeometry, paneTransitionIntent } from "../apps/workbench-web/src/components/workspace-pane-geometry";

test("Codex Frame never follows the maximization aperture below its ordinary split width",()=>{
  for(const full of [0,.1,.5,.9,1,1.02]){
    const value=workspacePaneGeometry(1000,600,1,full);
    assert.equal(value.frameWidth,400);
    assert.ok(Math.abs(value.viewportWidth-Math.max(0,400*(1-Math.min(1,full))))<1e-8);
    assert.ok(value.frameWidth>=value.viewportWidth);
  }
});
test("hide/reverse retain the lower bound without freezing ordinary resize or window geometry",()=>{
  for(const workspace of [800,1000,1400])for(const normal of [320,480,600])
    for(const visibility of [0,.1,.5,.9,1])for(const full of [0,.3,1]){
      const value=workspacePaneGeometry(workspace,normal,visibility,full);
      assert.ok(value.frameWidth>=workspace-normal);
      assert.ok(value.frameWidth>=value.viewportWidth-1e-8);
      if(visibility===0)assert.equal(value.frameWidth,workspace);
    }
  assert.notEqual(workspacePaneGeometry(1000,320,1,0).frameWidth,workspacePaneGeometry(1000,480,1,0).frameWidth);
});
test("scope snaps and mode changes do not leave a half-closed visibility transaction running",()=>{
  const previous={scope:"thread-a",open:true,fullWidth:false};
  assert.deepEqual(paneTransitionIntent(previous,{...previous,fullWidth:true},false),{snap:false,forceVisibility:true,visibilityTarget:1,fullWidthTarget:1});
  assert.equal(paneTransitionIntent(previous,{...previous,scope:"thread-b"},false).snap,true);
  assert.equal(paneTransitionIntent(previous,previous,true).snap,true);
  const close=paneTransitionIntent({...previous,fullWidth:true},{...previous,open:false},false);
  assert.equal(close.forceVisibility,false);assert.equal(close.visibilityTarget,0);assert.equal(close.fullWidthTarget,0);
});
