import { Button } from "@opencraft/design-system-web/button";
import { defineMessages } from "@opencraft/i18n";
import { useIntl } from "@opencraft/i18n/react";
import { StyleControls, HoldComparison, polishMessages } from "./style-controls";
import type { AnnotationMode, BrowserAnnotationController } from "./use-browser-annotation";

export const v2Messages = defineMessages({
  browse: { id: "browserAnnotation.v2.browse", defaultMessage: "Move page" },
  element: { id: "browserAnnotation.v2.element", defaultMessage: "Element" },
  region: { id: "browserAnnotation.v2.region", defaultMessage: "Region" },
  text: { id: "browserAnnotation.v2.text", defaultMessage: "Text" },
  modes: { id: "browserAnnotation.v2.modes", defaultMessage: "Selection mode" },
  addTarget: { id: "browserAnnotation.v2.addTarget", defaultMessage: "Add target" },
  removeTarget: { id: "browserAnnotation.v2.removeTarget", defaultMessage: "Remove target {label}" },
  targets: { id: "browserAnnotation.v2.targets", defaultMessage: "Selected targets" },
  resume: { id: "browserAnnotation.v2.resume", defaultMessage: "Edit comment" },
  dragHint: { id: "browserAnnotation.v2.dragHint", defaultMessage: "Drag to select · Move page to scroll" },
  browseHint: { id: "browserAnnotation.v2.browseHint", defaultMessage: "Page interaction enabled" },
  pending: { id: "browserAnnotation.v2.pending", defaultMessage: "Confirming selection…" },
  stop: { id: "browserAnnotation.v2.stop", defaultMessage: "Cancel operation" },
  stale: { id: "browserAnnotation.v2.stale", defaultMessage: "Collected from an earlier page state. Your comment and reviewed images are preserved." },
  styles: { id: "browserAnnotation.v2.styles", defaultMessage: "Style requests" },
  readStyles: { id: "browserAnnotation.v2.readStyles", defaultMessage: "Read current styles" },
  remove: { id: "browserAnnotation.v2.remove", defaultMessage: "Remove" },
  replacement: { id: "browserAnnotation.v2.replacement", defaultMessage: "Replace selected text" },
  afterText: { id: "browserAnnotation.v2.afterText", defaultMessage: "Replace with (empty deletes the text)" },
  beforeText: { id: "browserAnnotation.v2.beforeText", defaultMessage: "Selected text" },
  previewChanges: { id: "browserAnnotation.v2.previewChanges", defaultMessage: "Preview changes" },
  original: { id: "browserAnnotation.v2.original", defaultMessage: "Show original" },
  clearPreview: { id: "browserAnnotation.v2.clearPreview", defaultMessage: "Restore page" },
  context: { id: "browserAnnotation.v2.context", defaultMessage: "Preview surrounding screenshot" },
  target: { id: "browserAnnotation.v2.target", defaultMessage: "Preview target screenshot" },
  keepImage: { id: "browserAnnotation.v2.keepImage", defaultMessage: "Keep this image" },
  discardImage: { id: "browserAnnotation.v2.discardImage", defaultMessage: "Discard preview" },
  contextNotice: { id: "browserAnnotation.v2.contextNotice", defaultMessage: "The surrounding image may include private information. Review it before keeping it." },
  imageLabel: { id: "browserAnnotation.v2.imageLabel", defaultMessage: "{kind} · {labels}" },
  discardPrompt: { id: "browserAnnotation.v2.discardPrompt", defaultMessage: "Discard this comment and its selected targets?" },
  discard: { id: "browserAnnotation.v2.discard", defaultMessage: "Discard comment" },
  keep: { id: "browserAnnotation.v2.keep", defaultMessage: "Keep editing" },
  limit: { id: "browserAnnotation.v2.limit", defaultMessage: "A comment can have 8 targets; a message can have 8 comments and 32 targets. Remove a target or send the current message." },
  imageLimit: { id: "browserAnnotation.v2.imageLimit", defaultMessage: "Keep up to 4 images per comment. Remove an image before capturing another." },
  targetChanged: { id: "browserAnnotation.v2.targetChanged", defaultMessage: "The page changed. Select the target again; your comment and reviewed images are saved." },
  stylesChanged: { id: "browserAnnotation.v2.stylesChanged", defaultMessage: "Current styles changed. Remove the affected style request, read the styles again and confirm a new value." },
  invalidStyle: { id: "browserAnnotation.v2.invalidStyle", defaultMessage: "Enter a valid value for this CSS property." },
  reviewImage: { id: "browserAnnotation.v2.reviewImage", defaultMessage: "Keep or discard the image preview before adding the comment." },
  timeout: { id: "browserAnnotation.v2.timeout", defaultMessage: "The operation took too long. Your comment is saved; try again." },
  contextUnavailable: { id: "browserAnnotation.v2.contextUnavailable", defaultMessage: "These targets cannot share a screenshot. Capture each target separately." },
  failed: { id: "browserAnnotation.v2.failed", defaultMessage: "The operation could not finish. Your comment and reviewed images are saved. Try again." },
  noImage: { id: "browserAnnotation.v2.noImage", defaultMessage: "This region has no image attached. Add a screenshot if its appearance matters." },
});

