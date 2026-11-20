import { annotationMarks, BROWSER_ANNOTATION_DRAFT_LIMIT, createAnnotation, nextAnnotationNumber, upgradeAnnotation } from "@opencraft/browser-annotation";
import { BROWSER_ANNOTATION_STYLE_PROPERTIES } from "@opencraft/browser-core";
import type { BrowserAnnotation, BrowserAnnotationAnchor, BrowserAnnotationEvidence, BrowserAnnotationMark, BrowserAnnotationPick, BrowserAnnotationPoint, BrowserAnnotationStyleIntent, BrowserAnnotationStyleProperty, BrowserAnnotationTextReplacement, BrowserAnnotator, BrowserPageId } from "@opencraft/browser-core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useBrowserAnnotationSink } from "./composer-sink-runtime";

export const ANNOTATION_LIMIT_ERROR = "annotation-limit";
export type AnnotationMode = "browse" | "element" | "region" | "text";
export interface AnnotationCandidate {
  readonly id: string;
  readonly label: string;
  readonly point: BrowserAnnotationPoint;
  readonly end?: BrowserAnnotationPoint;
  readonly pick: BrowserAnnotationPick;
  readonly selector?: string;
}
export interface BrowserAnnotationController {
  readonly available: boolean; readonly active: boolean; readonly candidate: AnnotationCandidate | null;
  readonly selections: readonly AnnotationCandidate[]; readonly selecting: boolean;
  readonly mode: AnnotationMode; setMode(mode: AnnotationMode): void;
  readonly capabilities: { region: boolean; text: boolean; multiSelect: boolean; styles: boolean; preview: boolean };
  readonly comment: string; setComment(value: string): void;
  addSelection(): void; selectSelection(id: string): void; removeSelection(id: string): void;
  readonly markerChoices: readonly { id: string; label: string }[]; openMarker(id: string): void; dismissMarkers(): void;
  readonly hasRequest: boolean;
  readonly busy: boolean; readonly pending: boolean; cancelOperation(): void;
  readonly stale: boolean; readonly discardRequested: boolean; keepEditing(): void; discard(): void;
  readonly screenshot: string | null; readonly evidence: readonly BrowserAnnotationEvidence[];
  readonly pendingEvidence: BrowserAnnotationEvidence | null; confirmEvidence(): void; discardEvidence(): void;
  readonly canPreview: boolean; previewScreenshot(kind?: "target" | "context"): Promise<void>; removeScreenshot(id?: string): void;
  readonly styles: Readonly<Record<string, string>> | null; readonly styleIntents: readonly BrowserAnnotationStyleIntent[];
  readStyles(): Promise<void>; setStyles(values: readonly { property: BrowserAnnotationStyleProperty; value: string | null }[]): void; setStyle(property: BrowserAnnotationStyleProperty, value: string | null): void;
  readonly textReplacements: readonly BrowserAnnotationTextReplacement[]; setReplacement(value: string | null): void;
  readonly previewing: boolean; readonly original: boolean; previewChanges(original?: boolean): Promise<void>; clearPreview(): void;
  readonly saved: readonly BrowserAnnotation[]; readonly editingId: string | null; edit(id: string): void;
  readonly error: string | null; readonly count: number; readonly nextNumber: number;
  toggle(): void; exit(): void; step(delta: 1 | -1): void; cancel(): void; reveal(fraction: number): void;
  submit(comment: string): Promise<boolean>; clear(): void; finish(): void;
}

function accentColor(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const probe = document.createElement("span"); probe.style.color = "var(--color-text-accent)"; document.body.append(probe);
  const value = getComputedStyle(probe).color; probe.remove();
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!context) return undefined;
  context.fillStyle = value; context.fillRect(0, 0, 1, 1);
  return "#" + [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(part => part.toString(16).padStart(2, "0")).join("");
}
function selectionSuffix(index: number): string {
  let label = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label;
  return label;
}
function sameTarget(a: BrowserAnnotationAnchor, b: BrowserAnnotationAnchor) {
  return a.kind === b.kind && a.bindingKey === b.bindingKey && a.documentGeneration === b.documentGeneration
    && a.selectedText === b.selectedText && JSON.stringify(a.textLocator) === JSON.stringify(b.textLocator)
    && (a.kind !== "region" || JSON.stringify(a.rect) === JSON.stringify(b.rect));
}

