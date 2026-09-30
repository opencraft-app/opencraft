import { useEffect, useLayoutEffect, useSyncExternalStore, type ReactNode } from "react";
import { canonicalizeLocale, LocaleRuntime, type IntlPort, type LocaleCatalog, type LocaleInputs } from "@opencraft/i18n";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import type { UiPreferencesRuntime } from "@opencraft/ui-preferences";
import { localeCatalogs } from "./catalogs";

interface DesktopLocalePort {
  getSystemLocale(): Promise<string>;
  setApplicationLocale?(locale: string): Promise<void>;
}
const desktopLocalePort = (): DesktopLocalePort | undefined =>
  (globalThis as typeof globalThis & { opencraftDesktop?: { locale?: DesktopLocalePort } }).opencraftDesktop?.locale;

/** Environment input belongs to the embedding surface, not to a remote Agent. */
export interface WorkbenchLocaleOptions {
  readonly ideLocale?: string | null;
  readonly localeSource?: LocaleInputs["localeSource"];
  readonly enabled?: boolean;
}

export function validateWorkbenchLocaleOptions(input: WorkbenchLocaleOptions): WorkbenchLocaleOptions {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Invalid localization options");
  if (input.ideLocale != null && !canonicalizeLocale(input.ideLocale)) throw new TypeError("Invalid host locale");
  if (input.localeSource !== undefined && !["IDE", "SYSTEM", "FIRST_AVAILABLE"].includes(input.localeSource)) throw new TypeError("Invalid locale source");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new TypeError("Invalid localization gate");
  return Object.freeze({ ...input });
}

export class WorkbenchLocaleController implements IntlPort {
  readonly runtime: LocaleRuntime;
  readonly #preferences: UiPreferencesRuntime;
  readonly #unsubscribe: () => void;
  #options: WorkbenchLocaleOptions;
  #systemLocale: string;
  #disposed = false;
  #systemGeneration = 0;

  constructor(preferences: UiPreferencesRuntime, options: WorkbenchLocaleOptions = {}, catalogs: readonly LocaleCatalog[] = localeCatalogs) {
    this.runtime = new LocaleRuntime(catalogs, event => console.warn("[i18n]", event.code, event.locale));
    this.#preferences = preferences;
    this.#options = validateWorkbenchLocaleOptions(options);
    this.#systemLocale = globalThis.navigator?.language ?? "en-US";
    this.#unsubscribe = preferences.subscribe(() => { void this.#update(); });
  }
  getSnapshot = () => this.runtime.getSnapshot();
  subscribe = (listener: () => void) => this.runtime.subscribe(listener);
  async initialize(): Promise<void> { await this.refreshSystemLocale(); }
  async refreshSystemLocale(): Promise<void> {
    const generation = ++this.#systemGeneration;
    let locale = globalThis.navigator?.language ?? "en-US";
    try { locale = await desktopLocalePort()?.getSystemLocale() ?? locale; } catch { /* Browser fallback. */ }
    if (this.#disposed || this.#systemGeneration !== generation) return;
    this.#systemLocale = locale;
    await this.#update();
  }
  configure(options: WorkbenchLocaleOptions): Promise<void> {
    this.#options = validateWorkbenchLocaleOptions(options);
    return this.#update();
  }
  retry(): Promise<void> { return this.#update(); }
  dispose(): void { this.#disposed = true; this.#systemGeneration++; this.#unsubscribe(); this.runtime.dispose(); }
  #update(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    return this.runtime.update({ ...this.#options,
      localeOverride: this.#preferences.get("locale.override"),
      systemLocale: this.#systemLocale,
      // Desktop/Web standalone follows SYSTEM; embedded host locale is Codex's IDE input.
      localeSource: this.#options.localeSource ?? (this.#options.ideLocale ? "IDE" : "SYSTEM"),
    });
  }
}

export function WorkbenchIntlProvider({ controller, target, children }: {
  readonly controller: WorkbenchLocaleController;
  readonly target: HTMLElement;
  readonly children: ReactNode;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useLayoutEffect(() => {
    target.lang = snapshot.intl.locale;
    target.dir = snapshot.direction;
  }, [snapshot.intl.locale, snapshot.direction, target]);
  useEffect(() => {
    const update = () => { void controller.refreshSystemLocale(); };
    window.addEventListener("languagechange", update);
    return () => window.removeEventListener("languagechange", update);
  }, [controller]);
  useEffect(() => {
    if (target !== document.documentElement) return;
    void desktopLocalePort()?.setApplicationLocale?.(snapshot.intl.locale).catch(() => {
      console.warn("[i18n] NATIVE_LOCALE_SYNC_FAILED");
    });
  }, [snapshot.intl.locale, target]);
  return <IntlRuntimeProvider runtime={controller}>{children}</IntlRuntimeProvider>;
}
