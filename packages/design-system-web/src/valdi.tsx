import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { isTouchPresentation, subscribeTouchPresentation } from "./input-presentation";
import {
  ValdiWebRenderer,
  setValdiThemeColors,
  setValdiTouchDensity,
  type ColorTokens,
  type ValdiComponentConstructor,
} from "../vendor/valdi-web/valdi-web-bundle.mjs";

export {
  ActionSheet,
  AddMachineSurface,
  AgentReadinessSurface,
  AppearanceSettingsSurface,
  ArchivedThreadsSurface,
  AssetsSurface,
  AssistantsSurface,
  Banner,
  Button,
  ChatSettingsSurface,
  ConfirmDialog,
  EmptyState,
  Gallery,
  Icon,
  InboxEmptySurface,
  InboxSurface,
  MobileWelcomeSurface,
  ModelServicesSurface,
  PageControl,
  PluginsSettingsSurface,
  ProgressBar,
  RemoteAccessSettingsSurface,
  RemoteWorkbenchWelcomeSurface,
  SegmentedControl,
  SelectMenu,
  ServerConnectionSurface,
  SettingsFormRow,
  SettingsGroup,
  SettingsListItem,
  SettingsPageHeader,
  SettingsRow,
  ShortcutsSettingsSurface,
  SidebarDockSurface,
  SidebarOrbSurface,
  Slider,
  Stepper,
  TabBar,
  TextField,
  Toggle,
  TokenUsageDashboardSurface,
  TokenUsageSurface,
  ValdiWebRenderer,
  VoiceInputSettingsSurface,
  colors,
  darkColors,
  lightColors,
  radii,
  registerHapticHandler,
  setValdiThemeColors,
  setValdiTouchDensity,
  themeColors,
  triggerHaptic,
  valdiTouch,
  type ActionSheetAction,
  type AddMachineProps,
  type AgentReadinessProps,
  type AppearanceSettingsProps,
  type AppearanceThemeCardItem,
  type ArchivedThreadItem,
  type ArchivedThreadsProps,
  type AssetConnectionItem,
  type AssetEnvironmentItem,
  type AssetLibraryItem,
  type AssetTabId,
  type AssetsSurfaceProps,
  type AssistantActorCardItem,
  type AssistantPresetCardItem,
  type AssistantsSurfaceProps,
  type ChatSettingsProps,
  type ColorTokens,
  type GalleryProps,
  type HapticStyle,
  type HubMachineDirectoryItem,
  type HubThreadPreviewItem,
  type IconName,
  type InboxEmptyProps,
  type InboxGroupItem,
  type InboxMemberItem,
  type InboxSurfaceProps,
  type InboxTabId,
  type ManagedBotItem,
  type MobileWelcomeProps,
  type ModelServiceConnectionItem,
  type ModelServiceModelItem,
  type ModelServicesSurfaceProps,
  type PendingMachineSummary,
  type PluginCatalogItem,
  type PluginDetailModel,
  type PluginsSettingsProps,
  type RemoteAccessActiveShareItem,
  type RemoteAccessDirectRouteItem,
  type RemoteAccessPendingApprovalItem,
  type RemoteAccessSettingsProps,
  type RemoteWorkbenchWelcomeProps,
  type SelectMenuOption,
  type SelectMenuProps,
  type ServerConnectionProps,
  type ShortcutRowItem,
  type ShortcutsSettingsProps,
  type SidebarDockProps,
  type SidebarDockTabItem,
  type SidebarOrbProps,
  type TabBarItem,
  type TokenUsageBarItem,
  type TokenUsageDashboardProps,
  type TokenUsageDiagnosticStatItem,
  type TokenUsageGatewayRequestItem,
  type TokenUsageGatewaySection,
  type TokenUsageHeatmapCell,
  type TokenUsageHeatmapWeek,
  type TokenUsageLedgerMetricItem,
  type TokenUsageLedgerSection,
  type TokenUsageLocalSection,
  type TokenUsageMetricItem,
  type TokenUsageModelCardItem,
  type TokenUsageProps,
  type TokenUsageTableRowItem,
  type TokenUsageTurnRowItem,
  type TokenUsageWindowItem,
  type ValdiComponentConstructor,
  type VoiceInputSettingsProps,
} from "../vendor/valdi-web/valdi-web-bundle.mjs";

