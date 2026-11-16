'use strict';
const { failure } = require('./errors.cjs');
function createFrames(transport, sessions, worldName) {
  const initialized = new Set(), worlds = new Map();
  const unsubscribe = transport.subscribe(event => {
    const session = event.sessionId || '';
    for (const [id, world] of worlds) {
      const clear = event.method === 'Page.frameNavigated' && event.params.frame?.id === id
        || event.method === 'Page.frameDetached' && event.params.frameId === id && event.params.reason !== 'swap'
        || event.method === 'Runtime.executionContextsCleared' && world.session === session
        || event.method === 'Runtime.executionContextDestroyed' && world.session === session && event.params.executionContextId === world.contextId
        || event.method === 'Target.detachedFromTarget' && world.session === event.params.sessionId;
      if (clear) worlds.delete(id);
    }
    if (event.method === 'Target.detachedFromTarget') initialized.delete(event.params.sessionId);
  });
  return {
    async list(call) {
      const frames = new Map();
      const liveSessions = new Set(['', ...sessions().map(target => target.sessionId)]);
      for (const session of initialized) if (!liveSessions.has(session)) initialized.delete(session);
      for (const [id, world] of worlds) if (!liveSessions.has(world.session)) worlds.delete(id);
      const visit = (tree, session, parentId) => {
        const frame = tree.frame, previous = frames.get(frame.id);
        frames.set(frame.id, { id: frame.id, parentId: frame.parentId || parentId || previous?.parentId,
          loaderId: frame.loaderId, url: frame.url, session });
        for (const child of tree.childFrames || []) visit(child, session, frame.id);
      };
      // Parent trees come first; an attached target owns its own subtree.
      for (const session of liveSessions) {
        if (!initialized.has(session)) {
          await call.send('Page.enable', {}, session || undefined);
          await call.send('Runtime.enable', {}, session || undefined);
          initialized.add(session);
        }
        const result = await call.send('Page.getFrameTree', {}, session || undefined);
        visit(result.frameTree, session);
      }
      for (const [id, world] of worlds) {
        const frame = frames.get(id);
        if (!frame || frame.session !== world.session || frame.loaderId !== world.loaderId) worlds.delete(id);
      }
      return frames;
    },
    async world(frame, call) {
      let world = worlds.get(frame.id);
      if (!world || world.loaderId !== frame.loaderId || world.session !== frame.session) {
        const result = await call.send('Page.createIsolatedWorld', {
          frameId: frame.id, worldName, grantUniveralAccess: false,
        }, frame.session || undefined);
        world = { ...frame, contextId: result.executionContextId };
        worlds.set(frame.id, world);
      }
      return world;
    },
    assert(world) {
      if (worlds.get(world.id) !== world) throw failure('STALE_REF', 'Browser frame or document changed; inspect again');
    },
    dispose() { unsubscribe(); worlds.clear(); initialized.clear(); },
  };
}
module.exports = { createFrames };
