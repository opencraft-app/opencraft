import { workbenchIconMetrics } from "@opencraft/design-system/tokens";
import { createContext, useContext, useEffect, useMemo, lazy, Suspense, useState, useSyncExternalStore, type ReactNode } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { conversationAppearanceKey, type ConversationAppearance, type ConversationIconName } from "@opencraft/ui-preferences";
import { IconButton } from "@opencraft/design-system-web/button";
import { ChatIcon, FolderIcon, ChartIcon, BookIcon, CodeIcon, TerminalIcon, EditIcon, PaletteIcon, GlobeIcon, TargetIcon, BriefcaseIcon, CalendarIcon, LightningIcon, ModelIcon, PeopleIcon, ToolIcon, ImageIcon, SparklesIcon } from "@opencraft/design-system-web/action-icons";
import { useUiPreferencesRuntime } from "../runtime/ui-preferences-runtime";
import "./conversation-appearance.scss";

export type Target = { hostId: string; threadId: string; title?: string };
const icons = { chat: ChatIcon, folder: FolderIcon, chart: ChartIcon, book: BookIcon, code: CodeIcon, terminal: TerminalIcon, pencil: EditIcon, palette: PaletteIcon, globe: GlobeIcon, target: TargetIcon, briefcase: BriefcaseIcon, calendar: CalendarIcon, lightning: LightningIcon, brain: ModelIcon, people: PeopleIcon, tool: ToolIcon, image: ImageIcon, star: SparklesIcon } satisfies Record<ConversationIconName, typeof ChatIcon>;
export const fallback: ConversationAppearance = { icon: "chat", color: "default" };
const Context = createContext<{
  scope: string; preferences: ReturnType<typeof useUiPreferencesRuntime>;
  open(target: Target, returnFocus?: () => HTMLElement | null): void;
} | null>(null);
export function useConversationAppearanceActions() { return useContext(Context); }
const noSubscribe = () => () => {};
const emptySnapshot = () => null;

export function useAppearance(target: Target): ConversationAppearance | null {
  const context = useContext(Context);
  const read = () => context?.preferences.get("chat.conversationAppearances")[conversationAppearanceKey(context.scope, target.hostId, target.threadId)] ?? null;
  return useSyncExternalStore(context?.preferences.subscribe ?? noSubscribe, context ? read : emptySnapshot, emptySnapshot);
}
export function Artwork({ appearance, size = workbenchIconMetrics.overview.action }: { appearance: ConversationAppearance; size?: number }) {
  const Icon = icons[appearance.icon];
  return <span className="conversation-appearance-icon conversation-appearance-color" data-color={appearance.color} data-icon={appearance.icon}
    style={appearance.color.startsWith("#") ? { color: appearance.color } : undefined} aria-hidden="true"><Icon size={size} /></span>;
}
export function ConversationAppearanceIcon(props: Target & { size?: number; fallback?: ReactNode }) {
  const appearance = useAppearance(props);
  return appearance ? <Artwork appearance={appearance} size={props.size} /> : props.fallback ?? null;
}
export function ConversationAppearanceButton(props: Target & { readOnly?: boolean }) {
  const context = useContext(Context);
  const appearance = useAppearance(props);
  const intl = useIntl();
  if (!context) return null;
  const label = intl.formatMessage({ id: "chat.appearance.change", defaultMessage: "Change icon" });
  return <IconButton disabled={props.readOnly} className="conversation-appearance-trigger no-drag" aria-label={label} title={label}
    onClick={() => context.open(props)}><Artwork appearance={appearance ?? fallback} size={workbenchIconMetrics.overview.heading} /></IconButton>;
}

const AppearancePicker = lazy(() => import("./conversation-appearance-picker"));

export function ConversationAppearanceProvider({ scope, routeKey, children }: { scope: string; routeKey: string; children: ReactNode }) {
  const preferences = useUiPreferencesRuntime();
  const [editing, setEditing] = useState<{ target: Target; returnFocus: () => HTMLElement | null } | null>(null);
  useEffect(() => { setEditing(null); }, [scope, routeKey]);
  const context = useMemo(() => ({ scope, preferences, open: (target: Target, returnFocus?: () => HTMLElement | null) => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditing({ target, returnFocus: returnFocus ?? (() => trigger?.isConnected ? trigger : null) });
  } }), [scope, preferences]);
  return <Context.Provider value={context}>{children}{editing ? <Suspense fallback={null}><AppearancePicker key={conversationAppearanceKey(scope, editing.target.hostId, editing.target.threadId)}
    target={editing.target} returnFocus={editing.returnFocus} onDismiss={() => setEditing(null)} /></Suspense> : null}</Context.Provider>;
}
