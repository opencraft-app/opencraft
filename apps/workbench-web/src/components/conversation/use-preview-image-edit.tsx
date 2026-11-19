import { lazy, Suspense, useContext, useState } from "react";
import { ImageEditorContext } from "@opencraft/extension-react";
import type { ComposerImageEditSession } from "@opencraft/composer-editor";
const ImageAttachmentPreview = lazy(() => import("@opencraft/composer-editor/image-attachment-preview").then(module => ({ default: module.ImageAttachmentPreview })));
import { EditIcon } from "@opencraft/design-system-web/action-icons";
import { useIntl } from "@opencraft/i18n/react";
import { ConversationDocumentContext } from "./document-context";
import { useWorkbenchPresentationRoot } from "../workbench-presentation-root";

/** Sent media stays immutable. Only the captured Composer accepts the edited File. */
export function usePreviewImageEdit(source: string | null, name: string, onComplete: () => void) {
  const context = useContext(ConversationDocumentContext);
  const contribution = useContext(ImageEditorContext);
  const portalContainer = useWorkbenchPresentationRoot();
  const intl = useIntl();
  const identity = JSON.stringify([context.hostId, context.conversationId, source]);
  const [editing, setEditing] = useState<{ identity: string; source: string; session: ComposerImageEditSession; completed: boolean } | null>(null);
  const current = editing?.identity === identity ? editing : null;
  const label = intl.formatMessage({ id: "imageEditor.edit", defaultMessage: "Edit image" });
  return {
    action: source && contribution && context.beginImageEdit ? <>
      {contribution.styles ? <style children={portalContainer?.getRootNode() instanceof ShadowRoot ? contribution.styles.replaceAll(":root", ":host") : contribution.styles} /> : null}
      <button type="button" className="opencraft-composer-image-preview__edit" aria-label={label} title={label} onClick={() => {
        const session = context.beginImageEdit?.();
        if (session) setEditing({ identity, source, session, completed: false });
      }}><EditIcon aria-hidden size={20} /></button>
    </> : null,
    editor: current ? <Suspense fallback={null}><ImageAttachmentPreview
      initialEditing
      images={[{ id: current.identity, source: current.source, name }]}
      selectedId={current.identity}
      onSelect={() => {}}
      onClose={() => setEditing(null)}
      onReturnFocus={() => { if (current.completed) current.session.focus(); }}
      onEditComplete={(_id, _source, file) => {
        if (current.completed || !current.session.complete(file)) return false;
        current.completed = true;
        setEditing(null);
        onComplete();
        return true;
      }}
      portalContainer={portalContainer}
    /></Suspense> : null,
  };
}
