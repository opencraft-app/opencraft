import { useRef, useState } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { CloseIcon, ChevronLeftIcon, ChevronRightIcon } from "@opencraft/design-system-web/action-icons";
import { ZoomableImageView as ZoomableImage } from "./zoomable-image-view";
import type { ImagePreviewNavigation } from "./zoomable-image";
import previewStyles from "./image-preview.scss?inline";

import { PreviewSurface } from "@opencraft/design-system-web/preview-surface";
import type { ImagePreviewProps } from "./image-preview";

/** One fullscreen gallery shell around the existing image manipulation owner. */
export function ImagePreviewView({ image, onClose, previous, next, position, actions, returnFocus, openedByPointer = false, className }: ImagePreviewProps) {
  const intl = useIntl();
  const navigation = useRef<ImagePreviewNavigation>(null);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [failed, setFailed] = useState<{ id: string; source: string } | null>(null);
  const unavailable = image.source === null || (failed?.id === image.id && failed.source === image.source);
  const closeLabel = intl.formatMessage({ id: "chat.image.close", defaultMessage: "Close image preview" });
  const requestPrevious = () => { if (navigation.current) navigation.current.previous(); else previous?.onSelect(); };
  const requestNext = () => { if (navigation.current) navigation.current.next(); else next?.onSelect(); };
  return <PreviewSurface styles={previewStyles} dismissOnBackground className={["opencraft-image-preview", className].filter(Boolean).join(" ")} label={image.alt || intl.formatMessage({ id: "chat.image.preview", defaultMessage: "Image preview" })} onClose={onClose} returnFocus={returnFocus} openedByPointer={openedByPointer && !keyboardFocus}
    onKeyDown={event => {
      if (event.key === "Tab") setKeyboardFocus(true);
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229
        || (event.target instanceof HTMLElement && event.target.closest("input,textarea,select,[contenteditable=true]"))) return;
      if (event.key === "ArrowLeft" && previous) { event.preventDefault(); event.stopPropagation(); requestPrevious(); }
      if (event.key === "ArrowRight" && next) { event.preventDefault(); event.stopPropagation(); requestNext(); }
    }}>
    {close => <>
    {!unavailable && image.source !== null ? <ZoomableImage ref={navigation} imageKey={image.id} src={image.source} alt={image.alt} title={image.title}
      onError={() => setFailed({ id: image.id, source: image.source! })}
      onBackgroundClick={close} onPreviousImage={previous?.onSelect} onNextImage={next?.onSelect}
      previousImage={previous?.content} nextImage={next?.content} />
      : <div className="opencraft-image-preview__status" role="status">{intl.formatMessage(image.source === null && image.status === "loading"
        ? { id: "chat.image.loading", defaultMessage: "Loading image…" }
        : { id: "chat.image.unavailable", defaultMessage: "Image unavailable" })}</div>}
    <button type="button" className="opencraft-image-preview__close" aria-label={closeLabel} onClick={close}><CloseIcon aria-hidden size={20} /></button>
    {(previous || next || (position && position.count > 1)) && <div className="opencraft-image-preview__navigation">
      {previous && <button type="button" className="opencraft-image-preview__previous" aria-label={intl.formatMessage({ id: "chat.image.previous", defaultMessage: "Previous image" })} onClick={requestPrevious}><ChevronLeftIcon aria-hidden size={20} /></button>}
      {position && position.count > 1 && <span className="opencraft-image-preview__position" aria-live="polite">{position.index + 1} / {position.count}</span>}
      {next && <button type="button" className="opencraft-image-preview__next" aria-label={intl.formatMessage({ id: "chat.image.next", defaultMessage: "Next image" })} onClick={requestNext}><ChevronRightIcon aria-hidden size={20} /></button>}
    </div>}
    {!unavailable && actions}
    </>}
  </PreviewSurface>;
}
