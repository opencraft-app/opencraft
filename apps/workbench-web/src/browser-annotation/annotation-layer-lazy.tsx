import { lazy, Suspense, type ComponentProps } from "react";
import type { BrowserAnnotationLayer as Layer } from "./annotation-layer";

const LazyLayer = lazy(() =>
  import("./annotation-layer").then((module) => ({ default: module.BrowserAnnotationLayer })),
);

/** Editing UI and its stylesheet are loaded only after entering annotation mode. */
export function BrowserAnnotationLayer(props: ComponentProps<typeof Layer>) {
  if (!props.controller.active) return null;
  return (
    <Suspense fallback={null}>
      <LazyLayer {...props} />
    </Suspense>
  );
}
