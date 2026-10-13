import {
  Activity, Archive, ArrowLeft, ArrowRight, AudioLines, Bot, BrainCircuit,
  CalendarClock, CircleHelp, Cloud, Cpu, Database, FileCode2, Folder,
  GitBranch, Globe2, HardDrive, LayoutGrid, ListTodo, MessageCircle,
  MessagesSquare, Mic, Monitor, PanelLeft, PanelLeftClose, Plug,
  Plus, Search, Server, Settings, SlidersHorizontal, Sparkles, SunMoon,
  SquarePen, TerminalSquare, UserRound, UserRoundCog, UsersRound,
  type LucideIcon,
} from "lucide-react";

/** Wire names stay semantic. Only this Web adapter selects the artwork. */
export const workbenchIconRegistry = {
  activity: Activity, appearance: SunMoon, archive: Archive, "arrow-left": ArrowLeft, "arrow-right": ArrowRight,
  audio: AudioLines, bot: Bot, brain: BrainCircuit, browser: Globe2,
  calendar: CalendarClock, changes: GitBranch, chat: MessageCircle,
  cloud: Cloud, collaboration: MessagesSquare, cpu: Cpu, database: Database,
  file: FileCode2, folder: Folder, "hard-drive": HardDrive,
  grid: LayoutGrid, "message-circle": MessageCircle, microphone: Mic,
  monitor: Monitor, "panel-left": PanelLeft, "panel-left-close": PanelLeftClose,
  plug: Plug, plus: Plus, search: Search, server: Server, settings: Settings,
  sliders: SlidersHorizontal, sparkles: Sparkles, start: SquarePen,
  tasks: ListTodo, terminal: TerminalSquare, user: UserRound,
  "user-round": UserRound, "user-round-cog": UserRoundCog, users: UsersRound,
} satisfies Record<string, LucideIcon>;

export type WorkbenchIconName = keyof typeof workbenchIconRegistry;

/** Decorative glyph; the owning control supplies its accessible name. */
export function WorkbenchIcon({ name, size = 18, className }: {
  readonly name?: string;
  readonly size?: number;
  readonly className?: string;
}) {
  const Icon = name && Object.hasOwn(workbenchIconRegistry, name)
    ? workbenchIconRegistry[name as WorkbenchIconName] : CircleHelp;
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" focusable="false"
    className={className} data-workbench-icon={name ?? "unknown"} />;
}
