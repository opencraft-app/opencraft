// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { getI18n } from "react-i18next";

export const DEFAULT_HERMES_AGENT_NAME_FALLBACK = "我的Hermes";
export const DEFAULT_HERMES_AGENT_NAME_I18N_KEY = "k_2889ddb2";

type TranslateDefaultAgentName = (
  key: string,
  options: { defaultValue: string },
) => unknown;

export const resolveDefaultHermesAgentName = (
  translate?: TranslateDefaultAgentName,
): string => {
  const translated = translate?.(DEFAULT_HERMES_AGENT_NAME_I18N_KEY, {
    defaultValue: DEFAULT_HERMES_AGENT_NAME_FALLBACK,
  });

  return typeof translated === "string" && translated.trim()
    ? translated
    : DEFAULT_HERMES_AGENT_NAME_FALLBACK;
};

export const defaultHermesAgentName = (): string => {
  const i18n = getI18n();
  return resolveDefaultHermesAgentName(
    i18n ? (key, options) => i18n.t(key, options) : undefined,
  );
};
