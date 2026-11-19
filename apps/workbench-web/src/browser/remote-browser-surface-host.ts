import { readPresentation, type BrowserTabPresentation } from '@opencraft/browser-core/presentation';
import { AdaptiveInputWindow, CreditWindow } from '@opencraft/remote-interaction';
import type { WebSocketMediaReceiver } from '@opencraft/remote-interaction/websocket';
import { browserPresentationClipPath } from "./browser-presentation-geometry";
import type { BrowserMetadataStorage } from './desktop-browser-storage';
import { H264MediaSource, onFirstVideoFrame } from './h264-media-source';
import { BrowserAutomationError, type BrowserAutomation, type BrowserAutomationCallOptions, type BrowserDeviceProfile, type BrowserPageId, type BrowserUrl, type BrowserViewportLayout, type BrowserAnnotator, type BrowserAnnotationPointerHandlers } from '@opencraft/browser-core';
import type { BrowserInputFailureKind, BrowserSurfaceEvents, BrowserSurfaceHost } from './web-browser-surface-host';
import type { PresentationHostPort } from './opencraft-presentation-host';
import { serverStorageKey, serverUrl } from '../runtime/server-context';
import type { RemoteBrowserIme } from './remote-browser-ime';
import { BrowserLocalMenuController } from './browser-local-menu';
import { remoteBrowserDeviceProfile } from './remote-browser-device';
import type { RemoteBrowserInputQueue } from './remote-browser-input-queue';

import { exponentialBackoffMs } from "@opencraft/workbench-runtime/retry-schedule";
interface RemoteKeyboardPolicy { kind: string; secure: boolean; inputMode: string; enterKeyHint: string; multiline: boolean; autoKeyboard: boolean; }
type Pending = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
interface Control { epoch: number; active: boolean; controller: boolean; kind: 'human' | 'agent' | null; token?: string; }
export type RemoteBrowserInputPage = Page;
export type RemoteBrowserMediaPage = Page;
interface Page {
  mediaReady: Promise<void> | null; mediaRuntime: typeof import('./remote-browser-media-runtime') | null;
  inputReady: Promise<void> | null; inputBound: boolean;
  hasPaint: boolean; paintWaiters: Set<() => void>;
  mediaReceiver: WebSocketMediaReceiver | null; inputCredits: CreditWindow; inputPolicy: AdaptiveInputWindow; adaptiveInput: boolean;
  document: string | undefined;
  inputAcknowledgements: boolean; inputQueue: RemoteBrowserInputQueue | null;
  humanIntent?: number; control: Control; controlGeneration: number; acquiring: { kind: 'human' | 'agent'; promise: Promise<string>; generation: number } | null; agentQueue: Promise<unknown>; serverInitialNavigation: boolean; gestureActive: boolean;
  media: H264MediaSource | null; video: HTMLVideoElement | null; cancelVideoReady: (() => void) | null; id: BrowserPageId; lease: string; container: HTMLDivElement; canvas: HTMLCanvasElement; receiver: HTMLInputElement; editor: string | null; keyboard: RemoteKeyboardPolicy | null; keyboardIntent: { pointer: number; x: number; y: number; editor: string | null; until: number; completed: boolean } | null; ime: RemoteBrowserIme | null; editable: boolean; nativeIme: boolean; multiTouch: boolean;
  serverClosed?: boolean;
  events: BrowserSurfaceEvents; navigation: number; url: BrowserUrl | null | undefined; socket: WebSocket | null;
  restored: boolean; resumed: boolean; ready: Promise<void>; opened: boolean; disconnected: boolean; displaced: boolean; closed: boolean; visible: boolean; watching?: boolean; blocked: boolean;
  pending: Map<string, Pending>; decoder: VideoDecoder | null; latest: VideoFrame | null; raf: number;
  reconnect: ReturnType<typeof setTimeout> | null; connection: number; retries: number; needsKey: boolean;
  layoutViewport?: boolean; viewportDeferred?: boolean; viewportMeasured: boolean; width: number; height: number; viewport: { width: number; height: number; deviceProfile?: BrowserDeviceProfile }; sentViewport: string;
  resizeTimer: ReturnType<typeof setTimeout> | null; resizing: boolean; resizeRetry?: { target: string; failures: number }; awaitingFrame?: boolean;
  nativeCopy: boolean; cdpAutomation: boolean; interaction: number; menuIntent: string | null; automation: BrowserAutomation; resetPointers: () => void; resetInput: () => void; inputDispose: () => void;
}
/** Physical pages live on the Server. Canvas is only a presentation consumer;
 * the existing tool host still owns thread/tab authorization and use claims. */