const VALDI_SHADOW_STYLES = `
:host {
  display: block;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  height: 100%;
  box-sizing: border-box;
  font-family: var(--font-family-ui, -apple-system, BlinkMacSystemFont, "Inter Variable", "Inter", system-ui, sans-serif);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

:host * {
  font-family: var(--font-family-ui, -apple-system, BlinkMacSystemFont, "Inter Variable", "Inter", system-ui, sans-serif) !important;
}

.oc-mono,
.oc-mono * {
  font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace) !important;
}

[role="button"],
[role="switch"],
[role="radio"],
[role="slider"] {
  cursor: pointer;
}

[role="button"][aria-disabled="true"],
[role="switch"][aria-disabled="true"],
[role="radio"][aria-disabled="true"],
[role="slider"][aria-disabled="true"] {
  cursor: default;
}

[role="button"]:focus-visible,
[role="radio"]:focus-visible {
  border-radius: 8px;
  outline: 2px solid var(--color-border-focus, rgba(48, 48, 48, 0.62));
  outline-offset: -3px;
}

[role="switch"]:focus-visible .oc-toggle-track {
  outline: 2px solid var(--color-border-focus, rgba(48, 48, 48, 0.62));
  outline-offset: 2px;
}

[role="slider"]:focus-visible {
  border-radius: 8px;
  outline: 2px solid var(--color-border-focus, rgba(48, 48, 48, 0.62));
  outline-offset: 2px;
}

.oc-pill-button:focus-visible {
  border-radius: inherit;
}

input:focus-visible {
  border-radius: 8px;
  outline: 2px solid var(--color-border-focus, rgba(48, 48, 48, 0.62));
  outline-offset: -2px;
}

:host-context(:root[data-touch-interaction]) :focus-visible,
:host-context(dialog[data-opened-by-pointer="true"]) :focus-visible,
:host-context(:root[data-pointer-focus]) :is([role="button"], [role="switch"], [role="radio"], [role="slider"]):focus-visible,
:host-context(:root[data-pointer-focus]) [role="switch"]:focus-visible .oc-toggle-track {
  outline: none !important;
  box-shadow: none !important;
}

input {
  min-width: 0;
  caret-color: var(--color-text-accent, var(--color-text, currentColor));
}

.oc-liquid-glass {
  background: linear-gradient(
    168deg,
    color-mix(in srgb, var(--color-background-elevated-primary-opaque, #ffffff) 82%, transparent),
    color-mix(in srgb, var(--color-surface, #ffffff) 60%, transparent) 56%,
    color-mix(in srgb, var(--color-background-panel, #f7f7f7) 74%, transparent)
  ) !important;
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.72),
    inset 0 0 0 0.5px var(--color-border-default, rgb(48 48 48 / 0.08)),
    0 8px 24px -8px color-mix(in srgb, var(--color-text, #303030) 12%, transparent);
  -webkit-backdrop-filter: blur(24px) saturate(132%);
  backdrop-filter: blur(24px) saturate(132%);
}

.oc-liquid-glass.oc-dark {
  background: linear-gradient(
    168deg,
    color-mix(in srgb, var(--color-background-elevated-primary-opaque, #2b2b2b) 80%, transparent),
    color-mix(in srgb, var(--color-surface, #202020) 62%, transparent) 56%,
    color-mix(in srgb, var(--color-background-panel, #242424) 74%, transparent)
  ) !important;
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.10),
    inset 0 0 0 0.5px var(--color-border-default, rgb(237 237 237 / 0.10)),
    0 12px 30px -8px rgb(0 0 0 / 0.40);
}

.oc-settings-group {
  -webkit-backdrop-filter: var(--material-card-filter, none);
  backdrop-filter: var(--material-card-filter, none);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.02);
}

.oc-apple-sheet {
  border-radius: 26px !important;
  box-shadow:
    0 24px 64px -14px rgb(0 0 0 / 0.08),
    0 4px 16px -2px rgb(0 0 0 / 0.035);
}

.oc-apple-sheet.oc-dark {
  border-radius: 26px !important;
  box-shadow:
    0 28px 72px -12px rgb(0 0 0 / 0.65),
    0 6px 20px -2px rgb(0 0 0 / 0.42);
}

.oc-apple-emblem {
  border-radius: 16px !important;
  box-shadow: 0 6px 16px -4px rgb(0 0 0 / 0.07);
}

.oc-apple-emblem.oc-dark {
  border-radius: 16px !important;
  box-shadow: 0 8px 20px -4px rgb(0 0 0 / 0.48);
}

.oc-apple-capsule,
.oc-apple-input-capsule,
.oc-apple-input-capsule .oc-pill-button {
  border-radius: 999px !important;
}

.oc-apple-input-capsule input,
.oc-apple-input-capsule input:focus,
.oc-apple-input-capsule input:focus-visible {
  outline: none !important;
  box-shadow: none !important;
}

:host-context(:root:not([data-touch-interaction])) .oc-apple-input-capsule:has(input:focus-visible) {
  outline: 1.5px solid var(--color-border-focus, rgb(29 29 31 / 0.28));
  outline-offset: -1.5px;
}

:host-context(:root:not([data-touch-interaction])) .oc-apple-sheet.oc-dark .oc-apple-input-capsule:has(input:focus-visible) {
  outline: 1.5px solid var(--color-border-focus, rgb(245 245 247 / 0.34));
  outline-offset: -1.5px;
}

@media (forced-colors: active) {
  .oc-apple-input-capsule:has(input:focus-visible) {
    outline: 1.5px solid Highlight !important;
    outline-offset: -1.5px;
  }
}

.oc-cold-skeleton {
  opacity: 0;
  animation: oc-cold-skeleton-fade 160ms ease 150ms forwards;
}

@keyframes oc-cold-skeleton-fade {
  to {
    opacity: 1;
  }
}

.oc-ghost-button,
.oc-dock-item,
.oc-pill-button,
.oc-settings-row {
  transition: background-color 140ms ease, opacity 110ms ease;
}

.oc-pill-button:active:not([aria-disabled="true"]) {
  opacity: 0.86;
}

@media (prefers-reduced-motion: reduce) {
  .oc-ghost-button,
  .oc-dock-item,
  .oc-pill-button,
  .oc-settings-row {
    transition: none !important;
  }
}

.oc-dock-thumb {
  pointer-events: none;
}

.oc-dock-item {
  border-radius: 9px;
}

:host-context(:root[data-ui-density="touch"]) .oc-dock-item {
  border-radius: 11px;
}

.oc-dock-item:focus-visible {
  border-radius: 9px;
}

.oc-dock-item:active:not([aria-disabled="true"]) {
  background-color: var(--color-background-navigation-pressed, rgb(48 48 48 / 0.10)) !important;
}

.oc-ghost-button {
  border-radius: 7px;
}

.oc-ghost-button:focus-visible {
  border-radius: 7px;
}

.oc-ghost-button:active:not([aria-disabled="true"]) {
  background-color: var(--color-background-navigation-pressed, rgb(48 48 48 / 0.10)) !important;
}

.oc-settings-row {
  border-radius: 10px;
}

.oc-settings-row:active:not([aria-disabled="true"]) {
  background-color: var(--color-background-navigation-pressed, rgb(48 48 48 / 0.10)) !important;
}

@media (any-hover: hover) and (any-pointer: fine) {
  :host-context(:root:not([data-touch-interaction])) .oc-pill-button:hover:not([aria-disabled="true"]) {
    filter: brightness(1.02);
  }

  :host-context(:root:not([data-touch-interaction])) .oc-dock-item:hover:not([aria-disabled="true"]):not([aria-pressed="true"]) {
    background-color: var(--color-background-navigation-hover, rgb(48 48 48 / 0.055)) !important;
  }

  :host-context(:root:not([data-touch-interaction])) .oc-ghost-button:hover:not([aria-disabled="true"]) {
    background-color: var(--color-background-button-tertiary-hover, rgb(48 48 48 / 0.06)) !important;
  }

  :host-context(:root:not([data-touch-interaction])) .oc-settings-row:hover:not([aria-disabled="true"]) {
    background-color: var(--color-background-navigation-hover, rgb(48 48 48 / 0.055)) !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  .oc-ghost-button,
  .oc-dock-item,
  .oc-settings-row,
  .oc-segment-thumb,
  .oc-tab-indicator {
    transition: none !important;
  }
}

@media (forced-colors: active) {
  .oc-segment-option[aria-checked="true"],
  .oc-dock-item[aria-pressed="true"],
  [role="switch"][aria-checked="true"] .oc-toggle-track {
    outline: 1px solid Highlight;
    outline-offset: -1px;
  }
}

.oc-segment-thumb,
.oc-slider-knob {
  pointer-events: none;
}

.oc-segment-track,
.oc-slider-track {
  touch-action: pan-y;
}

.oc-slider-track {
  cursor: pointer;
}

.oc-segment-options .oc-segment-thumb {
  left: 0 !important;
  translate: calc(var(--oc-drag-index, var(--oc-segment-index, 0)) * 100%) 0;
}

.oc-segment-thumb::after {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  content: '';
  background: linear-gradient(
    170deg,
    color-mix(in srgb, var(--color-background-elevated-primary-opaque, #ffffff) 64%, transparent),
    color-mix(in srgb, var(--color-surface, #ffffff) 14%, transparent) 58%,
    color-mix(in srgb, var(--color-background-panel, #f7f7f7) 40%, transparent)
  );
  box-shadow:
    inset 0 1px 1px rgb(255 255 255 / 0.55),
    inset 0 -0.5px 1px color-mix(in srgb, var(--color-text, #303030) 12%, transparent);
  -webkit-backdrop-filter: blur(6px) saturate(118%);
  backdrop-filter: blur(6px) saturate(118%);
  opacity: 0;
}

.oc-segment-track[data-oc-pressing] .oc-segment-thumb {
  opacity: 0.88 !important;
}

.oc-segment-track[data-oc-pressing] .oc-segment-thumb::after {
  opacity: 1;
}

.oc-example-toolbar {
  background: linear-gradient(
    color-mix(in srgb, var(--color-background-surface-under, #f7f7f7) 94%, transparent) 10%,
    color-mix(in srgb, var(--color-background-surface-under, #f7f7f7) 74%, transparent) 85%,
    transparent
  );
  -webkit-backdrop-filter: blur(14px) saturate(124%);
  backdrop-filter: blur(14px) saturate(124%);
}

.oc-example-toolbar.oc-dark {
  background: linear-gradient(
    color-mix(in srgb, var(--color-background-surface-under, #181818) 94%, transparent) 10%,
    color-mix(in srgb, var(--color-background-surface-under, #181818) 74%, transparent) 85%,
    transparent
  );
}

.oc-example-back {
  filter: drop-shadow(0 2px 3px rgb(24 24 28 / 0.08));
}

[role="dialog"] {
  -webkit-backdrop-filter: blur(20px) saturate(125%);
  backdrop-filter: blur(20px) saturate(125%);
}

@media (prefers-reduced-motion: no-preference) {
  .oc-segment-thumb {
    transition: translate 220ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 140ms ease;
  }

  .oc-segment-thumb::after {
    transition: opacity 140ms ease;
  }

  .oc-segment-track[data-oc-dragging] .oc-segment-thumb {
    transition: opacity 140ms ease;
  }

  .oc-tab-indicator {
    transition: left 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
}

@media (prefers-reduced-transparency: reduce) {
  .oc-liquid-glass {
    background: var(--color-background-elevated-primary-opaque, #f7f7f7) !important;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }

  .oc-liquid-glass.oc-dark {
    background: var(--color-background-elevated-primary-opaque, #242424) !important;
  }

  .oc-example-toolbar {
    background: var(--color-background-surface-under, #f7f7f7);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }

  .oc-example-toolbar.oc-dark {
    background: var(--color-background-surface-under, #181818);
  }

  .oc-segment-track[data-oc-pressing] .oc-segment-thumb {
    opacity: 1 !important;
  }

  .oc-segment-thumb::after {
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}
`;

