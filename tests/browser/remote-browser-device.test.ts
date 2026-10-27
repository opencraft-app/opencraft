import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteBrowserDeviceProfile } from '../../apps/workbench-web/src/browser/remote-browser-device';

test('mobile identity is recognized independently of viewport width and physical DPR', () => {
  assert.equal(remoteBrowserDeviceProfile({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile MicroMessenger/8', maxTouchPoints: 5 }), 'iphone');
  assert.equal(remoteBrowserDeviceProfile({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/152 Mobile MicroMessenger/8', maxTouchPoints: 5 }), 'android-phone');
  assert.equal(remoteBrowserDeviceProfile({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/152', maxTouchPoints: 5 }), 'android-tablet');
  assert.equal(remoteBrowserDeviceProfile({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', maxTouchPoints: 5 }), 'ipad');
  assert.equal(remoteBrowserDeviceProfile({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', platform: 'MacIntel', maxTouchPoints: 5 }), 'ipad');
});

test('desktop and hybrid inputs retain desktop identity; reduced Android hints are supported', () => {
  assert.equal(remoteBrowserDeviceProfile({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', maxTouchPoints: 10 }), 'desktop-touch');
  assert.equal(remoteBrowserDeviceProfile({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)', platform: 'MacIntel' }), 'desktop');
  assert.equal(remoteBrowserDeviceProfile({ userAgentData: { platform: 'Android', mobile: true } }), 'android-phone');
  assert.equal(remoteBrowserDeviceProfile({}), 'desktop');
});
