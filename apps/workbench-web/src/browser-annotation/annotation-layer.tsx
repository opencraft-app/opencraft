import "./browser-annotation.scss";
import { describeTarget } from "@opencraft/browser-annotation";
import { ChevronDownIcon, ChevronUpIcon, CloseIcon } from "@opencraft/design-system-web/action-icons";
import { Button, IconButton } from "@opencraft/design-system-web/button";
import { defineMessages } from "@opencraft/i18n";
import { useIntl } from "@opencraft/i18n/react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ANNOTATION_LIMIT_ERROR, type BrowserAnnotationController } from "./use-browser-annotation";
import { placeAnnotationCard } from "./annotation-polish";
import { polishMessages } from "./style-controls";
import {
  AnnotationModeControls,
  AnnotationTargetControls,
  AnnotationIntentControls,
  AnnotationEvidenceControls,
  v2Messages,
} from "./annotation-selection-controls";
import { useOptionalAsyncNotices } from "../components/async-notices-context";

const messages = defineMessages({
  editSaved: { id: "browserAnnotation.editSaved", defaultMessage: "Edit comment {number}" },
  save: { id: "browserAnnotation.save", defaultMessage: "Save changes" },
  hint: {
    id: "browserAnnotation.hint.pointer",
    defaultMessage: "Click an element to comment",
    description: "Instruction in the annotation mode bar on desktop",
  },
  hintTouch: {
    id: "browserAnnotation.hint.touch",
    defaultMessage: "Tap an element to comment · drag to scroll",
    description: "Instruction in the annotation mode bar on touch devices",
  },
  exit: {
    id: "browserAnnotation.exit",
    defaultMessage: "Exit annotations",
    description: "Button in the annotation mode bar that leaves annotation mode and focuses the composer",
  },
  heading: {
    id: "browserAnnotation.editor.heading",
    defaultMessage: "Comment {number}",
    description:
      "Heading of the comment editor for the selected page element. {number} is the marker number shown on the page",
  },
  placeholder: {
    id: "browserAnnotation.editor.placeholder",
    defaultMessage: "Describe a change or ask a question…",
    description: "Placeholder of the comment field for a selected page element",
  },
  parent: {
    id: "browserAnnotation.editor.parent",
    defaultMessage: "Parent",
    description: "Button that widens the selection to the enclosing page element",
  },
  child: {
    id: "browserAnnotation.editor.child",
    defaultMessage: "Child",
    description: "Button that narrows the selection back to the inner page element",
  },
  cancel: {
    id: "browserAnnotation.editor.cancel",
    defaultMessage: "Cancel",
    description: "Discard the current element selection and comment",
  },
  add: {
    id: "browserAnnotation.editor.add",
    defaultMessage: "Add to chat",
    description: "Add the comment to the conversation composer as an annotation card",
  },
  adding: {
    id: "browserAnnotation.editor.adding",
    defaultMessage: "Adding…",
    description: "Add button while the page screenshot for the annotation is being captured",
  },
  tray: {
    id: "browserAnnotation.tray.count",
    defaultMessage: "{count, plural, one {# comment} other {# comments}} in the composer",
    description: "Summary pill while annotating, counting annotations already added to the composer for this tab",
  },
  clear: {
    id: "browserAnnotation.tray.clear",
    defaultMessage: "Clear",
    description: "Remove all annotations of this tab from the composer",
  },
  done: {
    id: "browserAnnotation.tray.done",
    defaultMessage: "Write message",
    description: "Leave annotation mode and focus the composer to send the annotations to the agent",
  },
  sensitive: {
    id: "browserAnnotation.editor.sensitive",
    defaultMessage: "Sensitive field: its content is not shared",
    description: "Notice in the comment editor when the selected element is a password or similar control",
  },
});

/** Above this fraction of the page height the target stays visible over the sheet. */