const ACTION_SELECTOR = '[aria-roledescription="button"]';
const SWITCH_SELECTOR = '.oc-switch, [aria-roledescription="checkbox"]';
const SLIDER_SELECTOR = '.oc-slider-track, [aria-roledescription="adjustable"]';
const INTERACTIVE_SELECTOR = '[role="button"], [role="switch"], [role="radio"], [role="slider"]';
const DIALOG_SELECTOR =
  '#remove-dialog, #preview-delete-dialog, #gallery-sheet, #welcome-actionsheet, [id$="-modal-dialog"], [id$="-action-sheet"]';

function setAttrIfChanged(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

function removeAttrIfPresent(element: Element, name: string): void {
  if (element.hasAttribute(name)) {
    element.removeAttribute(name);
  }
}

function setTabIndexIfChanged(element: HTMLElement, next: number): void {
  const nextStr = String(next);
  if (element.getAttribute("tabindex") !== nextStr) {
    element.setAttribute("tabindex", nextStr);
  }
}

interface SegmentDragGesture {
  readonly track: HTMLElement;
  readonly options: readonly HTMLElement[];
  readonly left: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
  readonly pointer: number;
  dragging: boolean;
}

/**
 * Attaches Shadow DOM focus styles, ARIA button/switch/radio/slider/dialog semantics,
 * roving tabIndex + arrow-key navigation, and smooth pointer-drag scrubbing.
 */
export function attachValdiWebEnhancements(root: ShadowRoot): () => void {
  const styleEl = document.createElement("style");
  styleEl.setAttribute("data-opencraft-valdi-styles", "");
  styleEl.textContent = VALDI_SHADOW_STYLES;
  root.append(styleEl);

  let openDialog: HTMLElement | null = null;
  let openDialogId: string | null = null;
  let returnFocus: HTMLElement | null = null;
  let gesture: SegmentDragGesture | undefined;
  let syncScheduled = false;
  let disposed = false;

  const synchronize = () => {
    syncScheduled = false;
    if (disposed) return;

    for (const element of Array.from(root.querySelectorAll<HTMLElement>(ACTION_SELECTOR))) {
      const isSegmentOption = element.classList.contains("oc-segment-option");
      setAttrIfChanged(element, "role", isSegmentOption ? "radio" : "button");
      if (!isSegmentOption && !element.classList.contains("oc-dock-item")) {
        setTabIndexIfChanged(element, element.getAttribute("aria-disabled") === "true" ? -1 : 0);
      }
      if (element.hasAttribute("aria-selected")) {
        const selectedVal = element.getAttribute("aria-selected") ?? "false";
        setAttrIfChanged(element, isSegmentOption ? "aria-checked" : "aria-pressed", selectedVal);
        removeAttrIfPresent(element, "aria-selected");
      }
    }

    for (const sw of Array.from(root.querySelectorAll<HTMLElement>(SWITCH_SELECTOR))) {
      setAttrIfChanged(sw, "role", "switch");
      setTabIndexIfChanged(sw, sw.getAttribute("aria-disabled") === "true" ? -1 : 0);
      if (sw.hasAttribute("aria-selected")) {
        setAttrIfChanged(sw, "aria-checked", sw.getAttribute("aria-selected") ?? "false");
        removeAttrIfPresent(sw, "aria-selected");
      }
    }

    for (const slider of Array.from(root.querySelectorAll<HTMLElement>(SLIDER_SELECTOR))) {
      setAttrIfChanged(slider, "role", "slider");
      setTabIndexIfChanged(slider, slider.getAttribute("aria-disabled") === "true" ? -1 : 0);
    }

    for (const track of Array.from(root.querySelectorAll<HTMLElement>(".oc-segment-track"))) {
      setAttrIfChanged(track, "role", "radiogroup");
      const options = Array.from(track.querySelectorAll<HTMLElement>(".oc-segment-option"));
      const selected = options.findIndex((option) => option.getAttribute("aria-checked") === "true");
      const focusIdx =
        selected >= 0 && options[selected]?.getAttribute("aria-disabled") !== "true"
          ? selected
          : options.findIndex((option) => option.getAttribute("aria-disabled") !== "true");
      options.forEach((option, idx) => {
        setTabIndexIfChanged(option, idx === focusIdx ? 0 : -1);
      });
      if (selected >= 0) {
        const nextVal = String(selected);
        if (track.style.getPropertyValue("--oc-segment-index") !== nextVal) {
          track.style.setProperty("--oc-segment-index", nextVal);
        }
      } else if (track.style.getPropertyValue("--oc-segment-index")) {
        track.style.removeProperty("--oc-segment-index");
      }
    }

    for (const menu of Array.from(root.querySelectorAll<HTMLElement>(".oc-select-menu"))) {
      const trigger = menu.parentElement?.querySelector<HTMLElement>(".oc-select-trigger");
      const menuRect = menu.getBoundingClientRect();
      if (menuRect.height > 0 && menuRect.bottom > window.innerHeight - 16) {
        const triggerRect = trigger?.getBoundingClientRect();
        const triggerH = trigger?.offsetHeight || 30;
        menu.style.top = "auto";
        menu.style.bottom = `${triggerH + 6}px`;
        menu.style.maxHeight = `${Math.max(140, (triggerRect?.top ?? 240) - 16)}px`;
        menu.style.overflowY = "auto";
      }
    }

    for (const dock of Array.from(root.querySelectorAll<HTMLElement>(".oc-dock-track"))) {
      setAttrIfChanged(dock, "role", "toolbar");
      const items = Array.from(dock.querySelectorAll<HTMLElement>(".oc-dock-item"));
      const activeIdx = items.findIndex((item) => item.getAttribute("aria-pressed") === "true");
      const focusIdx =
        activeIdx >= 0 && items[activeIdx]?.getAttribute("aria-disabled") !== "true"
          ? activeIdx
          : items.findIndex((item) => item.getAttribute("aria-disabled") !== "true");
      items.forEach((item, idx) => {
        setTabIndexIfChanged(item, idx === focusIdx ? 0 : -1);
      });
    }

    for (const input of Array.from(root.querySelectorAll<HTMLInputElement>("input[id]"))) {
      const id = input.id;
      const error = root.getElementById(`${id}-error`);
      const description = error ?? root.getElementById(`${id}-hint`);
      setAttrIfChanged(input, "aria-invalid", String(Boolean(error)));
      if (description) setAttrIfChanged(input, "aria-describedby", description.id);
      else removeAttrIfPresent(input, "aria-describedby");
    }

    const dialog = root.querySelector<HTMLElement>(DIALOG_SELECTOR);
    if (dialog === openDialog) return;

    const content = root.getElementById("style-lab-content") as (HTMLElement & { inert?: boolean }) | null;
    const toolbar = root.getElementById("example-toolbar") as (HTMLElement & { inert?: boolean }) | null;
    if (toolbar) toolbar.inert = Boolean(dialog);

    if (dialog) {
      openDialogId = dialog.id;
      returnFocus = root.activeElement instanceof HTMLElement ? root.activeElement : null;
      setAttrIfChanged(dialog, "role", "dialog");
      setAttrIfChanged(dialog, "aria-modal", "true");
      const msgEl = root.getElementById(`${dialog.id}-message`);
      if (msgEl) setAttrIfChanged(dialog, "aria-describedby", msgEl.id);
      if (content) content.inert = true;
      (root.getElementById(`${dialog.id}-cancel`) as HTMLElement | null)?.focus({ preventScroll: true });
    } else {
      if (content) content.inert = false;
      const fallback = root.getElementById("restore-project");
      const target = returnFocus?.isConnected ? returnFocus : fallback;
      target?.focus({ preventScroll: true });
      returnFocus = null;
      openDialogId = null;
    }
    openDialog = dialog;
  };

  const scheduleSynchronize = () => {
    if (syncScheduled || disposed) return;
    syncScheduled = true;
    queueMicrotask(synchronize);
  };

  const observer = new MutationObserver(scheduleSynchronize);
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["id", "aria-selected", "aria-disabled", "aria-roledescription"],
  });
  synchronize();

  const controller = new AbortController();
  const { signal } = controller;

  root.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const clear = target?.closest<HTMLElement>('[id$="-clear"]');
      if (clear) {
        (root.getElementById(clear.id.slice(0, -6)) as HTMLElement | null)?.focus({ preventScroll: true });
      }
    },
    { capture: true, signal },
  );

  root.addEventListener(
    "keydown",
    (rawEvent) => {
      const event = rawEvent as KeyboardEvent;
      if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) {
        event.stopPropagation();
        return;
      }
      if (openDialog && event.key === "Escape") {
        event.preventDefault();
        if (openDialogId) {
          (root.getElementById(`${openDialogId}-cancel`) as HTMLElement | null)?.click();
        }
        return;
      }
      if (openDialog && event.key === "Tab") {
        const focusables = Array.from(openDialog.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)).filter(
          (el) => el.tabIndex === 0,
        );
        if (focusables.length > 0) {
          const active = root.activeElement instanceof HTMLElement ? root.activeElement : null;
          const current = active ? focusables.indexOf(active) : -1;
          const next = (current + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
          event.preventDefault();
          focusables[next]?.focus();
        }
        return;
      }

      const target = event.target instanceof Element ? event.target : null;

      // Roving radiogroup / toolbar arrow-key navigation (SegmentedControl + SidebarDock)
      if (
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
      ) {
        // Open SelectMenu keyboard navigation (ArrowUp/ArrowDown/Home/End)
        const openMenu = root.querySelector<HTMLElement>(".oc-select-menu");
        if (
          openMenu &&
          (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End")
        ) {
          const items = Array.from(openMenu.querySelectorAll<HTMLElement>('[role="button"]')).filter(
            (el) => el.getAttribute("aria-disabled") !== "true",
          );
          if (items.length > 0) {
            event.preventDefault();
            event.stopPropagation();
            const active = (
              root.activeElement instanceof HTMLElement ? root.activeElement : null
            )?.closest<HTMLElement>('[role="button"]');
            const currentIdx = active ? items.indexOf(active) : -1;
            const nextIdx =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : event.key === "ArrowUp"
                    ? currentIdx <= 0
                      ? items.length - 1
                      : currentIdx - 1
                    : (currentIdx + 1) % items.length;
            items[nextIdx]?.focus({ preventScroll: true });
            return;
          }
        }

        const group = target?.closest<HTMLElement>(".oc-segment-track, .oc-dock-track");
        if (group) {
          const selector = group.classList.contains("oc-segment-track") ? ".oc-segment-option" : ".oc-dock-item";
          const items = Array.from(group.querySelectorAll<HTMLElement>(selector)).filter(
            (el) => el.getAttribute("aria-disabled") !== "true",
          );
          const active = root.activeElement instanceof HTMLElement ? root.activeElement : null;
          const index = active ? items.indexOf(active) : -1;
          if (index >= 0 && items.length > 0) {
            event.preventDefault();
            const rtl = getComputedStyle(group).direction === "rtl";
            const isPrev = event.key === "ArrowUp" || event.key === (rtl ? "ArrowRight" : "ArrowLeft");
            const nextIdx =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (index + (isPrev ? -1 : 1) + items.length) % items.length;
            const nextEl = items[nextIdx]!;
            items.forEach((el, idx) => setTabIndexIfChanged(el, idx === nextIdx ? 0 : -1));
            nextEl.focus({ preventScroll: true });
            if (group.classList.contains("oc-segment-track")) {
              nextEl.click();
            }
            return;
          }
        }

        // Slider keyboard stepping (ArrowLeft/Right/Up/Down/Home/End)
        const slider = target?.closest<HTMLElement>('[role="slider"]');
        if (slider && slider.getAttribute("aria-disabled") !== "true") {
          const rect = slider.getBoundingClientRect();
          const knob = slider.querySelector<HTMLElement>(".oc-slider-knob");
          if (rect.width > 0 && knob) {
            event.preventDefault();
            const knobW = knob.getBoundingClientRect().width || 18;
            const usable = Math.max(1, rect.width - knobW);
            const currentRatio = Math.max(0, Math.min(1, knob.offsetLeft / usable));
            const rtl = getComputedStyle(slider).direction === "rtl";
            const dec = event.key === "ArrowDown" || event.key === (rtl ? "ArrowRight" : "ArrowLeft");
            const nextRatio =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? 1
                  : Math.max(0, Math.min(1, currentRatio + (dec ? -0.05 : 0.05)));
            const clientX = rect.left + knobW / 2 + nextRatio * usable;
            const clientY = rect.top + rect.height / 2;
            slider.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX, clientY }));
            return;
          }
        }
      }

      if (event.key === "Escape") {
        const openMenu = root.querySelector<HTMLElement>(".oc-select-menu");
        if (openMenu) {
          const trigger = openMenu.parentElement?.querySelector<HTMLElement>(".oc-select-trigger");
          if (trigger) {
            event.preventDefault();
            event.stopPropagation();
            trigger.click();
            trigger.focus({ preventScroll: true });
            return;
          }
        }
        if (target instanceof HTMLInputElement && target.value.length > 0) {
          const clearBtn = target.parentElement?.parentElement?.querySelector<HTMLElement>('[id$="-clear"]');
          if (clearBtn) {
            event.preventDefault();
            clearBtn.click();
            return;
          }
        }
      }

      if (event.key !== "Enter" && event.key !== " ") return;
      const control = target?.closest<HTMLElement>('[role="button"], [role="switch"], [role="radio"]');
      if (!control || control.getAttribute("aria-disabled") === "true" || event.repeat) return;
      event.preventDefault();
      control.click();
    },
    { capture: true, signal },
  );

  const resetGesture = (active: SegmentDragGesture) => {
    active.track.removeAttribute("data-oc-pressing");
    active.track.removeAttribute("data-oc-dragging");
    active.track.style.removeProperty("--oc-drag-index");
    gesture = undefined;
  };

  const resolveDragPosition = (active: SegmentDragGesture, clientX: number): number =>
    Math.max(0, Math.min(active.options.length - 1, (clientX - active.left) / active.width - 0.5));

  root.addEventListener(
    "pointerdown",
    (rawEvent) => {
      const event = rawEvent as PointerEvent;
      const target = event.target instanceof Element ? event.target : null;
      const option = target?.closest<HTMLElement>(".oc-segment-option");
      if (
        gesture ||
        !event.isPrimary ||
        event.button !== 0 ||
        !option ||
        option.getAttribute("aria-disabled") === "true"
      ) {
        return;
      }
      const track = option.closest<HTMLElement>(".oc-segment-track");
      const row = track?.querySelector<HTMLElement>(".oc-segment-options");
      if (!track || !row) return;
      const options = Array.from(row.querySelectorAll<HTMLElement>(".oc-segment-option"));
      if (options.length < 2) return;
      const rect = row.getBoundingClientRect();
      if (rect.width === 0) return;
      gesture = {
        track,
        options,
        left: rect.left,
        width: rect.width / options.length,
        x: event.clientX,
        y: event.clientY,
        pointer: event.pointerId,
        dragging: false,
      };
      track.setAttribute("data-oc-pressing", "");
    },
    { signal },
  );

  root.addEventListener(
    "pointermove",
    (rawEvent) => {
      const event = rawEvent as PointerEvent;
      const active = gesture;
      if (!active || active.pointer !== event.pointerId) return;
      if (!active.dragging) {
        const horizontal = Math.abs(event.clientX - active.x);
        const vertical = Math.abs(event.clientY - active.y);
        if (vertical > 8 && vertical > horizontal) {
          resetGesture(active);
          return;
        }
        if (horizontal < 8 || horizontal < vertical) return;
        active.dragging = true;
        active.track.setPointerCapture(event.pointerId);
        active.track.setAttribute("data-oc-dragging", "");
      }
      active.track.style.setProperty("--oc-drag-index", String(resolveDragPosition(active, event.clientX)));
    },
    { signal },
  );

  root.addEventListener(
    "pointerup",
    (rawEvent) => {
      const event = rawEvent as PointerEvent;
      const active = gesture;
      if (!active || active.pointer !== event.pointerId) return;
      const chosen = active.dragging
        ? active.options[Math.round(resolveDragPosition(active, event.clientX))]
        : undefined;
      resetGesture(active);
      if (chosen && chosen.getAttribute("aria-disabled") !== "true") chosen.click();
    },
    { signal },
  );

  document.addEventListener(
    "pointerdown",
    (rawEvent) => {
      const openMenus = Array.from(root.querySelectorAll<HTMLElement>(".oc-select-menu"));
      if (openMenus.length === 0) return;
      const path = typeof rawEvent.composedPath === "function" ? rawEvent.composedPath() : [];
      for (const menu of openMenus) {
        const trigger = menu.parentElement?.querySelector<HTMLElement>(".oc-select-trigger");
        if (path.includes(menu) || (trigger && path.includes(trigger))) continue;
        trigger?.click();
      }
    },
    { capture: true, signal },
  );

  for (const eventName of ["pointercancel", "lostpointercapture"] as const) {
    root.addEventListener(
      eventName,
      (rawEvent) => {
        const event = rawEvent as PointerEvent;
        if (!gesture || gesture.pointer !== event.pointerId) return;
        if (eventName === "lostpointercapture" && event.target !== gesture.track) return;
        resetGesture(gesture);
      },
      { signal },
    );
  }

  return () => {
    disposed = true;
    controller.abort();
    observer.disconnect();
    styleEl.remove();
  };
}

