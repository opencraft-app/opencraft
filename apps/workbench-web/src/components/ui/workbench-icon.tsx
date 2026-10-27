import React from "react";
import type { ComponentType } from "react";
import type { ActionIconProps } from "@opencraft/design-system-web/action-icons";
import { ModelIcon as Brain, ModelIcon as BrainCircuit, FolderIcon as Folder, MicrophoneIcon as Mic, AddIcon as Plus, SearchIcon as Search, SettingsGearIcon as Settings, ComposeIcon as SquarePen, TerminalIcon as TerminalSquare } from "@opencraft/design-system-web/action-icons";
import { SettingsGearIcon } from "@opencraft/design-system-web/action-icons";
import { workbenchIconMetrics } from "@opencraft/design-system/tokens";
import { useWorkbenchPresentation } from "../../workbench-product";
import { ExtensionsIcon as Blocks, PaletteIcon as Palette, MessageIcon as MessageSquare, PulseIcon as Activity, ArchiveIcon as Archive, ArrowLeftIcon as ArrowLeft, ArrowRightIcon as ArrowRight, AudioIcon as AudioLines, AgentIcon as Bot, CalendarIcon as CalendarClock, HelpIcon as CircleHelp, CloudIcon as Cloud, ColumnsIcon as Columns3, CpuIcon as Cpu, DatabaseIcon as Database, DownloadIcon as Download, CodeFileIcon as FileCode2, BranchIcon as GitBranch, GlobeIcon as Globe2, KeyboardIcon as Keyboard, DriveIcon as HardDrive, HomeIcon as House, GridIcon as LayoutGrid, TasksIcon as ListTodo, ChatIcon as MessageCircle, RefreshIcon as RefreshCw, CollaborationIcon as MessagesSquare, MonitorIcon as Monitor, SidebarLayoutIcon as PanelLeft, SidebarCollapseLayoutIcon as PanelLeftClose, PlugIcon as Plug, ServerIcon as Server, SlidersIcon as SlidersHorizontal, SparklesIcon as Sparkles, AppearanceIcon as SunMoon, PersonIcon as UserRound, PersonSettingsIcon as UserRoundCog, PeopleIcon as UsersRound } from "@opencraft/design-system-web/action-icons";

/** Wire names stay semantic. Only this Web adapter selects the artwork. */
export const workbenchIconRegistry = {
  activity: Activity, appearance: SunMoon, archive: Archive, "arrow-left": ArrowLeft, "arrow-right": ArrowRight,
  audio: AudioLines, bot: Bot, brain: BrainCircuit, browser: Globe2,
  calendar: CalendarClock, changes: GitBranch, chat: MessageCircle,
  cloud: Cloud, collaboration: MessagesSquare, cpu: Cpu, database: Database,
  desktop: Monitor, write: SquarePen, applications: LayoutGrid, columns: Columns3,
  file: FileCode2, folder: Folder, "hard-drive": HardDrive,
  keyboard: Keyboard, home: House, grid: LayoutGrid, "message-circle": MessageCircle, microphone: Mic,
  monitor: Monitor, "panel-left": PanelLeft, "panel-left-close": PanelLeftClose,
  plug: Plug, plus: Plus, refresh: RefreshCw, search: Search, server: Server, settings: Settings,
  sliders: SlidersHorizontal, sparkles: Sparkles, start: SquarePen, updates: Download, download: Download,
  tasks: ListTodo, terminal: TerminalSquare, user: UserRound,
  "user-round": UserRound, "user-round-cog": UserRoundCog, users: UsersRound,
} satisfies Record<string, ComponentType<ActionIconProps>>;

export type WorkbenchIconName = keyof typeof workbenchIconRegistry;

export type WorkbenchIconPurpose = "navigation" | "settings" | "settings-page" | "panel" | "work";
const legacyIconOverrides = { chat: MessageSquare, appearance: Palette, brain: Brain };
/** Presentation may select classic artwork, but registered contribution names remain authoritative. */
export function resolveWorkbenchIcon(name: string | undefined, classic: boolean, purpose: WorkbenchIconPurpose = "settings"): ComponentType<ActionIconProps> {
  if (classic && purpose === "panel" && !["chat", "terminal", "browser", "desktop", "folder"].includes(name ?? "")) return Plus;
  if (classic && purpose === "work") return name === "sparkles" ? Sparkles : Cloud;
  if (classic && name && Object.hasOwn(legacyIconOverrides, name)) return legacyIconOverrides[name as keyof typeof legacyIconOverrides];
  if (name && Object.hasOwn(workbenchIconRegistry, name)) return workbenchIconRegistry[name as WorkbenchIconName];
  return purpose === "navigation" ? Blocks : classic ? purpose === "panel" ? Plus : Blocks : CircleHelp;
}
export function workbenchIconSize(classic: boolean, purpose: WorkbenchIconPurpose): number {
  return (classic ? workbenchIconMetrics.classic : workbenchIconMetrics.core)[purpose === "settings-page" ? "settings" : purpose];
}

/** Decorative glyph; the owning control supplies its accessible name. */
export function WorkbenchIcon({ name, size, purpose = "settings", className }: {
  readonly name?: string;
  readonly size?: number;
  readonly purpose?: WorkbenchIconPurpose;
  readonly className?: string;
}) {
  const classic = useWorkbenchPresentation().iconStyle === "classic";
  if (name === "settings") return <SettingsGearIcon size={size ?? workbenchIconSize(classic, purpose)} className={className} data-workbench-icon="settings" />;
  const Icon = resolveWorkbenchIcon(name, classic, purpose);
  const stroke = !classic && purpose === "navigation" ? workbenchIconMetrics.coreNavigation.stroke
    : (classic ? workbenchIconMetrics.classic : workbenchIconMetrics.core).stroke;
  return <Icon size={size ?? workbenchIconSize(classic, purpose)} strokeWidth={stroke} aria-hidden="true" focusable="false"
    className={className} data-workbench-icon={name ?? "unknown"} />;
}
