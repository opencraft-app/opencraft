import type { DesktopConnection, DesktopControlLease } from "./contract";

/** Web-only media/input adapter. Transport listeners and coordinate mapping
 * belong to the adapter, not the Shell, product provider or tab model. */
export interface DesktopSurface {
  /** Logical presentation activity, independent of viewing transport and input grant.
   * Inactive surfaces retire overlays/listeners even while media stays mounted. */
  setActive(active: boolean): void;
  enableInput(lease: DesktopControlLease): void;
  disableInput(): void;
  /** Acquire media focus without granting input, including before Take awaits authorization. */
  focus?(): void;
  /** Bind an optional relative pointer surface to this same input owner. */
  attachTrackpad?(element: HTMLElement): () => void;
  /** Explicit platform keyboard gesture, only under this surface's grant. */
  focusTextInput?(label: string): void;
  /** Physical clipboard capability; consumed only under this exact valid grant. */
  pasteText?(text: string, lease: DesktopControlLease, signal: AbortSignal): Promise<void>;
  setPasteHandler?(handler: (readText: () => Promise<string>) => void): void;
  dispose(): void;
}

export interface DesktopSurfaceFactory {
  /** Must start observe-only, before the caller can invoke disableInput. */
  mount(element: HTMLElement, connection: DesktopConnection): DesktopSurface;
}
