import { forwardRef, lazy, Suspense, type ImgHTMLAttributes, type ReactNode } from "react";

export type ZoomableImageProps = Pick<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt" | "title" | "onError" | "onLoad"> & {
  readonly fitToContainer?: boolean;
  readonly onBackgroundClick?: () => void;
  readonly onPreviousImage?: () => void;
  readonly onNextImage?: () => void;
  readonly imageKey?: string;
  readonly previousImage?: ReactNode;
  readonly nextImage?: ReactNode;
};
export interface ImagePreviewNavigation { previous(): void; next(): void }

const LazyZoomableImage = lazy(() => import("./zoomable-image-view").then(module => ({ default: module.ZoomableImageView })));

/** Gesture observers and styles start only when an image surface is mounted. */
export const ZoomableImage = forwardRef<ImagePreviewNavigation, ZoomableImageProps>(function ZoomableImage(props, ref) {
  return <Suspense fallback={null}><LazyZoomableImage {...props} ref={ref} /></Suspense>;
});
