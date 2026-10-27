import { useSyncExternalStore } from "react";
import {
  defaultThemePreference, isThemePreference, resolveThemePreference,
  type ResolvedTheme, type ThemePreference,
} from "@opencraft/design-system/theme";
import {
  buildOpenCraftThemeCssProperties,
  type OpenCraftThemeDefinition, type ThemeCssProperties,
} from "@opencraft/design-system/theme-engine";
import { resolveBuiltinAppearanceCatalog, type AppearanceThemeDescriptor, type CatalogEntry } from "./appearance-catalog";
import { resolveWindowAppearanceIntent, projectWindowAppearance, type WindowAppearanceProjection, type WindowAppearanceProjector } from "./runtime/window-appearance";
import { readWindowPresentation } from "./runtime/window-presentation";
import type { ExtensionContributionSnapshot, ExtensionContributionStore } from "@opencraft/extension-runtime";
import { applyWorkbenchProductPresentation, workbenchProductId, workbenchPresentation } from "./workbench-product";
import { builtinThemeIds, normalizeBuiltinThemeId, type WorkbenchPresentation } from "./workbench-presentation";

// Canonical built-in identities; legacy values are normalized at read boundaries.
export const coreThemeId = builtinThemeIds.neutral;
export const canvasThemeId = builtinThemeIds.canvas;
export const frostThemeId = builtinThemeIds.frost;
export const lavenderThemeId = builtinThemeIds.lavender;
export const longingThemeId = builtinThemeIds.longing;
export const mistThemeId = builtinThemeIds.mist;
export const graphiteThemeId = builtinThemeIds.graphite;

export type { AppearanceThemeDescriptor } from "./appearance-catalog";
export interface AppearanceThemeSnapshot {
  readonly preference: ThemePreference;
  readonly resolvedTheme: ResolvedTheme;
  readonly requestedThemeId: string;
  readonly themeId: string;
  readonly availableThemes: readonly AppearanceThemeDescriptor[];
}

const baseCatalog = resolveBuiltinAppearanceCatalog(workbenchPresentation);
let catalog = new Map(baseCatalog.map(entry => [entry.descriptor.id, entry]));
let availableThemes = Object.freeze([...catalog.values()].map(entry => entry.descriptor));
const subscribers = new Set<() => void>();
const projectedProperties = new WeakMap<HTMLElement, readonly string[]>();
const preferenceKey = "opencraft.appearance-theme";
const selectionKey = "opencraft.appearance-theme-id";
const systemAppearance = window.matchMedia("(prefers-color-scheme: dark)");
let windowProjection: WindowAppearanceProjection | undefined;
let windowProjector: WindowAppearanceProjector | undefined;
/** Bootstrap binds one active host projector; theme preference stays here. */
export function bindWindowAppearanceProjector(projector: WindowAppearanceProjector): () => void {
  if (windowProjector) throw new Error("A window appearance projector is already bound");
  windowProjector = projector;
  try { if (initialized) projectDocument(); }
  catch (error) { windowProjector = undefined; throw error; }
  return () => { if (windowProjector === projector) windowProjector = undefined; };
}
/** Projection evidence only; native status-bar pixels cannot be read here. */
export function getWindowAppearanceProjection(): WindowAppearanceProjection | undefined { return windowProjection; }
let initialized = false;
let disconnectSource: (() => void) | undefined;

export function defaultAppearanceThemeId(
  presentation: Pick<WorkbenchPresentation, "defaultThemeId"> = workbenchPresentation,
): string {
  return normalizeBuiltinThemeId(presentation.defaultThemeId ?? coreThemeId);
}

function readPreference(key: string): string | null | undefined {
  try { return window.localStorage.getItem(key); }
  catch { return undefined; }
}

function writePreference(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); }
  catch { /* Storage availability does not own the current in-memory choice. */ }
}

function resolveEntry(id: string): CatalogEntry {
  return catalog.get(normalizeBuiltinThemeId(id)) ?? baseCatalog.find(entry => entry.descriptor.id === defaultAppearanceThemeId()) ?? baseCatalog[0]!;
}

function snapshot(preference: ThemePreference, requestedThemeId: string): AppearanceThemeSnapshot {
  return Object.freeze({
    preference,
    resolvedTheme: resolveThemePreference(preference, systemAppearance.matches),
    requestedThemeId,
    themeId: resolveEntry(requestedThemeId).descriptor.id,
    availableThemes,
  });
}

const storedMode = readPreference(preferenceKey);
const persistedMode = storedMode ?? readPreference("vela.appearance-theme");
const storedThemeId = readPreference(selectionKey);
const persistedThemeId = (storedThemeId ?? readPreference("vela.appearance-theme-id"))?.trim();
const initialThemeId = normalizeBuiltinThemeId(persistedThemeId || defaultAppearanceThemeId());
// Copy known old preferences forward without deleting recovery inputs or
// replacing an opaque extension ID with the currently displayed fallback.
// An unavailable read is distinct from a missing key: never overwrite it.
if (storedMode === null && isThemePreference(persistedMode)) writePreference(preferenceKey, persistedMode);
if (persistedThemeId && (storedThemeId === null || (typeof storedThemeId === "string" && initialThemeId !== storedThemeId.trim()))) {
  writePreference(selectionKey, initialThemeId);
}
let current = snapshot(
  isThemePreference(persistedMode) ? persistedMode : defaultThemePreference,
  initialThemeId,
);

