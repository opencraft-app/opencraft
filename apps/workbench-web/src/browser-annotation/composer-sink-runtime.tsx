import type { ComposerController, ComposerContextReference } from "@opencraft/composer-core";
import { annotationContextReference, annotationFromReference, BROWSER_ANNOTATION_REFERENCE_PREFIX, BROWSER_ANNOTATION_DRAFT_LIMIT } from "@opencraft/browser-annotation";
import type { BrowserAnnotation } from "@opencraft/browser-core";
import { useMemo, useSyncExternalStore } from "react";

/**
 * The only seam between browser annotation and the conversation composer.
 * Annotations live in the composer draft as context references, so removing
 * a card there removes the marker on the page and sending clears both.
 */
export interface BrowserAnnotationSink {
  subscribe(listener: () => void): () => void;
  list(): readonly BrowserAnnotation[];
  draftId(): string;
  prepareAdd(): (annotation: BrowserAnnotation | null) => boolean;
  /** Edit a copy; commit replaces the existing reference atomically. */
  prepareEdit?(id: string): (annotation: BrowserAnnotation | null) => boolean;
  remove(id: string): void;
  clear(): void;
  focusComposer(): void;
}

import { useAnnotationComposerController } from "./composer-sink";

export function createComposerAnnotationSink(controller: ComposerController): BrowserAnnotationSink {
  let cachedContext: readonly ComposerContextReference[] | null = null;
  let cached: readonly BrowserAnnotation[] = [];
  const list = () => {
    const context = controller.getSnapshot().draft.context;
    if (context !== cachedContext) {
      cachedContext = context;
      cached = context.flatMap((reference) => annotationFromReference(reference) ?? []);
    }
    return cached;
  };
  const prepare = (editId?: string) => {
    const initial = controller.getSnapshot().draft;
    const draftId = initial.id;
    const referenceId = editId === undefined ? null : BROWSER_ANNOTATION_REFERENCE_PREFIX + editId;
    const original = referenceId === null ? null : initial.context.find(item => item.id === referenceId);
    let valid = initial.lifecycle.phase !== "submitting" && (referenceId === null || original !== undefined);
    const unsubscribe = controller.subscribe(() => {
      const draft = controller.getSnapshot().draft;
      if (draft.id !== draftId || draft.lifecycle.phase === "submitting"
        || referenceId !== null && draft.context.find(item => item.id === referenceId) !== original) valid = false;
    });
    let settled = false;
    return (annotation: BrowserAnnotation | null) => {
      if (settled) return false;
      const draft = controller.getSnapshot().draft;
      if (!annotation || !valid || draft.id !== draftId || draft.lifecycle.phase === "submitting"
        || editId !== undefined && annotation.id !== editId) { settled = true; unsubscribe(); return false; }
      const remaining = list().filter(item => item.id !== editId);
      if (remaining.length >= BROWSER_ANNOTATION_DRAFT_LIMIT
        || remaining.some(item => item.number === annotation.number || item.id === annotation.id)) return false;
      let next: ComposerContextReference;
      try { next = annotationContextReference(annotation); } catch { return false; }
      // Validate the same representation that is persisted and later compiled.
      if (!annotationFromReference(next)) return false;
      const context = [...draft.context.filter(item => item.id !== next.id), next];
      const annotations = context.flatMap(item => annotationFromReference(item) ?? []);
      if (annotations.reduce((sum, item) => sum + (item.selections?.length ?? 1), 0) > 32) return false;
      const imageCount = context.reduce((sum, item) => {
        if (!item.id.startsWith(BROWSER_ANNOTATION_REFERENCE_PREFIX)) return sum;
        const images = item.metadata?.inputImages;
        return sum + (Array.isArray(images) ? images.length : typeof item.metadata?.inputImage === "string" ? 1 : 0);
      }, 0);
      if (imageCount > 8) return false;
      // Leave room for persistence envelope/version fields under the 4 MiB record limit.
      if (new TextEncoder().encode(JSON.stringify({ ...draft, context })).byteLength > 4 * 1024 * 1024 - 64 * 1024) return false;
      settled = true; unsubscribe(); valid = false;
      controller.dispatch({ type: "add-context", reference: next });
      return true;
    };
  };
  return {
    subscribe: (listener) => controller.subscribe(listener),
    list,
    draftId: () => controller.getSnapshot().draft.id,
    prepareAdd: () => prepare(),
    prepareEdit: (id) => prepare(id),
    remove: (id) => controller.dispatch({ type: "remove-context", id: BROWSER_ANNOTATION_REFERENCE_PREFIX + id }),
    clear: () => { for (const annotation of list()) controller.dispatch({ type: "remove-context", id: BROWSER_ANNOTATION_REFERENCE_PREFIX + annotation.id }); },
    focusComposer: () => controller.focus(),
  };
}

const EMPTY: readonly BrowserAnnotation[] = [];
export function useBrowserAnnotationSink() {
  const controller = useAnnotationComposerController();
  const sink = useMemo(() => controller ? createComposerAnnotationSink(controller) : null, [controller]);
  const annotations = useSyncExternalStore(sink?.subscribe ?? (() => () => {}), sink?.list ?? (() => EMPTY), sink?.list ?? (() => EMPTY));
  const draftId = useSyncExternalStore(sink?.subscribe ?? (() => () => {}), sink?.draftId ?? (() => ""), sink?.draftId ?? (() => ""));
  return { sink, annotations, draftId };
}
