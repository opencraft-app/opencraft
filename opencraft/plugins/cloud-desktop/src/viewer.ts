import type { DesktopConnection, DesktopControlLease } from "./contract";

/** Web-only media/input adapter. Transport listeners and coordinate mapping
 * belong to the adapter, not the Shell, product provider or tab model. */
export interface DesktopSurface {
  enableInput(lease: DesktopControlLease): void;
  disableInput(): void;
  /** Optional physical adapter capabilities; consumed only under valid control. */
  focus?(): void;
  pasteText?(text: string, lease: DesktopControlLease, signal: AbortSignal): Promise<void>;
  setPasteHandler?(handler: (readText: () => Promise<string>) => void): void;
  dispose(): void;
}

export interface DesktopSurfaceFactory {
  /** Must start observe-only, before the caller can invoke disableInput. */
  mount(element: HTMLElement, connection: DesktopConnection): DesktopSurface;
}
