import { createElectronBrowserAutomation, type ElectronAutomationPort } from '../../../apps/workbench-web/src/browser/electron-browser-automation';

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
(globalThis as any).probe = (async () => {
  const port: ElectronAutomationPort = (globalThis as any).opencraftDesktop.browser;
  check(!('sendCommand' in port), 'Preload must not expose a raw debugger');
  const guest = document.createElement('webview') as HTMLElement & { getWebContentsId(): number; loadURL(url: string): Promise<void> };
  guest.setAttribute('partition', 'persist:opencraft-browser:browser-cdp-probe');
  guest.style.cssText = 'display:flex;width:800px;height:600px';
  const ready = () => new Promise<void>(resolve => guest.addEventListener('dom-ready', () => resolve(), { once: true }));
  const loaded = ready(); guest.setAttribute('src', location.origin + '/guest'); document.getElementById('root')!.append(guest);
  await loaded;
  const id = guest.getWebContentsId();
  const missing = await port.connectAutomation(id + 100000);
  check(!missing.ok, 'An unowned guest must be rejected');
  const outside = document.getElementById("outside") as HTMLInputElement; outside.focus();
  let takeFocus = false;
  const operationPort: ElectronAutomationPort = { ...port, invokeAutomation(...args) {
    const operation = port.invokeAutomation(...args);
    // Take focus at the real asynchronous IPC boundary, before its native
    // reply. No timer assumption about renderer/compositor speed is needed.
    if (takeFocus) { takeFocus = false; outside.focus(); }
    return operation;
  } };
  const automation = createElectronBrowserAutomation(guest, operationPort);
  await automation.wait({ text: 'Ready', timeoutMs: 5000 });
  const inspection = await automation.inspect();
  const field = inspection.elements.find(element => element.name === 'Name');
  const button = inspection.elements.find(element => element.name === 'Save');
  check(field && button, 'Real webview controls must be inspected');
  await automation.fill({ ref: field.ref, expectedRevision: inspection.revision, value: '  React draft  ' });
  // React re-render must not invalidate a connected, semantically identical node.
  await automation.press({ key: "ControlOrMeta+a" });
  await automation.press({ key: "Backspace" });
  check((await automation.inspect()).elements.find(element => element.name === "Name")?.value === "", "Native shortcut and Backspace must edit the focused control");
  await automation.fill({ ref: field.ref, expectedRevision: inspection.revision, value: "  React draft  " });
  check(document.activeElement === outside, "Native writes must restore the preceding workbench focus");
  takeFocus = true;
  const interrupted = automation.fill({ ref: field.ref, expectedRevision: inspection.revision, value: "must not replace the draft" }).then(() => null, error => error);
  check((await interrupted)?.code === "CONTROL_LOST", "User focus takeover must fence native input");
  check(outside.value === "Workbench draft", "Guest input must not enter a workbench control");
  const filled = (await automation.inspect()).elements.find(element => element.name === "Name")?.value;
  check(filled === "  React draft  ", "Fill must preserve whitespace in a controlled input: " + JSON.stringify(filled));
  await automation.click({ ref: button.ref, expectedRevision: inspection.revision });
  await automation.wait({ text: 'Saved: React draft :trusted', timeoutMs: 5000 });
  check(!JSON.stringify(await automation.readContext()).includes('secret-fixture-value'), 'Sensitive text must be redacted');
  const another = createElectronBrowserAutomation(guest, port);
  const nativeLease = await port.connectAutomation(id);
  check(nativeLease.ok, 'Main must grant an owned native document lease');
  automation.dispose();
  await another.inspect(); // Disposing one client must not detach the shared owner.
  const pending = another.wait({ text: 'never appears', timeoutMs: 10000 }).then(() => { throw new Error('Wait should be cancelled'); }, error => error);
  await new Promise(resolve => setTimeout(resolve, 50)); another.dispose();
  check((await pending).code, 'Disposal must cancel the old consumer');
  const nextReady = ready(); await guest.loadURL(location.origin + '/next'); await nextReady;
  const expired = await port.invokeAutomation(id, nativeLease.value.lease, crypto.randomUUID(), 'inspect', {});
  check(!expired.ok && expired.error.code === 'DOCUMENT_CHANGED', 'Old Main lease must not bind to a replacement document');
  const next = createElectronBrowserAutomation(guest, port);
  await next.wait({ text: 'New document', timeoutMs: 5000 }); next.dispose();
  return { ok: true, backend: automation.capabilities.backend };
})();
