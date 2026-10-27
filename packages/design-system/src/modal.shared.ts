/**
 * Renderer-neutral modal semantics. Product code describes the content and its
 * presentation intent; each Workbench host owns the concrete window, focus,
 * dismissal, portal and animation implementation.
 */
export type ModalPresentation = "dialog" | "sheet" | "adaptive-sheet" | "fullscreen" | "inspector";

export type ModalSize = "compact" | "default" | "wide" | "workspace";

export type ModalLayer = "application" | "nested" | "confirmation";

export type ModalDismissReason =
  | "close-button"
  | "escape-key"
  | "outside-press"
  | "system";

export interface ModalDescriptor {
  readonly appearance?: "default" | "utility";
  readonly label: string;
  readonly presentation?: ModalPresentation;
  readonly size?: ModalSize;
  readonly layer?: ModalLayer;
  readonly dismissOnOutsidePress?: boolean;
  readonly showCloseButton?: boolean;
}

export const modalGeometry = {
  maximumViewportWidthPercent: 92,
  maximumViewportHeightPercent: 92,
  widths: {
    compact: 420,
    default: 520,
    wide: 680,
    workspace: 1120,
  },
} as const;