/** Optional host tactile hook; native containers attach CoreHaptics separately. */
export function triggerBrowserHaptic(_style: string): void {
  // Safari/iOS WebKit omit Web Vibration; native haptics route via mobile-valdi-bridge.
}

export interface ValdiSurfaceProps<TViewModel extends object> {
  readonly component: ValdiComponentConstructor<TViewModel>;
  readonly viewModel: TViewModel;
  readonly componentProps?: Record<string, unknown>;
  readonly context?: Record<string, unknown>;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly "data-testid"?: string;
}

const EMPTY_RECORD: Record<string, unknown> = {};

const activeThemeListeners = new Set<() => void>();
let hostThemeObserver: MutationObserver | null = null;
let lastThemeSignature = "";
let colorProbeContainer: HTMLDivElement | null = null;
const colorProbeSpans = new Map<string, HTMLSpanElement>();

function formatByteHex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0");
}

function parseRgbStringToValdi(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const r = trimmed[1]!;
    const g = trimmed[2]!;
    const b = trimmed[3]!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const commaMatch = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+%?))?\s*\)$/i.exec(trimmed);
  if (commaMatch) {
    const r = Math.round(Number(commaMatch[1]));
    const g = Math.round(Number(commaMatch[2]));
    const b = Math.round(Number(commaMatch[3]));
    const alphaRaw = commaMatch[4];
    if (alphaRaw === undefined) return `#${formatByteHex(r)}${formatByteHex(g)}${formatByteHex(b)}`;
    const a = alphaRaw.endsWith("%") ? Number(alphaRaw.slice(0, -1)) / 100 : Number(alphaRaw);
    return a >= 0.999
      ? `#${formatByteHex(r)}${formatByteHex(g)}${formatByteHex(b)}`
      : `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
  }
  const spaceMatch = /^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i.exec(trimmed);
  if (spaceMatch) {
    const r = Math.round(Number(spaceMatch[1]));
    const g = Math.round(Number(spaceMatch[2]));
    const b = Math.round(Number(spaceMatch[3]));
    const alphaRaw = spaceMatch[4];
    if (alphaRaw === undefined) return `#${formatByteHex(r)}${formatByteHex(g)}${formatByteHex(b)}`;
    const a = alphaRaw.endsWith("%") ? Number(alphaRaw.slice(0, -1)) / 100 : Number(alphaRaw);
    return a >= 0.999
      ? `#${formatByteHex(r)}${formatByteHex(g)}${formatByteHex(b)}`
      : `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
  }
  const srgbMatch = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i.exec(trimmed);
  if (srgbMatch) {
    const r = Math.round(Number(srgbMatch[1]) * 255);
    const g = Math.round(Number(srgbMatch[2]) * 255);
    const b = Math.round(Number(srgbMatch[3]) * 255);
    const alphaRaw = srgbMatch[4];
    if (alphaRaw === undefined) return `#${formatByteHex(r)}${formatByteHex(g)}${formatByteHex(b)}`;
    const a = alphaRaw.endsWith("%") ? Number(alphaRaw.slice(0, -1)) / 100 : Number(alphaRaw);
    return a >= 0.999
      ? `#${formatByteHex(r)}${formatByteHex(g)}${formatByteHex(b)}`
      : `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
  }
  return undefined;
}

function ensureProbeSpan(varName: string): HTMLSpanElement {
  if (!colorProbeContainer || !colorProbeContainer.isConnected) {
    colorProbeContainer = document.createElement("div");
    colorProbeContainer.setAttribute("aria-hidden", "true");
    colorProbeContainer.style.cssText =
      "position:fixed;width:0;height:0;overflow:hidden;pointer-events:none;visibility:hidden;contain:strict;";
    colorProbeSpans.clear();
    document.body.append(colorProbeContainer);
  }
  let span = colorProbeSpans.get(varName);
  if (!span) {
    span = document.createElement("span");
    span.style.color = `var(${varName})`;
    colorProbeContainer.append(span);
    colorProbeSpans.set(varName, span);
  }
  return span;
}

function resolveCssVarColorsBatch(styles: CSSStyleDeclaration, varNames: readonly string[]): Map<string, string> {
  const resolved = new Map<string, string>();
  const pendingSpans: Array<[string, HTMLSpanElement]> = [];

  for (const varName of varNames) {
    if (resolved.has(varName)) continue;
    const raw = styles.getPropertyValue(varName).trim();
    if (!raw) continue;
    const direct = parseRgbStringToValdi(raw);
    if (direct) {
      resolved.set(varName, direct);
    } else if (typeof document !== "undefined" && document.body) {
      pendingSpans.push([varName, ensureProbeSpan(varName)]);
    }
  }

  for (const [varName, span] of pendingSpans) {
    const parsed = parseRgbStringToValdi(getComputedStyle(span).color);
    if (parsed) resolved.set(varName, parsed);
  }

  return resolved;
}

const THEME_CSS_VAR_CANDIDATES = [
  "--color-background-surface-under",
  "--color-background-panel",
  "--material-settings-background",
  "--material-optics-settings",
  "--color-background-elevated-primary-opaque",
  "--color-surface",
  "--color-background-input",
  "--color-surface-secondary",
  "--color-border-default",
  "--color-border",
  "--color-text",
  "--opencraft-base-ink",
  "--color-text-secondary",
  "--color-text-tertiary",
  "--color-accent-blue",
  "--color-text-accent",
  "--opencraft-base-accent",
  "--color-text-on-accent",
  "--color-background-accent",
  "--color-background-button-primary",
  "--color-text-button-primary",
  "--color-background-navigation-current",
  "--color-background-button-secondary-active",
  "--color-background-button-secondary",
  "--color-border-strong",
  "--color-badge-blue-foreground",
  "--color-badge-blue-background",
  "--color-status-success",
  "--color-badge-green-foreground",
  "--color-badge-green-background",
  "--color-text-warning",
  "--color-badge-orange-foreground",
  "--color-badge-orange-background",
  "--color-text-danger",
  "--color-badge-red-foreground",
  "--color-badge-red-background",
  "--color-accent-purple",
  "--color-badge-purple-foreground",
  "--color-badge-purple-background",
  "--color-background-navigation-hover",
  "--color-border-subtle",
  "--color-dialog-scrim",
  "--color-background-elevated-primary",
] as const;

function syncValdiHostTheme(force = false): boolean {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return false;
  const root = document.documentElement;
  if (!root) return false;
  const themeAttr = root.getAttribute("data-theme") ?? "";
  const themeIdAttr = root.getAttribute("data-theme-id") ?? "";
  const styleAttr = root.getAttribute("style") ?? "";
  const touchDensity = isTouchPresentation(document);
  setValdiTouchDensity(touchDensity);
  const signature = `${themeAttr}|${themeIdAttr}|${touchDensity ? "touch" : "compact"}|${styleAttr}`;
  if (!force && signature === lastThemeSignature) return false;
  lastThemeSignature = signature;

  const styles = getComputedStyle(root);
  const isDark = themeAttr === "dark" || styles.colorScheme === "dark";
  const mode: "light" | "dark" = isDark ? "dark" : "light";
  const resolvedMap = resolveCssVarColorsBatch(styles, THEME_CSS_VAR_CANDIDATES);

  const pick = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = resolvedMap.get(name);
      if (value) return value;
    }
    return undefined;
  };

  const patch: Partial<ColorTokens> = {};
  const assign = <K extends keyof ColorTokens>(key: K, value: string | undefined) => {
    if (value) patch[key] = value;
  };

  assign("canvas", pick("--color-background-surface-under", "--color-background-panel"));
  assign(
    "surface",
    pick(
      "--material-settings-background",
      "--material-optics-settings",
      "--color-background-panel",
      "--color-background-elevated-primary-opaque",
      "--color-surface",
    ),
  );
  assign("recessed", pick("--color-background-input", "--color-surface-secondary"));
  assign("border", pick("--color-border-default", "--color-border"));
  assign("ink", pick("--color-text", "--opencraft-base-ink"));
  assign("muted", pick("--color-text-secondary"));
  assign("disabled", pick("--color-text-tertiary"));
  const accent = pick("--color-accent-blue", "--color-text-accent", "--opencraft-base-accent");
  assign("accent", accent);
  assign("accentForeground", pick("--color-text-on-accent"));
  assign("accentSoft", pick("--color-background-accent"));
  assign("primaryButton", pick("--color-background-button-primary"));
  assign("primaryButtonForeground", pick("--color-text-button-primary"));
  assign("toggleOn", accent);
  assign(
    "segmentThumb",
    isDark
      ? pick("--color-background-navigation-current", "--color-background-button-secondary-active")
      : pick("--color-background-elevated-primary-opaque", "--color-surface"),
  );
  assign("navCurrent", pick("--color-background-navigation-current", "--color-background-button-secondary"));
  assign("trackOff", pick("--color-border-strong", "--color-border-default"));
  assign("info", pick("--color-badge-blue-foreground", "--color-text-accent"));
  assign("infoSurface", pick("--color-badge-blue-background", "--color-background-accent"));
  assign("success", pick("--color-status-success", "--color-badge-green-foreground"));
  assign("successSurface", pick("--color-badge-green-background"));
  assign("warning", pick("--color-text-warning", "--color-badge-orange-foreground"));
  assign("warningSurface", pick("--color-badge-orange-background"));
  assign("danger", pick("--color-text-danger", "--color-badge-red-foreground"));
  assign("dangerSurface", pick("--color-badge-red-background"));
  assign("skill", pick("--color-accent-purple", "--color-badge-purple-foreground"));
  assign("skillSurface", pick("--color-badge-purple-background"));
  assign("trackSoft", pick("--color-background-button-secondary"));
  assign("trackSubtle", pick("--color-background-navigation-hover"));
  assign("glassBorder", pick("--color-border-default", "--color-border-subtle"));
  assign("overlay", pick("--color-dialog-scrim"));
  assign("alert", pick("--color-background-elevated-primary", "--color-background-elevated-primary-opaque"));

  if (Object.keys(patch).length > 0) {
    setValdiThemeColors(mode, patch);
  }
  return true;
}

let unsubscribeTouchDensity: (() => void) | null = null;

function subscribeValdiHostTheme(listener: () => void): () => void {
  activeThemeListeners.add(listener);
  if (
    !hostThemeObserver &&
    typeof MutationObserver !== "undefined" &&
    typeof document !== "undefined" &&
    document.documentElement
  ) {
    const notify = () => {
      if (syncValdiHostTheme()) {
        for (const cb of Array.from(activeThemeListeners)) cb();
      }
    };
    hostThemeObserver = new MutationObserver(notify);
    hostThemeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-theme-id", "style", "class"],
    });
    unsubscribeTouchDensity = subscribeTouchPresentation(document, notify);
  }
  return () => {
    activeThemeListeners.delete(listener);
    if (activeThemeListeners.size === 0) {
      if (hostThemeObserver) {
        hostThemeObserver.disconnect();
        hostThemeObserver = null;
      }
      if (unsubscribeTouchDensity) {
        unsubscribeTouchDensity();
        unsubscribeTouchDensity = null;
      }
    }
  };
}

function isHostDarkTheme(): boolean {
  if (typeof document === "undefined") return false;
  const root = document.documentElement;
  if (!root) return false;
  if (root.getAttribute("data-theme") === "dark") return true;
  return typeof getComputedStyle === "function" && getComputedStyle(root).colorScheme === "dark";
}

function withResolvedHostTheme<TViewModel extends object>(viewModel: TViewModel): TViewModel {
  if ("dark" in viewModel && (viewModel as { readonly dark?: boolean }).dark !== undefined) {
    return viewModel;
  }
  return { ...viewModel, dark: isHostDarkTheme() };
}

/**
 * Mounts any Valdi cross-platform component inside an isolated Shadow DOM host
 * powered by `ValdiWebRenderer`.
 */
export function ValdiSurface<TViewModel extends object>({
  component,
  viewModel,
  componentProps = EMPTY_RECORD,
  context = EMPTY_RECORD,
  className,
  style,
  "data-testid": testId,
}: ValdiSurfaceProps<TViewModel>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<ValdiWebRenderer | null>(null);
  const latestRef = useRef({ component, viewModel, componentProps, context });
  const lastRenderedRef = useRef<{
    component: unknown;
    viewModel: unknown;
    componentProps: unknown;
    context: unknown;
  } | null>(null);
  latestRef.current = { component, viewModel, componentProps, context };

  useLayoutEffect(() => {
    const rootElement = containerRef.current;
    if (!rootElement) return;
    syncValdiHostTheme();
    // ValdiWebRenderer attaches a ShadowRoot once per host element; create a fresh
    // inner mount node so React StrictMode remounts and component swaps stay clean.
    const mountNode = document.createElement("div");
    mountNode.style.width = "100%";
    mountNode.style.height = "100%";
    rootElement.replaceChildren(mountNode);

    const renderer = new ValdiWebRenderer(mountNode);
    const shadowRoot = mountNode.shadowRoot;
    const detachEnhancements = shadowRoot ? attachValdiWebEnhancements(shadowRoot) : () => {};
    rendererRef.current = renderer;
    const initial = latestRef.current;
    lastRenderedRef.current = initial;
    renderer.renderRootComponent(
      component,
      initial.componentProps,
      withResolvedHostTheme(initial.viewModel),
      initial.context,
    );

    const unsubscribeTheme = subscribeValdiHostTheme(() => {
      const current = latestRef.current;
      lastRenderedRef.current = current;
      rendererRef.current?.renderRootComponent(
        current.component,
        current.componentProps,
        withResolvedHostTheme(current.viewModel),
        current.context,
      );
    });

    return () => {
      unsubscribeTheme();
      rendererRef.current = null;
      lastRenderedRef.current = null;
      detachEnhancements();
      renderer.destroy();
      mountNode.remove();
    };
  }, [component]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const prev = lastRenderedRef.current;
    if (
      prev &&
      prev.component === component &&
      prev.componentProps === componentProps &&
      prev.viewModel === viewModel &&
      prev.context === context
    ) {
      return;
    }
    lastRenderedRef.current = { component, viewModel, componentProps, context };
    renderer.renderRootComponent(component, componentProps, withResolvedHostTheme(viewModel), context);
  }, [component, componentProps, viewModel, context]);

  return <div ref={containerRef} className={className} style={style} data-valdi-surface="" data-testid={testId} />;
}
