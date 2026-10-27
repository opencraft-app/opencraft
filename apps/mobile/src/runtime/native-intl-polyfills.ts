import { Locale } from "@formatjs/intl-locale";

// Hermes can format dates/numbers without exposing Intl.Locale. Install the
// missing standard capability before shared LocaleRuntime module evaluation;
// retain a native constructor when one is already available.
if (typeof Intl.Locale !== "function") {
  Object.defineProperty(Intl, "Locale", { configurable: true, writable: true, value: Locale });
}
