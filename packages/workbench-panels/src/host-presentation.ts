import { RIGHT_PANEL_MAIN_CONTENT_RESERVE, RIGHT_PANEL_MINIMUM_WIDTH } from "./model";

/** Renderer-neutral projection. Resources, credentials and callbacks stay with the owner. */
export interface HostPanelState {
  readonly ownerId: string;
  readonly available: boolean;
  readonly open: boolean;
  readonly fullWidth: boolean;
  readonly activeTabId: string | null;
  readonly tabs: readonly { id: string; title: string; kind: string; closable: boolean; preview: boolean }[];
  readonly actions: readonly { id: string; label: string; icon: string }[];
}
export type HostPanelCommand = { readonly ownerId: string } & (
  | { readonly action: "open"; readonly open: boolean }
  | { readonly action: "select" | "close"; readonly tabId: string }
  | { readonly action: "move"; readonly tabId: string; readonly beforeTabId: string | null }
  | { readonly action: "full-width" }
  | { readonly action: "launch"; readonly actionId: string }
);
export interface HostPanelGeometry {
  readonly containerWidth: number;
  readonly panelWidth: number;
  readonly chromeHeight: number;
  readonly overlay: boolean;
}
/** Transient input to the layout owner, never a second tab/visibility store. */
export interface HostPanelGesture {
  readonly id: number;
  readonly phase: "start" | "move" | "end" | "cancel";
  readonly translationX: number;
  readonly velocityX: number;
}
export function isHostPanelGesture(value: unknown): value is HostPanelGesture {
  return object(value) && Number.isSafeInteger(value.id) && (value.id as number) > 0
    && ["start", "move", "end", "cancel"].includes(value.phase as string)
    && [value.translationX, value.velocityX].every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 100000);
}
export function hostPanelDragProgress(origin: number, translation: number, width: number): number {
  return Math.max(0, Math.min(1, origin - translation / Math.max(1, width)));
}
export function hostPanelReleaseOpen(progress: number, velocityX: number, width: number): boolean {
  return progress - velocityX * 0.12 / Math.max(1, width) >= 0.5;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024;
export function isHostPanelState(value: unknown): value is HostPanelState {
  return object(value) && text(value.ownerId)
    && ["available", "open", "fullWidth"].every(key => typeof value[key] === "boolean")
    && (value.activeTabId === null || text(value.activeTabId))
    && Array.isArray(value.tabs) && value.tabs.length <= 128
    && value.tabs.every(tab => object(tab) && text(tab.id) && typeof tab.title === "string" && tab.title.length <= 1024
      && text(tab.kind) && typeof tab.closable === "boolean" && typeof tab.preview === "boolean")
    && new Set(value.tabs.map(tab => tab.id)).size === value.tabs.length
    && (value.activeTabId === null || value.tabs.some(tab => tab.id === value.activeTabId))
    && Array.isArray(value.actions) && value.actions.length <= 24
    && value.actions.every(action => object(action) && text(action.id) && text(action.label) && text(action.icon));
}
export function isHostPanelCommand(value: unknown): value is HostPanelCommand {
  if (!object(value) || !text(value.ownerId)) return false;
  switch (value.action) {
    case "open": return typeof value.open === "boolean";
    case "full-width": return true;
    case "select": case "close": return text(value.tabId);
    case "move": return text(value.tabId) && (value.beforeTabId === null || text(value.beforeTabId));
    case "launch": return text(value.actionId);
    default: return false;
  }
}
export function isHostPanelGeometry(value: unknown): value is HostPanelGeometry {
  return object(value) && typeof value.containerWidth === "number" && Number.isFinite(value.containerWidth)
    && value.containerWidth > 0 && value.containerWidth <= 32768
    && typeof value.panelWidth === "number" && Number.isFinite(value.panelWidth)
    && value.panelWidth >= 0 && value.panelWidth <= value.containerWidth
    && typeof value.chromeHeight === "number" && Number.isFinite(value.chromeHeight)
    && value.chromeHeight >= 0 && value.chromeHeight <= 256 && typeof value.overlay === "boolean";
}
/** Revalidate against the current owner at execution time, not at wire receipt. */
export function canInvokeHostPanelCommand(state: HostPanelState, command: HostPanelCommand): boolean {
  if (!isHostPanelCommand(command) || state.ownerId !== command.ownerId || !state.available) return false;
  switch (command.action) {
    case "open": case "full-width": return true;
    case "select": return state.tabs.some(tab => tab.id === command.tabId);
    case "close": return state.tabs.some(tab => tab.id === command.tabId && tab.closable);
    case "move": return state.tabs.some(tab => tab.id === command.tabId)
      && (command.beforeTabId === null || state.tabs.some(tab => tab.id === command.beforeTabId));
    case "launch": return state.actions.some(action => action.id === command.actionId);
  }
}
export function resolveHostPanelGeometry(width: number, state: Pick<HostPanelState, "available" | "open" | "fullWidth"> | null,
  chromeHeight: number, preferredWidth?: number): HostPanelGeometry {
  const containerWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const overlay = containerWidth < RIGHT_PANEL_MINIMUM_WIDTH + RIGHT_PANEL_MAIN_CONTENT_RESERVE || state?.fullWidth === true;
  const open = state?.available === true && state.open;
  const panelWidth = !open ? 0 : overlay ? containerWidth : Math.min(containerWidth - RIGHT_PANEL_MAIN_CONTENT_RESERVE,
    Math.max(RIGHT_PANEL_MINIMUM_WIDTH, preferredWidth ?? containerWidth * 0.42));
  return { containerWidth, panelWidth, chromeHeight, overlay };
}
