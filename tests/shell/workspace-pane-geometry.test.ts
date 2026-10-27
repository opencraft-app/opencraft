import assert from "node:assert/strict";
import test from "node:test";
import { workspacePaneGeometry, paneTransitionIntent } from "../../apps/workbench-web/src/components/workspace-pane-geometry";

test("Workspace frame never follows the maximization aperture below its ordinary split width",()=>{
  for(const full of [0,.1,.5,.9,1,1.02]){
    const value=workspacePaneGeometry(1000,600,1,full,480);
    assert.equal(value.frameWidth,480);
    assert.ok(Math.abs(value.frameX+480-value.viewportWidth)<1e-8);
    assert.ok(Math.abs(value.viewportWidth-Math.max(0,400*(1-Math.min(1,full))))<1e-8);
    assert.ok(value.frameWidth>=value.viewportWidth);
  }
});
test("hide/reverse retain the lower bound without freezing ordinary resize or window geometry",()=>{
  for(const workspace of [800,1000,1400])for(const normal of [320,480,600])
    for(const visibility of [0,.1,.5,.9,1])for(const full of [0,.3,1]){
      const value=workspacePaneGeometry(workspace,normal,visibility,full,480);
      assert.ok(value.frameWidth>=workspace-normal);
      assert.ok(value.frameWidth>=value.viewportWidth-1e-8);
      if(visibility===0)assert.equal(value.frameWidth,workspace);
    }
  assert.notEqual(workspacePaneGeometry(1000,320,1,0,480).frameWidth,workspacePaneGeometry(1000,480,1,0,480).frameWidth);
});
test("scope snaps and mode changes do not leave a half-closed visibility transaction running",()=>{
  const previous={scope:"thread-a",open:true,fullWidth:false};
  assert.deepEqual(paneTransitionIntent(previous,{...previous,fullWidth:true},false),{snap:false,forceVisibility:true,visibilityTarget:1,fullWidthTarget:1});
  assert.equal(paneTransitionIntent(previous,{...previous,scope:"thread-b"},false).snap,true);
  assert.equal(paneTransitionIntent(previous,previous,true).snap,true);
  const close=paneTransitionIntent({...previous,fullWidth:true},{...previous,open:false},false);
  assert.equal(close.forceVisibility,false);assert.equal(close.visibilityTarget,0);assert.equal(close.fullWidthTarget,0);
});

test("small workspaces retain readable chat width and translate rather than reflow below it", () => {
  for (const width of [0, 240, 320, 390, 430, 480, 640, 800, 1280]) {
    for (const visibility of [0, .01, .25, .5, .9, 1]) {
      for (const full of [0, .1, .5, 1]) {
        const geometry = workspacePaneGeometry(width, 320, visibility, full, 480);
        assert.ok(geometry.frameWidth >= Math.min(width, 480));
        assert.ok(geometry.frameWidth >= geometry.viewportWidth - 1e-8);
        assert.ok(Math.abs(geometry.frameX + geometry.frameWidth - geometry.viewportWidth) < 1e-8,
          "chat right edge follows its aperture throughout motion");
        if (width <= 480) assert.equal(geometry.frameWidth, width, "narrow chat retains its unoccluded layout");
        if (visibility === 0) assert.equal(geometry.frameX, 0, "closed tools restore original position");
      }
    }
  }
  assert.equal(workspacePaneGeometry(390, 320, 1, 0, 480).frameWidth, 390);
  assert.equal(workspacePaneGeometry(390, 320, 1, 0, 480).frameX, -320);
  assert.equal(workspacePaneGeometry(1280, 600, 1, 0, 480).frameX, 0,
    "ordinary desktop split does not shift when it fits");
});