export class RemoteBrowserSurfaceHost implements BrowserSurfaceHost {
  readonly nativeNavigation = true;
  readonly localMenu = new BrowserLocalMenuController();
  private menuOwner: Page | null = null;
  private controlListeners = new Set<() => void>();
  onControlState(listener: () => void) { this.controlListeners.add(listener); return () => { this.controlListeners.delete(listener); }; }
  controlState(id: BrowserPageId): 'unavailable' | 'viewing' | 'human' | 'agent' | 'elsewhere' {
    const p = this.pages.get(id); return !p?.opened ? 'unavailable' : p.control.kind === 'agent' ? 'agent' : p.control.controller ? p.control.kind ?? 'viewing' : p.control.active ? 'elsewhere' : 'viewing';
  }
  takeControl(id: BrowserPageId) { const p = this.require(id); void this.acquireControl(p, 'human').catch(error => this.inputError(p, 'control', error.message)); }
  releaseControl(id: BrowserPageId) { const p = this.require(id); void this.releaseControlToken(p).catch(error => this.inputError(p, 'control', error.message)); }
  private inputError(p: Page, kind: BrowserInputFailureKind, message: string) {
    if (p.closed) return;
    if (p.events.onInputError) p.events.onInputError(kind);
    else p.events.onError(message); // Standalone surface consumer compatibility.
  }
  private operationError(p: Page, error: Error) {
    if (p.closed) return;
    if (['CONTROL_LOST', 'CONTROL_BUSY'].includes((error as BrowserAutomationError).code)) this.inputError(p, 'control', error.message);
    else p.events.onError(error.message);
  }
  private setControl(p: Page, control: Control) {
    if (!control || !Number.isSafeInteger(control.epoch) || control.epoch < p.control.epoch) return;
    const humanIntent = p.control.controller && p.control.token === control.token
      || p.acquiring?.kind === 'human' && p.acquiring.generation === p.controlGeneration;
    if (control.controller && control.kind === 'human' && (!this.isVisible(p) || !humanIntent)) {
      ++p.controlGeneration; p.acquiring = null;
      if (control.token) void this.rawCall(p, 'control', { action: 'release', token: control.token }).catch(() => {});
      control = { ...control, controller: false, token: undefined };
    }
    const gained = control.controller && control.token !== p.control.token;
    const lost = p.control.controller && p.control.token !== control.token;
    p.control = control;
    if (gained) p.resizeRetry = undefined;
    if (lost) { ++p.controlGeneration; this.retireMenu(p); p.resetInput(); this.resetKeyboard(p); }
    for (const listener of this.controlListeners) listener();
    p.viewportDeferred = false; this.queueViewport(p);
  }
  private acquireControl(p: Page, kind: 'human' | 'agent', temporary = false): Promise<string> {
    if (kind === 'human' && !temporary) p.humanIntent = (p.humanIntent ?? 0) + 1;
    if (kind === 'human' && !this.isVisible(p)) return Promise.reject(new BrowserAutomationError('CONTROL_LOST', 'Browser interaction ended', true));
    if (p.control.controller && p.control.kind === kind && p.control.token) return Promise.resolve(p.control.token);
    if (p.acquiring?.kind === kind) return p.acquiring.promise;
    if (kind === 'human' && p.control.controller) this.setControl(p, { ...p.control, controller: false, token: undefined });
    const generation = p.controlGeneration, connection = p.connection;
    const promise = this.rawCall(p, 'control', { action: kind, takeover: kind === 'human' }).then((state: Control) => {
      if (p.closed || kind === 'human' && !this.isVisible(p) || p.connection !== connection || p.controlGeneration !== generation || !state.controller || !state.token || state.epoch < p.control.epoch) {
        if (!p.closed && p.connection === connection && state.token) void this.rawCall(p, 'control', { action: 'release', token: state.token }).catch(() => {});
        throw new BrowserAutomationError('CONTROL_LOST', 'Browser control changed; start a new interaction', true);
      }
      this.setControl(p, state); return state.token;
    });
    const pending = { kind, promise, generation }; p.acquiring = pending;
    void promise.finally(() => { if (p.acquiring === pending) p.acquiring = null; }).catch(() => {});
    return promise;
  }
  private async releaseControlToken(p: Page, expected = p.control.token) {
    if (!expected) return;
    const state = await this.rawCall(p, 'control', { action: 'release', token: expected });
    if (p.control.token === expected) this.setControl(p, state);
  }
  private async humanCall(p: Page, method: string, input?: unknown) {
    const alreadyHuman = p.control.controller && p.control.kind === 'human';
    const intent = p.humanIntent;
    const token = await this.acquireControl(p, 'human', true);
    try { return await this.call(p, method, input, token); }
    finally {
      // Toolbar navigation is a bounded action, not a persistent human claim.
      // A later explicit button/gesture must keep its own human intent.
      if (!alreadyHuman && p.humanIntent === intent) await this.releaseControlToken(p, token);
    }
  }
  private keyboardListeners = new Set<() => void>();
  onKeyboardState(listener: () => void) { this.keyboardListeners.add(listener); return () => { this.keyboardListeners.delete(listener); }; }
  keyboardState(id: BrowserPageId): 'unavailable' | 'idle' | 'ready' { return !this.pages.get(id)?.nativeIme ? 'unavailable' : this.canShowKeyboard(id) ? 'ready' : 'idle'; }
  canShowKeyboard(id: BrowserPageId) { const p = this.pages.get(id); return !!p && p.nativeIme && p.editable && p.control.controller && p.control.kind === 'human' && this.acceptsInput(p); }
  showKeyboard(id: BrowserPageId) {
    const p = this.require(id); if (!this.canShowKeyboard(id)) return;
    // Must stay synchronous inside the local button gesture for mobile WebViews.
    // A canvas touch may already focus the manual receiver. Re-focus after
    // changing policy rather than relying on focus() on an active element.
    if (p.receiver.inputMode === 'none' && document.activeElement === p.receiver) p.receiver.blur();
    p.receiver.inputMode = p.keyboard?.inputMode === 'none' ? 'text' : p.keyboard?.inputMode || 'text'; p.receiver.setAttribute('virtualkeyboardpolicy', 'auto');
    p.receiver.focus({ preventScroll: true });
  }
  private keyboardChanged() { for (const listener of this.keyboardListeners) listener(); }
  private resetKeyboard(p: Page, blur = true) { if (blur) p.receiver.blur(); p.editable = false; p.editor = null; p.keyboard = null; p.keyboardIntent = null; p.receiver.value = ''; p.receiver.type = 'text'; p.receiver.inputMode = 'none'; p.receiver.setAttribute('virtualkeyboardpolicy', 'manual'); this.keyboardChanged(); }
  private updateKeyboard(p: Page) {
    const intent = p.keyboardIntent;
    const tappedNewEditor = intent?.completed && performance.now() < intent.until && intent.editor !== p.editor;
    // No asynchronous focus: only update input views on the receiver already
    // focused in the user's gesture. Scrolling and multiple contacts disarm it.
    if (p.editable && p.keyboard && document.activeElement === p.receiver
      && (p.receiver.inputMode !== 'none' || tappedNewEditor && p.keyboard.autoKeyboard)) {
      p.receiver.inputMode = p.keyboard.inputMode;
      p.receiver.setAttribute('virtualkeyboardpolicy', 'auto');
    }
  }
  private root: HTMLElement | null = null;
  private storageIds = new Map<BrowserPageId, string>();
  constructor(private readonly storage: BrowserMetadataStorage = localStorage, private readonly storageKey = serverStorageKey('opencraft.remote-browser-storage.v1'), private readonly admitted: () => boolean = () => true, private readonly whenAdmitted?: () => Promise<void>) {
    this.restoreStorage();
    this.releaseMetadata = storage.onMetadataChanged?.(field => { if (field === "storage" || field === "*") this.restoreStorage(); }) ?? (() => {});
  }
  private readonly releaseMetadata: () => void;
  restoreStorage() {
    try { for (const [id, storage] of Object.entries(JSON.parse(this.storage.getItem(this.storageKey) || '{}')))
      if (!this.storageIds.has(id as BrowserPageId) && typeof storage === 'string' && /^browser[:-][a-zA-Z0-9-]+$/.test(storage)) this.storageIds.set(id as BrowserPageId, storage); } catch {}
  }
  get listResources() { return this.storage.listResources ? () => this.storage.listResources!() : undefined; }
  get closeResource() { return this.storage.closeResource ? (lease: string) => this.storage.closeResource!(lease) : undefined; }
  existingStorageId(id: BrowserPageId) { return this.storageIds.get(id) ?? null; }
  bindStorageId(id: BrowserPageId, storage: string) {
    this.storageIds.set(id, storage); this.persistStorage();
  }
  forget(id: BrowserPageId) { this.presentationGeneration.delete(id); this.presentationCache.delete(id); this.storageIds.delete(id); this.persistStorage(); }
  private persistStorage() { if (!this.admitted()) return; try { this.storage.setItem(this.storageKey, JSON.stringify(Object.fromEntries(this.storageIds))); } catch {} }

