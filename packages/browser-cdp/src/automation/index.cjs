'use strict';
const { failure } = require('./errors.cjs');
const { declaration } = require('./page-functions.cjs');
const { createFrames } = require('./frames.cjs');
const { clickPoint } = require('./geometry.cjs');
const { press } = require('./keyboard.cjs');
const { parseRequest } = require('./request.cjs');

const capabilities = Object.freeze({ protocolVersion: 1, backend: 'electron-cdp', domInspection: true,
  semanticInput: true, trustedInput: true, networkObservation: 'none', screenshot: false, deviceEmulation: 'none' });
const methods = ['inspect', 'readContext', 'click', 'fill', 'press', 'scroll', 'wait'];

/** The host lends its connection and invocation guards; this consumer never
 * attaches, navigates, captures, takes control or destroys the native page. */
function createCdpAutomation(options) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(options.instanceId || '')) throw failure('INVALID_ARGUMENT', 'A unique browser instance identity is required');
  const transport = options.transport;
  const frames = createFrames(transport, options.sessions, `opencraft.browser.${options.instanceId}`);
  const snapshots = new Map(), controllers = new Set();
  let disposed = false, inputUncertain = false, revision = 0, callId = 0, tail = Promise.resolve();
  const assertLive = () => { if (disposed) throw failure('PAGE_CLOSED', 'Browser automation was disposed'); };

  async function run(method, input, invocation) {
    assertLive(); invocation.validate?.();
    if (inputUncertain && !['inspect', 'readContext', 'wait'].includes(method))
      throw failure('INPUT_STATE_UNKNOWN', 'Browser input release was not confirmed; close and reopen this browser tab', 'unknown');
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => controller.abort();
    invocation.signal?.addEventListener('abort', abort, { once: true });
    if (invocation.signal?.aborted) controller.abort();
    const timeout = Math.min(60000, Math.max(1, invocation.timeoutMs ?? (method === 'wait' ? input.timeoutMs + 2000 : 30000)));
    const timer = setTimeout(abort, timeout);
    let effects = false, releaseDrawing;
    const groups = new Set();
    const call = {
      group: `opencraft-browser-${options.instanceId}-${++callId}`,
      check() { assertLive(); invocation.validate?.(); if (controller.signal.aborted) throw failure('CDP_ABORTED', 'Browser operation cancelled'); },
      async send(method, params = {}, session) {
        call.check(); groups.add(session);
        const mutates = method.startsWith('Input.') || method === 'DOM.focus' || method === 'DOM.scrollIntoViewIfNeeded';
        if (mutates) effects = true;
        const result = await transport.send(method, params, session, { signal: controller.signal, validate: () => {
          call.check(); call.validateReference?.();
        } });
        if (result?.exceptionDetails) throw failure('CDP_EVALUATION_FAILED', 'Browser observation failed');
        call.check(); return result;
      },
      // Native up events release already admitted gestures despite lost document
      // or control. They neither target a replacement element nor restart input.
      async cleanup(method, params, session) {
        try { return await transport.send(method, params, session, { timeoutMs: 2000 }); }
        catch (error) { inputUncertain = true; throw error; }
      },
      async value(world, method, args = [], objectId) {
        frames.assert(world);
        const result = await call.send('Runtime.callFunctionOn', {
          ...(objectId ? { objectId } : { executionContextId: world.contextId }),
          functionDeclaration: declaration(method), arguments: args.map(value => ({ value })), returnByValue: true, awaitPromise: true,
        }, world.session || undefined);
        return result.result.value;
      },
    };
    try {
      releaseDrawing = await options.acquireDrawing(); call.check();
      const frameList = await frames.list(call);
      call.render = async () => {
        const root = [...frameList.values()].find(frame => !frame.parentId);
        if (!root) throw failure('DOCUMENT_NOT_READY', 'Browser main frame unavailable');
        await call.value(await frames.world(root, call), 'rendered');
      };
      call.frameViewport = async frame => call.value(await frames.world(frame, call), 'viewport');
      if (method === 'inspect') {
        const next = ++revision, references = new Map(), elements = [];
        let rootInfo;
        for (const frame of frameList.values()) {
          if (elements.length >= 500) break;
          const world = await frames.world(frame, call);
          if (!frame.parentId) rootInfo = await call.value(world, 'context', [1, false]);
          const result = await call.send('Runtime.callFunctionOn', {
            executionContextId: world.contextId, functionDeclaration: declaration('collect'),
            arguments: [{ value: 500 - elements.length }], objectGroup: call.group,
          }, world.session || undefined);
          const objectId = result.result.objectId;
          const properties = await call.send('Runtime.getProperties', { objectId, ownProperties: true }, world.session || undefined);
          const metadata = await call.value(world, 'describeAll', [], objectId);
          for (const property of properties.result) {
            if (!/^\d+$/.test(property.name) || !property.value?.objectId) continue;
            const meta = metadata[Number(property.name)];
            const node = await call.send('DOM.describeNode', { objectId: property.value.objectId }, world.session || undefined);
            const ref = `${options.instanceId}:${next}:${elements.length + 1}`;
            references.set(ref, { world, backendNodeId: node.node.backendNodeId, metadata: meta });
            elements.push({ ref, role: meta.role, name: meta.name, disabled: meta.disabled,
              ...(meta.value !== undefined ? { value: meta.value } : {}), frameId: frame.id });
          }
        }
        for (const reference of references.values()) frames.assert(reference.world);
        snapshots.set(next, references);
        while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value);
        return { url: rootInfo?.url || '', title: rootInfo?.title || '', revision: next, elements };
      }
      if (method === 'readContext' || method === 'wait') {
        const read = async currentFrames => {
          const limit = Math.min(200000, Math.max(1, input.maxInlineChars ?? 50000));
          if (!Number.isFinite(limit)) throw failure('INVALID_ARGUMENT', 'Invalid browser context size');
          let result, remaining = limit;
          for (const frame of currentFrames.values()) {
            if (remaining <= 0) break;
            const world = await frames.world(frame, call);
            const context = await call.value(world, 'context', [remaining, input.includeSelection !== false]);
            if (!frame.parentId) result = { ...context, revision };
            else if (result && context.content) result.content += `\n${context.content}`;
            remaining -= context.content.length + 1;
          }
          return result || { url: '', title: '', revision, selection: null, content: '' };
        };
        if (method === 'readContext') return read(frameList);
        if (typeof input.text !== 'string' || !input.text || !Number.isFinite(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 60000)
          throw failure('INVALID_ARGUMENT', 'Invalid browser wait');
        const deadline = Date.now() + input.timeoutMs;
        let current = frameList;
        do {
          if ((await read(current)).content.includes(input.text)) return;
          if (Date.now() >= deadline) throw failure('WAIT_TIMEOUT', 'Browser text did not appear in time');
          await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
          call.check(); current = await frames.list(call);
        } while (true);
      }
      if (method === 'press') { await call.render(); await press(call.send, call.cleanup, input.key, options.platform); await call.render(); return; }
      if (method === 'scroll') {
        if (![input.x, input.y].every(value => Number.isFinite(value) && Math.abs(value) <= 10000)) throw failure('INVALID_ARGUMENT', 'Invalid browser scroll');
        await call.render();
        const metrics = await call.send('Page.getLayoutMetrics');
        await call.send('Input.dispatchMouseEvent', { type: 'mouseWheel',
          x: metrics.cssVisualViewport.clientWidth / 2, y: metrics.cssVisualViewport.clientHeight / 2,
          deltaX: input.x, deltaY: input.y });
        await call.render(); return;
      }
      const reference = snapshots.get(input.expectedRevision)?.get(input.ref);
      if (!reference) throw failure('STALE_REF', 'Unknown or expired browser reference; inspect again');
      const currentFrame = frameList.get(reference.world.id);
      if (!currentFrame || currentFrame.session !== reference.world.session || currentFrame.loaderId !== reference.world.loaderId)
        throw failure('STALE_REF', 'Browser document changed; inspect again');
      frames.assert(reference.world);
      call.validateReference = () => frames.assert(reference.world);
      const session = reference.world.session || undefined;
      const resolved = await call.send('DOM.resolveNode', { backendNodeId: reference.backendNodeId,
        executionContextId: reference.world.contextId, objectGroup: call.group }, session);
      const objectId = resolved.object.objectId;
      if (!objectId) throw failure('STALE_REF', 'Browser element was removed; inspect again');
      const checkElement = async () => {
        const code = await call.value(reference.world, 'check', [reference.metadata, method === 'fill'], objectId);
        if (code) throw failure(code, 'Browser element changed or is unavailable; inspect again');
      };
      await checkElement();
      if (method === 'click') {
        const point = await clickPoint(call, reference, objectId, frameList);
        await checkElement();
        let down = false;
        try {
          await call.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none' }, session);
          down = true;
          await call.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, session);
        } finally {
          if (down) await call.cleanup('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, session);
        }
        return;
      }
      if (typeof input.value !== 'string' || input.value.length > 100000) throw failure('INVALID_ARGUMENT', 'Invalid browser fill value');
      await call.send('DOM.focus', { objectId }, session);
      await call.render();
      if (!await call.value(reference.world, 'focused', [], objectId)) throw failure('ELEMENT_NOT_ACTIONABLE', 'Browser element did not retain focus');
      await call.value(reference.world, 'selectContents', [], objectId);
      await checkElement();
      if (!await call.value(reference.world, 'focused', [], objectId)) throw failure('ELEMENT_NOT_ACTIONABLE', 'Browser element lost focus');
      await call.send('Input.insertText', { text: input.value });
      await call.render();
    } catch (error) {
      throw failure(error?.code || 'BROWSER_ERROR', error?.message || 'Browser operation failed', effects ? 'unknown' : 'not-dispatched');
    } finally {
      clearTimeout(timer); controllers.delete(controller); invocation.signal?.removeEventListener('abort', abort);
      // Failed/disposed consumers still release their own temporary handles.
      await Promise.allSettled([...groups].map(session => transport.send('Runtime.releaseObjectGroup',
        { objectGroup: call.group }, session, { timeoutMs: 1000 })));
      releaseDrawing?.();
    }
  }
  const api = {
    capabilities,
    invoke(method, input = {}, invocation = {}) {
      if (!methods.includes(method)) return Promise.reject(failure('INVALID_ARGUMENT', 'Unsupported browser operation'));
      try { assertLive(); invocation.validate?.(); input = parseRequest(method, input, options.platform); }
      catch (error) { return Promise.reject(error); }
      const operation = tail.then(() => run(method, input, invocation));
      tail = operation.catch(() => {}); return operation;
    },
    dispose() { if (disposed) return; disposed = true; for (const controller of controllers) controller.abort(); frames.dispose(); snapshots.clear(); },
  };
  for (const method of methods) api[method] = (input, invocation) => api.invoke(method, input, invocation);
  return api;
}
module.exports = { createCdpAutomation, capabilities };
