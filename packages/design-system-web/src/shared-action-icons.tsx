import React from "react";
import { actionArtwork, type ActionArtworkName } from "@opencraft/design-system/action-artwork";
import { ActionGlyph, type ActionIconProps } from "./icon-glyph";

export function sharedActionIcon(name: ActionArtworkName) {
  const { kind, shapes } = actionArtwork[name];
  return function SharedActionIcon(props: ActionIconProps) {
    return <ActionGlyph {...props} kind={kind}>
      {shapes.map(({ tag, attributes }, index) => React.createElement(tag, { ...attributes, key: index }))}
    </ActionGlyph>;
  };
}

export const BoldIcon = sharedActionIcon("BoldIcon");
export const ItalicIcon = sharedActionIcon("ItalicIcon");
export const ParagraphIcon = sharedActionIcon("ParagraphIcon");
export const QuoteIcon = sharedActionIcon("QuoteIcon");
export const OrderedListIcon = sharedActionIcon("OrderedListIcon");
export const UndoIcon = sharedActionIcon("UndoIcon");
export const HistoryIcon = sharedActionIcon("HistoryIcon");
export const CalendarClockIcon = sharedActionIcon("CalendarClockIcon");
export const NewFileIcon = sharedActionIcon("NewFileIcon");
export const SearchFileIcon = sharedActionIcon("SearchFileIcon");
export const AddImageIcon = sharedActionIcon("AddImageIcon");
