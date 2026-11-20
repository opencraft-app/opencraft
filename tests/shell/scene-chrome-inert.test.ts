import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { suspendSceneChrome } from '../../apps/workbench-web/src/components/scene-chrome-inert';

function fixture(t: test.TestContext) {
  const dom = new JSDOM(`<main class="app-shell-root">
    <header data-retained-preview-chrome></header>
    <div class="thread-composer-overlay-host"><footer class="thread-scroll-footer"></footer></div>
    <section class="app-shell-root"><header data-retained-preview-chrome></header></section>
  </main>`);
  // jsdom has no native inert reflection; model the HTML boolean attribute.
  Object.defineProperty(dom.window.HTMLElement.prototype, 'inert', {
    configurable: true,
    get() { return this.hasAttribute('inert'); },
    set(value: boolean) { if (value) this.setAttribute('inert', ''); else this.removeAttribute('inert'); },
  });
  const old = Object.getOwnPropertyDescriptors(globalThis);
  for (const name of ['Element', 'HTMLElement', 'MutationObserver'] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] });
  }
  t.after(() => {
    dom.window.close();
    for (const name of ['Element', 'HTMLElement', 'MutationObserver']) {
      if (old[name]) Object.defineProperty(globalThis, name, old[name]); else Reflect.deleteProperty(globalThis, name);
    }
  });
  const root = dom.window.document.querySelector<HTMLElement>('main')!;
  return { root, header: root.querySelector<HTMLElement>('header')!, nested: root.querySelector<HTMLElement>('section header')!,
    flush: () => new Promise<void>(resolve => setTimeout(resolve, 0)) };
}

test('chrome input leases cover side title and floating composer, isolate nested Shell', t => {
  const f = fixture(t), release = suspendSceneChrome(f.root);
  assert.equal(f.header.inert, true);
  assert.equal(f.root.querySelector<HTMLElement>('.thread-composer-overlay-host')!.inert, true);
  assert.equal(f.root.querySelector<HTMLElement>('footer')!.inert, true);
  assert.equal(f.nested.inert, false);
  release(); release();
  assert.equal(f.header.inert, false);
});

test('later input owner writes survive release, including pending redundant true', async t => {
  const f = fixture(t);
  let release = suspendSceneChrome(f.root);
  f.header.inert = true;
  release();
  assert.equal(f.header.inert, true);
  release = suspendSceneChrome(f.root);
  f.header.inert = false;
  await f.flush();
  assert.equal(f.header.inert, true, 'presentation still blocks input');
  release();
  assert.equal(f.header.inert, false, 'latest owner intent restored');
});

test('new chrome is leased, reparented chrome is released to its new Shell', async t => {
  const f = fixture(t), release = suspendSceneChrome(f.root);
  const newHeader = f.header.cloneNode() as HTMLElement;
  newHeader.inert = false;
  f.root.append(newHeader);
  await f.flush();
  assert.equal(newHeader.inert, true);
  f.nested.parentElement!.append(newHeader);
  await f.flush();
  assert.equal(newHeader.inert, false);
  f.header.remove();
  await f.flush();
  assert.equal(f.header.inert, false);
  release();
});
