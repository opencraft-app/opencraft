import { PendingPreview } from "@opencraft/design-system-web/preview-activation";
import { lazy, Suspense, useEffect, type ReactNode } from "react";

/** Display-only resources. Their caller retains authorization and URL lifetime. */
export interface ImagePreviewMedia {
  readonly id: string;
  readonly source: string | null;
  readonly alt: string;
  readonly title?: string;
  readonly status?: "loading" | "unavailable";
}
interface ImagePreviewNeighbor {
  readonly onSelect: () => void;
  readonly content?: ReactNode;
}
export interface ImagePreviewProps {
  readonly image: ImagePreviewMedia;
  readonly onClose: () => void;
  readonly previous?: ImagePreviewNeighbor;
  readonly next?: ImagePreviewNeighbor;
  readonly position?: { readonly index: number; readonly count: number };
  readonly actions?: ReactNode;
  readonly returnFocus?: () => HTMLElement | null;
  readonly openedByPointer?: boolean;
  readonly className?: string;
}

// Opening a gallery activates its dialog, gestures and stylesheet together.
// Merely importing chat renderers must not put optional viewer CSS on startup.
const LazyImagePreview = lazy(() =>
  import("./image-preview-view").then((module) => ({ default: module.ImagePreviewView })),
);

export function ImagePreview(props: ImagePreviewProps) {
  return (
    <Suspense fallback={<PendingPreview onClose={props.onClose} />}>
      <LazyImagePreview {...props} />
    </Suspense>
  );
}