export function useBrowserAnnotation(input: {
  readonly annotator: BrowserAnnotator | null; readonly pageId?: BrowserPageId; readonly tabId: string;
  readonly url: string | null; readonly blocked: boolean; readonly surface?: "browser" | "file-preview";
}): BrowserAnnotationController {
  const { annotator, tabId, url, blocked, surface } = input;
  const { sink, annotations, draftId } = useBrowserAnnotationSink();
  const [active, setActive] = useState(false), [mode, setMode] = useState<AnnotationMode>("element");
  const [selections, setSelections] = useState<AnnotationCandidate[]>([]), [activeId, setActiveId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(true), [comment, setComment] = useState("");
  const [hover, setHover] = useState<BrowserAnnotationPick | null>(null), [busy, setBusy] = useState(false), [pending, setPending] = useState(false);
  const [evidence, setEvidence] = useState<BrowserAnnotationEvidence[]>([]), [pendingEvidence, setPendingEvidence] = useState<BrowserAnnotationEvidence | null>(null);
  const [styleIntents, setStyleIntents] = useState<BrowserAnnotationStyleIntent[]>([]), [textReplacements, setTextReplacements] = useState<BrowserAnnotationTextReplacement[]>([]);
  const [styleCache, setStyleCache] = useState<Record<string, Readonly<Record<string, string>>>>({});
  const [previewing, setPreviewing] = useState(false), [original, setOriginal] = useState(false);
  const [error, setError] = useState<string | null>(null), [stale, setStale] = useState(false), [discardRequested, setDiscardRequested] = useState(false);
  const sequence = useRef(0), ordinal = useRef(0), transactionId = useRef<string | null>(null), transactionNumber = useRef<number | null>(null);
  const [markerChoices, setMarkerChoices] = useState<{ id: string; label: string }[]>([]);
  const markerAction = useRef<(id: string) => void>(() => {}), hitBusy = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const [editing, setEditing] = useState<BrowserAnnotation | null>(null);
  const editCommit = useRef<ReturnType<NonNullable<NonNullable<typeof sink>["prepareEdit"]>> | null>(null);
  const candidate = selections.find(item => item.id === activeId) ?? null;
  const state = useRef({ selections, candidate, selecting, mode, blocked, active, annotations, editing });
  state.current = { selections, candidate, selecting, mode, blocked, active, annotations, editing };
  const capabilities = {
    region: !!annotator?.capabilities?.region && !!annotator.pickRegion,
    text: !!annotator?.capabilities?.text && !!annotator.pickText,
    multiSelect: !!annotator?.capabilities?.multiSelect,
    styles: !!annotator?.capabilities?.styles && !!annotator.readStyles,
    preview: !!annotator?.capabilities?.preview && !!annotator.preview && !!annotator.clearPreview,
  };
  const nextNumber = transactionNumber.current ?? nextAnnotationNumber(annotations);
  const onPage = useMemo(() => annotations.filter(item => item.tabId === tabId), [annotations, tabId]);
  const stop = useCallback(() => {
    sequence.current++; operation.current?.abort(); operation.current = null; setBusy(false); setPending(false); setHover(null); setMarkerChoices([]);
  }, []);
  const clearPreview = useCallback(() => {
    setPreviewing(false); setOriginal(false);
    void annotator?.clearPreview?.().catch(() => setError("preview-failed"));
  }, [annotator]);
  const reset = useCallback(() => {
    stop(); editCommit.current?.(null); editCommit.current = null; setEditing(null); setSelections([]); setActiveId(null); setSelecting(true); setComment(""); setEvidence([]); setPendingEvidence(null);
    setStyleIntents([]); setTextReplacements([]); setStyleCache({}); setError(null); setStale(false); setDiscardRequested(false);
    ordinal.current = 0; transactionId.current = null; transactionNumber.current = null;
  }, [stop]);
  // Composer owns persisted data. A different draft/tab must never inherit this transaction.
  useLayoutEffect(() => { reset(); clearPreview(); return stop; }, [sink, draftId, tabId, reset, stop]);
  useLayoutEffect(() => {
    stop(); setPendingEvidence(null); setPreviewing(false); setOriginal(false);
    if (state.current.selections.length) setStale(true);
    return () => { stop(); void annotator?.clearPreview?.().catch(() => undefined); };
  }, [annotator, url, blocked, stop]);
  useEffect(() => { if (!active) { stop(); clearPreview(); } }, [active, stop, clearPreview]);

  // Every operation has one owner and a finite lifetime; late completions cannot change a replacement transaction.
  const run = useCallback(async (work: (task: AbortController) => Promise<void>) => {
    stop(); const task = new AbortController(); operation.current = task; setBusy(true); setError(null);
    const slow = setTimeout(() => { if (operation.current === task) setPending(true); }, 300);
    const timeout = setTimeout(() => { if (operation.current === task) { stop(); setError("operation-timeout"); } }, 10000);
    try { await work(task); } catch (cause) {
      if (!task.signal.aborted && operation.current === task) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      clearTimeout(slow); clearTimeout(timeout);
      if (operation.current === task) { operation.current = null; setBusy(false); setPending(false); }
    }
  }, [stop]);
  const choose = useCallback((point: BrowserAnnotationPoint, end?: BrowserAnnotationPoint, depth = 0, replacing?: AnnotationCandidate) => {
    if (!annotator || state.current.blocked || operation.current) return;
    const current = state.current;
    const others = current.annotations.filter(item => item.id !== current.editing?.id);
    if (!replacing && current.selections.length && !annotator.capabilities?.multiSelect) return;
    if (!replacing && (others.length >= BROWSER_ANNOTATION_DRAFT_LIMIT || current.selections.length >= 8 || others.reduce((n, a) => n + (a.selections?.length ?? 1), 0) + current.selections.length >= 32)) { setError(ANNOTATION_LIMIT_ERROR); return; }
    void run(async task => {
      const result = end && current.mode === "region" ? await annotator.pickRegion!({ start: point, end })
        : end && current.mode === "text" ? await annotator.pickText!({ start: point, end })
        : await annotator.pick({ point, depth, selector: replacing?.selector });
      task.signal.throwIfAborted();
      const duplicate = current.selections.find(item => item.pick.anchor.bindingKey && sameTarget(item.pick.anchor, result.anchor));
      if (duplicate && !replacing) { setActiveId(duplicate.id); setSelecting(false); return; }
      transactionId.current ??= crypto.randomUUID(); transactionNumber.current ??= nextAnnotationNumber(current.annotations);
      const selected: AnnotationCandidate = { id: replacing?.id ?? crypto.randomUUID(), label: replacing?.label ?? `${transactionNumber.current}${selectionSuffix(ordinal.current++)}`, point, end, pick: result, selector: result.anchor.selector ?? undefined };
      if (replacing) {
        setSelections(items => items.map(item => item.id === replacing.id ? selected : item));
        setEvidence(items => items.filter(item => !item.selectionIds.includes(replacing.id)));
        setPendingEvidence(null); setStyleIntents(items => items.filter(item => item.selectionId !== replacing.id));
        setTextReplacements(items => items.filter(item => item.selectionId !== replacing.id));
        setStyleCache(items => { const next = { ...items }; delete next[replacing.id]; return next; }); clearPreview();
      } else setSelections(items => [...items, selected]);
      setActiveId(selected.id); setSelecting(false); setHover(null);
    });
  }, [annotator, run, clearPreview]);
  const hoverBusy = useRef(false), hoverNext = useRef<BrowserAnnotationPoint | null>(null);
  const hoverPick = useCallback((point: BrowserAnnotationPoint) => {
    if (!annotator || operation.current) return;
    if (hoverBusy.current) { hoverNext.current = point; return; }
    const generation = sequence.current; hoverBusy.current = true;
    void annotator.pick({ point }).then(result => { if (generation === sequence.current && state.current.selecting) setHover(result); }, () => undefined).finally(() => {
      hoverBusy.current = false; const next = hoverNext.current; hoverNext.current = null;
      if (next && generation === sequence.current) hoverPick(next);
    });
  }, [annotator]);
  useEffect(() => {
    if (!active || !annotator || blocked || mode === "browse") return;
    return annotator.intercept({ mode,
      hover: point => { if (state.current.selecting && mode === "element") hoverPick(point); },
      tap: point => {
        if (operation.current || hitBusy.current) return;
        if (!annotator.hitMark) { if (state.current.selecting && mode === "element") choose(point); return; }
        const generation = sequence.current; hitBusy.current = true;
        void annotator.hitMark(point).then(ids => {
          if (generation !== sequence.current || !state.current.active) return;
          const current = state.current;
          const choices = [...current.selections.map(item => ({ id: `${transactionId.current}/${item.id}`, label: item.label })),
            ...current.annotations.filter(item => item.tabId === tabId && item.id !== current.editing?.id).flatMap(item => upgradeAnnotation(item).selections!.map(selection => ({ id: `${item.id}/${selection.id}`, label: selection.label })))].filter(item => ids.includes(item.id));
          if (choices.length === 1) markerAction.current(choices[0]!.id);
          else if (choices.length > 1) setMarkerChoices(choices);
          else if (current.selecting && mode === "element") choose(point);
        }, () => { if (generation === sequence.current) setError("target-changed"); }).finally(() => { hitBusy.current = false; });
      },
      drag: (start, end) => { if (state.current.selecting && (mode === "region" || mode === "text")) choose(start, end); },
    });
  }, [active, annotator, blocked, mode, choose, hoverPick, tabId]);
  const color = useMemo(() => accentColor(), [active]);
  const marks = useMemo((): BrowserAnnotationMark[] => {
    const saved = annotationMarks(onPage.filter(item => item.id !== editing?.id), url);
    if (!active || stale || blocked) return saved;
    const editingMarks = selections.map(item => ({ ...item.pick.anchor.rect, markerId: `${transactionId.current}/${item.id}`, state: item.id === activeId ? "current" as const : "selected" as const, kind: item.pick.anchor.kind, selectionRects: item.pick.anchor.selectionRects, documentGeneration: item.pick.anchor.kind !== "element" ? item.pick.anchor.documentGeneration : undefined, fixed: item.pick.anchor.isFixed, selector: item.pick.anchor.kind === "element" ? item.pick.anchor.selector ?? undefined : undefined, targetKey: item.pick.anchor.kind === "element" ? item.pick.anchor.bindingKey ?? "expired" : undefined, label: item.label }));
    return [...saved, ...editingMarks, ...(hover && selecting ? [{ ...hover.anchor.rect, fixed: hover.anchor.isFixed, selector: hover.anchor.selector ?? undefined, targetKey: hover.anchor.bindingKey ?? "expired", pending: true, state: "hover" as const, kind: hover.anchor.kind, caption: `${hover.anchor.elementName ?? hover.anchor.name ?? hover.anchor.tag} · ${Math.round(hover.anchor.rect.width)} × ${Math.round(hover.anchor.rect.height)}` }] : [])];
  }, [onPage, editing, url, active, stale, blocked, selections, hover, selecting, activeId]);
  const marksKey = JSON.stringify(marks), drawn = useRef(false);
  useEffect(() => { drawn.current = false; return () => { void annotator?.mark([]).catch(() => undefined); }; }, [annotator]);
  useEffect(() => { if (annotator && (marks.length || drawn.current)) { drawn.current = !!marks.length; void annotator.mark(marks, color).catch(() => undefined); } }, [annotator, marksKey, color]);
  const exit = useCallback(() => { stop(); setActive(false); setDiscardRequested(false); }, [stop]);
  const cancel = useCallback(() => {
    stop();
    if (comment.length || evidence.length || textReplacements.length || styleIntents.length) setDiscardRequested(true);
    else { reset(); clearPreview(); }
  }, [stop, comment, evidence, textReplacements, styleIntents, reset, clearPreview]);
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (operation.current) stop(); else if (selecting && selections.length) setSelecting(false); else if (selections.length) cancel(); else exit();
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [active, selecting, selections.length, cancel, exit, stop]);
  const repick = async (item: AnnotationCandidate) => {
    if (!annotator) throw Error("target-changed");
    const anchor = item.pick.anchor;
    const result = anchor.kind === "text" && item.end && annotator.pickText ? await annotator.pickText({ start: item.point, end: item.end })
      : anchor.kind === "region" && item.end && annotator.pickRegion ? await annotator.pickRegion({ start: item.point, end: item.end })
      : await annotator.pick({ point: item.point, selector: anchor.selector ?? undefined });
    if (!sameTarget(anchor, result.anchor) || anchor.text !== result.anchor.text || result.anchor.sensitive) throw Error("target-changed");
    return result;
  };
  const editSaved = (id: string) => {
      if (!sink?.prepareEdit || operation.current) return;
      if (comment || selections.length) { setError("edit-in-progress"); return; }
      const saved = sink.list().find(item => item.id === id && item.tabId === tabId); if (!saved) return;
      reset(); clearPreview();
      const upgraded = upgradeAnnotation(saved);
      editCommit.current = sink.prepareEdit(id); setEditing(upgraded);
      transactionId.current = saved.id; transactionNumber.current = saved.number;
      const selected = upgraded.selections!.map(item => ({ ...item, point: { x: 0, y: 0, frameWidth: 1, frameHeight: 1 },
        selector: item.anchor.selector ?? undefined, pick: { anchor: item.anchor, depth: 0, maxDepth: 0, viewport: { top: 0, bottom: 0 } } }));
      ordinal.current = Math.max(...selected.map(item => [...item.label.replace(/^\d+/, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)), 0);
      setSelections(selected); setActiveId(selected[0]?.id ?? null); setSelecting(false); setComment(saved.comment);
      setStyleIntents([...(saved.styleIntents ?? [])]); setTextReplacements([...(saved.textReplacements ?? [])]); setEvidence([...(saved.evidence ?? [])]);
      // Rehydrated anchors are evidence, not a renewed DOM binding. Never silently target a replacement document.
      setStale(true); setActive(true);
    };
  const setStyles = (values: readonly { property: BrowserAnnotationStyleProperty; value: string | null }[]) => {
    if (!candidate || operation.current || stale || blocked || !values.length || values.length > 32) return;
    for (const {property, value} of values) {
      if (!BROWSER_ANNOTATION_STYLE_PROPERTIES.includes(property)) return;
      if (value !== null && (value.length > 200 || /[;{}<>]|url\s*\(|expression\s*\(|!important/i.test(value) || !CSS.supports(property, value))) { setError("invalid-style"); return; }
      if (value !== null && styleCache[candidate.id]?.[property] === undefined) return;
    }
    clearPreview(); setError(null);
    setStyleIntents(items => {
      let next = items;
      for (const {property, value} of values) {
        const observed = styleCache[candidate.id]?.[property];
        next = [...next.filter(item => item.selectionId !== candidate.id || item.property !== property),
          ...(value === null || value === observed ? [] : [{ selectionId: candidate.id, property, observedComputedValue: observed!, requestedValue: value }])];
      }
      return next;
    });
  };
  markerAction.current = id => {
    const selected = selections.find(item => `${transactionId.current}/${item.id}` === id);
    if (selected) { stop(); setActiveId(selected.id); setSelecting(false); return; }
    const saved = onPage.find(item => upgradeAnnotation(item).selections!.some(selection => `${item.id}/${selection.id}` === id));
    setMarkerChoices([]); if (saved) editSaved(saved.id);
  };
  const hasRequest = !!comment.trim() || styleIntents.some(item => item.observedComputedValue !== item.requestedValue) || textReplacements.some(item => item.beforeText !== item.afterText);
  const canPreview = !!candidate && !stale && !blocked && surface !== "file-preview" && annotator?.capabilities?.capture !== false && !candidate.pick.anchor.sensitive
    && (candidate.pick.anchor.kind !== "element" || !!candidate.pick.anchor.selector);
  const screenshot = evidence.find(item => item.selectionIds.includes(activeId ?? ""))?.dataUrl ?? null;
  return {
    available: !!annotator && !!sink, active, candidate, selections, selecting, mode, capabilities, comment, setComment,
    setMode: value => { if (value === "region" && !capabilities.region || value === "text" && !capabilities.text) return; stop(); setMode(value); if (value !== "browse" && (!selections.length || capabilities.multiSelect)) setSelecting(true); },
    addSelection: () => { if (!capabilities.multiSelect || stale) return; stop(); setSelecting(true); if (mode === "browse") setMode("element"); },
    selectSelection: id => { stop(); setActiveId(id); setSelecting(false); },
    removeSelection: id => {
      stop(); clearPreview(); setSelections(items => items.filter(item => item.id !== id));
      setEvidence(items => items.filter(item => !item.selectionIds.includes(id))); setPendingEvidence(null);
      setStyleIntents(items => items.filter(item => item.selectionId !== id)); setTextReplacements(items => items.filter(item => item.selectionId !== id));
      if (activeId === id) setActiveId(selections.find(item => item.id !== id)?.id ?? null);
      if (selections.length === 1) setSelecting(false);
    },
    markerChoices, openMarker: id => markerAction.current(id), dismissMarkers: () => setMarkerChoices([]), hasRequest,
    busy, pending, cancelOperation: stop, stale, discardRequested, keepEditing: () => setDiscardRequested(false),
    discard: () => { reset(); clearPreview(); }, screenshot, evidence, pendingEvidence, canPreview,
    confirmEvidence: () => { if (!pendingEvidence) return; setEvidence(items => [...items, pendingEvidence]); setPendingEvidence(null); },
    discardEvidence: () => setPendingEvidence(null),
    removeScreenshot: id => { stop(); setEvidence(items => items.filter(item => id ? item.id !== id : !item.selectionIds.includes(activeId ?? ""))); },
    previewScreenshot: async (kind = "target") => {
      if (!canPreview || !candidate || !annotator || operation.current) return;
      if (evidence.length >= 4) { setError("evidence-limit"); return; }
      const targets = kind === "context" ? selections : [candidate];
      if (targets.some(item => item.pick.anchor.sensitive || item.pick.anchor.documentGeneration !== candidate.pick.anchor.documentGeneration || JSON.stringify(item.pick.anchor.framePath) !== JSON.stringify(candidate.pick.anchor.framePath))) { setError("context-unavailable"); return; }
      await run(async task => {
        const before = await Promise.all(targets.map(repick)); task.signal.throwIfAborted();
        const data = await annotator.capture(); task.signal.throwIfAborted();
        const after = await Promise.all(targets.map(repick)); task.signal.throwIfAborted();
        if (before.some((item, i) => JSON.stringify(item.viewport) !== JSON.stringify(after[i].viewport))) throw Error("target-changed");
        const bounds = { top: Math.min(...after.map(item => item.viewport.top)), bottom: Math.max(...after.map(item => item.viewport.bottom)), left: Math.min(...after.map(item => item.viewport.left ?? 0)), right: Math.max(...after.map(item => item.viewport.right ?? 1)) };
        if (kind === "context") { bounds.top = Math.max(0, bounds.top - .05); bounds.bottom = Math.min(1, bounds.bottom + .05); bounds.left = Math.max(0, bounds.left - .05); bounds.right = Math.min(1, bounds.right + .05); }
        const { cropAnnotationScreenshot } = await import("./screenshot");
        const cropped = await cropAnnotationScreenshot(data, bounds, task.signal); task.signal.throwIfAborted();
        if (!cropped) throw Error("capture-failed");
        const item: BrowserAnnotationEvidence = { id: crypto.randomUUID(), selectionIds: targets.map(item => item.id), dataUrl: cropped, kind, ...(previewing && !original ? { preface: "Temporary page preview; source files are unchanged." } : {}) };
        // Legacy surfaces retain the existing one-click preview contract.
        if (!annotator.capabilities) setEvidence(items => [...items.filter(item => !item.selectionIds.includes(candidate.id)), item]);
        else setPendingEvidence(item);
      });
    },
    styles: activeId ? styleCache[activeId] ?? null : null, styleIntents, textReplacements,
    readStyles: async () => {
      if (!candidate || !capabilities.styles || candidate.pick.anchor.kind !== "element" || stale || blocked || operation.current) return;
      await run(async task => { const values = await annotator!.readStyles!(candidate.pick.anchor); task.signal.throwIfAborted();
        setStyleCache(items => ({ ...items, [candidate.id]: Object.fromEntries(BROWSER_ANNOTATION_STYLE_PROPERTIES.filter(key => typeof values[key] === "string").map(key => [key, values[key]])) })); });
    },
    setStyles, setStyle: (property, value) => setStyles([{ property, value }]),
    setReplacement: value => {
      if (!candidate || candidate.pick.anchor.sensitive || candidate.pick.anchor.selectedText === undefined || operation.current) return;
      if (value !== null && value.length > 2000) { setError("text-limit"); return; }
      clearPreview(); setTextReplacements(items => [...items.filter(item => item.selectionId !== candidate.id), ...(value === null ? [] : [{ selectionId: candidate.id, beforeText: candidate.pick.anchor.selectedText!, afterText: value }])]);
    },
    previewing, original, clearPreview,
    previewChanges: async (showOriginal = false) => {
      if (!capabilities.preview || stale || blocked || operation.current) return;
      await run(async task => {
        const changes = [...styleIntents.map(item => ({ anchor: selections.find(s => s.id === item.selectionId)!.pick.anchor, property: item.property, value: item.requestedValue })), ...textReplacements.map(item => ({ anchor: selections.find(s => s.id === item.selectionId)!.pick.anchor, text: item.afterText }))];
        await annotator!.preview!({ changes, original: showOriginal });
        if (task.signal.aborted) { await annotator!.clearPreview!(); return; }
        setPreviewing(true); setOriginal(showOriginal);
      });
    },
    saved: onPage, editingId: editing?.id ?? null,
    edit: editSaved,
    error, count: onPage.length, nextNumber,
    toggle: () => active ? exit() : (setActive(true), setError(null)), exit,
    step: delta => {
      if (!candidate || candidate.pick.anchor.kind !== "element" || operation.current || stale) return;
      const depth = Math.max(0, Math.min(candidate.pick.maxDepth, candidate.pick.depth + delta));
      if (depth !== candidate.pick.depth) choose(candidate.point, undefined, depth, candidate);
    },
    cancel, reveal: fraction => { void annotator?.reveal?.(fraction).catch(() => undefined); },
    submit: async value => {
      if (!selections.length || !sink || !annotator || operation.current || blocked || !(value.trim() || styleIntents.some(item => item.observedComputedValue !== item.requestedValue) || textReplacements.some(item => item.beforeText !== item.afterText))) return false;
      if (pendingEvidence) { setError("review-image"); return false; }
      let success = false;
      await run(async task => {
        const commit = editCommit.current ?? sink.prepareAdd();
        try {
          if (styleIntents.length && stale && !editing) throw Error("styles-changed");
          if (previewing) { await annotator.clearPreview?.(); task.signal.throwIfAborted(); setPreviewing(false); setOriginal(false); }
          for (const selection of selections) {
            const intents = styleIntents.filter(item => item.selectionId === selection.id);
            if (intents.length && !stale) {
              const current = await annotator.readStyles!(selection.pick.anchor); task.signal.throwIfAborted();
              if (intents.some(item => current[item.property] !== item.observedComputedValue)) throw Error("styles-changed");
            }
          }
          task.signal.throwIfAborted();
          const existing = sink.list().filter(item => item.id !== editing?.id);
          if (existing.length >= BROWSER_ANNOTATION_DRAFT_LIMIT || existing.reduce((n, a) => n + (a.selections?.length ?? 1), 0) + selections.length > 32) throw Error(ANNOTATION_LIMIT_ERROR);
          const created = createAnnotation({ id: transactionId.current!, tabId, anchor: selections[0].pick.anchor, comment: value.trim() || "Apply the requested style and text changes listed below.", surface, existing });
          const base = editing ? { ...created, number: editing.number, screenshot: editing.screenshot } : created;
          if (base.number !== transactionNumber.current) throw Error("number-conflict");
          const annotation = !annotator.capabilities ? { ...base, screenshot: evidence[0]?.dataUrl ?? null } : { ...base, schemaVersion: 2 as const, selections: selections.map(item => ({ id: item.id, label: item.label, anchor: item.pick.anchor })), styleIntents, textReplacements, evidence,
            screenshot: editing?.screenshot ?? null };
          if (!commit(annotation)) throw Error("add-failed");
          success = true; reset();
        } finally { if (!editing || success) commit(null); }
      });
      return success;
    },
    clear: () => { for (const item of onPage) sink?.remove(item.id); },
    finish: () => { exit(); sink?.focusComposer(); },
  };
}
