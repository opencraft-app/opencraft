import { sessionError } from '../remote-browser-state-file.mjs';

const checkpointUrl = url => url === 'about:blank' || url === '' ? null : url;
const unavailable = () => Object.assign(sessionError('BROWSER_UNAVAILABLE', 'Browser runtime changed; reconnecting', true), { outcome: 'unknown' });

/** Viewers and service invocations serialize bootstrap of the same logical page.
 * Native work never holds the durable state writer queue. */
export async function acquirePageActivation(service, key) {
  const previous = service.attachments.get(key);
  let unlock;
  const attachment = new Promise(resolve => { unlock = resolve; });
  service.attachments.set(key, attachment);
  await previous;
  return () => { unlock(); if (service.attachments.get(key) === attachment) service.attachments.delete(key); };
}

/** Caller holds the page activation slot. Presentation hooks belong to the
 * viewer adapter; native identity, recovery and uncertainty belong here. */
export async function activateRemotePage(service, { ownerId, key, input = {}, modern = true, authorize,
  attach = () => {}, detach = () => {}, finish = (page, result) => ({ page, ...result }) }) {
  await service.load(); authorize();
  const retired = await service.store.hasRetirement(key);
  const checkOpen = () => {
    authorize();
    if (service.closed) throw unavailable();
    if (retired || service.pages.get(key)?.closing) throw sessionError('SESSION_CLOSED', 'Browser tab is closed');
  };
  checkOpen();
  const existing = service.pages.get(key);
  if (existing?.closing) throw sessionError('SESSION_CLOSING', 'Browser tab is closing');
  await service.start(); checkOpen();
  const unknown = service.store.account(ownerId).pages.find(p => p.key === key)?.runtime?.kind === 'unknown';
  if (unknown && existing && !existing.live) {
    const epoch = existing.runtimeEpoch ?? 0, native = service.child;
    const requireCurrent = () => {
      checkOpen();
      if (existing.closing || service.pages.get(key) !== existing || service.child !== native || (existing.runtimeEpoch ?? 0) !== epoch)
        throw unavailable();
    };
    try {
      const config = await service.request(existing.id, 'snapshot'); requireCurrent();
      existing.live = true; existing.document = config.document; await service.runtimeState(existing, 'live', epoch); requireCurrent();
    } catch (error) {
      if (error.message !== 'Browser page closed') throw error;
      requireCurrent();
      await service.request(existing.id, 'close'); requireCurrent();
      await service.runtimeState(existing, 'absent', epoch); requireCurrent();
    }
  }
  // Only a generation-zero logical tab may consume an initial URL. Reattach
  // must preserve an already existing blank document and unsaved native state.
  const firstCreation = !existing || !existing.live && existing.runtime?.generation === 0;
  const reserved = await service.reserve(ownerId, key, input, authorize);
  const page = existing ?? { ...reserved, controller: null, live: false };
  page.runtime = reserved.runtime; checkOpen();
  attach(page); service.pages.set(key, page);
  const resumed = page.live, recoveryUrl = page.url, recoveryZoom = page.zoom;
  page.recovering = !resumed && !!existing;
  const epoch = page.runtimeEpoch ?? 0, native = service.child;
  const currentNative = () => !service.closed && !page.closing && service.pages.get(key) === page
    && (page.runtimeEpoch ?? 0) === epoch && service.child === native;
  const requireNative = () => { checkOpen(); if (!currentNative()) throw unavailable(); };
  let creating;
  try {
    page.creating = creating = resumed && modern ? service.request(page.id, 'snapshot')
      : service.request(page.id, 'create', { ...((modern && existing ? page.viewport : input.viewport) ?? page.viewport
        ?? { deviceProfile: input.defaultDeviceProfile ?? 'desktop' }), productionDemand: true });
    let config = await page.creating; requireNative(); page.live = true;
    page.productionDemand = config.productionDemand === 1 && config.mediaBuckets === 2;
    if ((!resumed || !page.document) && typeof config.document === 'string') page.document = config.document;
    if (!resumed && existing) {
      if (recoveryZoom !== 100) { await service.request(page.id, 'zoom', { percent: recoveryZoom }); requireNative(); }
      if (recoveryUrl) { await service.request(page.id, 'navigate', { url: recoveryUrl }); requireNative(); }
      config = await service.request(page.id, 'snapshot'); requireNative();
      if (recoveryUrl && !checkpointUrl(config.navigation?.url))
        config.navigation = { ...config.navigation, url: recoveryUrl, isLoading: true };
    }
    if (firstCreation && modern && input.initialUrl && (!existing || !recoveryUrl)) {
      await service.visibility(page); requireNative();
      await service.request(page.id, 'navigate', { url: input.initialUrl }); requireNative();
      config = await service.request(page.id, 'snapshot'); requireNative();
      if (!checkpointUrl(config.navigation?.url)) config.navigation = { ...config.navigation, url: input.initialUrl, isLoading: true };
    }
    page.recovering = false; page.url = checkpointUrl(config.navigation?.url) ?? null;
    page.viewport = { width: config.width, height: config.height, deviceProfile: config.deviceProfile };
    await service.runtimeState(page, 'live', epoch); requireNative(); authorize();
    return await finish(page, { config, resumed, restored: !!existing && !resumed, initialized: modern && firstCreation });
  } catch (error) {
    page.recovering = false; detach(page);
    if (page.closing) throw error;
    if (resumed && currentNative()) {
      page.live = false;
      await service.runtimeState(page, error.message === 'Browser page closed' ? 'absent' : 'unknown', epoch);
    }
    if (!resumed && currentNative()) {
      page.live = false; page.url = recoveryUrl;
      await service.runtimeState(page, 'unknown', epoch);
      // Transport uncertainty retains its capacity reservation. Only native
      // close acknowledgement permits a subsequent recreation.
      if (currentNative() && error.code !== 'BROWSER_UNAVAILABLE' && error.outcome !== 'unknown') {
        try {
          await service.request(page.id, 'close');
          if (currentNative()) await service.runtimeState(page, 'absent', epoch);
        }
        catch { /* unresolved reservation survives restart */ }
      }
    }
    throw error;
  } finally {
    // A settled create receipt is not an in-flight native operation. Retaining
    // it would make unarchive try to close an already absent, retired owner.
    if (page.creating === creating) page.creating = null;
  }
}
