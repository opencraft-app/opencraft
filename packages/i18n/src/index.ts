import { createIntl, createIntlCache, type IntlShape } from "react-intl";
import { canonicalizeLocale, DEFAULT_LOCALE, getLocaleTextDirection, resolveBestLocale, resolveRequestedLocale, type LocaleInputs } from "./locale.js";

export * from "./locale.js";
export { defineMessages } from "react-intl";
export type { IntlShape, MessageDescriptor } from "react-intl";
export type MessageCatalog = Readonly<Record<string, string>>;
export interface LocaleCatalog {
  readonly locale: string;
  readonly label: string;
  readonly load: () => Promise<MessageCatalog>;
}
export interface LocaleSnapshot {
  readonly intl: IntlShape;
  readonly requestedLocale: string;
  readonly direction: "ltr" | "rtl";
  readonly phase: "loading" | "ready" | "error";
}
export interface IntlPort {
  getSnapshot(): LocaleSnapshot;
  subscribe(listener: () => void): () => void;
}

/** One instance per application. React and imperative consumers use the exact
 * same Intl object/cache; embedded applications never share a module singleton. */
export class LocaleRuntime implements IntlPort {
  readonly #cache = createIntlCache();
  readonly #listeners = new Set<() => void>();
  readonly #loads = new Map<string, Promise<MessageCatalog>>();
  readonly #catalogs: readonly LocaleCatalog[];
  readonly #onError: (event: { locale: string; code: string }) => void;
  #generation = 0;
  #disposed = false;
  #identity = "";
  #pending: Promise<void> = Promise.resolve();
  #snapshot: LocaleSnapshot;

  constructor(catalogs: readonly LocaleCatalog[], onError: (event: { locale: string; code: string }) => void = () => {}) {
    const locales = catalogs.map(entry => entry.locale);
    if (new Set(locales).size !== locales.length || locales.some(locale => canonicalizeLocale(locale) !== locale)) {
      throw new TypeError("Locale catalog keys must be unique canonical locales");
    }
    this.#catalogs = Object.freeze(catalogs.map(entry => Object.freeze({ ...entry })));
    this.#onError = onError;
    this.#snapshot = this.#createSnapshot(DEFAULT_LOCALE, DEFAULT_LOCALE, {}, "ready");
  }

  getSnapshot = (): LocaleSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) throw new Error("Locale runtime is disposed");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  update(input: LocaleInputs): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error("Locale runtime is disposed"));
    const requested = resolveRequestedLocale(input);
    const enabled = input.enabled !== false;
    const identity = `${enabled}:${requested}`;
    if (identity === this.#identity) return this.#pending;
    this.#identity = identity;
    const generation = ++this.#generation;
    const match = isEnglish(requested) ? undefined : resolveBestLocale(requested, this.#catalogs.map(entry => entry.locale));
    const locale = match ?? requested;
    const catalog = enabled ? this.#catalogs.find(entry => entry.locale === match) : undefined;
    // Publish English defaultMessage immediately for a new locale, never the
    // previous locale's messages under a new formatter or direction.
    this.#publish(this.#createSnapshot(locale, requested, {}, catalog ? "loading" : "ready"));
    this.#pending = catalog ? this.#load(catalog).then(messages => {
      if (!this.#disposed && this.#generation === generation) this.#publish(this.#createSnapshot(locale, requested, messages, "ready"));
    }, () => {
      if (this.#disposed || this.#generation !== generation) return;
      this.#identity = ""; // Explicit retry must be able to reload a failed chunk.
      this.#onError({ locale, code: "CATALOG_LOAD_FAILED" });
      this.#publish(this.#createSnapshot(locale, requested, {}, "error"));
    }) : Promise.resolve();
    return this.#pending;
  }

  dispose(): void {
    this.#disposed = true;
    this.#generation++;
    this.#listeners.clear();
    this.#loads.clear();
  }

  #load(catalog: LocaleCatalog): Promise<MessageCatalog> {
    const cached = this.#loads.get(catalog.locale);
    if (cached) return cached;
    const promise = Promise.resolve().then(catalog.load).then(messages => {
      if (!messages || typeof messages !== "object" || Array.isArray(messages) || Object.values(messages).some(value => typeof value !== "string")) {
        throw new TypeError("Invalid message catalog");
      }
      return Object.freeze({ ...messages });
    }).catch(error => { this.#loads.delete(catalog.locale); throw error; });
    this.#loads.set(catalog.locale, promise);
    return promise;
  }

  #createSnapshot(locale: string, requestedLocale: string, messages: MessageCatalog, phase: LocaleSnapshot["phase"]): LocaleSnapshot {
    const intl = createIntl({ locale, defaultLocale: DEFAULT_LOCALE, messages, wrapRichTextChunksInFragment: true,
      onError: error => {
        // Never log interpolation values or upstream error bodies.
        if (error.code !== "MISSING_TRANSLATION") this.#onError({ locale, code: error.code });
      },
    }, this.#cache);
    return Object.freeze({ intl, requestedLocale, direction: getLocaleTextDirection(locale), phase });
  }

  #publish(snapshot: LocaleSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}

function isEnglish(locale: string): boolean { return new Intl.Locale(locale).language === "en"; }
