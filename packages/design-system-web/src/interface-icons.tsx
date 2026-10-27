import { sharedActionIcon } from "./shared-action-icons";
import React, { type ReactNode } from "react";
import { ActionGlyph, RoundedPage, type ActionIconProps } from "./icon-glyph";

/** Quiet, rounded interface artwork; consumers own slots, color, motion and interaction. */
function glyph(kind: string, artwork: ReactNode) {
  return function InterfaceIcon(props: ActionIconProps) {
    return <ActionGlyph {...props} kind={kind}>{artwork}</ActionGlyph>;
  };
}

function Screen({ children }: { readonly children?: ReactNode }) {
  return <><rect x="4" y="4.5" width="16" height="12" rx="2.75" /><path d="M12 16.5V20m-3.5 0h7" />{children}</>;
}
function Person() {
  return <><circle cx="12" cy="7.5" r="3" /><path d="M5.5 20v-1a6.5 6.5 0 0 1 13 0v1" /></>;
}
function Shield({ children }: { readonly children?: ReactNode }) {
  return <><path d="M12 3.5c2 1.4 4.3 2.4 7 3v5c0 4.1-2.5 7.2-7 9.5-4.5-2.3-7-5.4-7-9.5v-5c2.7-.6 5-1.6 7-3Z" />{children}</>;
}
function Chat({ children }: { readonly children?: ReactNode }) {
  return <><path d="M7.5 4.5h9A3.5 3.5 0 0 1 20 8v6.5a3.5 3.5 0 0 1-3.5 3.5H9l-5 3V8a3.5 3.5 0 0 1 3.5-3.5Z" />{children}</>;
}

