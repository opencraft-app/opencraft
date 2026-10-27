import type { ImageEditorProps } from "@opencraft/extension-react";
import { useIntl } from "@opencraft/i18n/react";
import { CheckIcon, CloseIcon, EditIcon, ImageCropIcon, ImageFitIcon, ImageMosaicIcon, ImageRedoIcon, ImageStickerIcon, ImageTextIcon, ImageUndoIcon, RotateIcon } from "@opencraft/design-system-web/action-icons";
import { flushSync } from "react-dom";
import { typographyRole } from "@opencraft/design-system/typography";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { commitEdit, emptyHistory, exportImage, paintEdit, renderDocument, selectionRect, stepHistory, type ImageEdit, type Point, type Rect } from "./document";
import { stickerPreview, stickers, type Sticker } from "./stickers";
import { messages } from "./messages";
import { useTouchViewport } from "./touch-viewport";

type Tool = "pen" | "sticker" | "text" | "crop" | "mosaic";
type TextDraft = { readonly point: Point; readonly text: string };
type Brush = Extract<ImageEdit, { type: "pen" | "mosaic" }>;
const colors = ["#ffffff", "#111827", "#ef4444", "#facc15", "#22c55e", "#3b82f6"];
const textInputMetrics = typographyRole("mobileInput", "web");
const tools = [{ id: "pen", Icon: EditIcon }, { id: "sticker", Icon: ImageStickerIcon }, { id: "text", Icon: ImageTextIcon }, { id: "crop", Icon: ImageCropIcon }, { id: "mosaic", Icon: ImageMosaicIcon }] as const;

