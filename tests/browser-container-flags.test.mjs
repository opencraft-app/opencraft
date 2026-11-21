import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../', import.meta.url));
const text = readFileSync(join(source,'apps/headless-server/src/remote-browser/owner.cjs'),'utf8');
const main = text.slice(text.indexOf('if (require.main === module)'));
test('actual browser launch retains small-shm mitigation without disabling sandbox', async () => {
  const module = { exports: {} }, require = { main: module };
  const process = { env: { OPENCRAFT_BROWSER_DATA_DIR:'/tmp/fixture-browser', ELECTRON_RUN_AS_NODE:'1' }, exitCode:undefined };
  let launched;
  const execute = new Function('require','module','__dirname','join','process','createBrowserOwner','spawn','installOwnerSignals',main);
  execute(require,module,'/owned/runtime/browser',join,process,
    async options => { options.spawnWorker(); return {}; },
    (executable,args,options) => { launched = { executable,args,options }; return {}; },()=>{});
  await Promise.resolve();
  assert.equal(launched.executable,'/owned/runtime/browser/electron/electron');
  assert(launched.args.includes('--disable-dev-shm-usage'));
  assert(launched.args.includes('--ozone-platform=headless'));
  assert(!launched.args.includes('--no-sandbox'));
  assert.equal(launched.args.at(-1),'/owned/runtime/browser/worker.cjs');
  assert.equal(launched.options.env.ELECTRON_RUN_AS_NODE,undefined);
  assert.equal(process.env.ELECTRON_RUN_AS_NODE,'1');
});
