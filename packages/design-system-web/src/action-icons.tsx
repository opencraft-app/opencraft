import { sharedActionIcon } from "./shared-action-icons";
import React from "react";
import { progressIndicatorGeometry } from "@opencraft/design-system/progress";
import { ActionGlyph, BrainArtwork, PencilArtwork, RoundedPage, type ActionIconProps } from "./icon-glyph";
export type { ActionIconProps } from "./icon-glyph";
export * from "./interface-icons";
export * from "./image-edit-icons";
export * from "./activity-icons";
export { RecoveryScanArtwork } from "./recovery-scan";
export * from "./layout-icons";
export { BoldIcon, ItalicIcon, ParagraphIcon, QuoteIcon, OrderedListIcon, UndoIcon, HistoryIcon, CalendarClockIcon, NewFileIcon, SearchFileIcon, AddImageIcon } from "./shared-action-icons";

/** Input geometry remains owned by ui-composer-input-icon (including touch). */
export function MicrophoneIcon({ off = false, ...props }: ActionIconProps & { readonly off?: boolean }) {
  return <ActionGlyph {...props} kind={off ? "microphone-off" : "microphone"}>
    {off ? <>
      <path d="M9 6.5v4a3 3 0 0 0 5.1 2.15M15 9V6a3 3 0 0 0-5.15-2.1" />
      <path d="M6.5 10.5v.5a5.5 5.5 0 0 0 9.4 3.9M17.5 11v-.5" />
      <path d="m4 4 16 16" />
    </> : <>
      <path d="M9 6a3 3 0 0 1 6 0v4.5a3 3 0 0 1-6 0Z" />
      <path d="M6.5 10.5v.5a5.5 5.5 0 0 0 11 0v-.5" />
    </>}
    <path d="M12 16.5V21m-3 0h6" />
  </ActionGlyph>;
}

/** One silhouette for commands, permissions and both Fast presentations. */
export function LightningIcon({ filled = false, ...props }: ActionIconProps & { readonly filled?: boolean }) {
  return <ActionGlyph {...props} kind="lightning">
    <path d="m13.25 3.5-7.75 9.5h6l-.75 7.5L18.5 11h-6l.75-7.5Z" fill={filled ? "currentColor" : "none"} />
  </ActionGlyph>;
}

/** A ring distinguishes stopping a response from recording and sending. */
export function StopCircleIcon(props: ActionIconProps) {
  return <ActionGlyph {...props} kind="stop">
    <circle cx="12" cy="12" r="9" />
    <rect x="8.5" y="8.5" width="7" height="7" rx="1.25" />
  </ActionGlyph>;
}

/** A shared page silhouette keeps read and edit permissions in one family. */
export function PermissionDocumentIcon({ editable = false, ...props }: ActionIconProps & { readonly editable?: boolean }) {
  return <ActionGlyph {...props} kind={editable ? "permission-edit" : "permission-read"}>
    <RoundedPage>{editable ? <path d="m10 12.5-2 2 2 2m4-4 2 2-2 2" /> : <path d="M8.5 12.5h7m-7 4h5" />}</RoundedPage>
  </ActionGlyph>;
}

export function PermissionShieldIcon(props: ActionIconProps) {
  return <ActionGlyph {...props} kind="permission-shield">
    <path d="M12 3.5c2 1.4 4.3 2.4 7 3v5c0 4.1-2.5 7.2-7 9.5-4.5-2.3-7-5.4-7-9.5v-5c2.7-.6 5-1.6 7-3Z" />
    <path d="m8.75 11.75 2.25 2.25 4.5-4.5" />
  </ActionGlyph>;
}

