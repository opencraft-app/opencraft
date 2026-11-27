import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { defineMessages } from "@opencraft/i18n";
import { useIntl } from "@opencraft/i18n/react";
import type { ThemePreference } from "@opencraft/design-system/theme";
import { SettingsPageHeader } from "@opencraft/extension-react";
import { getAppearanceThemePreviewProperties, type AppearanceThemeDescriptor } from "../appearance-theme";
import { useInternalDeveloperMode } from "../internal-developer-mode";
import { localeCatalogs } from "../i18n/catalogs";
import { mobileContainer, openMobileSourceSettings } from "../runtime/mobile-container";
import { requestMobileHaptic } from "../runtime/mobile-valdi-bridge";
import { useUiPreferencesRuntime } from "../runtime/ui-preferences-runtime";
import { useValdiTouchDensity } from "./shell-navigation/valdi-sidebar-dock";
import { valdiUiKitMessages } from "./valdi-ui-kit-messages";
import "./valdi-surfaces.scss";

const appearanceMessages = defineMessages({
  light: { id: "settings.light", defaultMessage: "Light" },
  dark: { id: "settings.dark", defaultMessage: "Dark" },
  system: { id: "settings.system", defaultMessage: "System" },
});

const LazyValdiAppearanceSettings = lazy(async () => {
  const mod = await import("@opencraft/design-system-web/valdi");
  function AppearanceSettingsMount({
    viewModel,
  }: {
    readonly viewModel: import("@opencraft/design-system-web/valdi").AppearanceSettingsProps;
  }) {
    return (
      <mod.ValdiSurface
        component={mod.AppearanceSettingsSurface}
        viewModel={viewModel}
        className="valdi-appearance-settings-surface"
        data-testid="valdi-appearance-settings-surface"
      />
    );
  }
  return { default: AppearanceSettingsMount };
});