  private hostIdentities = new Set<BrowserPageId>();
  bindHostIdentity(id: BrowserPageId) { this.hostIdentities.add(id); }
  private pages = new Map<BrowserPageId, Page>();
  private backing: ((id: BrowserPageId) => void) | null = null;
  private inputFailed = false;
  private storageError: Error | null = null;
  private use: ((id: BrowserPageId) => () => void) | null = null;
  private closeListeners = new Set<(id: BrowserPageId) => void>();
  setBackingFactory(factory: ((id: BrowserPageId) => void) | null) { this.backing = factory; }
  setUseFactory(factory: ((id: BrowserPageId) => () => void) | null) { this.use = factory; }
  acquireUse(id: BrowserPageId) { return this.use?.(id) ?? (() => {}); }
  setRoot(root: HTMLElement | null) { this.root = root; if (root) for (const p of this.pages.values()) root.prepend(p.container); else { this.localMenu.retire(); for (const p of this.pages.values()) { p.resetInput(); this.resetKeyboard(p); } } for (const p of this.pages.values()) this.syncVisibility(p); }
  onClose(listener: (id: BrowserPageId) => void) { this.closeListeners.add(listener); return () => { this.closeListeners.delete(listener); }; }
  setZoom(id: BrowserPageId, percent: number) { this.run(this.require(id), 'zoom', { percent }); }
  private presentationLifetime = 0;
  private presentationGeneration = new Map<BrowserPageId, number>();
  private presentationCache = new Map<BrowserPageId, BrowserTabPresentation>();
  onPresentationChanged(id: BrowserPageId, listener: () => void) {
    return this.storage.onPresentationChanged?.(lease => {
      if (lease === this.existingStorageId(id)?.replace(':', '-')) { this.presentationGeneration.set(id, (this.presentationGeneration.get(id) ?? 0) + 1); this.presentationCache.delete(id); listener(); }
    }) ?? (() => {});
  }
  async readPresentation(id: BrowserPageId): Promise<BrowserTabPresentation | null> {
    const lease = this.existingStorageId(id)?.replace(':', '-');
    if (!lease || !this.storage.readPresentation) return null;
    const lifetime = this.presentationLifetime;
    const generation = this.presentationGeneration.get(id) ?? 0;
    this.presentationGeneration.set(id, generation);
    const previous = this.presentationCache.get(id);
    const result = await this.storage.readPresentation(lease, previous?.revision);
    if (this.existingStorageId(id)?.replace(':', '-') !== lease || this.presentationLifetime !== lifetime || this.presentationGeneration.get(id) !== generation) return null;
    const conditional = result as { version?: number; unchanged?: boolean; revision?: string } | null;
    if (conditional?.version === 1 && conditional.unchanged && previous && previous.revision === conditional.revision) return previous;
    const value = readPresentation(result);
    this.presentationCache.delete(id);
    if (value) { this.presentationCache.set(id, value); while (this.presentationCache.size > 32) this.presentationCache.delete(this.presentationCache.keys().next().value!); }
    return value;
  }
  async capture(id: BrowserPageId): Promise<string> { const p = this.require(id); await p.ready; return this.call(p, 'capture'); }
  annotate(id: BrowserPageId): BrowserAnnotator | null {
    const p = this.pages.get(id);
    if (!p) return null;
    const operation = async (method: string, input?: unknown) => {
      const generation = p.document, connection = p.connection;
      await p.ready;
      if (generation !== p.document || connection !== p.connection) throw new BrowserAutomationError('DOCUMENT_CHANGED', 'Browser document changed', true);
      const result = await this.call(p, 'automation', { method, input }, p.control.token, generation);
      if (p.closed || generation !== p.document || connection !== p.connection) throw new BrowserAutomationError('DOCUMENT_CHANGED', 'Browser document changed', true);
      return result;
    };
    return {
      capabilities: { region: true, text: true, multiSelect: true, styles: true, capture: true, preview: false, sameOriginFrames: true, openShadow: true },
      pick: input => operation('annotatePick', input),
      pickRegion: input => operation('annotateRegion', input),
      pickText: input => operation('annotateText', input),
      readStyles: anchor => operation('annotateStyles', anchor),
      preview: input => operation('annotatePreview', input),
      clearPreview: () => operation('annotateClearPreview'),
      hitMark: async point => {
        const generation = p.document, connection = p.connection;
        await p.ready;
        if (p.closed || generation !== p.document || connection !== p.connection) throw new BrowserAutomationError('DOCUMENT_CHANGED', 'Browser document changed', true);
        const hits = await this.call(p, 'annotation-overlay', { type: 'hit', point }, p.control.token, generation);
        if (p.closed || generation !== p.document || connection !== p.connection) throw new BrowserAutomationError('DOCUMENT_CHANGED', 'Browser document changed', true);
        return Array.isArray(hits) ? hits.filter((id): id is string => typeof id === 'string' && id.length <= 240).slice(0, 32) : [];
      },
      mark: async (boxes, color) => {
        await p.ready;
        if (p.acquiring?.kind === 'human') await p.acquiring.promise;
        await this.call(p, 'annotation-overlay', boxes.length ? { type: 'boxes', boxes, color } : { type: 'clear' });
      },
      capture: async () => {
        const generation = p.document, connection = p.connection;
        const image = await this.capture(id);
        if (p.closed || generation !== p.document || connection !== p.connection) throw new BrowserAutomationError('DOCUMENT_CHANGED', 'Browser document changed', true);
        return image;
      },
      intercept: handlers => {
        void p.ready.then(() => this.acquireControl(p, 'human')).catch(() => {});
        return this.interceptAnnotation(p, handlers);
      },
      // Wheel deltas are frame px; negative deltaY scrolls the page down.
      reveal: async fraction => {
        if (!Number.isFinite(fraction) || fraction === 0) return;
        await p.ready; await this.acquireControl(p, 'human');
        await this.call(p, 'input', { type: 'mouseWheel', x: Math.round(p.width / 2), y: Math.round(p.height / 2), deltaX: 0, deltaY: -Math.round(fraction * p.height), modifiers: [] });
      },
    };
  }
  /** Capture-phase listeners on the container run before the canvas input
   * bindings, so a tap never reaches the page. Wheel passes through; a touch
   * drag is replayed as wheel scrolling so the user can scroll while picking. */
  private interceptAnnotation(p: Page, handlers: BrowserAnnotationPointerHandlers): () => void {
    const container = p.container, canvas = p.canvas, cleanup: (() => void)[] = [];
    if (handlers.mode === 'browse') return () => {};
    const selecting = handlers.mode === 'region' || handlers.mode === 'text';
    const frame = (event: PointerEvent) => {
      const r = canvas.getBoundingClientRect(), scale = r.width / p.width;
      return { x: (event.clientX - r.left) / scale, y: (event.clientY - r.top) / scale, frameWidth: p.width, frameHeight: p.height };
    };
    let down: { id: number; x: number; y: number; lastX: number; lastY: number; dragging: boolean; type: string; start: ReturnType<typeof frame>; bounds: DOMRect; document: string | undefined; connection: number } | null = null, raf = 0, hover: PointerEvent | null = null;
    let wheel: { x: number; y: number; dx: number; dy: number } | null = null, wheelFrame = 0, wheelBusy = false, released = false;
    const flushWheel = () => {
      wheelFrame = 0;
      if (released || wheelBusy) return;
      const next = wheel; wheel = null;
      if (!next || (Math.round(next.dx) === 0 && Math.round(next.dy) === 0)) return;
      wheelBusy = true;
      void this.acquireControl(p, 'human')
        .then(() => { if (!released) return this.call(p, 'input', { type: 'mouseWheel', x: next.x, y: next.y, deltaX: Math.round(next.dx), deltaY: Math.round(next.dy), modifiers: [] }); })
        .catch(() => {})
        .finally(() => { wheelBusy = false; if (!released && wheel && !wheelFrame) wheelFrame = requestAnimationFrame(flushWheel); });
    };
    const stop = (event: Event) => { event.stopImmediatePropagation(); event.preventDefault(); };
    const cancel = () => { const previous = down; down = null; wheel = null; if (previous) { try { canvas.releasePointerCapture(previous.id); } catch {} } };
    const validPoint = (point: ReturnType<typeof frame>) => Object.values(point).every(Number.isFinite) && point.frameWidth > 0 && point.frameHeight > 0 && point.x >= 0 && point.y >= 0 && point.x <= point.frameWidth && point.y <= point.frameHeight;
    const previousTouchAction = canvas.style.touchAction;
    if (selecting) canvas.style.touchAction = 'none';
    const on = (name: string, handler: (event: any) => void) => { container.addEventListener(name, handler, { capture: true, passive: false }); cleanup.push(() => container.removeEventListener(name, handler, { capture: true })); };
    on('pointerdown', (event: PointerEvent) => {
      if (event.target !== canvas || !event.isPrimary || event.button > 0) return;
      stop(event); cancel();
      const start = frame(event);
      if (!this.acceptsPointer(p) || !validPoint(start)) return;
      down = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, dragging: false, type: event.pointerType, start, bounds: canvas.getBoundingClientRect(), document: p.document, connection: p.connection };
      try { canvas.setPointerCapture(event.pointerId); } catch {}
    });
    on('pointermove', (event: PointerEvent) => {
      if (event.target !== canvas) return;
      stop(event);
      if (down && down.id === event.pointerId) {
        if (!down.dragging && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 8) down.dragging = true;
        if (!selecting && down.dragging && down.type !== 'mouse') {
          const r = canvas.getBoundingClientRect(), scale = r.width / p.width;
          const dx = (event.clientX - down.lastX) / scale, dy = (event.clientY - down.lastY) / scale;
          down.lastX = event.clientX; down.lastY = event.clientY;
          const at = frame(event);
          // Coalesce to one ordered wheel per frame; a flood of independent
          // control round trips would reorder and lag on slow links.
          wheel = { x: Math.round(at.x), y: Math.round(at.y), dx: (wheel?.dx ?? 0) + dx, dy: (wheel?.dy ?? 0) + dy };
          if (!wheelFrame) wheelFrame = requestAnimationFrame(flushWheel);
        }
        return;
      }
      if (selecting || event.pointerType !== 'mouse' || !handlers.hover) return;
      hover = event;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (hover) handlers.hover!(frame(hover)); hover = null; });
    });
    on('pointerup', (event: PointerEvent) => {
      if (!down || down.id !== event.pointerId) return;
      stop(event);
      const start = down, end = frame(event), bounds = canvas.getBoundingClientRect();
      down = null;
      try { canvas.releasePointerCapture(event.pointerId); } catch {}
      if (!this.acceptsPointer(p) || !validPoint(end) || start.document !== p.document || start.connection !== p.connection || start.start.frameWidth !== end.frameWidth || start.start.frameHeight !== end.frameHeight || ['left', 'top', 'width', 'height'].some(key => start.bounds[key as keyof DOMRect] !== bounds[key as keyof DOMRect])) return;
      if (selecting) handlers.drag?.(start.start, end);
      else if (!start.dragging && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 8) handlers.tap(end, start.type === 'touch' ? 'touch' : start.type === 'pen' ? 'pen' : 'mouse');
    });
    on('pointercancel', (event: PointerEvent) => { if (down?.id === event.pointerId) { stop(event); cancel(); } });
    on('lostpointercapture', (event: PointerEvent) => { if (down?.id === event.pointerId) cancel(); });
    on('wheel', () => { if (selecting) cancel(); });
    if (selecting) on('touchmove', (event: Event) => { if (event.target === canvas) stop(event); });
    for (const name of ['click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup', 'touchstart', 'touchend']) on(name, (event: Event) => { if (event.target === canvas) stop(event); });
    container.dataset.annotating = 'true';
    return () => { released = true; cancel(); canvas.style.touchAction = previousTouchAction; cancelAnimationFrame(raf); cancelAnimationFrame(wheelFrame); for (const dispose of cleanup) dispose(); delete container.dataset.annotating; };
  }
  async waitUntilReady(id: BrowserPageId) { await this.require(id).ready; }
  presentationPort(id: BrowserPageId): PresentationHostPort {
    const p = this.require(id);
    return { container: p.container, guest: p.receiver, ready: p.ready,
      whenPainted: signal => new Promise<void>(resolve => {
        if (p.hasPaint || p.closed || signal.aborted) { resolve(); return; }
        const done = () => { p.paintWaiters.delete(done); signal.removeEventListener('abort', done); resolve(); };
        p.paintWaiters.add(done); signal.addEventListener('abort', done, { once: true });
      }),
      commit: (layout, visible) => this.commit(id, layout, visible ? 'visible' : 'staged'),
      park: () => this.park(id), close: () => this.release(id, false), clearCover: () => {}, cover: () => {} };
  }
  navigate(id: BrowserPageId, _title: string, url: BrowserUrl | null, events: BrowserSurfaceEvents, force = false): boolean {
    const absent = !this.pages.has(id);
    if (absent && !this.hostIdentities.has(id)) this.backing?.(id);
    const p = this.ensure(id, events); p.events = events;
    if (p.serverClosed) return false;
    // A transferred viewer must not compete with its replacement during layout
    // or state synchronization. Explicit reload is the user's takeover intent.
    if (p.displaced && !force) return false;
    if (!force && p.url === url && !p.disconnected) return absent;
    const navigation = ++p.navigation;
    p.url = url;
    const reconnecting = p.disconnected;
    if (reconnecting) this.reconnect(p);
    // Capture the requested URL; replacement before connection must not issue
    // an obsolete navigation after the latest one.
    const ready = p.ready;
    void ready.then(() => { if (!p.closed && p.ready === ready && p.navigation === navigation && !(absent && p.restored && !force) && !(force && reconnecting && !p.resumed)) return absent && p.serverInitialNavigation && !force ? undefined : this.humanCall(p, force ? 'reload' : 'navigate', { url }); })
      .catch(error => { if (!p.closed && p.ready === ready && p.navigation === navigation) this.operationError(p, error); });
    return true;
  }
  stop(id: BrowserPageId) { this.run(this.require(id), 'stop'); }
  goBack(id: BrowserPageId) { this.run(this.require(id), 'back'); }
  goForward(id: BrowserPageId) { this.run(this.require(id), 'forward'); }
  automation(id: BrowserPageId) { return this.pages.get(id)?.automation ?? null; }
  commit(id: BrowserPageId, layout: BrowserViewportLayout, phase: 'staged' | 'visible') {
    const p = this.require(id), bounds = layout.visualBounds, origin = this.root?.getBoundingClientRect();
    Object.assign(p.container.style, { left: `${bounds.x - (origin?.left ?? 0)}px`, top: `${bounds.y - (origin?.top ?? 0)}px`,
      width: `${bounds.width}px`, height: `${bounds.height}px`, clipPath: browserPresentationClipPath(layout), visibility: 'visible', opacity: phase === 'visible' ? '1' : '.001',
      pointerEvents: phase === 'visible' && !p.blocked && !this.inputFailed ? 'auto' : 'none' });
    if (layout.viewportSize.width > 0 && layout.viewportSize.height > 0) {
      p.viewportMeasured = true;
      const previous = JSON.stringify(p.viewport);
      p.viewport = { width: Math.max(1, Math.round(layout.viewportSize.width)), height: Math.max(1, Math.round(layout.viewportSize.height)), deviceProfile: layout.deviceProfile ?? remoteBrowserDeviceProfile() };
      if (JSON.stringify(p.viewport) !== previous) p.viewportDeferred = false;
      this.queueViewport(p);
    }
    p.blocked = false;
    const visible = phase === 'visible';
    p.visible = visible; this.syncVisibility(p);
  }
  block(id: BrowserPageId) { const p = this.pages.get(id); if (p) { this.retireMenu(p); p.resetInput(); this.run(p, 'input', { type: 'touchCancel' }); p.blocked = true; p.container.style.pointerEvents = 'none'; } }
  park(id: BrowserPageId) {
    const p = this.pages.get(id); if (!p) return;
    this.retireMenu(p);
    if (p.acquiring?.kind === 'human') { ++p.controlGeneration; p.acquiring = null; }
    p.resetInput(); this.resetKeyboard(p); p.container.style.visibility = 'hidden'; p.container.style.pointerEvents = 'none';
    p.visible = false; this.syncVisibility(p);
  }
  detach(id: BrowserPageId) { this.release(id, false); }
  close(id: BrowserPageId) {
    if (!this.pages.has(id)) { const lease = this.storageIds.get(id); if (lease) this.discard(lease.replace(':', '-')); return; }
    this.release(id, true);
  }
  retire(id: BrowserPageId) {
    this.storageIds.delete(id); this.hostIdentities.delete(id);
    const p = this.pages.get(id); if (p) p.serverClosed = true;
    this.release(id, true);
  }
  private release(id: BrowserPageId, destroy: boolean) {
    const p = this.pages.get(id); if (!p || p.closed) return;
    this.retireMenu(p);
    if (destroy && !p.serverClosed) this.discard(p.lease);
    p.closed = true; if (p.reconnect) clearTimeout(p.reconnect); if (p.resizeTimer) clearTimeout(p.resizeTimer);
    for (const done of p.paintWaiters) done();
    p.inputDispose(); p.mediaReceiver?.dispose(); p.socket?.close(); this.resetDecoder(p);
    this.rejectPending(p); p.container.remove(); this.pages.delete(id); this.hostIdentities.delete(id);
    if (destroy) for (const listener of this.closeListeners) listener(id);
  }
  private retirements = new Map<string, { socket: WebSocket | null; timer: ReturnType<typeof setTimeout> | null }>();
  private discard(lease: string) {
    if (this.retirements.has(lease)) return;
    const job = { socket: null as WebSocket | null, timer: null as ReturnType<typeof setTimeout> | null };
    this.retirements.set(lease, job);
    let attempts = 0;
    const attempt = () => {
      if (this.retirements.get(lease) !== job) return;
      const url = new URL(serverUrl('/__opencraft_browser/stream'), location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(url), id = crypto.randomUUID(); job.socket = ws;
      let acknowledged = false;
      job.timer = setTimeout(() => ws.close(), 25000);
      ws.onopen = () => ws.send(JSON.stringify({ id, method: 'discard', input: { lease } }));
      ws.onmessage = event => {
        let message; try { message = JSON.parse(event.data); } catch { return; }
        if (message.type !== 'result' || message.id !== id) return;
        acknowledged = !message.error;
        if (acknowledged) this.retirements.delete(lease);
        ws.close();
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (job.timer) clearTimeout(job.timer);
        job.socket = null;
        if (!acknowledged && this.retirements.get(lease) === job)
          job.timer = setTimeout(attempt, exponentialBackoffMs(attempts++, { initialMs: 250, maxMs: 10_000 }));
      };
    };
    attempt();
  }
  dispose() {
    this.releaseMetadata();
    for (const id of [...this.pages.keys()]) this.release(id, false);
    for (const job of this.retirements.values()) { if (job.timer) clearTimeout(job.timer); job.socket?.close(); }
    this.presentationLifetime++; this.retirements.clear(); this.presentationCache.clear(); this.presentationGeneration.clear(); this.root = null;
  }
  fail(error: Error) { this.inputFailed = true; this.storageError = error; for (const p of this.pages.values()) { p.blocked = true; p.resetInput(); this.resetKeyboard(p); p.container.style.pointerEvents = 'none'; p.events.onError(error.message); } }
  private sessionClosed(p: Page): boolean {
    if (!p.events.onSessionClosed) return false;
    if (!p.serverClosed) { p.serverClosed = true; p.events.onSessionClosed(); }
    return true;
  }
  private watchConnection(p: Page) {
    const ready = p.ready;
    void ready.catch(error => {
      if (p.closed || p.ready !== ready) return;
      if (error.code === 'SESSION_CLOSED' && this.sessionClosed(p)) return;
      p.events.onError(error.message);
    });
  }
  private require(id: BrowserPageId) { const p = this.pages.get(id); if (!p) throw new Error('Browser page closed'); return p; }
  private ensure(id: BrowserPageId, events: BrowserSurfaceEvents): Page {
    const old = this.pages.get(id); if (old) return old;
    const container = document.createElement('div'); container.className = 'web-browser-surface'; container.dataset.browserPageId = id; container.dataset.browserPainted = 'false';
    Object.assign(container.style, { visibility: 'hidden', overflow: 'hidden', background: 'var(--background, #fff)' });
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720; canvas.tabIndex = -1;
    const receiver = document.createElement('input'); receiver.type = 'text'; receiver.tabIndex = 0; receiver.className = 'ui-text--mobile-input';
    receiver.setAttribute('aria-label', 'Remote browser keyboard input'); receiver.spellcheck = false;
    receiver.autocomplete = 'off'; receiver.setAttribute('autocorrect', 'off'); receiver.autocapitalize = 'none';
    receiver.inputMode = 'none'; receiver.setAttribute('virtualkeyboardpolicy', 'manual');
    Object.assign(receiver.style, { position: 'absolute', left: '0', top: '0', width: '1px', height: '1px',
      opacity: '0', padding: '0', border: '0', pointerEvents: 'none', resize: 'none' });
    canvas.setAttribute('aria-label', 'Browser page'); canvas.dataset.browserPageId = id;
    // The outer layout already fits fixed-device previews. Keep received frames
    // at that width while a height resize waits for the remote encoder; contain
    // inside the new shorter slot would briefly shrink the entire document.
    Object.assign(canvas.style, { display: 'block', width: '100%', height: 'auto', outline: 'none', touchAction: 'none' });
    container.append(canvas, receiver); this.root?.prepend(container);
    const p: Page = { mediaReady: null, mediaRuntime: null, inputReady: null, inputBound: false, hasPaint: false, paintWaiters: new Set(), mediaReceiver: null, inputPolicy: new AdaptiveInputWindow(), adaptiveInput: false, inputCredits: new CreditWindow({ maxItems: 12, maxBytes: 65536 }), document: undefined, inputAcknowledgements: false, inputQueue: null, control: { epoch: 0, active: false, controller: false, kind: null }, controlGeneration: 0, acquiring: null, agentQueue: Promise.resolve(), serverInitialNavigation: false, gestureActive: false, media: null, video: null, cancelVideoReady: null, id, lease: (this.storageIds.get(id) ?? ('browser-' + crypto.randomUUID())).replace(':', '-'), container, canvas, receiver, ime: null, editor: null, keyboard: null, keyboardIntent: null, editable: false, nativeIme: false, multiTouch: false, events, navigation: 0, url: undefined, socket: null,
      nativeCopy: false, cdpAutomation: false, interaction: 0, menuIntent: null, restored: false, resumed: false, ready: Promise.resolve(), opened: false, disconnected: false, displaced: false, closed: false, visible: false, blocked: false, pending: new Map(), decoder: null,
      viewportMeasured: false, width: 1280, height: 720, viewport: { width: 1280, height: 720 }, sentViewport: '', resizeTimer: null, resizing: false,
      latest: null, raf: 0, reconnect: null, connection: 0, retries: 0, needsKey: true, automation: null!, resetPointers: () => {}, resetInput: () => {}, inputDispose: () => {} };
    if (this.admitted() && !this.storageIds.has(id)) { this.storageIds.set(id, p.lease); this.persistStorage(); }
    const call = (method: string, input?: unknown, invocation?: BrowserAutomationCallOptions): Promise<any> => {
      const requireCdp = () => { if (invocation?.signal?.aborted) throw new BrowserAutomationError('CDP_ABORTED', 'Browser invocation cancelled', false, 'not-dispatched'); if (!p.cdpAutomation) throw new BrowserAutomationError('AUTOMATION_UNAVAILABLE', 'This browser runtime does not support native automation'); };
      if (['inspect', 'readContext', 'wait', 'annotatePick', 'annotateRegion', 'annotateText', 'annotateStyles'].includes(method)) return p.ready.then(() => { requireCdp(); return this.call(p, 'automation', { method, input }, undefined, p.document, invocation?.signal); });
      const operation = p.agentQueue.catch(() => {}).then(async () => {
        await p.ready; requireCdp(); const token = await this.acquireControl(p, 'agent');
        try { return await this.call(p, 'automation', { method, input }, token, p.document, invocation?.signal); }
        finally { await this.releaseControlToken(p, token).catch(() => {}); }
      });
      p.agentQueue = operation; return operation;
    };
    p.automation = {
      get capabilities() { return { protocolVersion: 1 as const, backend: 'electron-cdp' as const, domInspection: p.cdpAutomation, semanticInput: p.cdpAutomation, trustedInput: p.cdpAutomation,
        networkObservation: 'none' as const, screenshot: true, deviceEmulation: 'full' as const }; },
      readContext: (input, invocation) => call('readContext', input, invocation), inspect: invocation => call('inspect', undefined, invocation), click: (input, invocation) => call('click', input, invocation),
      fill: (input, invocation) => call('fill', input, invocation), press: (input, invocation) => call('press', input, invocation), scroll: (input, invocation) => call('scroll', input, invocation),
      wait: (input, invocation) => call('wait', input, invocation), dispose: () => {} };
    this.pages.set(id, p); if (this.storageError) p.events.onError(this.storageError.message);
    p.ready = this.connect(p); this.watchConnection(p);
    return p;
  }
  private rejectPending(p: Page) { for (const request of p.pending.values()) { clearTimeout(request.timer); request.reject(new BrowserAutomationError('PAGE_CLOSED', 'Browser disconnected before its result was confirmed', false, 'unknown')); } p.pending.clear(); }
  private resetTransport(p: Page) {
    p.mediaReceiver?.dispose(); p.mediaReceiver = null; p.inputCredits.retire();
    p.opened = false; p.document = undefined; p.cdpAutomation = false; p.inputAcknowledgements = false; ++p.controlGeneration; p.acquiring = null; p.control = { epoch: 0, active: false, controller: false, kind: null };
    for (const listener of this.controlListeners) listener();
    this.retireMenu(p); p.resetInput(); this.resetKeyboard(p); p.opened = false;
    if (p.resizeTimer) clearTimeout(p.resizeTimer);
    p.resizeTimer = null; p.resizing = false; p.resizeRetry = undefined; this.rejectPending(p); this.resetDecoder(p);
  }
  private reconnect(p: Page) {
    // Retire the previous generation before closing it: its delayed close and
    // open rejection must not clear the replacement connection's state.
    ++p.connection; p.displaced = false;
    if (p.reconnect) clearTimeout(p.reconnect);
    p.reconnect = null; p.socket?.close(); this.resetTransport(p); p.retries = 0;
    p.ready = this.connect(p); this.watchConnection(p);
  }
  private connect(p: Page): Promise<void> {
    // Own the attempt before either asynchronous barrier. A reload can replace
    // a connection while admission or metadata persistence is still pending.
    const generation = ++p.connection;
    const checkCurrent = () => {
      if (p.closed || this.inputFailed) throw this.storageError ?? new Error('Browser tab closed');
      if (p.connection !== generation) throw new Error('Browser connection superseded');
    };
    // Restored panels may mount while the offline shell is still authenticating.
    // Give them a presentation port immediately; only admit physical resources
    // after the authoritative metadata has loaded.
    if (!this.admitted()) return (this.whenAdmitted?.() ?? Promise.reject(new Error('Remote browser awaits authenticated initialization'))).then(() => {
      checkCurrent();
      if (!this.admitted()) throw new Error('Remote browser awaits authenticated initialization');
      this.restoreStorage();
      p.lease = (this.storageIds.get(p.id) ?? p.lease).replace(':', '-');
      this.storageIds.set(p.id, p.lease); this.persistStorage();
      return this.connect(p);
    });
    // Native creation must follow the metadata commit, including reconnect.
    if (this.storage.flush) return this.storage.flush().then(() => {
      checkCurrent();
      return this.connectTransport(p, generation);
    });
    return this.connectTransport(p, generation);
  }
  private connectTransport(p: Page, generation: number): Promise<void> {
    if (p.closed || this.inputFailed || p.connection !== generation)
      return Promise.reject(this.storageError ?? new Error('Browser connection superseded or closed'));
    // No socket can become interactive before its synchronous handlers exist.
    // Reconnects share the Page binding but each attempt owns its generation.
    if (!p.inputBound || !p.mediaRuntime) return Promise.all([
      p.inputBound ? Promise.resolve() : this.ensureInputBound(p),
      p.mediaRuntime ? Promise.resolve() : this.ensureMediaReady(p),
    ]).then(() => this.connectTransport(p, generation));
    const mediaRuntime = p.mediaRuntime;
    p.disconnected = false;
    p.inputCredits = new CreditWindow({ maxItems: 12, maxBytes: 65536 });
    p.inputPolicy.reset(); p.adaptiveInput = false;
    return new Promise((resolve, reject) => {
      const url = new URL(serverUrl('/__opencraft_browser/stream'), location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(url); ws.binaryType = 'arraybuffer'; p.socket = ws;
      let terminalError: Error | null = null;
      const timer = setTimeout(() => { reject(new Error('Browser connection timed out')); ws.close(); }, 20000);
      const current = () => !p.closed && p.connection === generation;
      p.mediaReceiver?.dispose();
      p.mediaReceiver = new mediaRuntime.WebSocketMediaReceiver({
        visible: () => this.isVisible(p),
        reset: () => this.resetDecoder(p, true),
        send: input => {
          if (current() && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 65536)
            ws.send(JSON.stringify({ id: crypto.randomUUID(), method: 'mediaFeedback', input }));
        },
      });
      ws.onopen = () => { if (!current()) return; clearTimeout(timer);
        const viewport = p.viewportMeasured ? { ...p.viewport } : undefined;
        void this.call(p, 'open', { lease: p.lease, metadataRequired: !!this.storage.flush, multiView: true, documentInput: true, inputAcknowledgements: true, mediaFeedback: 1, mediaStage: typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined' ? 'rendered' : 'received', visible: this.isVisible(p), initialUrl: p.url ?? null, viewport, defaultDeviceProfile: remoteBrowserDeviceProfile() }).then(async config => {
          if (!current()) return; this.applyDocument(p, config.document); p.cdpAutomation = config.automationBackend === 'electron-cdp'; p.inputAcknowledgements = config.inputAcknowledgements === true; p.adaptiveInput = config.inputWindow === 12; p.serverInitialNavigation = config.multiView === true; p.layoutViewport = config.layoutViewport === true; p.viewportDeferred = false; this.setControl(p, config.control); p.resumed = config.resumed === true; p.restored = (config.resumed || config.restored) && !!config.navigation?.url && config.navigation.url !== 'about:blank'; p.nativeCopy = config.nativeCopy === true; p.nativeIme = config.nativeIme === true; p.multiTouch = config.multiTouch === true; this.keyboardChanged(); this.applyViewport(p, config);
          const effective = { width: config.width, height: config.height, deviceProfile: config.deviceProfile };
          if (!p.viewportMeasured) p.viewport = effective;
          p.sentViewport = JSON.stringify(effective); p.opened = true; for (const listener of this.controlListeners) listener(); p.retries = 0; clearTimeout(timer); resolve();
          if (p.restored && config.navigation) { p.events.onNavigation?.(config.navigation); if (config.navigation.url) p.url = config.navigation.url; }
          if (!config.navigation?.isLoading) p.events.onLoaded(config.navigation?.title || null);
          this.queueViewport(p); this.run(p, 'visible', { visible: this.isVisible(p) });
        }).catch(error => {
          clearTimeout(timer); reject(error); if (!current()) return; p.disconnected = true;
          if (error instanceof BrowserAutomationError && !error.retryable) terminalError = error;
          if (terminalError) p.events.onError(terminalError.message);
          ws.close(1000);
        });
      };
      ws.onmessage = event => {
        if (!current()) return;
        if (typeof event.data !== 'string') {
          if (p.mediaReceiver?.negotiated && p.mediaReceiver.receive(event.data) === null) return;
          this.decode(p, event.data); return;
        }
        const message = JSON.parse(event.data);
        if (message.type === 'media-config') {
          if (!p.mediaReceiver?.configure(message)) ws.close(1002, 'Unsupported browser media configuration');
          return;
        }
        if (message.type === 'result') {
          const inputDelay = p.inputCredits.age(message.id, performance.now());
          if (inputDelay !== null && p.adaptiveInput) p.inputPolicy.observe(inputDelay);
          p.inputCredits.release(message.id);
          const request = p.pending.get(message.id); if (!request) return;
          p.pending.delete(message.id); clearTimeout(request.timer);
          message.error ? request.reject(new BrowserAutomationError(message.error.code, message.error.message, message.error.retryable, message.error.outcome)) : request.resolve(message.value);
        } else if (message.type === 'control') this.setControl(p, message);
        else if (message.type === 'navigation') {
          if (message.state.isLoading && !p.document) { this.retireMenu(p); p.resetInput(); this.resetKeyboard(p); }
          p.events.onNavigation?.(message.state);
          if (!message.state.isLoading) { if (message.state.url && message.state.url !== 'about:blank') p.url = message.state.url; p.events.onLoaded(message.state.title || null); }
        } else if (message.type === 'input-reset') {
          this.applyDocument(p, message.document); this.retireMenu(p); p.resetInput(); this.resetKeyboard(p);
        }
        else if (message.type === 'viewport') this.applyViewport(p, message);
        else if (message.type === 'ime-state') {
          const oldEditor = p.editor;
          const keyboard = message.keyboard;
          p.editable = message.editable === true;
          p.editor = p.editable && typeof message.editor === 'string' ? message.editor : null;
          p.keyboard = keyboard && ['text','password','search','email','number','tel','url','textarea','contenteditable'].includes(keyboard.kind)
            && ['none','text','search','email','url','tel','numeric','decimal'].includes(keyboard.inputMode)
            && ['enter','done','go','next','previous','search','send'].includes(keyboard.enterKeyHint) ? keyboard : null;
          if (oldEditor !== p.editor) { p.ime?.retire(); p.receiver.value = ''; }
          p.receiver.type = p.keyboard?.secure ? 'password' : 'text';
          p.receiver.enterKeyHint = p.keyboard?.enterKeyHint || 'enter';
          this.updateKeyboard(p);
          this.keyboardChanged();
          if (!p.editable) { p.ime?.retire(); this.resetKeyboard(p, false); }
          const b = message.caret, r = p.canvas.getBoundingClientRect(), bounds = p.container.getBoundingClientRect();
          if (b && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.height)) {
            const scale = r.width / p.width;
            p.receiver.style.left = `${Math.max(0, Math.min(bounds.width - 1, b.x * scale))}px`;
            p.receiver.style.top = `${Math.max(0, Math.min(bounds.height - 1, (b.y + b.height) * scale))}px`;
          }
        }
        else if (message.type === 'context-menu') this.showMenu(p, message);
        else if (message.type === 'cursor' && typeof message.cursor === 'string' && /^[a-z-]+$/.test(message.cursor)) p.canvas.style.cursor = message.cursor;
        else if (message.type === 'new-window') p.events.onNewWindow?.(message.url, false);
        else if (message.type === 'error') p.events.onError(message.message);
      };
      ws.onerror = () => {}; // close owns recovery and pending rejection.
      ws.onclose = event => {
        clearTimeout(timer); reject(new Error('Browser connection closed'));
        if (!current()) return;
        p.disconnected = true; this.resetTransport(p);
        if (event.code === 4009) { p.displaced = true; p.events.onError('Browser tab opened in another client; reload this tab to take over'); return; }
        // Logical retirement and admission are terminal; a transport ending
        // cleanly is not itself a Tab close. Retain compatibility with the
        // existing server's explicit 1000 close reason.
        if (terminalError || event.code === 1008 || event.code === 1000 && event.reason === 'Browser tab closed') {
          if ((terminalError instanceof BrowserAutomationError && terminalError.code === 'SESSION_CLOSED'
            || event.code === 1000 && event.reason === 'Browser tab closed') && this.sessionClosed(p)) return;
          p.events.onError(terminalError?.message || (event.code === 1008
            ? event.reason === 'Invalid browser request' ? 'Browser request rejected; reload this tab'
              : 'Browser authorization expired; reload OpenCraft'
            : 'Browser tab closed')); return;
        }
        p.events.onError('Browser disconnected; reconnecting');
        p.reconnect = setTimeout(() => {
          if (!current()) return;
          p.reconnect = null; p.ready = this.connect(p); this.watchConnection(p);
        }, exponentialBackoffMs(p.retries++, { initialMs: 250, maxMs: 5_000 }));
      };
    });
  }
  private applyViewport(p: Page, config: { width: number; height: number }) {
    if (!Number.isInteger(config.width) || !Number.isInteger(config.height) || config.width < 1 || config.height < 1) return;
    if (p.width === config.width && p.height === config.height) return;
    // Config belongs to the new input/decoder epoch. The displayed bitmap keeps
    // its own dimensions until a complete replacement can be painted atomically.
    this.resetDecoder(p, true); p.width = config.width; p.height = config.height; p.awaitingFrame = true;
  }
  private retireMenu(p: Page) { ++p.interaction; p.menuIntent = null; if (this.menuOwner === p) { this.menuOwner = null; this.localMenu.retire(); } }
  private isVisible(p: Page) {
    return this.root !== null && p.visible && (typeof document === 'undefined' || !document.hidden);
  }
  private syncVisibility(p: Page) {
    const watching = this.root !== null && this.isVisible(p);
    if (p.watching === watching) return;
    p.watching = watching;
    if (!watching) {
      // Visibility retires human intent, not the logical Tab or an Agent use.
      const token = p.control.kind === 'human' ? p.control.token : undefined;
      if (p.acquiring?.kind === 'human' || token) { ++p.controlGeneration; p.acquiring = null; }
      this.retireMenu(p); p.resetInput(); this.resetKeyboard(p);
      if (p.resizeTimer) clearTimeout(p.resizeTimer); p.resizeTimer = null;
      if (token) {
        this.setControl(p, { ...p.control, controller: false, token: undefined });
        if (p.opened) void this.rawCall(p, 'control', { action: 'release', token }).catch(() => {});
      }
    } else { p.resizeRetry = undefined; p.viewportDeferred = false; this.queueViewport(p); }
    if (p.opened) this.run(p, 'visible', { visible: watching });
  }
  private acceptsInput(p: Page) {
    return this.root !== null && !p.closed && !this.inputFailed && !p.blocked && this.isVisible(p) && p.opened && p.container.style.pointerEvents !== 'none';
  }
  private acceptsPointer(p: Page) { return this.acceptsInput(p) && !p.resizing && !p.awaitingFrame; }
  private copyCurrent(p: Page) {
    this.menuOwner = p;
    const connection = p.connection, interaction = p.interaction;
    const current = () => this.acceptsInput(p) && p.connection === connection && p.interaction === interaction;
    this.localMenu.copy(() => this.call(p, 'copy'), current, message => this.inputError(p, 'copy', message));
  }
  private showMenu(p: Page, menu: { intent?: unknown; context?: unknown; x?: unknown; y?: unknown; copy?: unknown; link?: unknown }) {
    if (!this.acceptsInput(p) || typeof menu.x !== 'number' || !Number.isFinite(menu.x)
      || typeof menu.y !== 'number' || !Number.isFinite(menu.y) || !p.menuIntent || menu.intent !== p.menuIntent) return;
    const context = typeof menu.context === 'string' && /^[a-zA-Z0-9-]{20,100}$/.test(menu.context) ? menu.context : undefined;
    let link: string | undefined;
    try { const url = new URL(String(menu.link)); if (['https:', 'http:'].includes(url.protocol) && url.href.length <= 16384) link = url.href; } catch {}
    const copy = p.nativeCopy && menu.copy === true && context !== undefined;
    if (!copy && !link) return;
    const connection = p.connection, interaction = p.interaction;
    const current = () => this.acceptsInput(p) && p.connection === connection && p.interaction === interaction;
    const r = p.canvas.getBoundingClientRect(), scale = r.width / p.width;
    this.menuOwner = p;
    this.localMenu.open({ copy, link: link !== undefined,
      x: r.left + menu.x * scale,
      y: r.top + menu.y * scale,
      current, run: action => action === 'copy' ? this.call(p, 'copy', { context }) : Promise.resolve({ text: link! }),
      focus: () => { if (current()) p.receiver.focus({ preventScroll: true }); }, error: message => this.inputError(p, 'copy', message) });
  }
  private queueViewport(p: Page) {
    const target = JSON.stringify(p.viewport), failures = p.resizeRetry?.target === target ? p.resizeRetry.failures : 0;
    const human = p.control.controller && p.control.kind === 'human';
    const idle = p.layoutViewport && !p.control.active;
    if (p.closed || !p.opened || !p.viewportMeasured || !this.isVisible(p) || !(human || idle) || p.viewportDeferred || p.gestureActive || p.resizing || p.resizeTimer || p.sentViewport === target || failures > 3) return;
    const connection = p.connection, generation = p.controlGeneration, token = p.control.token, control = p.control;
    const current = () => !p.closed && p.opened && this.isVisible(p) && connection === p.connection
      && generation === p.controlGeneration && (human
        ? p.control.controller && p.control.kind === 'human' && p.control.token === token
        : !p.control.active);
    p.resizeTimer = setTimeout(() => {
      p.resizeTimer = null; if (!current() || p.gestureActive) { this.queueViewport(p); return; }
      const viewport = { ...p.viewport }, sent = JSON.stringify(viewport);
      const attempt = p.resizeRetry?.target === sent ? p.resizeRetry.failures : 0;
      p.resetPointers(); p.resizing = true;
      void this.call(p, human ? 'viewport' : 'layoutViewport', viewport, token).then(result => {
        if (current()) {
          if (result?.deferred) p.viewportDeferred = p.control === control && JSON.stringify(p.viewport) === sent;
          else { p.sentViewport = sent; p.resizeRetry = undefined; }
        }
      }).catch(error => {
        if (!current()) return;
        const failures = error.retryable === false ? 4 : attempt + 1;
        p.resizeRetry = { target: sent, failures };
        if (failures > 3) p.events.onError(error.message);
      }).finally(() => {
        // An old connection's completion cannot release its replacement's slot.
        if (connection !== p.connection) return;
        p.resizing = false; this.queueViewport(p);
      });
    }, failures ? exponentialBackoffMs(failures - 1, { initialMs: 200, maxMs: 1_600 }) : 100);
  }
  private applyDocument(p: Page, document: unknown) {
    if (typeof document === 'string' && document.length <= 100) p.document = document;
  }
  private call(p: Page, method: string, input?: unknown, expected = p.control.token, document = p.document, signal?: AbortSignal): Promise<any> {
    const readOnly = ['open', 'visible', 'keyframe', 'capture', 'copy', 'layoutViewport'].includes(method)
      || method === 'automation' && ['inspect', 'readContext', 'wait', 'annotatePick', 'annotateRegion', 'annotateText', 'annotateStyles'].includes((input as { method?: string })?.method ?? '');
    if (!readOnly && (!expected || !p.control.controller || p.control.token !== expected))
      return Promise.reject(new BrowserAutomationError('CONTROL_LOST', 'Browser control changed; start a new interaction', true));
    if (!['input', 'open', 'visible', 'keyframe'].includes(method) && p.inputQueue?.busy) {
      const generation = p.controlGeneration, connection = p.connection;
      return p.inputQueue.barrier(() => {
        if (p.closed || p.controlGeneration !== generation || p.connection !== connection || !readOnly && (!p.control.controller || p.control.token !== expected))
          throw new BrowserAutomationError('CONTROL_LOST', 'Browser interaction ended', true);
        return this.rawCall(p, method, input, readOnly ? undefined : expected, document, signal);
      });
    }
    return this.rawCall(p, method, input, readOnly ? undefined : expected, document, signal);
  }
  private rawCall(p: Page, method: string, input?: unknown, control?: string, document = p.document, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) return Promise.reject(new BrowserAutomationError('CDP_ABORTED', 'Browser invocation cancelled', false, 'not-dispatched'));
    if (p.closed || p.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new BrowserAutomationError('PAGE_CLOSED', 'Browser disconnected', true));
    const id = crypto.randomUUID(), payload = JSON.stringify({ id, method, input, control, document });
    const trackedInput = method === 'input' && p.inputAcknowledgements;
    if (trackedInput && !p.inputCredits.reserve(id, new TextEncoder().encode(payload).byteLength, false, performance.now()))
      return Promise.reject(new BrowserAutomationError('TIMEOUT', 'Browser input is waiting for confirmation', true));
    if (['text','visible','keyframe'].includes(method) || method === 'input' && !p.inputAcknowledgements) { p.socket.send(payload); return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const connection = p.connection, socket = p.socket!;
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', cancel);
        p.pending.delete(id);
        // Settling unknown never returns credits or replays this operation.
        if (trackedInput && connection === p.connection) socket.close(1013, 'Input result unknown; reconnecting');
        reject(new BrowserAutomationError('TIMEOUT', `Browser operation timed out (${method})`, false, 'unknown'));
      }, method === 'open' ? 45000 : method === 'automation' ? Math.min(65000, Math.max(35000, Number((input as any)?.input?.timeoutMs ?? 0) + 5000)) : 25000);
      const cancel = () => {
        if (method === 'automation' && p.connection === connection && p.socket === socket && socket.readyState === WebSocket.OPEN) {
          try { socket.send(JSON.stringify({ id: crypto.randomUUID(), method: 'cancelAutomation', input: { requestId: id } })); }
          catch { /* The original request retains its unknown-outcome deadline. */ }
        }
      };
      const clean = () => signal?.removeEventListener('abort', cancel);
      p.pending.set(id, {
        resolve: value => { clean(); if (signal?.aborted) reject(new BrowserAutomationError('CDP_ABORTED', 'Browser invocation cancelled', false, 'unknown')); else resolve(value); },
        reject: error => { clean(); reject(error); }, timer,
      });
      signal?.addEventListener('abort', cancel, { once: true });
      try { socket.send(payload); } catch (error) {
        clean(); clearTimeout(timer); p.pending.delete(id); socket.close(); reject(error as Error);
      }
    });
  }
  private run(p: Page, method: string, input?: unknown) { void p.ready.then(() => ['zoom', 'stop', 'back', 'forward'].includes(method) ? this.humanCall(p, method, input) : this.call(p, method, input)).catch(error => this.operationError(p, error)); }
  private paintFrame(p: Page, frame: CanvasImageSource, width: number, height: number, frameId?: string) {
    // Resizing a canvas clears it. Resize and draw in this same rendering task,
    // never in the earlier viewport-notification task.
    if (p.canvas.width !== width) p.canvas.width = width;
    if (p.canvas.height !== height) p.canvas.height = height;
    const context = p.canvas.getContext('2d', { alpha: false }); if (!context) return;
    context.drawImage(frame, 0, 0, width, height);
    this.didPaint(p);
    if (frameId) p.mediaReceiver?.renderedFrame(frameId);
    if (width === p.width && height === p.height) p.awaitingFrame = false;
  }
  private didPaint(p: Page) {
    p.hasPaint = true;
    p.container.dataset.browserPainted = 'true';
    for (const done of p.paintWaiters) done();
  }
  private resetDecoder(p: Page, preserveFrame = false) {
    p.cancelVideoReady?.(); p.cancelVideoReady = null;
    if (preserveFrame && p.video?.style.opacity === '1') p.mediaRuntime?.snapshotVideo(this.mediaOwner, p, p.video);
    if (p.decoder && p.decoder.state !== 'closed') p.decoder.close(); p.decoder = null;
    p.media?.dispose(); p.media = null; p.video?.remove(); p.video = null;
    p.latest?.close(); p.latest = null; cancelAnimationFrame(p.raf); p.raf = 0; p.needsKey = true;
  }
  private readonly mediaOwner: import('./remote-browser-media-runtime').RemoteBrowserMediaOwner = {
    paintFrame: (...args) => this.paintFrame(...args),
    didPaint: p => this.didPaint(p),
    resetDecoder: (...args) => this.resetDecoder(...args),
    run: (...args) => this.run(...args),
  };
  private decode(p: Page, bytes: ArrayBuffer) { p.mediaRuntime?.decodeFrame(this.mediaOwner, p, bytes); }
  private loadMediaRuntime() { return import('./remote-browser-media-runtime'); }
  private ensureMediaReady(p: Page): Promise<void> {
    if (p.mediaReady) return p.mediaReady;
    const ready = this.loadMediaRuntime().then(runtime => {
      if (p.closed || this.inputFailed || this.pages.get(p.id) !== p)
        throw this.storageError ?? new Error('Browser tab closed');
      p.mediaRuntime = runtime;
    });
    p.mediaReady = ready;
    void ready.catch(() => { if (p.mediaReady === ready) p.mediaReady = null; });
    return ready;
  }
  private loadInputRuntime() { return import('./remote-browser-input-runtime'); }
  private ensureInputBound(p: Page): Promise<void> {
    if (p.inputReady) return p.inputReady;
    const ready = this.loadInputRuntime().then(({ bindRemoteBrowserInput }) => {
      // Public code may arrive after close, detach, disposal or ID reuse.
      if (p.closed || this.inputFailed || this.pages.get(p.id) !== p)
        throw this.storageError ?? new Error('Browser tab closed');
      p.inputDispose = bindRemoteBrowserInput({
        acceptsInput: (...args) => this.acceptsInput(...args),
        acceptsPointer: (...args) => this.acceptsPointer(...args),
        call: (...args) => this.call(...args),
        inputError: (...args) => this.inputError(...args),
        acquireControl: (...args) => this.acquireControl(...args),
        retireMenu: (...args) => this.retireMenu(...args),
        updateKeyboard: (...args) => this.updateKeyboard(...args),
        queueViewport: (...args) => this.queueViewport(...args),
        syncVisibility: (...args) => this.syncVisibility(...args),
        copyCurrent: (...args) => this.copyCurrent(...args),
      }, p);
      p.inputBound = true;
      this.syncVisibility(p);
    });
    p.inputReady = ready;
    // A later explicit retry may load a previously unavailable chunk again.
    void ready.catch(() => { if (p.inputReady === ready) p.inputReady = null; });
    return ready;
  }
}
