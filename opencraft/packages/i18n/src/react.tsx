import React, { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { RawIntlProvider } from "react-intl";
import type { IntlPort } from "./index.js";

export { FormattedMessage, FormattedDate, FormattedTime, FormattedNumber, FormattedList, FormattedRelativeTime, useIntl, useIntl as useLocale } from "react-intl";
const RuntimeContext = createContext<IntlPort | null>(null);

export function IntlRuntimeProvider({ runtime, children }: { readonly runtime: IntlPort; readonly children: ReactNode }) {
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  return <RuntimeContext.Provider value={runtime}><RawIntlProvider value={snapshot.intl}>{children}</RawIntlProvider></RuntimeContext.Provider>;
}

export function useIntlRuntime(): IntlPort {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("IntlRuntimeProvider is missing");
  return runtime;
}