export function AnnotationModeControls({ controller: c }: { controller: BrowserAnnotationController }) {
  const intl = useIntl();
  const modes: AnnotationMode[] = ["browse", "element", ...(c.capabilities.region ? ["region" as const] : []), ...(c.capabilities.text ? ["text" as const] : [])];
  return <div className="browser-annotation-modes" role="group" aria-label={intl.formatMessage(v2Messages.modes)}>
    {modes.map(mode => <Button key={mode} variant={c.mode === mode ? "secondary" : "ghost"} size="sm" aria-pressed={c.mode === mode} disabled={c.busy || c.stale && mode !== "browse"} onClick={() => c.setMode(mode)}>{intl.formatMessage(v2Messages[mode])}</Button>)}
  </div>;
}

export function AnnotationTargetControls({ controller: c }: { controller: BrowserAnnotationController }) {
  const intl = useIntl();
  return <div className="browser-annotation-targets" role="group" aria-label={intl.formatMessage(v2Messages.targets)}>
    {c.selections.map(item => <span key={item.id} className="browser-annotation-targets__item">
      <Button size="sm" variant={item.id === c.candidate?.id ? "secondary" : "ghost"} aria-pressed={item.id === c.candidate?.id} disabled={c.busy} onClick={() => c.selectSelection(item.id)} title={item.pick.anchor.elementName ?? item.pick.anchor.name ?? item.pick.anchor.text ?? item.pick.anchor.tag}><b>{item.label}</b><span className="browser-annotation-targets__name">{item.pick.anchor.elementName ?? item.pick.anchor.name ?? item.pick.anchor.text ?? item.pick.anchor.tag}</span></Button>
      <Button size="sm" variant="ghost" aria-label={intl.formatMessage(v2Messages.removeTarget, { label: item.label })} disabled={c.busy} onClick={() => c.removeSelection(item.id)}>×</Button>
    </span>)}
    {c.capabilities.multiSelect ? <Button variant="secondary" size="sm" disabled={c.busy || c.stale || c.selections.length >= 8} onClick={c.addSelection}>{intl.formatMessage(v2Messages.addTarget)}</Button> : null}
  </div>;
}

