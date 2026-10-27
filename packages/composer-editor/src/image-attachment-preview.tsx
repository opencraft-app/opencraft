import { ChevronLeftIcon, ChevronRightIcon, CloseIcon } from "@opencraft/design-system-web/action-icons";
import { ZoomableImage } from "@opencraft/chat-render-web/zoomable-image";
import { useIntl } from "@opencraft/i18n/react";
import { ImageEditorContext } from "@opencraft/extension-react";
import { EditIcon } from "@opencraft/design-system-web/action-icons";
import * as Dialog from "@radix-ui/react-dialog";
import { useContext, useLayoutEffect, useState } from "react";

export interface ComposerPreviewImage {
  readonly id: string;
  readonly name: string;
  readonly source: string;
}

/** A transient view of the existing draft's resources; it never owns uploads. */
export function ImageAttachmentPreview({ images, selectedId, onSelect, onClose, onReturnFocus, onEditComplete, portalContainer }: {
  readonly images: readonly ComposerPreviewImage[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
  readonly onReturnFocus: () => void;
  readonly onEditComplete?: (id: string, source: string, file: File) => boolean;
  readonly portalContainer?: HTMLElement | null;
}) {
  const intl = useIntl();
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const editor = useContext(ImageEditorContext);
  const [editing, setEditing] = useState<{ id: string; source: string } | null>(null);
  const index = images.findIndex(image => image.id === selectedId);
  const image = images[index];
  const Editor = editor?.Component;
  const isEditing = Editor !== undefined && onEditComplete !== undefined && image !== undefined && editing !== null && editing.id === image.id && editing.source === image.source;
  const viewport = useEditingViewport(isEditing);
  if (image === undefined) return null;
  const label = intl.formatMessage({ id: "chat.image.position", defaultMessage: "Attached image {index} of {count}" }, { index: index + 1, count: images.length });
  const previous = () => onSelect(images[(index + images.length - 1) % images.length]!.id);
  const next = () => onSelect(images[(index + 1) % images.length]!.id);
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Portal container={portalContainer ?? undefined}>
      <Dialog.Overlay className="modal-surface__scrim" data-layer="nested" />
      <Dialog.Content
        aria-describedby={undefined}
        className="modal-surface opencraft-composer-image-preview"
        data-layer="nested"
        data-presentation="fullscreen"
        data-size="workspace"
        data-editing={isEditing}
        style={viewport ?? undefined}
        onCloseAutoFocus={event => { event.preventDefault(); onReturnFocus(); }}
        onEscapeKeyDown={event => {
          // Radix receives document-capture Escape before the inline editor.
          // Native text editing owns this key, including inside a ShadowRoot.
          if (event.isComposing || event.keyCode === 229 || (isEditing && event.composedPath().some(target => target instanceof HTMLTextAreaElement))) event.preventDefault();
        }}
        onKeyDown={event => {
          if (isEditing || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || images.length < 2) return;
          if (event.key === "ArrowLeft") { event.preventDefault(); previous(); }
          if (event.key === "ArrowRight") { event.preventDefault(); next(); }
        }}
      >
        {editor?.styles && <style children={portalContainer?.getRootNode() instanceof ShadowRoot ? editor.styles.replaceAll(":root", ":host") : editor.styles} />}
        <Dialog.Title className="modal-surface__accessible-title">{label}</Dialog.Title>
        {isEditing && Editor ? <Editor key={image.id + image.source} source={image.source} name={image.name} onCancel={onClose} onComplete={file => onEditComplete!(image.id, image.source, file)} /> : <>
        {failedSource === image.source
          ? <div className="thread-user-image-lightbox__unavailable" role="status">{intl.formatMessage({ id: "chat.image.unavailable", defaultMessage: "Image unavailable" })}</div>
          : <ZoomableImage alt={image.name} src={image.source} fitToContainer onBackgroundClick={onClose} onError={() => setFailedSource(image.source)} />}
        {images.length > 1 && <div className="thread-user-image-lightbox__navigation">
          <button aria-label={intl.formatMessage({ id: "chat.image.previous", defaultMessage: "Previous image" })} onClick={previous} type="button"><ChevronLeftIcon aria-hidden size={20} /></button>
          <span aria-live="polite">{index + 1} / {images.length}</span>
          <button aria-label={intl.formatMessage({ id: "chat.image.next", defaultMessage: "Next image" })} onClick={next} type="button"><ChevronRightIcon aria-hidden size={20} /></button>
        </div>}
        <Dialog.Close aria-label={intl.formatMessage({ id: "chat.image.close", defaultMessage: "Close image preview" })} className="modal-surface__close" type="button"><CloseIcon aria-hidden size={20} /></Dialog.Close>
        {Editor && onEditComplete && failedSource !== image.source && <button type="button" className="opencraft-composer-image-preview__edit" onClick={() => setEditing({ id: image.id, source: image.source })}><EditIcon aria-hidden size={18} />{intl.formatMessage({ id: "imageEditor.edit", defaultMessage: "Edit image" })}</button>}
        </>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

// The modal owns viewport placement. Mobile keyboards can shrink and offset the
// visual viewport without changing 100dvh; keep editor tools above the keyboard.
function useEditingViewport(enabled: boolean) {
  const [bounds, setBounds] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    if (!enabled || !viewport) return;
    const measure = () => setBounds({ top: viewport.offsetTop, left: viewport.offsetLeft, width: viewport.width, height: viewport.height });
    measure(); viewport.addEventListener("resize", measure); viewport.addEventListener("scroll", measure);
    return () => { viewport.removeEventListener("resize", measure); viewport.removeEventListener("scroll", measure); };
  }, [enabled]);
  return enabled ? bounds : null;
}
