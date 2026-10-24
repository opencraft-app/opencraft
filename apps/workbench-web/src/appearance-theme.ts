import { useSyncExternalStore } from "react";
import {
  defaultThemePreference, isThemePreference, resolveThemePreference,
  type ResolvedTheme, type ThemePreference,
} from "@opencraft/design-system/theme";
import {
  buildOpenCraftThemeCssProperties, opencraftNeutralThemePalette, frostThemePalette,
  lavenderThemePalette, longingThemePalette, mistThemePalette, opencraftCanvasThemePalette, graphiteThemePalette,
  type OpenCraftThemeDefinition, type ThemeCssProperties,
} from "@opencraft/design-system/theme-engine";
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

export interface AppearanceThemeDescriptor {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly source: "core" | "extension";
}

export interface AppearanceThemeSnapshot {
  readonly preference: ThemePreference;
  readonly resolvedTheme: ResolvedTheme;
  readonly requestedThemeId: string;
  readonly themeId: string;
  readonly availableThemes: readonly AppearanceThemeDescriptor[];
}

type PalettePair = Readonly<Record<ResolvedTheme, OpenCraftThemeDefinition>>;
type CatalogEntry = Readonly<{ descriptor: AppearanceThemeDescriptor; palettes: PalettePair }>;

function builtin(id: string, label: string, description: string, palettes: PalettePair): CatalogEntry {
  return { descriptor: Object.freeze({ id, label, description, source: "core" }), palettes };
}

const builtins: readonly CatalogEntry[] = [
  builtin(coreThemeId, "Neutral", "A neutral palette with light and dark appearances.", opencraftNeutralThemePalette),
  builtin(canvasThemeId, "Canvas", "A quiet, web-native canvas.", opencraftCanvasThemePalette),
  builtin(frostThemeId, "Frost", "A cool translucent Sidebar with a lighter fixed material.", frostThemePalette),
  builtin(longingThemeId, "Longing", "Blue glass with translucent navigation and soft surface transitions.", longingThemePalette),
  builtin(lavenderThemeId, "Lavender", "A soft lavender workspace with a quiet UI palette.", lavenderThemePalette),
  builtin(graphiteThemeId, "Graphite", "Quiet grayscale layers, crisp controls, and an opaque workspace.", graphiteThemePalette),
  builtin(mistThemeId, "Mist", "Close neutral surfaces with a quiet, unified canvas.", mistThemePalette),
];
const visibleBuiltins = builtins.filter(entry => !workbenchPresentation.hiddenBuiltinThemeIds.includes(entry.descriptor.id));
const defaultBuiltin = visibleBuiltins.find(entry => entry.descriptor.id === defaultAppearanceThemeId());
// Even a policy that hides every built-in needs an executable fallback.
const baseCatalog = defaultBuiltin
  ? [defaultBuiltin, ...visibleBuiltins.filter(entry => entry !== defaultBuiltin)]
  : visibleBuiltins.length ? visibleBuiltins : [builtins[0]!];
let catalog = new Map(baseCatalog.map(entry => [entry.descriptor.id, entry]));
let availableThemes = Object.freeze([...catalog.values()].map(entry => entry.descriptor));
const subscribers = new Set<() => void>();
const projectedProperties = new WeakMap<HTMLElement, readonly string[]>();
const preferenceKey = "opencraft.appearance-theme";
const selectionKey = "opencraft.appearance-theme-id";
const systemAppearance = window.matchMedia("(prefers-color-scheme: dark)");
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
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", definition.surface);
  const desktop = (globalThis as typeof globalThis & {
    opencraftDesktop?: { setWindowAppearance?: (appearance: import("@opencraft/design-system/theme-options").ThemeWindowAppearance) => void };
  }).opencraftDesktop;
  desktop?.setWindowAppearance?.({
    themeSource: current.preference,
    resolvedTheme: current.resolvedTheme,
    opaqueWindows: definition.material?.window === "opaque" || definition.opaqueWindows,
    backgroundColor: definition.surfaces?.window ?? definition.surface,
  });
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
