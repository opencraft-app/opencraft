const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { build } = require('esbuild');
const http = require('http'), fs = require('fs'), path = require('path');
(async () => {
  const output = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'annotation-preview-'));
  await build({ entryPoints: [path.join(__dirname, 'smoke-annotation-file-preview.entry.ts')], bundle: true, format: 'esm', minify: true, outfile: path.join(output, 'frame-bundle.js') });
  fs.writeFileSync(path.join(output, 'frame.html'), '<!doctype html><title>Parent</title><script type=module src=frame-bundle.js></script>');
  const server = http.createServer((req, res) => { const name = req.url === '/' ? 'frame.html' : req.url === '/frame-bundle.js' ? 'frame-bundle.js' : null; if (!name) { res.writeHead(404); res.end(); return; } const f = path.join(output, name); res.setHeader('content-type', f.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(fs.readFileSync(f)); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 600, height: 500 } });
  try {
  const errors = []; p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto('http://127.0.0.1:' + server.address().port + '/'); await p.waitForTimeout(600);
  const frame = p.frames().find(f => f !== p.mainFrame());
  const r = {};
  r.pageScriptsRun = await frame.evaluate(() => window.pageReady === true);
  r.sandboxKeepsParentOut = await frame.evaluate(() => window.leak) === 'blocked';
  await p.evaluate(() => window.t.start()); await p.waitForTimeout(100);
  // Scroll inside the frame, then tap the button through real input.
  await frame.evaluate(() => scrollTo(0, 300)); await p.waitForTimeout(100);
  const box = await frame.locator('#go').boundingBox();
  await p.mouse.click(box.x + 10, box.y + 5); await p.waitForTimeout(150);
  r.tapBlockedFromPage = await frame.evaluate(() => !window.clicked);
  const taps = await p.evaluate(() => window.t.taps);
  r.tapReported = taps.length === 1;
  const pick = await p.evaluate(p0 => window.t.annotator.pick({ point: p0 }), taps[0]);
  r.pickFindsButton = pick.anchor.selector === 'button#go' && pick.anchor.text === 'Expand all';
  r.documentCoords = pick.anchor.rect.y === Math.round(await frame.evaluate(() => document.getElementById('go').getBoundingClientRect().top + scrollY));
  r.fileIdentity = pick.anchor.url === '/repo/report.html' && pick.anchor.source === '/repo/report.html' && pick.anchor.ref === '';
  const up = await p.evaluate(p0 => window.t.annotator.pick({ point: p0, depth: 1 }), taps[0]);
  r.parentStep = up.anchor.tag === 'div';
  await p.evaluate(() => window.t.annotator.reveal(0.1)); await p.waitForTimeout(80);
  const movedParent = await p.evaluate(({ point, selector }) => window.t.annotator.pick({ point, selector, depth: 1 }), { point: taps[0], selector: pick.anchor.selector });
  r.parentStepAfterReveal = movedParent.anchor.tag === 'div';
  const inputBox = await frame.locator('#pw').boundingBox();
  const sens = await p.evaluate(pt => window.t.annotator.pick({ point: pt }), { x: inputBox.x - 8 + 5, y: inputBox.y - 8 + 5, frameWidth: 500, frameHeight: 400 });
  r.sensitiveRedacted = sens.anchor.sensitive === true && !JSON.stringify(sens).includes('s3cret');
  await p.evaluate(a => window.t.annotator.mark([{ ...a.rect, label: '1' }], '#339cff'), pick.anchor); await p.waitForTimeout(100);
  r.markDrawnInFrame = await frame.evaluate(() => !!document.getElementById('opencraft-annotation-host'));
  await p.screenshot({ path: path.join(output, 'frame-marked.png') });
  // Forged reply from the page itself can't break shape: parent sanitizes.
  r.forgedIgnoredWithoutToken = await p.evaluate(async () => { window.postMessage({ channel: 'opencraft-annotation', token: 'x', type: 'tap', point: { x: 1, y: 1, frameWidth: 1, frameHeight: 1 } }, '*'); await new Promise(r => setTimeout(r, 50)); return window.t.taps.length === 1; });
  // Stop: page clicks work again.
  await p.evaluate(() => window.t.annotator.intercept({ tap() {} })()); await p.waitForTimeout(50);
  const box2 = await frame.locator('#go').boundingBox();
  await p.mouse.click(box2.x + 10, box2.y + 5); await p.waitForTimeout(100);
  r.clicksRestoredAfterStop = await frame.evaluate(() => window.clicked === 1);
  await p.evaluate(() => window.t.start());
  await p.evaluate(() => window.t.annotator.dispose());
  await p.waitForTimeout(50);
  await p.mouse.click(box2.x + 10, box2.y + 5);
  r.disposeRestoresClicks = await frame.evaluate(() => window.clicked === 2);
  r.disposeRemovesMarks = await frame.evaluate(() => !document.getElementById('opencraft-annotation-host'));
  r.disposedPickRejected = await p.evaluate(async () => { try { await window.t.annotator.pick({ point: window.t.taps[0] }); return false; } catch { return true; } });
  r.noErrors = errors.length === 0; if (errors.length) r.errors = errors.join(' | ');
  console.log(JSON.stringify(r, null, 1));
  for (const [name, passed] of Object.entries(r)) assert.equal(passed, true, name);
  } finally { await b.close(); server.close(); fs.rmSync(output, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
