import assert from 'node:assert/strict';
import test from 'node:test';
import {equivalentToolbarRaster} from '../../scripts/smoke/shell/toolbar-pixel-comparison.mjs';
test('toolbar pixel tolerance admits measured sparse antialiasing but refuses broad or strong paint',()=>{
 assert.equal(equivalentToolbarRaster({totalPixels:1624,changedPixels:0,maxChannelDelta:0}),true);
 assert.equal(equivalentToolbarRaster({totalPixels:1624,changedPixels:1,maxChannelDelta:5}),true);
 for(const delta of [{totalPixels:1624,changedPixels:3,maxChannelDelta:1},{totalPixels:1624,changedPixels:1,maxChannelDelta:9},{totalPixels:1624,changedPixels:100,maxChannelDelta:80},{totalPixels:0,changedPixels:0,maxChannelDelta:0}])assert.equal(equivalentToolbarRaster(delta),false);
});