export function AppearanceSettings({
  themes,
  themeId,
  themePreference,
  resolvedTheme,
  onThemeChange,
  onThemePreferenceChange,
  onOpenUiKit,
}: {
  readonly themes: readonly AppearanceThemeDescriptor[];
  readonly themeId: string;
  readonly themePreference: ThemePreference;
  readonly resolvedTheme: "light" | "dark";
  readonly onThemeChange: (themeId: string) => void;
  readonly onThemePreferenceChange: (preference: ThemePreference) => void;
  readonly onOpenUiKit: () => void;
}) {
  const intl = useIntl();
  const internalDeveloperMode = useInternalDeveloperMode();
  const preferences = useUiPreferencesRuntime();
  const snapshot = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot);
  const touch = useValdiTouchDensity();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(() => (typeof window !== "undefined" ? window.innerWidth < 680 : false));
  const [saveError, setSaveError] = useState(false);
  const latestTouchSave = useRef(0);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number" && width > 0) setNarrow(width < 560);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const handleChangeLanguage = useCallback(
    (locale: string) => {
      setSaveError(false);
      void preferences.set("locale.override", locale).catch(() => setSaveError(true));
    },
    [preferences],
  );

  const handleChangeTouch = useCallback(
    (value: string) => {
      if (value !== "auto" && value !== "on" && value !== "off") return;
      const attempt = ++latestTouchSave.current;
      setSaveError(false);
      void preferences.set("interface.touchFriendly", value).catch(() => {
        if (attempt === latestTouchSave.current) setSaveError(true);
      });
    },
    [preferences],
  );

  const handleChangeMode = useCallback(
    (mode: string) => {
      if (mode === "light" || mode === "dark" || mode === "system") {
        onThemePreferenceChange(mode);
      }
    },
    [onThemePreferenceChange],
  );

  const handleHaptic = useCallback((style: string) => {
    requestMobileHaptic(style === "warning" ? "warning" : style === "light" ? "light" : "selection");
  }, []);

  const title = intl.formatMessage({ id: "settings.appearance", defaultMessage: "Appearance" });
  const subtitle = intl.formatMessage({
    id: "settings.appearance.description",
    defaultMessage: "Choose how OpenCraft looks across the workbench.",
  });

  const languageOptions = useMemo(
    () => [
      {
        id: "",
        title: intl.formatMessage({
          id: "settings.language.default",
          defaultMessage: "Automatic",
          description: "Use embedding host or system language",
        }),
      },
      ...localeCatalogs.map((entry) => ({ id: entry.locale, title: entry.label })),
    ],
    [intl],
  );

  const touchOptions = useMemo(
    () => [
      { id: "auto", title: intl.formatMessage({ id: "settings.touchFriendly.auto", defaultMessage: "Automatic" }) },
      { id: "on", title: intl.formatMessage({ id: "settings.touchFriendly.on", defaultMessage: "On" }) },
      { id: "off", title: intl.formatMessage({ id: "settings.touchFriendly.off", defaultMessage: "Off" }) },
    ],
    [intl],
  );

  const modeOptions = useMemo(
    () =>
      (["light", "dark", "system"] as const).map((preference) => ({
        id: preference,
        title: intl.formatMessage(appearanceMessages[preference]),
      })),
    [intl],
  );

  const themeItems = useMemo<readonly import("@opencraft/design-system-web/valdi").AppearanceThemeCardItem[]>(
    () =>
      themes.map((theme) => {
        const css = getAppearanceThemePreviewProperties(theme.id);
        const showDescription =
          theme.description &&
          !(intl.locale.toLowerCase().startsWith("zh") && !/[\u4e00-\u9fff]/u.test(theme.description))
            ? theme.description
            : undefined;
        return {
          id: theme.id,
          label: theme.label,
          description: showDescription,
          sidebarBg: css["--opencraft-sidebar-material-background"] || css["--color-background-panel"] || "#f3f3f3",
          headerBg: css["--color-background-panel"] || "#f7f7f7",
          canvasBg: css["--color-background-surface"] || "#ffffff",
          pillBg: css["--color-background-button-primary"] || "#303030",
          previewBorder: css["--color-border-default"] || "rgba(48, 48, 48, 0.10)",
        };
      }),
    [themes, resolvedTheme, intl.locale],
  );

  const viewModel = useMemo(
    (): import("@opencraft/design-system-web/valdi").AppearanceSettingsProps => ({
      dark: resolvedTheme === "dark",
      touch,
      narrow,
      title,
      subtitle,
      errorMessage: saveError
        ? intl.formatMessage({
            id: "settings.chat.saveError",
            defaultMessage: "Could not save your preference. Please try again.",
          })
        : undefined,
      interfaceGroupTitle: intl.formatMessage({ id: "settings.interface", defaultMessage: "Interface" }),
      interfaceGroupDescription: intl.formatMessage({
        id: "settings.interface.description",
        defaultMessage: "Shared display preferences apply across every Workbench view.",
      }),
      languageTitle: intl.formatMessage({
        id: "settings.language",
        defaultMessage: "Language",
        description: "Interface language preference",
      }),
      languageValue: snapshot.values["locale.override"],
      languageOptions,
      touchTitle: intl.formatMessage({ id: "settings.touchFriendly", defaultMessage: "Touch experience" }),
      touchDescription: intl.formatMessage({
        id: "settings.touchFriendly.description",
        defaultMessage:
          "Larger touch targets with the touch composer and navigation layout. Automatically follows touch capability, with a manual override.",
      }),
      touchValue: snapshot.values["interface.touchFriendly"],
      touchOptions,
      showMobileSource: Boolean(mobileContainer()),
      mobileSourceTitle: intl.formatMessage({ id: "mobile.source", defaultMessage: "Workspace source" }),
      mobileSourceDescription: intl.formatMessage({
        id: "mobile.description",
        defaultMessage: "Use the built-in workspace or open your own OpenCraft website.",
      }),
      mobileSourceActionLabel: intl.formatMessage({ id: "mobile.source", defaultMessage: "Workspace source" }),
      modeTitle: title,
      modeDescription: intl.formatMessage({
        id: "settings.appearance.follow",
        defaultMessage: "Follow the system or keep one appearance.",
      }),
      modeValue: themePreference,
      modeOptions,
      themeTitle: intl.formatMessage({ id: "settings.theme", defaultMessage: "Theme" }),
      themeDescription: intl.formatMessage({
        id: "settings.theme.description",
        defaultMessage: "Semantic palettes define every surface, border, and interaction state.",
      }),
      themeId,
      themes: themeItems,
      showUiKit: internalDeveloperMode,
      uiKitTitle: intl.formatMessage(valdiUiKitMessages.appearanceRowLabel),
      uiKitDescription: intl.formatMessage(valdiUiKitMessages.appearanceRowDescription),
      uiKitActionLabel: intl.formatMessage(valdiUiKitMessages.openStyleLab),
      onChangeLanguage: handleChangeLanguage,
      onChangeTouch: handleChangeTouch,
      onOpenMobileSource: () => openMobileSourceSettings(),
      onChangeMode: handleChangeMode,
      onChangeTheme: onThemeChange,
      onOpenUiKit,
      onHaptic: handleHaptic,
    }),
    [
      handleChangeLanguage,
      handleChangeMode,
      handleChangeTouch,
      handleHaptic,
      internalDeveloperMode,
      intl,
      languageOptions,
      modeOptions,
      narrow,
      onOpenUiKit,
      onThemeChange,
      resolvedTheme,
      saveError,
      snapshot.values,
      subtitle,
      themeId,
      themeItems,
      themePreference,
      title,
      touch,
      touchOptions,
    ],
  );

  return (
    <div ref={containerRef} className="valdi-appearance-settings-host">
      <Suspense fallback={<SettingsPageHeader title={title} description={subtitle} />}>
        <LazyValdiAppearanceSettings viewModel={viewModel} />
      </Suspense>
    </div>
  );
}
