import {
  defaultThemePreference,
  isThemePreference,
  resolveThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "@opencraft/design-system/theme";
import {
  buildCodexThemeCssProperties,
  codexThemePalette,
  velaThemePalette,
  type CodexThemeDefinition,
} from "@opencraft/design-system/theme-engine";
import type {
  ExtensionContributionSnapshot,
  ExtensionContributionStore,
} from "@opencraft/extension-runtime";
import { useSyncExternalStore } from "react";

import { workbenchProductId } from "./workbench-product";

const preferenceStorageKey = "vela.appearance-theme";
const themeIdStorageKey = "vela.appearance-theme-id";
export const coreThemeId = "vela.core.codex";
export const velaThemeId = "vela.core.web";

export function defaultAppearanceThemeId(productId: string): string {
  return productId === "lightvela-web" ? velaThemeId : coreThemeId;
}

const defaultThemeId = defaultAppearanceThemeId(workbenchProductId);

interface SystemThemeQuery {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

function createSystemThemeQuery(): SystemThemeQuery {
  if (typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)") as SystemThemeQuery;
  }
  return {
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

const systemDarkQuery = createSystemThemeQuery();

export interface AppearanceThemeDescriptor {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly source: "core" | "extension";
}

interface AppearanceThemeRecord {
  readonly descriptor: AppearanceThemeDescriptor;
  readonly palettes: Readonly<Record<ResolvedTheme, CodexThemeDefinition>>;
}

export interface AppearanceThemeSnapshot {
  readonly preference: ThemePreference;
  readonly resolvedTheme: ResolvedTheme;
  /** Persisted intent may temporarily refer to an unloaded extension. */
  readonly requestedThemeId: string;
  /** Theme currently applied after deterministic fallback. */
  readonly themeId: string;
  readonly availableThemes: readonly AppearanceThemeDescriptor[];
}

const coreTheme: AppearanceThemeRecord = Object.freeze({
  descriptor: Object.freeze({
    id: coreThemeId,
    label: "Codex",
    description: "OpenCraft's source-faithful neutral theme.",
    source: "core",
  }),
  palettes: codexThemePalette,
});

const velaTheme: AppearanceThemeRecord = Object.freeze({
  descriptor: Object.freeze({
    id: velaThemeId,
    label: "Vela",
    description: "LightVela's quiet, web-native canvas.",
    source: "core",
  }),
  palettes: velaThemePalette,
});

const coreThemes = new Map<string, AppearanceThemeRecord>([
  [coreThemeId, coreTheme],
  [velaThemeId, velaTheme],
]);

let extensionThemes = new Map<string, AppearanceThemeRecord>();
let contributionRevision = -1;
let disconnectContributionStore: (() => void) | null = null;

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Sandboxed browser contexts may deny storage; memory state remains valid.
  }
}

function readStoredPreference(): ThemePreference {
  const stored = readStorage(preferenceStorageKey);
  return isThemePreference(stored) ? stored : defaultThemePreference;
}

function readStoredThemeId(): string {
  const stored = readStorage(themeIdStorageKey)?.trim();
  return stored === undefined || stored === null || stored.length === 0
    ? defaultThemeId
    : stored;
}

function themeRecords(): readonly AppearanceThemeRecord[] {
  const defaultTheme = coreThemes.get(defaultThemeId) ?? coreTheme;
  return [
    defaultTheme,
    ...[...coreThemes.values()].filter((theme) => theme !== defaultTheme),
    ...extensionThemes.values(),
  ];
}

function resolveThemeRecord(themeId: string): AppearanceThemeRecord {
  return coreThemes.get(themeId)
    ?? extensionThemes.get(themeId)
    ?? coreThemes.get(defaultThemeId)
    ?? coreTheme;
}

function createSnapshot(
  preference: ThemePreference,
  requestedThemeId: string,
): AppearanceThemeSnapshot {
  const activeTheme = resolveThemeRecord(requestedThemeId);
  return Object.freeze({
    preference,
    resolvedTheme: resolveThemePreference(preference, systemDarkQuery.matches),
    requestedThemeId,
    themeId: activeTheme.descriptor.id,
    availableThemes: Object.freeze(themeRecords().map(({ descriptor }) => descriptor)),
  });
}

let snapshot = createSnapshot(readStoredPreference(), readStoredThemeId());
const listeners = new Set<() => void>();
let listeningToSystemTheme = false;
let initialized = false;

interface DesktopAppearanceBridge {
  readonly setWindowAppearance?: (appearance: {
    readonly themeSource: ThemePreference;
    readonly resolvedTheme: ResolvedTheme;
  }) => void;
}

function synchronizeDesktopAppearance(next: AppearanceThemeSnapshot): void {
  const bridge = (
    globalThis as typeof globalThis & { readonly opencraftDesktop?: DesktopAppearanceBridge }
  ).opencraftDesktop;
  bridge?.setWindowAppearance?.({
    themeSource: next.preference,
    resolvedTheme: next.resolvedTheme,
  });
}

function activeDefinition(next: AppearanceThemeSnapshot): CodexThemeDefinition {
  return resolveThemeRecord(next.themeId).palettes[next.resolvedTheme];
}

/** Project the complete semantic theme contract onto a non-document root. */
export function applyAppearanceThemeToElement(
  element: HTMLElement,
  next: AppearanceThemeSnapshot = snapshot,
): void {
  const definition = activeDefinition(next);
  element.dataset.theme = next.resolvedTheme;
  element.dataset.themePreference = next.preference;
  element.dataset.themeId = next.themeId;
  element.style.colorScheme = next.resolvedTheme;
  for (const [name, value] of Object.entries(
    buildCodexThemeCssProperties(next.resolvedTheme, definition),
  )) {
    if (element.style.getPropertyValue(name) !== value) {
      element.style.setProperty(name, value);
    }
  }
}

function applySnapshot(next: AppearanceThemeSnapshot): void {
  const root = document.documentElement;
  const definition = activeDefinition(next);

  applyAppearanceThemeToElement(root, next);
  root.classList.toggle("electron-dark", next.resolvedTheme === "dark");
  root.classList.toggle("electron-light", next.resolvedTheme === "light");

  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", definition.surface);
  synchronizeDesktopAppearance(next);
}

function sameThemeCatalog(
  left: readonly AppearanceThemeDescriptor[],
  right: readonly AppearanceThemeDescriptor[],
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function publish(next: AppearanceThemeSnapshot, force = false): void {
  if (
    !force
    && next.preference === snapshot.preference
    && next.resolvedTheme === snapshot.resolvedTheme
    && next.requestedThemeId === snapshot.requestedThemeId
    && next.themeId === snapshot.themeId
    && sameThemeCatalog(next.availableThemes, snapshot.availableThemes)
  ) return;
  snapshot = next;
  if (initialized) applySnapshot(snapshot);
  for (const listener of listeners) listener();
}

function refreshSnapshot(force = false): void {
  publish(createSnapshot(snapshot.preference, snapshot.requestedThemeId), force);
}

function handleSystemThemeChange(): void {
  if (snapshot.preference === "system") refreshSnapshot();
}

function syncSystemSubscription(): void {
  const shouldListen = initialized && snapshot.preference === "system";
  if (shouldListen === listeningToSystemTheme) return;
  if (shouldListen) systemDarkQuery.addEventListener("change", handleSystemThemeChange);
  else systemDarkQuery.removeEventListener("change", handleSystemThemeChange);
  listeningToSystemTheme = shouldListen;
}

type ContributedPalette =
  ExtensionContributionSnapshot["themes"][number]["contribution"]["palettes"]["light"];

function toThemeDefinition(palette: ContributedPalette): CodexThemeDefinition {
  return Object.freeze({
    accent: palette.accent,
    contrast: palette.contrast,
    fonts: Object.freeze({ code: null, ui: null }),
    ink: palette.ink,
    opaqueWindows: false,
    semanticColors: palette.semanticColors,
    surface: palette.surface,
  });
}

function importContributedThemes(contributions: ExtensionContributionSnapshot): void {
  if (contributions.revision === contributionRevision) return;
  contributionRevision = contributions.revision;
  extensionThemes = new Map(contributions.themes.map(({ contribution }) => [
    contribution.id,
    Object.freeze({
      descriptor: Object.freeze({
        id: contribution.id,
        label: contribution.label,
        ...(contribution.description === undefined
          ? {}
          : { description: contribution.description }),
        source: "extension" as const,
      }),
      palettes: Object.freeze({
        light: toThemeDefinition(contribution.palettes.light),
        dark: toThemeDefinition(contribution.palettes.dark),
      }),
    }),
  ]));
  refreshSnapshot(true);
}

export function getAppearanceThemeSnapshot(): AppearanceThemeSnapshot {
  return snapshot;
}

export function subscribeToAppearanceTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setThemePreference(preference: ThemePreference): void {
  writeStorage(preferenceStorageKey, preference);
  publish(createSnapshot(preference, snapshot.requestedThemeId));
  syncSystemSubscription();
}

export function setAppearanceThemeId(themeId: string): void {
  const normalized = themeId.trim();
  if (normalized.length === 0) throw new TypeError("Theme ID must not be empty");
  if (resolveThemeRecord(normalized).descriptor.id !== normalized) {
    throw new Error(`Theme ${normalized} is not available`);
  }
  writeStorage(themeIdStorageKey, normalized);
  publish(createSnapshot(snapshot.preference, normalized));
}

export function useAppearanceTheme(): AppearanceThemeSnapshot {
  return useSyncExternalStore(
    subscribeToAppearanceTheme,
    getAppearanceThemeSnapshot,
    getAppearanceThemeSnapshot,
  );
}

/**
 * Application-owned bridge from immutable extension snapshots to the root
 * theme catalog. Unload falls back atomically while retaining persisted intent.
 */
export function connectAppearanceThemeContributions(
  store: Pick<ExtensionContributionStore, "getSnapshot" | "subscribe">,
): () => void {
  disconnectContributionStore?.();
  importContributedThemes(store.getSnapshot());
  const unsubscribe = store.subscribe(() => importContributedThemes(store.getSnapshot()));
  let connected = true;
  const disconnect = () => {
    if (!connected) return;
    connected = false;
    unsubscribe();
    if (disconnectContributionStore === disconnect) disconnectContributionStore = null;
    contributionRevision = -1;
    extensionThemes = new Map();
    refreshSnapshot(true);
  };
  disconnectContributionStore = disconnect;
  return disconnect;
}

/** Root-owned initialization; no button or settings route owns theme state. */
export function initializeAppearanceTheme(): void {
  initialized = true;
  applySnapshot(snapshot);
  syncSystemSubscription();
}