export function getAppearanceThemeSnapshot(): AppearanceThemeSnapshot { return current; }

export function subscribeToAppearanceTheme(listener: () => void): () => void {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}

export function useAppearanceTheme(): AppearanceThemeSnapshot {
  return useSyncExternalStore(subscribeToAppearanceTheme, getAppearanceThemeSnapshot, getAppearanceThemeSnapshot);
}

export function getAppearanceThemeShellMaterial(next = current): OpenCraftThemeDefinition["shellMaterial"] {
  return resolveEntry(next.themeId).palettes[next.resolvedTheme].shellMaterial;
}

export function getAppearanceThemePreviewProperties(themeId: string): ThemeCssProperties {
  return buildOpenCraftThemeCssProperties(current.resolvedTheme, resolveEntry(themeId).palettes[current.resolvedTheme]);
}

export function applyAppearanceThemeToElement(element: HTMLElement, next = current): void {
  const css = buildOpenCraftThemeCssProperties(next.resolvedTheme, resolveEntry(next.themeId).palettes[next.resolvedTheme]);
  for (const key of projectedProperties.get(element) ?? []) {
    if (!(key in css)) element.style.removeProperty(key);
  }
  for (const [key, value] of Object.entries(css)) element.style.setProperty(key, value);
  projectedProperties.set(element, Object.keys(css));
  element.classList.toggle("electron-light", next.resolvedTheme === "light");
  element.classList.toggle("electron-dark", next.resolvedTheme === "dark");
  element.dataset.theme = next.resolvedTheme;
  element.dataset.themePreference = next.preference;
  element.dataset.themeId = next.themeId;
  element.style.colorScheme = next.resolvedTheme;
}

function projectDocument(): void {
  const definition = resolveEntry(current.themeId).palettes[current.resolvedTheme];
  applyAppearanceThemeToElement(document.documentElement);
  applyWorkbenchProductPresentation(document.documentElement, workbenchProductId);
  const intent = resolveWindowAppearanceIntent(current.preference, current.resolvedTheme, definition);
  windowProjection = windowProjector ? windowProjector.projectAppearance(intent, "resolved")
    : projectWindowAppearance(document, intent, readWindowPresentation(window), "resolved");
}

function publish(next: AppearanceThemeSnapshot): void {
  if (next.preference === current.preference && next.resolvedTheme === current.resolvedTheme
    && next.requestedThemeId === current.requestedThemeId && next.themeId === current.themeId
    && next.availableThemes === current.availableThemes) return;
  current = next;
  projectDocument();
  for (const listener of subscribers) listener();
}

export function setThemePreference(preference: ThemePreference): void {
  writePreference(preferenceKey, preference);
  publish(snapshot(preference, current.requestedThemeId));
}

export function setAppearanceThemeId(themeId: string): void {
  const id = normalizeBuiltinThemeId(themeId.trim());
  if (!id) throw new Error("Theme ID must not be empty");
  if (!catalog.has(id)) throw new Error(`Theme ${id} is not available`);
  writePreference(selectionKey, id);
  publish(snapshot(current.preference, id));
}

function updateCatalog(themes: ExtensionContributionSnapshot["themes"]): void {
  catalog = new Map(baseCatalog.map(entry => [entry.descriptor.id, entry]));
  for (const { contribution } of themes) {
    const adapt = (mode: ResolvedTheme): OpenCraftThemeDefinition => ({
      ...contribution.palettes[mode], fonts: { code: null, ui: null }, opaqueWindows: false,
    });
    catalog.set(contribution.id, {
      descriptor: Object.freeze({
        id: contribution.id, label: contribution.label,
        ...(contribution.description === undefined ? {} : { description: contribution.description }),
        source: "extension",
      }),
      palettes: { light: adapt("light"), dark: adapt("dark") },
    });
  }
  availableThemes = Object.freeze([...catalog.values()].map(entry => entry.descriptor));
  publish(snapshot(current.preference, current.requestedThemeId));
}

export function connectAppearanceThemeContributions(
  store: Pick<ExtensionContributionStore, "getSnapshot" | "subscribe">,
): () => void {
  disconnectSource?.();
  let active = true;
  const refresh = () => { if (active) updateCatalog(store.getSnapshot().themes); };
  const unsubscribe = store.subscribe(refresh);
  const disconnect = () => {
    if (!active) return;
    active = false;
    unsubscribe();
    if (disconnectSource === disconnect) disconnectSource = undefined;
    updateCatalog([]);
  };
  disconnectSource = disconnect;
  refresh();
  return disconnect;
}

export function initializeAppearanceTheme(): void {
  if (!initialized) {
    initialized = true;
    systemAppearance.addEventListener("change", () => publish(snapshot(current.preference, current.requestedThemeId)));
  }
  projectDocument();
}
