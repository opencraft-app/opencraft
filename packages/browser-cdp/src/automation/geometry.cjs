'use strict';
const { failure } = require('./errors.cjs');
const { declaration } = require('./page-functions.cjs');

async function hitMatches(call, world, objectId, point) {
  const session = world.session || undefined;
  let hit;
  try { hit = await call.send('DOM.getNodeForLocation', {
      x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: false,
    }, session);
  } catch (error) {
    if (error?.code === 'CDP_COMMAND_FAILED' && /No node found at given location/.test(error.message)) return false;
    throw error;
  }
  if (hit.frameId !== world.id) return false;
  const node = await call.send('DOM.resolveNode', { backendNodeId: hit.backendNodeId,
    executionContextId: world.contextId, objectGroup: call.group }, session);
  const result = await call.send('Runtime.callFunctionOn', {
    objectId, functionDeclaration: declaration('containsHit'), arguments: [{ objectId: node.object.objectId }], returnByValue: true,
  }, session);
  return result.result.value === true;
}

async function clickPoint(call, reference, objectId, frames) {
  const session = reference.world.session || undefined;
  await call.send('DOM.scrollIntoViewIfNeeded', { objectId }, session);
  await call.render();
  const { quads } = await call.send('DOM.getContentQuads', { objectId }, session);
  let point;
  for (const quad of quads || []) {
    const candidate = { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 };
    if (await hitMatches(call, reference.world, objectId, candidate)) { point = candidate; break; }
  }
  if (!point) throw failure('ELEMENT_OBSCURED', 'Browser element has no visible hit point');

  const nativePoint = { ...point };
  // CDP quads are relative to the owning target viewport. Walk target roots
  // into parent target viewports. Same-process frames already share coordinates.
  let targetRoot = [...frames.values()].find(frame => frame.session === reference.world.session
    && (!frame.parentId || frames.get(frame.parentId)?.session !== frame.session));
  while (targetRoot?.parentId) {
    const parent = frames.get(targetRoot.parentId);
    if (!parent) throw failure('STALE_REF', 'Browser parent frame changed');
    const owner = await call.send('DOM.getFrameOwner', { frameId: targetRoot.id }, parent.session || undefined);
    const box = await call.send('DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, parent.session || undefined);
    // Page.getLayoutMetrics on an attached iframe can describe the top-level
    // viewport. Read the actual frame dimensions from its isolated world.
    const viewport = await call.frameViewport(targetRoot), quad = box.model.content;
    if (!(viewport.width > 0 && viewport.height > 0)) throw failure('ELEMENT_NOT_ACTIONABLE', 'Browser frame has no viewport');
    if (Math.abs(quad[4] - quad[2] - quad[6] + quad[0]) > 1 || Math.abs(quad[5] - quad[3] - quad[7] + quad[1]) > 1)
      throw failure('UNSUPPORTED_FRAME_TRANSFORM', 'Browser frame uses a perspective transform');
    const u = point.x / viewport.width, v = point.y / viewport.height;
    point = { x: quad[0] + (quad[2] - quad[0]) * u + (quad[6] - quad[0]) * v,
      y: quad[1] + (quad[3] - quad[1]) * u + (quad[7] - quad[1]) * v };
    const hit = await call.send('DOM.getNodeForLocation', { x: Math.round(point.x), y: Math.round(point.y) }, parent.session || undefined);
    if (hit.frameId !== targetRoot.id && hit.backendNodeId !== owner.backendNodeId)
      throw failure('ELEMENT_OBSCURED', 'Browser frame is covered by another element');
    targetRoot = [...frames.values()].find(frame => frame.session === parent.session
      && (!frame.parentId || frames.get(frame.parentId)?.session !== frame.session));
  }
  // Input in an iframe target is dispatched to that native widget. Chromium
  // applies the top-level page scale again; compensate for its local viewport.
  // Root-target input already consumes CSS viewport coordinates directly.
  if (session) {
    const root = await call.send('Page.getLayoutMetrics');
    const local = await call.value(reference.world, 'viewport');
    const factor = local.scale / root.cssVisualViewport.scale;
    nativePoint.x *= factor; nativePoint.y *= factor;
  }
  return nativePoint;
}
module.exports = { clickPoint };