export default function ImageEditor({ source, name, onCancel, onComplete }: ImageEditorProps) {
  const intl = useIntl(), m = (key: keyof typeof messages) => intl.formatMessage(messages[key]);
  const [history, setHistory] = useState(emptyHistory);
  const [tool, setTool] = useState<Tool>("pen"), [color, setColor] = useState(colors[2]!);
  const [width, setWidth] = useState(6), [textSize, setTextSize] = useState(42);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null), [sticker, setSticker] = useState<Sticker>("😀");
  const pendingText = useRef<TextDraft | null>(null), textInput = useRef<HTMLTextAreaElement>(null), composing = useRef(false);
  const updateText = (next: TextDraft | null) => { if (!next) composing.current = false; pendingText.current = next; setTextDraft(next); };
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [scene, setScene] = useState<HTMLCanvasElement | null>(null);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<"failed" | "saveFailed" | null>(null);
  const stage = useRef<HTMLDivElement>(null), display = useRef<HTMLCanvasElement>(null);
  const active = useRef(true), frame = useRef(0);
  const stroke = useRef<{ pointerId: number; edit: Brush } | null>(null);
  const placement = useRef<{ pointerId: number; point: Point } | null>(null);
  const cropStart = useRef<{ pointerId: number; point: Point } | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  useEffect(() => { active.current = true; return () => { active.current = false; cancelAnimationFrame(frame.current); }; }, []);
  useEffect(() => {
    let cancelled = false;
    const candidate = new Image();
    candidate.onload = () => { if (!cancelled) setImage(candidate); };
    candidate.onerror = () => { if (!cancelled) setError("failed"); };
    candidate.src = source;
    return () => { cancelled = true; candidate.onload = candidate.onerror = null; };
  }, [source]);
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!image) return;
    try { setScene(renderDocument(image, history)); setCrop(null); }
    catch { setError("failed"); }
  }, [image, history]);
  const draw = () => {
    const target = display.current;
    if (!target || !scene) return;
    if (target.width !== scene.width) target.width = scene.width;
    if (target.height !== scene.height) target.height = scene.height;
    const ctx = target.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, target.width, target.height); ctx.drawImage(scene, 0, 0);
    if (stroke.current) paintEdit(target, stroke.current.edit);
  };
  // A queued live-stroke frame must never repaint the previous document after undo.
  useLayoutEffect(() => { cancelAnimationFrame(frame.current); draw(); }, [scene]);
  const scheduleDraw = () => { cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(draw); };
  const point = (event: PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(event.currentTarget.width, (event.clientX - rect.left) / rect.width * event.currentTarget.width)), y: Math.max(0, Math.min(event.currentTarget.height, (event.clientY - rect.top) / rect.height * event.currentTarget.height)) };
  };
  const commit = (edit: ImageEdit) => { setHistory(current => commitEdit(current, edit)); setError(null); };
  const cancelGesture = () => { stroke.current = null; cropStart.current = null; placement.current = null; setCrop(null); scheduleDraw(); };
  const takeText = (): Extract<ImageEdit, { type: "text" }> | null => {
    const draft = pendingText.current;
    const input = textInput.current;
    const style = input ? getComputedStyle(input) : null;
    updateText(null);
    if (!draft?.text.trim() || !scene || !style) return null;
    return { type: "text", text: draft.text.trim(), point: draft.point, size: textSize * Math.min(scene.width, scene.height) / 500, color,
      format: { family: style.fontFamily, weight: style.fontWeight, leading: parseFloat(style.lineHeight) / parseFloat(style.fontSize) } };
  };
  const applyText = () => { if (composing.current) return; const edit = takeText(); if (edit) commit(edit); };
  const changeTool = (next: Tool) => { if (composing.current) return; applyText(); cancelGesture(); setTool(next); };
  const navigate = (direction: -1 | 1) => {
    if (composing.current) return;
    cancelGesture(); const edit = takeText();
    setHistory(current => stepHistory(edit ? commitEdit(current, edit) : current, direction));
  };
  const down = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!scene || busy || event.button !== 0 || stroke.current || cropStart.current) return;
    event.preventDefault(); const p = point(event), scale = Math.min(scene.width, scene.height) / 500;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "text" || tool === "sticker") { placement.current = { pointerId: event.pointerId, point: p }; return; }
    if (tool === "crop") { cropStart.current = { pointerId: event.pointerId, point: p }; setCrop(null); }
    else { stroke.current = { pointerId: event.pointerId, edit: { type: tool, points: [p], width: Math.max(1, width * scale * (tool === "mosaic" ? 5 : 1)), color } }; scheduleDraw(); }
  };
  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    if (cropStart.current?.pointerId === event.pointerId) setCrop(selectionRect(cropStart.current.point, point(event)));
    const current = stroke.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.edit = { ...current.edit, points: [...current.edit.points, point(event)] }; scheduleDraw();
  };
  const up = (event: PointerEvent<HTMLCanvasElement>) => {
    if (placement.current?.pointerId === event.pointerId) {
      const p = point(event);
      placement.current = null;
      if (tool === "text") {
        if (!composing.current) {
          applyText();
          // Keep focus in the trusted touch event for mobile software keyboards.
          flushSync(() => updateText({ point: p, text: "" }));
          textInput.current?.focus({ preventScroll: true });
        }
      } else commit({ type: "sticker", sticker, point: p, size: textSize * Math.min(scene!.width, scene!.height) / 500 });
    }
    const current = stroke.current;
    if (current?.pointerId === event.pointerId) { stroke.current = null; cancelAnimationFrame(frame.current); commit({ ...current.edit, points: [...current.edit.points, point(event)] }); }
    if (cropStart.current?.pointerId === event.pointerId) { setCrop(selectionRect(cropStart.current.point, point(event))); cropStart.current = null; }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const save = async () => {
    if (busy || !scene || stroke.current || cropStart.current || composing.current) return;
    const edit = takeText(), finalHistory = edit ? commitEdit(history, edit) : history;
    if (edit) setHistory(finalHistory);
    if (finalHistory.cursor === 0) { onCancel(); return; }
    setBusy(true); setError(null);
    try {
      const file = await exportImage(image ? renderDocument(image, finalHistory) : scene, name);
      if (active.current && !onComplete(file)) { setError("saveFailed"); setBusy(false); }
    } catch { if (active.current) { setError("saveFailed"); setBusy(false); } }
  };
  const scale = scene ? Math.min(viewport.width / scene.width, viewport.height / scene.height, 1) : 0;
  const { view, reset: resetView, handlers: touchHandlers } = useTouchViewport(viewport.width, viewport.height, (scene?.width ?? 0) * scale, (scene?.height ?? 0) * scale, `${scene?.width}x${scene?.height}`, cancelGesture);
  const textScale = scene ? textSize * Math.min(scene.width, scene.height) / 500 * scale / textInputMetrics.fontSize : 1;
  const canUndo = history.cursor > 0 || !!textDraft?.text.trim(), canRedo = history.cursor < history.edits.length;
  const gestureActive = () => stroke.current !== null || cropStart.current !== null || placement.current !== null;
  return <section className="image-editor" aria-label={`${m("edit")}: ${name}`} aria-busy={busy} onKeyDown={event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.nativeEvent.isComposing || (event.target as HTMLElement).closest("input,textarea,[contenteditable=true]")) return;
    const key = event.key.toLowerCase();
    if (key === "z" || key === "y") { event.preventDefault(); event.stopPropagation(); if (!busy) navigate(key === "y" || event.shiftKey ? 1 : -1); }
  }}>
    <header className="image-editor__header">
      <button type="button" onClick={onCancel}>{m("cancel")}</button>
      <span className="image-editor__header-space" aria-hidden />
      <button type="button" aria-label={m("fit")} title={m("fit")} onClick={resetView} disabled={busy || !scene}><ImageFitIcon aria-hidden size={24} /></button>
      <button type="button" aria-label={m("undo")} title={m("undo")} disabled={busy || !canUndo} onClick={() => navigate(-1)}><ImageUndoIcon aria-hidden size={24} /></button>
      <button type="button" aria-label={m("redo")} title={m("redo")} disabled={busy || !canRedo} onClick={() => navigate(1)}><ImageRedoIcon aria-hidden size={24} /></button>
    </header>
    <div className="image-editor__stage" ref={stage} {...touchHandlers}>
      {scene ? <div className="image-editor__image" style={{ width: scene.width * scale, height: scene.height * scale, transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
        <canvas ref={display} aria-label={m("surface")} onPointerDown={down} onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; move(event); }} onPointerUp={up} onPointerCancel={cancelGesture} onLostPointerCapture={() => { if (gestureActive()) cancelGesture(); }} />
        {textDraft && <textarea ref={textInput} className="image-editor__text-entry" aria-label={m("text")} placeholder={m("text")} value={textDraft.text} maxLength={500} wrap="off" rows={Math.max(1, textDraft.text.split("\n").length)}
          style={{ left: textDraft.point.x * scale, top: textDraft.point.y * scale, color, "--image-text-scale": textScale, "--image-text-lines": Math.max(1, textDraft.text.split("\n").length), width: Math.max(80, Math.min(scene.width * scale, 360)) / textScale } as CSSProperties}
          onChange={event => updateText({ ...textDraft, text: event.currentTarget.value })}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; if (pendingText.current) updateText({ ...pendingText.current, text: event.currentTarget.value }); }}
          onKeyDown={event => {
            event.stopPropagation();
            if (composing.current || event.nativeEvent.isComposing) return;
            if (event.key === "Escape") { event.preventDefault(); updateText(null); }
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); applyText(); }
          }} />}
        {crop && <div className="image-editor__crop" aria-hidden style={{ left: crop.x * scale, top: crop.y * scale, width: crop.width * scale, height: crop.height * scale }} />}
      </div> : <span role="status">{m(error === "failed" ? "failed" : "loading")}</span>}
    </div>
    <div className="image-editor__controls">
      {error && <div className="image-editor__feedback" role="alert">{m(error)}</div>}
      <fieldset className="image-editor__options" disabled={busy || !scene}>
        {(tool === "pen" || tool === "text") && <div className="image-editor__colors" role="group" aria-label={m("color")}>{colors.map(value => <button key={value} type="button" style={{ "--image-ink": value } as CSSProperties} aria-label={`${m("color")} ${value}`} aria-pressed={color === value} onClick={() => setColor(value)} />)}</div>}
        {(tool === "pen" || tool === "mosaic") && <input type="range" aria-label={m("width")} min={2} max={30} value={width} onChange={event => setWidth(Number(event.target.value))} />}
        {tool === "text" && <><input type="range" aria-label={m("textSize")} min={16} max={100} value={textSize} onChange={event => setTextSize(Number(event.target.value))} />{textDraft && <><button type="button" aria-label={m("discardText")} onClick={() => updateText(null)}><CloseIcon size={24} /></button><button type="button" aria-label={m("applyText")} onClick={applyText}><CheckIcon size={24} /></button></>}</>}
        {tool === "sticker" && <>{(Object.keys(stickers) as Sticker[]).map(value => <button type="button" key={value} aria-label={value} aria-pressed={sticker === value} onClick={() => setSticker(value)}><img src={stickerPreview(value)} alt="" width={28} height={28} draggable={false} /></button>)}</>}
        {tool === "crop" && <><button type="button" aria-label={m("rotate")} onClick={() => { if (!gestureActive()) commit({ type: "rotate" }); }}><RotateIcon aria-hidden size={24} /></button><button type="button" aria-label={m("applyCrop")} disabled={!crop || crop.width < 2 || crop.height < 2} onClick={() => { if (crop && !gestureActive()) commit({ type: "crop", rect: crop }); }}><CheckIcon size={24} /></button></>}
      </fieldset>
      <footer className="image-editor__toolbar">
        <div className="image-editor__tools" role="group" aria-label={m("edit")}>{tools.map(({ id, Icon }) => <button key={id} type="button" aria-label={m(id)} title={m(id)} aria-pressed={tool === id} disabled={busy || !scene} onClick={() => changeTool(id)}><Icon aria-hidden size={24} /></button>)}</div>
        <button type="button" className="image-editor__done" disabled={busy || !scene || error === "failed"} onClick={() => { void save(); }}>{m(busy ? "saving" : "done")}</button>
      </footer>
    </div>
  </section>;
}
