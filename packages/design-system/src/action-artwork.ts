/** Shared action contours; platform adapters own SVG elements, paint and accessibility. */
export interface ActionShape {
  readonly tag: "path" | "rect" | "circle" | "ellipse" | "line" | "polyline" | "polygon";
  readonly attributes: Readonly<Record<string, string | number>>;
}
export interface ActionArtwork {
  readonly kind: string;
  readonly shapes: readonly ActionShape[];
}

export const actionArtwork = {
  ShareIcon: { kind: "share", shapes: [{ tag: "path", attributes: { d: "M7 9H5.5v11h13V9H17M12 14V3.5m-3.5 4L12 3.5l3.5 4" } }] },
  AddIcon: {"kind": "add","shapes": [{"tag": "path","attributes": {"d": "M12 5v14M5 12h14"}}]},
  AddImageIcon: {"kind": "add-image","shapes": [{"tag": "path","attributes": {"d": "M17 10V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h4M4 14l4-4 4 4"}},{"tag": "circle","attributes": {"cx": 12,"cy": 7.5,"r": 1}},{"tag": "path","attributes": {"d": "M17 13v8m-4-4h8"}}]},
  AgentIcon: {"kind": "agent","shapes": [{"tag": "rect","attributes": {"x": "4","y": "6.5","width": "16","height": "13","rx": "3"}},{"tag": "path","attributes": {"d": "M12 3.5v3M9.5 15.5h5"}},{"tag": "circle","attributes": {"cx": "8.5","cy": "11.5","r": "0.75","fill": "currentColor","stroke": "none"}},{"tag": "circle","attributes": {"cx": "15.5","cy": "11.5","r": "0.75","fill": "currentColor","stroke": "none"}}]},
  AlertIcon: {"kind": "alert","shapes": [{"tag": "circle","attributes": {"cx": "12","cy": "12","r": "8"}},{"tag": "path","attributes": {"d": "M12 7.5v5"}},{"tag": "circle","attributes": {"cx": "12","cy": "16","r": "0.7","fill": "currentColor","stroke": "none"}}]},
  ArrowLeftIcon: {"kind": "arrow-left","shapes": [{"tag": "path","attributes": {"d": "M19.5 12h-15m5-5-5 5 5 5"}}]},
  ArrowRightIcon: {"kind": "arrow-right","shapes": [{"tag": "path","attributes": {"d": "M4.5 12h15m-5-5 5 5-5 5"}}]},
  ArrowUpIcon: {"kind": "arrow-up","shapes": [{"tag": "path","attributes": {"d": "M12 19.5v-15m-5 5 5-5 5 5"}}]},
  AttachmentIcon: {"kind": "attachment","shapes": [{"tag": "path","attributes": {"d": "m9 13 6.5-6.5a2.5 2.5 0 0 1 3.5 3.5L10.5 18.5a4.5 4.5 0 0 1-6.4-6.4L13 3.2"}}]},
  BoldIcon: {"kind": "bold","shapes": [{"tag": "path","attributes": {"d": "M7 4.5h5a3.75 3.75 0 0 1 0 7.5H7m0-7.5v15h6a3.75 3.75 0 0 0 0-7.5H7"}}]},
  BookIcon: {"kind": "book","shapes": [{"tag": "path","attributes": {"d": "M7.5 3.75h8.75a4 4 0 0 1 4 4v9a3.5 3.5 0 0 1-3.5 3.5h-1"}},{"tag": "path","attributes": {"d": "M4 7.25c2.9-.6 6.1-.1 8.7 1.35a6 6 0 0 1 3.05 5.2v6.45H7.5a3.5 3.5 0 0 1-3.5-3.5V7.25Z"}}]},
  BranchIcon: {"kind": "branch","shapes": [{"tag": "circle","attributes": {"cx": "6.5","cy": "5.5","r": "2"}},{"tag": "circle","attributes": {"cx": "6.5","cy": "18.5","r": "2"}},{"tag": "circle","attributes": {"cx": "17.5","cy": "5.5","r": "2"}},{"tag": "path","attributes": {"d": "M6.5 7.5v9m11-9v1A4.5 4.5 0 0 1 13 13H6.5"}}]},
  CalendarClockIcon: {"kind": "calendar-clock","shapes": [{"tag": "rect","attributes": {"x": 4,"y": 5,"width": 16,"height": 15,"rx": 3}},{"tag": "path","attributes": {"d": "M8 3.5v3m8-3v3M4 10h16"}},{"tag": "circle","attributes": {"cx": 12,"cy": 15,"r": 3}},{"tag": "path","attributes": {"d": "M12 13.5V15l1.25.75"}}]},
  CheckIcon: {"kind": "check","shapes": [{"tag": "path","attributes": {"d": "m5 12 4.5 4.5L19 7"}}]},
  ChecklistIcon: {"kind": "checklist","shapes": [{"tag": "path","attributes": {"d": "m4 6 1.5 1.5L8 4.5m3 2h9M4 17l1.5 1.5L8 15.5m3 2h9M11 12h9"}}]},
  ChevronDownIcon: {"kind": "chevron-down","shapes": [{"tag": "path","attributes": {"d": "m6 9 6 6 6-6"}}]},
  ChevronLeftIcon: {"kind": "chevron-left","shapes": [{"tag": "path","attributes": {"d": "m15 6-6 6 6 6"}}]},
  ChevronRightIcon: {"kind": "chevron-right","shapes": [{"tag": "path","attributes": {"d": "m9 6 6 6-6 6"}}]},
  CircleIcon: {"kind": "circle","shapes": [{"tag": "circle","attributes": {"cx": "12","cy": "12","r": "8"}}]},
  CloseIcon: {"kind": "close","shapes": [{"tag": "path","attributes": {"d": "m6 6 12 12M6 18 18 6"}}]},
  CloudIcon: {"kind": "cloud","shapes": [{"tag": "path","attributes": {"d": "M7 18.5a4.5 4.5 0 0 1-1.2-8.8 6 6 0 0 1 11.6-1.4A5.2 5.2 0 0 1 17 18.5H7Z"}}]},
  CodeFileIcon: {"kind": "code-file","shapes": [{"tag": "path","attributes": {"d": "M13.5 3.5h-6A2.5 2.5 0 0 0 5 6v12a2.5 2.5 0 0 0 2.5 2.5h9A2.5 2.5 0 0 0 19 18V9l-5.5-5.5Z"}},{"tag": "path","attributes": {"d": "M13.5 3.5v4A1.5 1.5 0 0 0 15 9h4"}},{"tag": "path","attributes": {"d": "m10 12.5-2 2 2 2m4-4 2 2-2 2"}}]},
  CodeIcon: {"kind": "code","shapes": [{"tag": "path","attributes": {"d": "m8 6.5-5 5.5 5 5.5m8-11 5 5.5-5 5.5M14 4l-4 16"}}]},
  ComposeIcon: {"kind": "compose","shapes": [{"tag": "path","attributes": {"d": "M11 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-4M10 11l7-7a2.1 2.1 0 0 1 3 3l-7 7-4 1 1-4Zm5.5-5.5 3 3"}}]},
  CopyIcon: {"kind": "copy","shapes": [{"tag": "rect","attributes": {"x": "8","y": "8","width": "12","height": "12","rx": "2.75"}},{"tag": "path","attributes": {"d": "M15 4H7a3 3 0 0 0-3 3v8"}}]},
  ExpandIcon: {"kind": "expand","shapes": [{"tag": "path","attributes": {"d": "M9 4.5H4.5V9m0-4.5 5.5 5.5m5 9.5h4.5V15m0 4.5L14 14"}}]},
  FolderIcon: {"kind": "folder","shapes": [{"tag": "path","attributes": {"d": "M4 7a3 3 0 0 1 3-3h3l2 2.5h5a3 3 0 0 1 3 3V17a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7Z"}}]},
  FolderOpenIcon: {"kind": "folder-open","shapes": [{"tag": "path","attributes": {"d": "M4 12V7a3 3 0 0 1 3-3h3l2 2.5h5a3 3 0 0 1 3 3M4 12h16l-2 6a3 3 0 0 1-2.8 2H7a3 3 0 0 1-3-3v-5Z"}}]},
  GlobeIcon: {"kind": "globe","shapes": [{"tag": "circle","attributes": {"cx": "12","cy": "12","r": "8"}},{"tag": "path","attributes": {"d": "M4 12h16M12 4c-4.2 4.5-4.2 11.5 0 16m0-16c4.2 4.5 4.2 11.5 0 16"}}]},
  HistoryIcon: {"kind": "history","shapes": [{"tag": "path","attributes": {"d": "M5 8.5a8 8 0 1 1-1 5M5 4v4.5H1.5M12 7.5V12l3 2"}}]},
  ImageIcon: {"kind": "image","shapes": [{"tag": "rect","attributes": {"x": "4","y": "4","width": "16","height": "16","rx": "3"}},{"tag": "path","attributes": {"d": "M4.5 16.5 9 12l4 4 2.5-2.5 4 4"}},{"tag": "circle","attributes": {"cx": "15.5","cy": "8.5","r": "1.25"}}]},
  ItalicIcon: {"kind": "italic","shapes": [{"tag": "path","attributes": {"d": "M10 4.5h8m-12 15h8M14.5 4.5l-5 15"}}]},
  LinkIcon: {"kind": "link","shapes": [{"tag": "path","attributes": {"d": "m9.5 8 2.5-2.5a4.25 4.25 0 0 1 6 6L15.5 14M8.5 10 6 12.5a4.25 4.25 0 0 0 6 6l2.5-2.5M9 15l6-6"}}]},
  ListIcon: {"kind": "list","shapes": [{"tag": "path","attributes": {"d": "M8.5 6h11M8.5 12h11M8.5 18h11M4.5 6h.1M4.5 12h.1M4.5 18h.1"}}]},
  MessageIcon: {"kind": "message","shapes": [{"tag": "path","attributes": {"d": "M7.5 4.5h9A3.5 3.5 0 0 1 20 8v6.5a3.5 3.5 0 0 1-3.5 3.5H9l-5 3V8a3.5 3.5 0 0 1 3.5-3.5Z"}}]},
  MonitorIcon: {"kind": "monitor","shapes": [{"tag": "rect","attributes": {"x": "4","y": "4.5","width": "16","height": "12","rx": "2.75"}},{"tag": "path","attributes": {"d": "M12 16.5V20m-3.5 0h7"}}]},
  NewFileIcon: {"kind": "new-file","shapes": [{"tag": "path","attributes": {"d": "M13.5 3.5h-6A2.5 2.5 0 0 0 5 6v12a2.5 2.5 0 0 0 2.5 2.5h9A2.5 2.5 0 0 0 19 18V9l-5.5-5.5Z"}},{"tag": "path","attributes": {"d": "M13.5 3.5v4A1.5 1.5 0 0 0 15 9h4"}},{"tag": "path","attributes": {"d": "M12 11v6m-3-3h6"}}]},
  OrderedListIcon: {"kind": "ordered-list","shapes": [{"tag": "path","attributes": {"d": "M10 6h10M10 12h10M10 18h10M4 4.5h1v3M4 11c0-1 3-1.2 3 .1 0 .8-3 1.2-3 2.4h3M4 17c1.2-1 3-1 3 .2 0 .8-1 .9-1 .9s1 .2 1 1c0 1.2-1.8 1.2-3 .2"}}]},
  ParagraphIcon: {"kind": "paragraph","shapes": [{"tag": "path","attributes": {"d": "M13 4.5H9a4 4 0 0 0 0 8h4M13 19.5v-15h5m-1 0v15"}}]},
  QuoteIcon: {"kind": "quote","shapes": [{"tag": "path","attributes": {"d": "M4.5 5.5h6v7h-2c0 2.5-1 4.5-4 6m0-13v7h4m6-7h6v7h-2c0 2.5-1 4.5-4 6m0-13v7h4"}}]},
  RedoIcon: {"kind": "redo","shapes": [{"tag": "path","attributes": {"d": "M19 9a8 8 0 1 0 1 5M19 4.5V9h-4.5"}}]},
  ResetIcon: {"kind": "reset","shapes": [{"tag": "path","attributes": {"d": "M5 9a8 8 0 1 1-1 5"}},{"tag": "path","attributes": {"d": "M5 4.5V9h4.5"}}]},
  ReviewShieldIcon: {"kind": "review-shield","shapes": [{"tag": "path","attributes": {"d": "M12 3.5c2 1.4 4.3 2.4 7 3v5c0 4.1-2.5 7.2-7 9.5-4.5-2.3-7-5.4-7-9.5v-5c2.7-.6 5-1.6 7-3Z"}},{"tag": "path","attributes": {"d": "m8.5 10 2 2-2 2m5 1H16"}}]},
  SearchFileIcon: {"kind": "search-file","shapes": [{"tag": "path","attributes": {"d": "M13.5 3.5h-6A2.5 2.5 0 0 0 5 6v12a2.5 2.5 0 0 0 2.5 2.5h9A2.5 2.5 0 0 0 19 18V9l-5.5-5.5Z"}},{"tag": "path","attributes": {"d": "M13.5 3.5v4A1.5 1.5 0 0 0 15 9h4"}},{"tag": "circle","attributes": {"cx": 11,"cy": 13.5,"r": 2.5}},{"tag": "path","attributes": {"d": "m13 15.5 3 3"}}]},
  SearchIcon: {"kind": "search","shapes": [{"tag": "path","attributes": {"d": "M17.5 10.75a6.75 6.75 0 1 1-13.5 0 6.75 6.75 0 0 1 13.5 0ZM15.5 15.5l5 5"}}]},
  SparklesIcon: {"kind": "sparkles","shapes": [{"tag": "path","attributes": {"d": "m11 4 2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6ZM19 3.5v4m-2-2h4"}}]},
  SquareIcon: {"kind": "square","shapes": [{"tag": "rect","attributes": {"x": "5","y": "5","width": "14","height": "14","rx": "2.75"}}]},
  TerminalIcon: {"kind": "terminal","shapes": [{"tag": "path","attributes": {"d": "M7.75 4.75h8.5A4.25 4.25 0 0 1 20.5 9v6a4.25 4.25 0 0 1-4.25 4.25h-8.5A4.25 4.25 0 0 1 3.5 15V9a4.25 4.25 0 0 1 4.25-4.25Z"}},{"tag": "path","attributes": {"d": "m7.8 9.1 3 2.9-3 2.9"}},{"tag": "path","attributes": {"d": "M13.6 14.9h2.9"}}]},
  ToolIcon: {"kind": "tool","shapes": [{"tag": "path","attributes": {"d": "M14 4a5.6 5.6 0 0 0-6.4 7.5l-3.5 3.6a2.8 2.8 0 0 0 4 4l3.5-3.6A5.6 5.6 0 0 0 19 9l-3.5 3-3.2-3.2L15 5.5 14 4Z"}}]},
  UndoIcon: {"kind": "undo","shapes": [{"tag": "path","attributes": {"d": "M4.5 9.5H15a5 5 0 0 1 0 10h-3M8.5 5.5l-4 4 4 4"}}]},
  WrapTextIcon: {"kind": "wrap-text","shapes": [{"tag": "path","attributes": {"d": "M4.5 6h15M4.5 11.5H16a3 3 0 0 1 0 6h-5m3-3-3 3 3 3M4.5 17.5H7"}}]},
} as const satisfies Record<string, ActionArtwork>;

export type ActionArtworkName = keyof typeof actionArtwork;
