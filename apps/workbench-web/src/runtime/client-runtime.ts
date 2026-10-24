import { bindTouchInteractionMode } from "./pointer-modality";
import { bindPwaEdgeNavigation } from "./pwa-edge-navigation";
import { ApplePwaPushDevice, type PushDevicePort } from "./push-device";
import { serverUrl } from "./server-context";
import { readWindowPresentation, resolveWindowPresentation, type WindowPresentation } from "./window-presentation";
import { projectWindowAppearance, type WindowAppearanceIntent, type WindowAppearanceProjection, type WindowAppearanceProjector } from "./window-appearance";

export type ClientRuntimeKind = "web" | "pwa" | "electron";

/** One document's presentation lifetime, distinct from AppServer/Actor runtime. */
export interface ClientRuntime extends WindowAppearanceProjector {
  readonly kind: ClientRuntimeKind;
  readonly presentation: WindowPresentation;
  readonly pushDevice: PushDevicePort | null;
  start(): void;
  dispose(): void;
}

export function resolveClientRuntimeKind(view: Window): ClientRuntimeKind {
  const presentation = readWindowPresentation(view);
  if (presentation.host === "electron") return "electron";
  const standalone = (view.navigator as Navigator & { standalone?: boolean }).standalone === true
    || view.matchMedia?.("(display-mode: standalone)").matches === true;
  return presentation.host === "browser" && standalone ? "pwa" : "web";
}

/** Shared DOM mechanics; subclasses own only their actual host capabilities. */
export class WebRuntime implements ClientRuntime {
  protected readonly document: Document;
  private started = false;
  private disposed = false;
  private readonly cleanups: Array<() => void> = [];
  constructor(document: Document) { this.document = document; }
  get kind(): ClientRuntimeKind { return "web"; }
  get pushDevice(): PushDevicePort | null { return null; }
  get presentation(): WindowPresentation {
    return this.document.defaultView ? readWindowPresentation(this.document.defaultView) : resolveWindowPresentation({});
  }
  protected own(dispose: (() => void) | undefined): void { if (dispose) this.cleanups.push(dispose); }
  protected onStart(): void { this.own(bindTouchInteractionMode(this.document)); }
  start(): void {
    if (this.disposed) throw new Error("Cannot start a retired ClientRuntime");
    if (this.started) return;
    this.started = true;
    try {
      this.onStart();
      this.document.documentElement.dataset.clientRuntime = this.kind;
    } catch (error) {
      try { this.dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], "ClientRuntime startup failed"); }
      throw error;
    }
  }
  projectAppearance(requested: WindowAppearanceIntent, phase: WindowAppearanceProjection["phase"]): WindowAppearanceProjection {
    if (this.disposed) throw new Error("Cannot project appearance through a retired ClientRuntime");
    return projectWindowAppearance(this.document, requested, this.presentation, phase);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const failures: unknown[] = [];
    for (const cleanup of this.cleanups.reverse()) {
      try { cleanup(); } catch (error) { failures.push(error); }
    }
    this.cleanups.length = 0;
    if (this.document.documentElement.dataset.clientRuntime === this.kind) delete this.document.documentElement.dataset.clientRuntime;
    if (failures.length) throw new AggregateError(failures, "ClientRuntime disposal failed");
  }
}

export class PwaRuntime extends WebRuntime {
  private readonly device = new ApplePwaPushDevice(this.document, serverUrl('/opencraft-push-worker.js'), serverUrl('/__opencraft_push/legacy/'));
  override get kind(): ClientRuntimeKind { return "pwa"; }
  override get pushDevice(): PushDevicePort | null { return this.device.supported ? this.device : null; }
  protected override onStart(): void {
    super.onStart();
    // Only the Apple Home Screen capability enables this native-history guard.
    // Other PWA hosts retain their native gestures; no fake history entries.
    this.own(bindPwaEdgeNavigation(this.document));
    this.own(() => this.device.dispose());
  }
}

interface DesktopFullscreenPort {
  readonly getWindowFullscreen?: () => boolean;
  readonly onWindowFullscreenChanged?: (listener: (fullscreen: boolean) => void) => () => void;
}
export class ElectronRuntime extends WebRuntime {
  override get kind(): ClientRuntimeKind { return "electron"; }
  protected override onStart(): void {
    super.onStart();
    const view = this.document.defaultView as (Window & { opencraftDesktop?: DesktopFullscreenPort }) | null;
    const bridge = view?.opencraftDesktop;
    const apply = (value: boolean) => { this.document.documentElement.dataset.opencraftWindowFullscreen = String(value); };
    // Subscribe before reading the snapshot, preserving the preload's ordering.
    this.own(bridge?.onWindowFullscreenChanged?.(apply));
    apply(bridge?.getWindowFullscreen?.() ?? false);
  }
}

export function createClientRuntime(document: Document): ClientRuntime {
  const kind = document.defaultView ? resolveClientRuntimeKind(document.defaultView) : "web";
  return kind === "electron" ? new ElectronRuntime(document) : kind === "pwa" ? new PwaRuntime(document) : new WebRuntime(document);
}