/** The same gear is used by Shell, account menus and settings contributions. */
export function SettingsGearIcon(props: ActionIconProps) {
  return <ActionGlyph strokeWidth={1.5} {...props} kind="settings">
    <path d="M8.93 5.58 Q9.21 5.42 9.34 5.01 L9.82 3.54 Q9.95 3.13 10.69 3.13 L13.31 3.13 Q14.05 3.13 14.18 3.54 L14.66 5.01 Q14.79 5.42 15.07 5.58 L16.03 6.13 Q16.30 6.29 16.73 6.20 L18.23 5.88 Q18.66 5.79 19.02 6.43 L20.33 8.70 Q20.70 9.34 20.41 9.66 L19.39 10.81 Q19.10 11.13 19.10 11.44 L19.10 12.56 Q19.10 12.87 19.39 13.19 L20.41 14.34 Q20.70 14.66 20.33 15.30 L19.02 17.57 Q18.66 18.21 18.23 18.12 L16.73 17.80 Q16.30 17.71 16.03 17.87 L15.07 18.42 Q14.79 18.58 14.66 18.99 L14.18 20.46 Q14.05 20.87 13.31 20.87 L10.69 20.87 Q9.95 20.87 9.82 20.46 L9.34 18.99 Q9.21 18.58 8.93 18.42 L7.97 17.87 Q7.70 17.71 7.27 17.80 L5.77 18.12 Q5.34 18.21 4.98 17.57 L3.67 15.30 Q3.30 14.66 3.59 14.34 L4.61 13.19 Q4.90 12.87 4.90 12.56 L4.90 11.44 Q4.90 11.13 4.61 10.81 L3.59 9.66 Q3.30 9.34 3.67 8.70 L4.98 6.43 Q5.34 5.79 5.77 5.88 L7.27 6.20 Q7.70 6.29 7.97 6.13Z" />
    <circle cx="12" cy="12" r="3.1" />
  </ActionGlyph>;
}

/** Artwork only: the progress adapter or existing busy control owns motion. */
export function LoadingRingIcon(props: ActionIconProps) {
  const geometry = progressIndicatorGeometry;
  return <ActionGlyph {...props} strokeWidth={geometry.strokeWidth} kind="loading">
    <circle cx={geometry.center} cy={geometry.center} r={geometry.radius} opacity={geometry.trackOpacity} />
    <path d={geometry.foregroundPath} />
  </ActionGlyph>;
}

/** Counterclockwise return shared by reset and retry actions. */
export const ResetIcon = sharedActionIcon("ResetIcon");


/** Static controls use the same quiet contours without process-row animation. */
export const SearchIcon = sharedActionIcon("SearchIcon");

export const TerminalIcon = sharedActionIcon("TerminalIcon");

export function ModelIcon(props: ActionIconProps) {
  return <ActionGlyph {...props} kind="model"><BrainArtwork /></ActionGlyph>;
}

export const ShareIcon = sharedActionIcon("ShareIcon");
export const CopyIcon = sharedActionIcon("CopyIcon");

export function EditIcon(props: ActionIconProps) {
  return <ActionGlyph {...props} kind="edit"><PencilArtwork /></ActionGlyph>;
}

export const ComposeIcon = sharedActionIcon("ComposeIcon");

export function DeleteIcon(props: ActionIconProps) {
  return <ActionGlyph {...props} kind="delete"><path d="M4.5 6.5h15M9 6.5V4h6v2.5m-9 0 1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M10 10v6.5M14 10v6.5" /></ActionGlyph>;
}

export function MoreIcon(props: ActionIconProps) {
  return <ActionGlyph {...props} kind="more"><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" /></ActionGlyph>;
}

export const AddIcon = sharedActionIcon("AddIcon");

export const CloseIcon = sharedActionIcon("CloseIcon");

export const CheckIcon = sharedActionIcon("CheckIcon");

export const AttachmentIcon = sharedActionIcon("AttachmentIcon");

export const ChevronDownIcon = sharedActionIcon("ChevronDownIcon");
export function ChevronUpIcon(props: ActionIconProps) {
  return <ActionGlyph {...props} kind="chevron-up"><path d="m6 15 6-6 6 6" /></ActionGlyph>;
}
export const ChevronRightIcon = sharedActionIcon("ChevronRightIcon");
export const ChevronLeftIcon = sharedActionIcon("ChevronLeftIcon");

export const FolderIcon = sharedActionIcon("FolderIcon");
export const FolderOpenIcon = sharedActionIcon("FolderOpenIcon");

/** Refresh, viewport rotation and conversation replay retain distinct meanings. */
export function RefreshIcon(props: ActionIconProps) {
  return <ActionGlyph {...props} kind="refresh"><path d="M19 8a8 8 0 0 0-13-2M5 4.5V9h4.5M5 16a8 8 0 0 0 13 2M19 19.5V15h-4.5" /></ActionGlyph>;
}
export function RotateIcon(props: ActionIconProps) {
  return <ActionGlyph {...props} kind="rotate"><rect x="8" y="8.5" width="7" height="11" rx="2" transform="rotate(20 11.5 14)" /><path d="M5 8a8 8 0 0 1 13-3M18 2V5h-3" /></ActionGlyph>;
}
export function ReplayIcon(props: ActionIconProps) {
  return <ActionGlyph {...props} kind="replay"><path d="M5 9a8 8 0 1 1-1 5M5 4.5V9h4.5" /><path d="m11 9 4 3-4 3V9Z" /></ActionGlyph>;
}
