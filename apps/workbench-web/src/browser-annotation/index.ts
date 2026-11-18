/** Browser annotation feature package: one hook, three mount points. */
export { BrowserAnnotationSinkProvider } from "./composer-sink";
export { createComposerAnnotationSink, useBrowserAnnotationSink, type BrowserAnnotationSink } from "./composer-sink-runtime";
export { useBrowserAnnotation, type BrowserAnnotationController } from "./use-browser-annotation";
export { BrowserAnnotationToggle } from "./annotation-toggle";
export { BrowserAnnotationLayer } from "./annotation-layer-lazy";
export { useFilePreviewAnnotation } from "./use-file-preview-annotation";
