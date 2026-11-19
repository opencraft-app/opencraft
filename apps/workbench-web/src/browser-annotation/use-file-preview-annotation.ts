import { useEffect, useMemo, useState, type RefObject } from "react";
import { createFrameAnnotator } from "./frame/frame-annotator";
import { annotationFrameScript, withAnnotationFrameAgent } from "./frame/frame-source";
import { useBrowserAnnotation } from "./use-browser-annotation";

/**
 * Annotation for our own HTML file previews (sandboxed srcdoc iframes, no
 * allow-same-origin). Returns the document to render and the controller.
 */
export function useFilePreviewAnnotation(input: {
  readonly frame: RefObject<HTMLIFrameElement | null>;
  readonly html: string | null;
  readonly hostId: string;
  readonly path: string;
  readonly tabId: string;
}) {
  const { frame, html, hostId, path, tabId } = input;
  // A same-path HTML replacement is still a new document, not a stable target.
  const token = useMemo(() => crypto.randomUUID(), [hostId, path, html]);
  const srcDoc = useMemo(
    () =>
      html === null
        ? null
        : withAnnotationFrameAgent(
            html,
            annotationFrameScript({ token, parentOrigin: window.location.origin, previewAllowed: true }),
          ),
    [html, token],
  );
  const title = path.split(/[\\/]/).at(-1) ?? path;
  const [annotator, setAnnotator] = useState<ReturnType<typeof createFrameAnnotator> | null>(null);
  useEffect(() => {
    if (html === null) {
      setAnnotator(null);
      return;
    }
    // Explicit host grant: temporary changes stay inside this owned sandbox,
    // never write the file, and are not granted to arbitrary browser pages.
    const next = createFrameAnnotator({
      frame: () => frame.current,
      token,
      previewAllowed: true,
      document: { url: path, title, source: path, generation: token },
    });
    setAnnotator(next);
    return () => next.dispose();
  }, [frame, token, path, title, html === null]);
  const controller = useBrowserAnnotation({
    annotator,
    tabId: `file:${hostId}:${tabId}`,
    url: path,
    blocked: false,
    surface: "file-preview",
  });
  // Leaving the rendered preview (source view, editing, other file) ends the mode.
  useEffect(() => {
    if (html === null) controller.exit();
  }, [html === null, path]);
  return { srcDoc, controller };
}