/** Tracks a slot's viewport rect while mounted; the page surface sits in a fixed layer above it. */
function useSlotRect(slot: RefObject<HTMLElement | null>, active: boolean, touch: boolean) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    let raf = 0,
      last = "";
    const tick = () => {
      let next = slot.current?.getBoundingClientRect() ?? null;
      const viewport = window.visualViewport;
      if (next && touch && viewport) {
        const top = Math.max(next.top, viewport.offsetTop);
        const bottom = Math.min(next.bottom, viewport.offsetTop + viewport.height);
        next = new DOMRect(next.x, top, next.width, Math.max(0, bottom - top));
      }
      const key = next ? `${next.x},${next.y},${next.width},${next.height}` : "";
      if (key !== last) {
        last = key;
        setRect(next);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [slot, active, touch]);
  return rect;
}

export function BrowserAnnotationLayer({
  controller,
  slot,
  portal,
  touch,
}: {
  readonly controller: BrowserAnnotationController;
  readonly slot: RefObject<HTMLElement | null>;
  readonly portal: HTMLElement | null;
  readonly touch: boolean;
}) {
  const intl = useIntl();
  const rect = useSlotRect(slot, controller.active, touch);
  const { comment, setComment } = controller;
  const notices = useOptionalAsyncNotices();
  useEffect(() => {
    if (!controller.error) return;
    const errors = {
      [ANNOTATION_LIMIT_ERROR]: v2Messages.limit,
      "evidence-limit": v2Messages.imageLimit,
      "target-changed": v2Messages.targetChanged,
      "styles-changed": v2Messages.stylesChanged,
      "invalid-style": v2Messages.invalidStyle,
      "review-image": v2Messages.reviewImage,
      "edit-in-progress": polishMessages.editFirst,
      "operation-timeout": v2Messages.timeout,
      "context-unavailable": v2Messages.contextUnavailable,
    };
    notices?.error({
      key: "browser-annotation",
      message: intl.formatMessage(errors[controller.error as keyof typeof errors] ?? v2Messages.failed),
    });
  }, [controller.error, notices, intl]);
  const input = useRef<HTMLTextAreaElement>(null),
    editor = useRef<HTMLFormElement>(null),
    toolbar = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [measured, setMeasured] = useState({ width: 360, height: 300, toolbar: 100 });
  const candidate = controller.candidate;
  const candidateKey = candidate?.id ?? "";
  useEffect(() => {
    setCollapsed(false);
    if (touch || !candidateKey) return;
    const frame = requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [candidateKey, touch]);
  useLayoutEffect(() => {
    const measure = () => {
      const card = editor.current?.getBoundingClientRect(),
        bar = toolbar.current?.getBoundingClientRect();
      const origin = slot.current?.getBoundingClientRect().top ?? 0;
      const next = { width: card?.width ?? 360, height: card?.height ?? 300, toolbar: bar ? bar.bottom - origin : 100 };
      setMeasured((prev) =>
        prev.width === next.width && prev.height === next.height && prev.toolbar === next.toolbar ? prev : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (editor.current) observer.observe(editor.current);
    if (toolbar.current) observer.observe(toolbar.current);
    return () => observer.disconnect();
  }, [controller.active, controller.selecting, candidateKey, collapsed, touch, slot]);
  const target =
    candidate && rect && candidate.pick.viewport.left !== undefined && candidate.pick.viewport.right !== undefined
      ? {
          x: candidate.pick.viewport.left * rect.width,
          y: candidate.pick.viewport.top * rect.height,
          width: (candidate.pick.viewport.right - candidate.pick.viewport.left) * rect.width,
          height: (candidate.pick.viewport.bottom - candidate.pick.viewport.top) * rect.height,
        }
      : null;
  const placement = rect ? placeAnnotationCard(rect, measured, target, measured.toolbar) : null;
  if (!controller.active || rect === null || portal === null) return null;
  const anchor = candidate?.pick.anchor;
  const submit = async () => {
    if (await controller.submit(comment)) setComment("");
  };
  return createPortal(
    <div
      className="browser-annotation-layer"
      data-touch={touch || undefined}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      <div className="browser-annotation-toolbar" ref={toolbar}>
        <div className="browser-annotation-modebar">
          <AnnotationModeControls controller={controller} />
          <span className="browser-annotation-modebar__divider" aria-hidden="true" />
          <IconButton
            type="button"
            variant="ghost"
            title={intl.formatMessage(messages.exit)}
            aria-label={intl.formatMessage(messages.exit)}
            className="browser-annotation-bar__exit"
            onClick={controller.finish}
          >
            <CloseIcon size={16} />
          </IconButton>
        </div>
        {controller.selecting || controller.pending || controller.mode === "browse" ? (
          <div className="browser-annotation-bar" role="status">
            <span className="browser-annotation-bar__hint">
              {intl.formatMessage(
                controller.pending
                  ? v2Messages.pending
                  : controller.mode === "browse"
                    ? v2Messages.browseHint
                    : controller.mode === "region" || controller.mode === "text"
                      ? v2Messages.dragHint
                      : touch
                        ? messages.hintTouch
                        : messages.hint,
              )}
            </span>
            {controller.busy ? (
              <Button type="button" variant="ghost" size="sm" onClick={controller.cancelOperation}>
                {intl.formatMessage(v2Messages.stop)}
              </Button>
            ) : null}
            {controller.selecting && candidate ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => controller.selectSelection(candidate.id)}>
                {intl.formatMessage(v2Messages.resume)}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {controller.markerChoices.length ? (
        <div
          className="browser-annotation-marker-choices"
          role="group"
          aria-label={intl.formatMessage(polishMessages.choose)}
        >
          <span>{intl.formatMessage(polishMessages.choose)}</span>
          {controller.markerChoices.map((item) => (
            <Button
              type="button"
              key={item.id}
              size="sm"
              variant="secondary"
              onClick={() => controller.openMarker(item.id)}
            >
              {item.label}
            </Button>
          ))}
          <Button type="button" size="sm" variant="ghost" onClick={controller.dismissMarkers}>
            {intl.formatMessage(messages.cancel)}
          </Button>
        </div>
      ) : null}
      {(anchor || comment) && !controller.selecting ? (
        <form
          ref={editor}
          className="browser-annotation-editor"
          data-variant={touch ? "sheet" : "card"}
          data-collapsed={(touch && collapsed) || undefined}
          style={
            !touch && placement
              ? {
                  left: placement.x,
                  top: placement.y,
                  bottom: "auto",
                  transform: "none",
                  maxHeight: Math.min(560, Math.max(100, rect.height - measured.toolbar - 24)),
                }
              : undefined
          }
          aria-label={intl.formatMessage(messages.heading, { number: controller.nextNumber })}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {touch ? (
            <Button
              type="button"
              className="browser-annotation-editor__collapse"
              size="sm"
              variant="ghost"
              aria-expanded={!collapsed}
              aria-controls="annotation-editor-body"
              onClick={() => {
                input.current?.blur();
                setCollapsed((v) => !v);
              }}
            >
              <span>{intl.formatMessage(collapsed ? polishMessages.expand : polishMessages.collapse)}</span>
              {collapsed ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
            </Button>
          ) : null}
          <div className="browser-annotation-editor__header" hidden={touch && collapsed}>
            <AnnotationTargetControls controller={controller} />
            {controller.stale ? (
              <p className="browser-annotation-editor__notice">{intl.formatMessage(v2Messages.stale)}</p>
            ) : null}
            {anchor ? (
              <div className="browser-annotation-editor__target">
                <span className="browser-annotation-editor__number" aria-hidden="true">
                  {candidate?.label ?? controller.nextNumber}
                </span>
                <span className="browser-annotation-editor__label">
                  <strong>{describeTarget(anchor)}</strong>
                  <small>
                    {Math.round(anchor.rect.width)} × {Math.round(anchor.rect.height)}
                  </small>
                </span>
                <span className="browser-annotation-editor__steps">
                  <IconButton
                    type="button"
                    title={intl.formatMessage(messages.parent)}
                    aria-label={intl.formatMessage(messages.parent)}
                    disabled={
                      controller.busy ||
                      controller.stale ||
                      anchor.kind !== "element" ||
                      candidate!.pick.depth >= candidate!.pick.maxDepth
                    }
                    onClick={() => controller.step(1)}
                  >
                    <ChevronUpIcon size={14} />
                  </IconButton>
                  <IconButton
                    type="button"
                    title={intl.formatMessage(messages.child)}
                    aria-label={intl.formatMessage(messages.child)}
                    disabled={
                      controller.busy || controller.stale || anchor.kind !== "element" || candidate!.pick.depth <= 0
                    }
                    onClick={() => controller.step(-1)}
                  >
                    <ChevronDownIcon size={14} />
                  </IconButton>
                </span>
              </div>
            ) : null}
          </div>
          <div id="annotation-editor-body" className="browser-annotation-editor__body" hidden={touch && collapsed}>
            {anchor ? (
              <details className="browser-annotation-editor__details">
                <summary>{intl.formatMessage(polishMessages.details)}</summary>
                <code>{anchor.selector ?? anchor.elementPath}</code>
              </details>
            ) : null}
            {anchor?.sensitive ? (
              <p className="browser-annotation-editor__notice">{intl.formatMessage(messages.sensitive)}</p>
            ) : null}
            <textarea
              ref={input}
              value={comment}
              rows={touch ? 3 : 2}
              placeholder={intl.formatMessage(messages.placeholder)}
              enterKeyHint="done"
              onChange={(event) => setComment(event.currentTarget.value)}
              onKeyDown={(event) => {
                // Enter confirms an IME candidate while composing (中文输入); never submit then.
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey || (touch === false && !event.shiftKey))) {
                  event.preventDefault();
                  void submit();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  controller.cancel();
                }
              }}
            />
            <AnnotationIntentControls controller={controller} />
            <AnnotationEvidenceControls controller={controller} />
            {controller.discardRequested ? (
              <div
                className="browser-annotation-discard"
                role="group"
                aria-label={intl.formatMessage(v2Messages.discardPrompt)}
              >
                <p>{intl.formatMessage(v2Messages.discardPrompt)}</p>
                <Button type="button" variant="secondary" size="sm" onClick={controller.keepEditing}>
                  {intl.formatMessage(v2Messages.keep)}
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={controller.discard}>
                  {intl.formatMessage(v2Messages.discard)}
                </Button>
              </div>
            ) : null}
          </div>
          <div className="browser-annotation-editor__actions" hidden={touch && collapsed}>
            <Button type="button" variant="ghost" size="sm" onClick={controller.cancel}>
              {intl.formatMessage(messages.cancel)}
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={
                controller.busy ||
                !controller.hasRequest ||
                !controller.selections.length ||
                !!controller.pendingEvidence
              }
            >
              {intl.formatMessage(
                controller.busy ? messages.adding : controller.editingId ? messages.save : messages.add,
              )}
            </Button>
          </div>
        </form>
      ) : controller.count > 0 ? (
        <div className="browser-annotation-tray">
          <div className="browser-annotation-tray__saved">
            {controller.saved.map((item) => (
              <Button
                key={item.id}
                type="button"
                size="sm"
                variant="ghost"
                title={item.comment}
                aria-label={intl.formatMessage(messages.editSaved, { number: item.number })}
                onClick={() => controller.edit(item.id)}
              >
                {item.number}
              </Button>
            ))}
          </div>
          <span className="browser-annotation-tray__count">
            {intl.formatMessage(messages.tray, { count: controller.count })}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="browser-annotation-tray__clear"
            onClick={controller.clear}
          >
            <CloseIcon size={12} aria-hidden="true" />
            {intl.formatMessage(messages.clear)}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="browser-annotation-tray__done"
            onClick={controller.finish}
          >
            {intl.formatMessage(messages.done)}
          </Button>
        </div>
      ) : null}
    </div>,
    portal,
  );
}
