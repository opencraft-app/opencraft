import type { MouseEvent } from "react";
import "./resource-chip.scss";
import { parseConversationRef } from "@opencraft/appserver-protocol/collaboration";
import { chatFilePresentation } from "@opencraft/chat-render-react/file-resource-presentation";
import { FormattedMessage } from "@opencraft/i18n/react";
import * as ContextMenu from "@opencraft/design-system-web/context-menu";
import { DocumentIcon, CodeFileIcon, ImageFileIcon, TableIcon, ArchiveIcon, AudioIcon, FolderIcon, PlayIcon, CopyIcon, ChatIcon, LinkIcon } from "@opencraft/design-system-web/action-icons";
import { writeTextToClipboard } from "../../clipboard";

const icons = { code: CodeFileIcon, image: ImageFileIcon, spreadsheet: TableIcon,
  archive: ArchiveIcon, audio: AudioIcon, video: PlayIcon, folder: FolderIcon, document: DocumentIcon };

/** File artwork and metadata load when a document actually contains a file. */
export function FileResourceChip({ target, label, kind, onClick }: {
  readonly target: string; readonly label?: string; readonly kind: string;
  readonly onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const app = kind === "app-route", conversation = app && parseConversationRef(target) !== null;
  const file = chatFilePresentation(target, label), Icon = app ? conversation ? ChatIcon : LinkIcon : icons[file.appearance];
  const rawLabel = label === target || /^(?:opencraft|app|agent|navigation|codex):/iu.test(label ?? "");
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild><a className="chat-file-citation chat-resource-chip"
      data-chat-resource-kind={kind} data-resource-appearance={app ? "application" : file.appearance}
      href={target} title={target} onClick={onClick}>
      <Icon size={16} aria-hidden="true" className="chat-file-citation__icon" />
      <span className="chat-resource-chip__name">{app && rawLabel
        ? conversation ? <FormattedMessage id="chat.resource.conversation" defaultMessage="Conversation" />
          : <FormattedMessage id="chat.resource.application" defaultMessage="Application" />
        : app ? label : file.name}</span>
      {file.location ? <span className="chat-resource-chip__location">{file.location}</span> : null}
    </a></ContextMenu.Trigger>
    <ContextMenu.Portal><ContextMenu.Content className="chat-external-link-menu">
      <ContextMenu.Item onSelect={() => void writeTextToClipboard(target)}>
        <CopyIcon aria-hidden="true" /><FormattedMessage id="chat.link.copy" defaultMessage="Copy link" />
      </ContextMenu.Item>
    </ContextMenu.Content></ContextMenu.Portal>
  </ContextMenu.Root>;
}
