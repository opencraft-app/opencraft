import { useEffect, useRef, useState } from "react";
import type { BrowserAnnotationStyleProperty as Property } from "@opencraft/browser-core";
import { ResetIcon } from "@opencraft/design-system-web/action-icons";
import { Button } from "@opencraft/design-system-web/button";
import { ColorInput } from "@opencraft/design-system-web/color-input";
import { defineMessages } from "@opencraft/i18n";
import { useIntl } from "@opencraft/i18n/react";
import type { BrowserAnnotationController } from "./use-browser-annotation";
import { parseStyleNumber, ratioStyleValue, stepStyleNumber } from "./annotation-polish";

export const polishMessages = defineMessages({
  appearance: { id: "browserAnnotation.polish.appearance", defaultMessage: "Appearance" },
  typography: { id: "browserAnnotation.polish.typography", defaultMessage: "Typography" },
  spacing: { id: "browserAnnotation.polish.spacing", defaultMessage: "Spacing" },
  dimensions: { id: "browserAnnotation.polish.dimensions", defaultMessage: "Size" },
  reset: { id: "browserAnnotation.polish.reset", defaultMessage: "Reset {property}" },
  decrease: { id: "browserAnnotation.polish.decrease", defaultMessage: "Decrease {property}" },
  increase: { id: "browserAnnotation.polish.increase", defaultMessage: "Increase {property}" },
  invalid: { id: "browserAnnotation.polish.invalid", defaultMessage: "Enter a valid CSS value, including its unit." },
  linked: { id: "browserAnnotation.polish.linked", defaultMessage: "Link opposite sides" },
  ratio: { id: "browserAnnotation.polish.ratio", defaultMessage: "Keep proportions" },
  hold: { id: "browserAnnotation.polish.hold", defaultMessage: "Hold to compare" },
  details: { id: "browserAnnotation.polish.details", defaultMessage: "Target details" },
  collapse: { id: "browserAnnotation.polish.collapse", defaultMessage: "Show page" },
  expand: { id: "browserAnnotation.polish.expand", defaultMessage: "Edit annotation" },
  choose: { id: "browserAnnotation.polish.choose", defaultMessage: "Choose a marker" },
  editFirst: { id: "browserAnnotation.polish.editFirst", defaultMessage: "Save or discard the current annotation before opening another." },
  preview: { id: "browserAnnotation.polish.preview", defaultMessage: "Preview is temporary; source files are unchanged." },
  color: { id: "browserAnnotation.polish.color", defaultMessage: "Text color" },
  background: { id: "browserAnnotation.polish.background", defaultMessage: "Background" },
  radius: { id: "browserAnnotation.polish.radius", defaultMessage: "Corner radius" },
  fontSizeLabel: { id: "browserAnnotation.polish.fontSize", defaultMessage: "Font size" },
  weight: { id: "browserAnnotation.polish.weight", defaultMessage: "Font weight" },
  lineHeightLabel: { id: "browserAnnotation.polish.lineHeight", defaultMessage: "Line height" },
  top: { id: "browserAnnotation.polish.top", defaultMessage: "Top padding" },
  right: { id: "browserAnnotation.polish.right", defaultMessage: "Right padding" },
  bottom: { id: "browserAnnotation.polish.bottom", defaultMessage: "Bottom padding" },
  left: { id: "browserAnnotation.polish.left", defaultMessage: "Left padding" },
  row: { id: "browserAnnotation.polish.row", defaultMessage: "Row gap" },
  column: { id: "browserAnnotation.polish.column", defaultMessage: "Column gap" },
  width: { id: "browserAnnotation.polish.width", defaultMessage: "Width" },
  height: { id: "browserAnnotation.polish.height", defaultMessage: "Height" },
});
const propertyNames = [["color", "color"], ["background-color", "background"], ["border-radius", "radius"], ["font-size", "fontSizeLabel"], ["font-weight", "weight"], ["line-height", "lineHeightLabel"], ["padding-top", "top"], ["padding-right", "right"], ["padding-bottom", "bottom"], ["padding-left", "left"], ["row-gap", "row"], ["column-gap", "column"], ["width", "width"], ["height", "height"]] as const;
const names = Object.fromEntries(propertyNames) as Record<(typeof propertyNames)[number][0], (typeof propertyNames)[number][1]>;
const groups: { key: "appearance" | "typography" | "spacing" | "dimensions"; properties: (keyof typeof names)[] }[] = [
  { key: "appearance", properties: ["color", "background-color", "border-radius"] },
  { key: "typography", properties: ["font-size", "font-weight", "line-height"] },
  { key: "spacing", properties: ["padding-top", "padding-right", "padding-bottom", "padding-left", "row-gap", "column-gap"] },
  { key: "dimensions", properties: ["width", "height"] },
];
function StyleField({ property, value, observed, disabled, onChange }: { property: keyof typeof names; value: string; observed: string; disabled: boolean; onChange(value: string | null): void }) {
  const intl = useIntl(), label = intl.formatMessage(polishMessages[names[property]]);
  const [draft, setDraft] = useState(value), [invalid, setInvalid] = useState(false);
  const suppressClick = useRef(false);
  const dragging = useRef<{ pointerId: number; x: number; value: string; next: string } | null>(null);
  useEffect(() => { if (!dragging.current) { setDraft(value); setInvalid(false); } }, [value]);
  const commit = (next: string) => { if (!next.trim() || !CSS.supports(property, next) || /[;{}<>]|url\s*\(|!important/i.test(next)) { setInvalid(true); return; } setInvalid(false); onChange(next); };
  const numeric = parseStyleNumber(draft) !== null;
  const cancelDrag = () => { if (dragging.current) suppressClick.current = true; if (dragging.current) setDraft(dragging.current.value); dragging.current = null; };
  useEffect(() => { window.addEventListener("blur", cancelDrag); return () => window.removeEventListener("blur", cancelDrag); }, []);
  useEffect(() => { if (disabled) cancelDrag(); }, [disabled]);
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*1)?\)$/.exec(draft);
  const hex = /^#[\da-f]{6}$/i.test(draft) ? draft : rgb ? "#" + rgb.slice(1,4).map(n => Number(n).toString(16).padStart(2,"0")).join("") : null;
  const color = property === "color" || property === "background-color";
  const changeStep = (delta: number) => { const next = stepStyleNumber(draft, property === "font-weight" ? delta * 100 : delta); if (next !== null) { setDraft(next); commit(next); } };
  return <div className="annotation-style-field" data-edited={value !== observed || undefined}>
    <label className="annotation-style-field__label" htmlFor={`annotation-style-${property}`}>{label}</label>
    <div className="annotation-style-field__value">
      {color && hex ? <ColorInput aria-label={label} value={hex!} disabled={disabled} onChange={event => { setDraft(event.target.value); commit(event.target.value); }} /> : null}
      <input id={`annotation-style-${property}`} value={draft} disabled={disabled} aria-invalid={invalid || undefined} aria-describedby={invalid ? `annotation-style-${property}-error` : undefined} spellCheck={false}
        onChange={e => { setDraft(e.target.value); setInvalid(false); }} onBlur={() => { if (draft !== value) commit(draft); }}
        onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commit(draft); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDraft(value); setInvalid(false); } else if (numeric && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); changeStep((e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1)); } }} />
      {numeric ? <><Button type="button" size="sm" variant="ghost" disabled={disabled} aria-label={intl.formatMessage(polishMessages.decrease, {property: label})} onClick={() => changeStep(-1)}>−</Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} aria-label={intl.formatMessage(polishMessages.increase, {property: label})} onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } changeStep(1); }}
          onPointerDown={e => { if (e.pointerType !== "mouse" || e.button !== 0) return; suppressClick.current = false; dragging.current = {pointerId: e.pointerId, x: e.clientX, value: draft, next: draft}; e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={e => { const d = dragging.current; if (!d || d.pointerId !== e.pointerId) return; const delta = Math.trunc((e.clientX - d.x) / 5); d.next = stepStyleNumber(d.value, property === "font-weight" ? delta * 100 : delta) ?? d.value; setDraft(d.next); }}
          onPointerUp={e => { const d = dragging.current; if (!d || d.pointerId !== e.pointerId) return; dragging.current = null; if (Math.abs(e.clientX - d.x) >= 5) { e.preventDefault(); suppressClick.current = true; commit(d.next); } }} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}>+</Button></> : null}
      <Button type="button" size="sm" variant="ghost" disabled={disabled || value === observed} aria-label={intl.formatMessage(polishMessages.reset, {property: label})} onClick={() => { setDraft(observed); onChange(null); }}><ResetIcon size={14} /></Button>
    </div>
    {invalid ? <small id={`annotation-style-${property}-error`} role="alert">{intl.formatMessage(polishMessages.invalid)}</small> : null}
  </div>;
}
export function StyleControls({ controller: c }: { controller: BrowserAnnotationController }) {
  const intl = useIntl(), [linked, setLinked] = useState(false), [ratio, setRatio] = useState(false);
  const value = (p: Property) => c.styleIntents.find(i => i.selectionId === c.candidate?.id && i.property === p)?.requestedValue ?? c.styles?.[p] ?? "";
  const apply = (property: Property, next: string | null) => {
    const changes: { property: Property; value: string | null }[] = [{ property, value: next }];
    const opposite: Partial<Record<Property, Property>> = {"padding-top": "padding-bottom", "padding-bottom": "padding-top", "padding-left": "padding-right", "padding-right": "padding-left"};
    if (linked && opposite[property]) changes.push({ property: opposite[property]!, value: next });
    if (ratio && (property === "width" || property === "height")) {
      const pair = property === "width" ? "height" : "width";
      const result = next === null ? null : ratioStyleValue(next, value(property), value(pair));
      if (next === null || result !== null) changes.push({ property: pair, value: result });
    }
    c.setStyles(changes);
  };
  const ratioAvailable = ratioStyleValue(value("width"), value("width"), value("height")) !== null;
  return <div className="annotation-style-groups">{groups.map(group => <details key={group.key} open={group.key === "appearance" || undefined}>
    <summary>{intl.formatMessage(polishMessages[group.key])}</summary>
    {group.key === "spacing" ? <Button type="button" size="sm" variant="ghost" aria-pressed={linked} onClick={() => setLinked(v => !v)}>{intl.formatMessage(polishMessages.linked)}</Button> : null}
    {group.key === "dimensions" ? <Button type="button" size="sm" variant="ghost" aria-pressed={ratio && ratioAvailable} disabled={!ratioAvailable} onClick={() => setRatio(v => !v)}>{intl.formatMessage(polishMessages.ratio)}</Button> : null}
    {group.properties.map(property => c.styles?.[property] === undefined ? null : <StyleField key={property} property={property} value={value(property)} observed={c.styles[property]!} disabled={c.busy || c.stale} onChange={next => apply(property, next)} />)}
  </details>)}</div>;
}

/** Release is never dropped while the press request is in flight. */
export function HoldComparison({ controller: c }: { controller: BrowserAnnotationController }) {
  const intl = useIntl(), current = useRef(c), held = useRef(false), running = useRef(false), mounted = useRef(true);
  current.current = c;
  const drive = async () => {
    if (running.current) return; running.current = true;
    try { let requested: boolean; do { requested = held.current; await current.current.previewChanges(requested); } while (requested !== held.current && mounted.current); }
    finally { running.current = false; }
  };
  const release = () => { if (!held.current) return; held.current = false; void drive(); };
  useEffect(() => { mounted.current = true; window.addEventListener("blur", release); return () => { mounted.current = false; held.current = false; window.removeEventListener("blur", release); }; }, []);
  return <Button type="button" size="sm" variant="ghost" disabled={!c.previewing || c.original && !held.current || c.busy && !held.current}
    onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); held.current = true; void drive(); }}
    onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release} onBlur={release}
    onKeyDown={e => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); held.current = true; void drive(); } }}
    onKeyUp={e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); release(); } }}>
    {intl.formatMessage(polishMessages.hold)}
  </Button>;
}
