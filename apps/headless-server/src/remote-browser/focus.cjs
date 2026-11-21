'use strict';
const { createElectronCdpOwner } = require('@opencraft/browser-cdp/electron');

/** Host composition keeps focus and iframe startup on the shared connection.
 * The returned disposer retains the existing API and exposes its owner's port
 * to the worker's other CDP consumers. */
async function initializeNativeFocus(wc, onFailure) {
  const owner = createElectronCdpOwner(wc, {
    initializeTarget: send => send('Emulation.setFocusEmulationEnabled', { enabled: true }),
    onFailure,
  });
  try {
    await owner.ready;
    return Object.assign(() => owner.dispose(), { owner });
  } catch (error) { owner.dispose(); throw error; }
}
module.exports = { initializeNativeFocus };