function StyleEditor({ controller: c }: { controller: BrowserAnnotationController }) {
  const intl = useIntl();
  return <details className="browser-annotation-intents" onToggle={event => { if (event.currentTarget.open && !c.styles && !c.busy && !c.stale) void c.readStyles(); }}>
    <summary className="ui-native-disclosure">{intl.formatMessage(v2Messages.styles)}{c.styleIntents.length ? ` · ${c.styleIntents.length}` : ""}</summary>
    {c.styles ? <StyleControls controller={c} /> : <Button type="button" size="sm" variant="secondary" disabled={c.busy || c.stale} onClick={() => void c.readStyles()}>{intl.formatMessage(v2Messages.readStyles)}</Button>}
  </details>;
}
export function AnnotationIntentControls({ controller: c }: { controller: BrowserAnnotationController }) {
  const intl = useIntl(), anchor = c.candidate?.pick.anchor;
  const replacement = c.textReplacements.find(item => item.selectionId === c.candidate?.id);
  const hasChanges = c.styleIntents.length > 0 || c.textReplacements.some(item => item.beforeText !== item.afterText);
  return <>
    {anchor?.selectedText !== undefined && !anchor.sensitive ? <div className="browser-annotation-intents">
      <label>{intl.formatMessage(v2Messages.beforeText)}<blockquote>{anchor.selectedText}</blockquote></label>
      {replacement ? <><label>{intl.formatMessage(v2Messages.afterText)}<textarea value={replacement.afterText} disabled={c.busy} onChange={event => c.setReplacement(event.target.value)} /></label><Button size="sm" variant="ghost" onClick={() => c.setReplacement(null)}>{intl.formatMessage(v2Messages.remove)}</Button></> : <Button size="sm" variant="secondary" onClick={() => c.setReplacement(anchor.selectedText!)}>{intl.formatMessage(v2Messages.replacement)}</Button>}
    </div> : null}
    {c.capabilities.styles && anchor?.kind === "element" && !anchor.sensitive ? <StyleEditor key={c.candidate?.id} controller={c} /> : null}
    {c.capabilities.preview && hasChanges ? <div className="browser-annotation-intents">
      <p>{intl.formatMessage(polishMessages.preview)}</p>
      <div className="browser-annotation-intents__row"><Button size="sm" variant="secondary" disabled={c.busy || c.stale} onClick={() => void c.previewChanges(false)}>{intl.formatMessage(v2Messages.previewChanges)}</Button>
        {c.previewing ? <><HoldComparison controller={c} /><Button size="sm" variant="secondary" aria-pressed={c.original} disabled={c.busy || c.stale} onClick={() => void c.previewChanges(!c.original)}>{intl.formatMessage(v2Messages.original)}</Button><Button size="sm" variant="ghost" onClick={c.clearPreview}>{intl.formatMessage(v2Messages.clearPreview)}</Button></> : null}</div>
    </div> : null}
  </>;
}

export function AnnotationEvidenceControls({ controller: c }: { controller: BrowserAnnotationController }) {
  const intl = useIntl();
  const images = [...c.evidence, ...(c.pendingEvidence ? [c.pendingEvidence] : [])];
  if (!c.canPreview && images.length === 0 && c.candidate?.pick.anchor.kind !== "region") return null;
  return <details className="browser-annotation-evidence"><summary className="ui-native-disclosure">{intl.formatMessage(v2Messages.target)}</summary>
    {c.canPreview ? <div className="browser-annotation-intents__row"><Button size="sm" variant="secondary" disabled={c.busy || !!c.pendingEvidence} onClick={() => void c.previewScreenshot()}>{intl.formatMessage(v2Messages.target)}</Button>
      <Button size="sm" variant="secondary" disabled={c.busy || !!c.pendingEvidence} onClick={() => void c.previewScreenshot("context")}>{intl.formatMessage(v2Messages.context)}</Button></div> : null}
    {images.map(item => {
      const label = intl.formatMessage(v2Messages.imageLabel, { kind: intl.formatMessage(item.kind === "context" ? v2Messages.context : v2Messages.target), labels: item.selectionIds.map(id => c.selections.find(s => s.id === id)?.label).join(", ") });
      return <figure key={item.id} className="browser-annotation-editor__screenshot"><figcaption>{label}</figcaption><img src={item.dataUrl} alt={label} />
        {c.pendingEvidence?.id === item.id ? <><p>{intl.formatMessage(v2Messages.contextNotice)}</p><div className="browser-annotation-intents__row"><Button size="sm" variant="secondary" onClick={c.confirmEvidence}>{intl.formatMessage(v2Messages.keepImage)}</Button><Button size="sm" variant="ghost" onClick={c.discardEvidence}>{intl.formatMessage(v2Messages.discardImage)}</Button></div></> : <Button size="sm" variant="ghost" disabled={c.busy} onClick={() => c.removeScreenshot(item.id)}>{intl.formatMessage(v2Messages.remove)}</Button>}
      </figure>;
    })}
    {c.candidate?.pick.anchor.kind === "region" && !c.evidence.some(item => item.selectionIds.includes(c.candidate!.id)) ? <p className="browser-annotation-editor__notice">{intl.formatMessage(v2Messages.noImage)}</p> : null}
  </details>;
}