export const HomeIcon = glyph("home", <path d="M4.5 10.5 10.3 5.3a2.6 2.6 0 0 1 3.4 0l5.8 5.2v7a2.5 2.5 0 0 1-2.5 2.5h-3v-6h-4v6H7a2.5 2.5 0 0 1-2.5-2.5v-7Z" />);
export const ChatIcon = glyph("chat", <path d="M7.5 18.6 4 20l1.2-4a8 8 0 1 1 2.3 2.6Z" />);
export const MessageIcon = sharedActionIcon("MessageIcon");
export const NewMessageIcon = glyph("new-message", <Chat><path d="M12 8v6m-3-3h6" /></Chat>);
export const CollaborationIcon = glyph("collaboration", <><path d="M15 11.5V7.2a3.2 3.2 0 0 0-3.2-3.2H6.7a3.2 3.2 0 0 0-3.2 3.2V16L7 13.5h4.8a3.2 3.2 0 0 0 3.2-3.2" /><path d="M18.5 8.5a3.2 3.2 0 0 1 2 3v9l-3.5-2.5h-5a3.2 3.2 0 0 1-3.2-3" /></>);
export const AgentIcon = sharedActionIcon("AgentIcon");
export const CloudIcon = sharedActionIcon("CloudIcon");
export const ServerIcon = glyph("server", <><rect x="4.5" y="4.5" width="15" height="6" rx="2" /><rect x="4.5" y="13.5" width="15" height="6" rx="2" /><path d="M12 7.5h4m-4 9h4" /><circle cx="8" cy="7.5" r="0.65" fill="currentColor" stroke="none" /><circle cx="8" cy="16.5" r="0.65" fill="currentColor" stroke="none" /></>);
export const GlobeIcon = sharedActionIcon("GlobeIcon");
export const MonitorIcon = sharedActionIcon("MonitorIcon");
export const MonitorOffIcon = glyph("monitor-off", <><path d="M9 4.5h8.3A2.7 2.7 0 0 1 20 7.2v7M4 7v6.8a2.7 2.7 0 0 0 2.7 2.7H17M12 16.5V20m-3.5 0h7M4 4l16 16" /></>);
export const LaptopIcon = glyph("laptop", <><path d="M5.5 15V6.5A2.5 2.5 0 0 1 8 4h8a2.5 2.5 0 0 1 2.5 2.5V15M4.5 15h15l1 2.5a1.8 1.8 0 0 1-1.7 2.5H5.2a1.8 1.8 0 0 1-1.7-2.5l1-2.5ZM10 17.5h4" /></>);
export const DevicesIcon = glyph("devices", <><path d="M10 16H6.5A2.5 2.5 0 0 1 4 13.5V7a2.5 2.5 0 0 1 2.5-2.5h10A2.5 2.5 0 0 1 19 7M8.5 16v4m-3 0h5" /><rect x="13.5" y="9" width="7" height="11" rx="2" /><path d="M16.5 17.5h1" /></>);
export const CalendarIcon = glyph("calendar", <><path d="M10 20H6.5A2.5 2.5 0 0 1 4 17.5v-10A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5V10M8 3.5v3m8-3v3M4 10h7" /><circle cx="16.5" cy="16.5" r="4" /><path d="M16.5 14.5v2l1.5 1" /></>);
export const ClockIcon = glyph("clock", <><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3.5 2" /></>);
export const PersonIcon = glyph("person", <Person />);
export const PeopleIcon = glyph("people", <><circle cx="9" cy="7.5" r="2.75" /><path d="M3.5 20v-1.5a5.5 5.5 0 0 1 11 0V20M16 5a2.8 2.8 0 0 1 0 5.5m2 3.5a5 5 0 0 1 2.5 4.3V20" /></>);
export const PersonSettingsIcon = glyph("person-settings", <><circle cx="9.5" cy="7.5" r="3" /><path d="M4 20v-1a5.5 5.5 0 0 1 7.5-5.1" /><circle cx="17" cy="17" r="2.5" /><path d="M17 13v1.5m0 5V21m4-4h-1.5m-5 0H13m1.2-2.8 1 1m3.6 3.6 1 1m0-5.6-1 1m-3.6 3.6-1 1" /></>);
export const ArrowLeftIcon = sharedActionIcon("ArrowLeftIcon");
export const ArrowRightIcon = sharedActionIcon("ArrowRightIcon");
export const ArrowUpIcon = sharedActionIcon("ArrowUpIcon");
export const ArrowDownIcon = glyph("arrow-down", <path d="M12 4.5v15m-5-5 5 5 5-5" />);
export const ArrowUpRightIcon = glyph("arrow-up-right", <path d="M6 18 18 6M9 6h9v9" />);
export const TurnRightIcon = glyph("turn-right", <path d="M5 5v7.5a3.5 3.5 0 0 0 3.5 3.5h11m-4.5-4.5 4.5 4.5-4.5 4.5" />);
export const ExternalLinkIcon = glyph("external-link", <><path d="M10.5 4.5h-3a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3v-3M13.5 4.5h6v6m0-6L10 14" /></>);
export const DownloadIcon = glyph("download", <path d="M12 4v11.5M8 11.5l4 4 4-4M4.5 15v2A2.5 2.5 0 0 0 7 19.5h10a2.5 2.5 0 0 0 2.5-2.5v-2" />);
export const UploadIcon = glyph("upload", <path d="M12 15.5V4M8 8l4-4 4 4M4.5 15v2A2.5 2.5 0 0 0 7 19.5h10a2.5 2.5 0 0 0 2.5-2.5v-2" />);
export const AlertIcon = sharedActionIcon("AlertIcon");
export const WarningIcon = glyph("warning", <><path d="m10.2 5-7 12a2.1 2.1 0 0 0 1.8 3h14a2.1 2.1 0 0 0 1.8-3l-7-12a2.1 2.1 0 0 0-3.6 0Z" /><path d="M12 9v4.5" /><circle cx="12" cy="17" r="0.7" fill="currentColor" stroke="none" /></>);
export const HelpIcon = glyph("help", <><circle cx="12" cy="12" r="8" /><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1.2.9-1.5 1.3-1.5 2.5" /><circle cx="12" cy="16.5" r="0.7" fill="currentColor" stroke="none" /></>);
export const InfoIcon = glyph("info", <><circle cx="12" cy="12" r="8" /><path d="M10.5 11H12v5.5m-1.5 0h3" /><circle cx="12" cy="7.5" r="0.7" fill="currentColor" stroke="none" /></>);
export const CircleIcon = sharedActionIcon("CircleIcon");
export const CheckedCircleIcon = glyph("checked-circle", <><circle cx="12" cy="12" r="8" /><path d="m8 12 2.7 2.7L16 9.5" /></>);
export const PausedCircleIcon = glyph("paused-circle", <><circle cx="12" cy="12" r="8" /><path d="M9.5 8.5v7m5-7v7" /></>);
export const SquareIcon = sharedActionIcon("SquareIcon");
export const PlayIcon = glyph("play", <path d="M8.5 5a1.5 1.5 0 0 0-2 1.3v11.4A1.5 1.5 0 0 0 8.5 19l10-5.7a1.5 1.5 0 0 0 0-2.6L8.5 5Z" />);
export const PauseIcon = glyph("pause", <><rect x="6" y="4.5" width="3.5" height="15" rx="1.5" /><rect x="14.5" y="4.5" width="3.5" height="15" rx="1.5" /></>);
export const ToolIcon = sharedActionIcon("ToolIcon");
export const ExtensionsIcon = glyph("extensions", <><rect x="4.5" y="10.5" width="6" height="9" rx="1.75" /><rect x="4.5" y="4.5" width="6" height="3" rx="1.25" /><rect x="13.5" y="4.5" width="6" height="9" rx="1.75" /><rect x="13.5" y="16.5" width="6" height="3" rx="1.25" /></>);
export const GridIcon = glyph("grid", <><rect x="4.5" y="4.5" width="6" height="6" rx="1.75" /><rect x="13.5" y="4.5" width="6" height="6" rx="1.75" /><rect x="4.5" y="13.5" width="6" height="6" rx="1.75" /><rect x="13.5" y="13.5" width="6" height="6" rx="1.75" /></>);
export const ColumnsIcon = glyph("columns", <><rect x="4" y="4.5" width="16" height="15" rx="2.75" /><path d="M9.3 4.5v15m5.4-15v15" /></>);
export const SlidersIcon = glyph("sliders", <><path d="M4.5 7.5h3m4 0h8M4.5 16.5h8m4 0h3" /><circle cx="9.5" cy="7.5" r="2" /><circle cx="14.5" cy="16.5" r="2" /></>);
export const BranchIcon = sharedActionIcon("BranchIcon");
export const ForkIcon = glyph("fork", <><circle cx="6" cy="5.5" r="2" /><circle cx="18" cy="5.5" r="2" /><circle cx="12" cy="18.5" r="2" /><path d="M6 7.5V9a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7.5M12 12v4.5" /></>);
export const EyeIcon = glyph("eye", <><path d="M3.5 12S6.5 6.5 12 6.5s8.5 5.5 8.5 5.5-3 5.5-8.5 5.5S3.5 12 3.5 12Z" /><circle cx="12" cy="12" r="2.75" /></>);
export const EyeOffIcon = glyph("eye-off", <path d="M9 7c4.5-1.3 8.4.8 11.5 5-.8 1.2-1.7 2.2-2.7 3M15 17c-4.5 1.3-8.4-.8-11.5-5 .8-1.2 1.7-2.2 2.7-3M4 4l16 16" />);
export const PointerIcon = glyph("pointer", <path d="m5 3.5 14 9-6.5 1.5-3 6.5L5 3.5Z" />);
export const PointerOffIcon = glyph("pointer-off", <path d="m9 6 10 6.5-4 1M6.5 10l3 10.5 3-6.5M3.5 3.5l17 17" />);
export const KeyboardIcon = glyph("keyboard", <><rect x="3.5" y="5.5" width="17" height="13" rx="2.75" /><path d="M7 9h.1m3.2 0h.1m3.2 0h.1m3.2 0h.1M7 12h.1m3.2 0h.1m3.2 0h.1m3.2 0h.1M8 15.5h8" /></>);
export const AudioIcon = glyph("audio", <path d="M4 10v4m4-7v10m4-13v16m4-13v10m4-7v4" />);
export const CpuIcon = glyph("cpu", <><rect x="6" y="6" width="12" height="12" rx="2.75" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" /><path d="M9.5 3.5V6m5-2.5V6m-5 12v2.5m5-2.5v2.5M3.5 9.5H6m-2.5 5H6m12-5h2.5m-2.5 5h2.5" /></>);
export const DatabaseIcon = glyph("database", <><ellipse cx="12" cy="6.5" rx="7" ry="2.75" /><path d="M5 6.5v10c0 3.7 14 3.7 14 0v-10M5 11.5c0 3.7 14 3.7 14 0" /></>);
export const DriveIcon = glyph("drive", <><path d="M5 12.5 7 6a2 2 0 0 1 2-1.5h6A2 2 0 0 1 17 6l2 6.5" /><rect x="4.5" y="12" width="15" height="7" rx="2.5" /><circle cx="8" cy="15.5" r="0.65" fill="currentColor" stroke="none" /><path d="M12 15.5h4" /></>);
export const PlugIcon = glyph("plug", <path d="M9 4v4m6-4v4M6.5 8h11M8 8v4a4 4 0 0 0 8 0V8m-4 8v4" />);
export const ArchiveIcon = glyph("archive", <><rect x="4" y="4.5" width="16" height="5" rx="1.5" /><path d="M5.5 9.5v8a2.5 2.5 0 0 0 2.5 2.5h8a2.5 2.5 0 0 0 2.5-2.5v-8M10 13h4" /></>);
export const RestoreArchiveIcon = glyph("restore-archive", <><path d="M9 4.5h10a1 1 0 0 1 1 1v4H9M5.5 12v5.5A2.5 2.5 0 0 0 8 20h8a2.5 2.5 0 0 0 2.5-2.5v-8M11 13h4M7 3.5 3.5 7 7 10.5M3.5 7H12" /></>);
export const ListIcon = sharedActionIcon("ListIcon");
export const TasksIcon = glyph("tasks", <><rect x="4.5" y="4.5" width="4" height="4" rx="1" /><rect x="4.5" y="15.5" width="4" height="4" rx="1" /><path d="M12 6.5h7.5M12 17.5h7.5M5.5 12h14" /></>);
export const ChecklistIcon = sharedActionIcon("ChecklistIcon");
export const FilterIcon = glyph("filter", <path d="M4.5 6.5h15M8 12h8m-5.5 5.5h3" />);
export const ChartIcon = glyph("chart", <path d="M4.5 4.5v12a3 3 0 0 0 3 3h12M8 14l4-4 3 2.5 5-6" />);
export const PulseIcon = glyph("pulse", <path d="M4 12h3l3-6 4 12 3-6h3" />);
export const TargetIcon = glyph("target", <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="0.75" fill="currentColor" stroke="none" /></>);
export const GaugeIcon = glyph("gauge", <><path d="M5.5 18a8 8 0 1 1 13 0M5 10l2 1m5-7v2m7 4-2 1m-5 5 4-4" /><circle cx="12" cy="16" r="1.5" /></>);
export const SparklesIcon = sharedActionIcon("SparklesIcon");
export const AppearanceIcon = glyph("appearance", <><path d="M13 4a8 8 0 1 0 7 11.5A7.5 7.5 0 0 1 13 4Z" /><path d="M18.5 3.5v4m-2-2h4" /></>);
export const SunriseIcon = glyph("sunrise", <path d="M7 15a5 5 0 0 1 10 0M4 15h16M6.5 19h11M12 4v2M5 8.5 6.5 10m12-1.5L17 10" />);
export const PaletteIcon = glyph("palette", <><path d="M12 4a8 8 0 1 0 2.8 15.5c1.6-.6 1.1-2 .4-3.2-.7-1.3.1-2.8 1.8-2.5 2.5.5 3.6-1.2 2.9-3.6A8 8 0 0 0 12 4Z" /><circle cx="8" cy="9" r="0.65" fill="currentColor" stroke="none" /><circle cx="12.5" cy="7.5" r="0.65" fill="currentColor" stroke="none" /><circle cx="6.5" cy="13.5" r="0.65" fill="currentColor" stroke="none" /></>);
export const BellIcon = glyph("bell", <path d="M7 10a5 5 0 0 1 10 0c0 5 2 5.5 2 7H5c0-1.5 2-2 2-7Zm3 10h4M12 3.5V5" />);
export const PinIcon = glyph("pin", <path d="M9 4.5h9m-7 0v5l-5 4.5h8.5l.5-4.5 3-5M10 14l-5 6" />);
export const PinOffIcon = glyph("pin-off", <path d="M11 4.5h7l-3 5-.2 1.5M8 8v1.5L5 14h8M10 14l-5 6M4 4l16 16" />);
export const GripIcon = glyph("grip", <><circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none" /><circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none" /><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none" /><circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none" /></>);
export const LoginIcon = glyph("login", <path d="M14 4.5h3a2.5 2.5 0 0 1 2.5 2.5v10a2.5 2.5 0 0 1-2.5 2.5h-3M4.5 12h10M10 7.5l4.5 4.5-4.5 4.5" />);
export const LogoutIcon = glyph("logout", <path d="M10 4.5H7A2.5 2.5 0 0 0 4.5 7v10A2.5 2.5 0 0 0 7 19.5h3M10 12h10m-4.5-4.5L20 12l-4.5 4.5" />);
export const AtSignIcon = glyph("mention", <><circle cx="11.5" cy="12" r="3.25" /><path d="M14.75 8.75v5.75a2 2 0 0 0 4 0V12a7.25 7.25 0 1 0-5 6.9" /></>);
export const LinkIcon = sharedActionIcon("LinkIcon");
export const LocationIcon = glyph("location", <><path d="M19 10.5C19 15.5 12 21 12 21S5 15.5 5 10.5a7 7 0 0 1 14 0Z" /><circle cx="12" cy="10.5" r="2.5" /></>);
export const ShieldIcon = glyph("shield", <Shield />);
export const PasteIcon = glyph("paste", <><path d="M8 5.5H6.5A2.5 2.5 0 0 0 4 8v9.5A2.5 2.5 0 0 0 6.5 20h4M16 5.5h1.5A2.5 2.5 0 0 1 20 8v2" /><rect x="8" y="3.5" width="8" height="4" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.75" /></>);
export const SaveIcon = glyph("save", <><path d="M14.5 4.5H7A2.5 2.5 0 0 0 4.5 7v10A2.5 2.5 0 0 0 7 19.5h10a2.5 2.5 0 0 0 2.5-2.5V9.5l-5-5ZM8 4.5V10h7V5M8 19.5V14h8v5.5" /></>);
export const SendIcon = glyph("send", <path d="m5 10 14-5a.75.75 0 0 1 1 1l-5 14a.75.75 0 0 1-1.35.1L10 14l-5.1-2.65A.75.75 0 0 1 5 10ZM10 14l6-6" />);
export const RedoIcon = sharedActionIcon("RedoIcon");
export const DoubleCheckIcon = glyph("double-check", <path d="m4 12 3.5 3.5 9-9M12.5 16l7.5-7.5" />);
export const ExpandIcon = sharedActionIcon("ExpandIcon");
export const CollapseIcon = glyph("collapse", <path d="M4.5 10H10V4.5m0 5.5L4.5 4.5m9.5 15V14h5.5m-5.5 0 5.5 5.5" />);
export const ZoomInIcon = glyph("zoom-in", <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4.5 4.5M7.5 10.5h6m-3-3v6" /></>);
export const ZoomOutIcon = glyph("zoom-out", <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4.5 4.5M7.5 10.5h6" /></>);
export const ImageIcon = sharedActionIcon("ImageIcon");
export const DocumentIcon = glyph("document", <RoundedPage />);
export const TextFileIcon = glyph("text-file", <RoundedPage><path d="M8.5 12.5h7m-7 4h5" /></RoundedPage>);
export const CodeFileIcon = sharedActionIcon("CodeFileIcon");
export const JsonFileIcon = glyph("json-file", <RoundedPage><path d="M10 11.5h-.5V14L8.5 15l1 1v1.5h.5m4-6h.5V14l1 1-1 1v1.5H14" /></RoundedPage>);
export const DiffFileIcon = glyph("diff-file", <RoundedPage><path d="M9.5 12.5h5m-2.5-2.5v5m-2.5 2.5h5" /></RoundedPage>);
export const ImageFileIcon = glyph("image-file", <RoundedPage><path d="m8 17 2.5-2.5 2 2 1.5-1.5 2 2" /><circle cx="9" cy="11.5" r="0.65" fill="currentColor" stroke="none" /></RoundedPage>);
export const CodeIcon = sharedActionIcon("CodeIcon");
export const BookIcon = sharedActionIcon("BookIcon");
export const NewFolderIcon = glyph("new-folder", <><path d="M4 7a3 3 0 0 1 3-3h3l2 2.5h5a3 3 0 0 1 3 3V17a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7Z" /><path d="M12 10.5v6m-3-3h6" /></>);
export const TableIcon = glyph("table", <><rect x="4" y="4.5" width="16" height="15" rx="2.75" /><path d="M4 10h16M9 10v9.5M4 15h16" /></>);
export const LabIcon = glyph("lab", <path d="M8 4h8m-6 0v5.5l-5 7.7a1.8 1.8 0 0 0 1.5 2.8h11a1.8 1.8 0 0 0 1.5-2.8l-5-7.7V4M7.5 14h9" />);
export const LayersIcon = glyph("layers", <path d="m12 4 8.5 4.5L12 13 3.5 8.5 12 4ZM4 13l8 4 8-4M4 17l8 4 8-4" />);
export const BoxesIcon = glyph("boxes", <><path d="m12 3.5 4.5 2.3v5L12 13l-4.5-2.2v-5L12 3.5Zm-4.5 2.3L12 8l4.5-2.2M12 8v5" /><path d="m7 11-4.5 2.3v5L7 20.5l4.5-2.2M2.5 13.3 7 15.5l4.5-2.2M7 15.5v5" /><path d="m17 11 4.5 2.3v5L17 20.5l-4.5-2.2M12.5 13.3l4.5 2.2 4.5-2.2M17 15.5v5" /></>);
export const BriefcaseIcon = glyph("briefcase", <><rect x="4" y="7" width="16" height="13" rx="2.75" /><path d="M8.5 7V5a.5.5 0 0 1 .5-.5h6a.5.5 0 0 1 .5.5v2M4 12c5 2.7 11 2.7 16 0M12 12v4" /></>);
export const BalanceIcon = glyph("balance", <path d="M12 4v16m-5 0h10M5 7h14M5 7l-3 7h6L5 7Zm14 0-3 7h6l-3-7Z" />);
export const HookIcon = glyph("hook", <><circle cx="12" cy="5" r="2.5" /><path d="M12 7.5V16a4.5 4.5 0 0 0 9 0v-2.5l-2 2M12 16a4.5 4.5 0 0 1-9 0v-2.5l2 2" /></>);

export const EnvironmentsIcon = glyph("environments", <><rect x="4" y="7" width="11.5" height="5" rx="1.5" /><rect x="4" y="15" width="11.5" height="5" rx="1.5" /><path d="M8 9.5h3.5M8 17.5h3.5M6 3.5h9l-2-2M20 7v13l2-2" /></>);

export const ReviewShieldIcon = sharedActionIcon("ReviewShieldIcon");

/** Static utility marks share the same rounded canvas as the shared layout family. */
export const WrapTextIcon = sharedActionIcon("WrapTextIcon");
export const MinusIcon = glyph("minus", <path d="M5 12h14" />);
export const UrgentPriorityIcon = glyph("priority-urgent", <><path d="M9 5.5v8m6-8v8" /><circle cx="9" cy="18" r=".75" fill="currentColor" stroke="none" /><circle cx="15" cy="18" r=".75" fill="currentColor" stroke="none" /></>);
export function CheckboxIcon({ checked = false, ...props }: ActionIconProps & { readonly checked?: boolean }) {
  return <ActionGlyph {...props} kind={checked ? "checkbox-checked" : "checkbox"}>
    <rect x="4.5" y="4.5" width="15" height="15" rx="2.75" />
    {checked ? <path d="m8 12 2.75 2.75L16 9.5" /> : null}
  </ActionGlyph>;
}

/** Native input adapters export the same artwork, never a second CSS drawing. */
export const DateIcon = glyph("date", <><rect x="4" y="5" width="16" height="15" rx="3" /><path d="M8 3.5v3m8-3v3M4 10h16" /></>);
export const NumberStepperIcon = glyph("number-stepper", <path d="m8 8 4-4 4 4m-8 8 4 4 4-4" />);
export const IndeterminateCheckboxIcon = glyph("checkbox-indeterminate", <><rect x="4.5" y="4.5" width="15" height="15" rx="2.75" /><path d="M8.5 12h7" /></>);
