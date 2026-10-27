import React from "react";
import { ActionGlyph, type ActionIconProps } from "./icon-glyph";

export function ImageTextIcon(props: ActionIconProps) {
  return <ActionGlyph {...props} kind="image-text"><path d="M5 7V4.5h14V7M12 4.5v15M8.5 19.5h7" /></ActionGlyph>;
}
export function ImageStickerIcon(props: ActionIconProps) {
  return <ActionGlyph {...props} kind="image-sticker"><circle cx="12" cy="12" r="8" /><path d="M8.5 14.5a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01" /></ActionGlyph>;
}
export function ImageCropIcon(props: ActionIconProps) {
  return <ActionGlyph {...props} kind="image-crop"><path d="M7 3.5v12A1.5 1.5 0 0 0 8.5 17H21M3.5 7h12A1.5 1.5 0 0 1 17 8.5V21" /></ActionGlyph>;
}
export function ImageFitIcon(props: ActionIconProps) {
  return <ActionGlyph {...props} kind="image-fit"><path d="M9 4.5H6A1.5 1.5 0 0 0 4.5 6v3M15 4.5h3A1.5 1.5 0 0 1 19.5 6v3M4.5 15v3A1.5 1.5 0 0 0 6 19.5h3M19.5 15v3a1.5 1.5 0 0 1-1.5 1.5h-3" /></ActionGlyph>;
}
export function ImageUndoIcon(props: ActionIconProps) {
  return <ActionGlyph {...props} kind="image-undo"><path d="m8.5 4.5-4 4 4 4M4.5 8.5h10a5.5 5.5 0 0 1 0 11H10" /></ActionGlyph>;
}
export function ImageRedoIcon(props: ActionIconProps) {
  return <ActionGlyph {...props} kind="image-redo"><path d="m15.5 4.5 4 4-4 4M19.5 8.5h-10a5.5 5.5 0 0 0 0 11H14" /></ActionGlyph>;
}
export function ImageMosaicIcon(props: ActionIconProps) {
  return <ActionGlyph {...props} kind="image-mosaic">
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path fill="currentColor" stroke="none" d="M5 5h4v4H5Zm5 5h4v4h-4Zm5-5h4v4h-4ZM5 15h4v4H5Zm10 0h4v4h-4Z" />
  </ActionGlyph>;
}
