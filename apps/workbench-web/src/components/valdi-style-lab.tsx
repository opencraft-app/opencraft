import { lazy, Suspense, useMemo, useState } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsPageHeader, SettingsSegmented } from "@opencraft/extension-react";
import type { ThemePreference } from "@opencraft/design-system/theme";
import { setThemePreference, useAppearanceTheme } from "../appearance-theme";
import { requestMobileHaptic } from "../runtime/mobile-valdi-bridge";
import { valdiUiKitMessages } from "./valdi-ui-kit-messages";
import "./valdi-style-lab.scss";

type LayoutMode = "auto" | "split" | "compact";

const LazyValdiGallerySurface = lazy(async () => {
  const mod = await import("@opencraft/design-system-web/valdi");
  function ValdiGalleryMount({
    dark,
    locale,
    layoutMode,
    onThemeChange,
  }: {
    readonly dark: boolean;
    readonly locale: string;
    readonly layoutMode: LayoutMode;
    readonly onThemeChange: (nextDark: boolean) => void;
  }) {
    const viewModel = useMemo(
      () => ({
        dark,
        locale,
        layoutMode,
        onHaptic: (style: string) => {
          const mapped = style === "warning" ? "warning" : style === "light" ? "light" : "selection";
          if (!requestMobileHaptic(mapped)) mod.triggerBrowserHaptic(mapped);
        },
        onThemeChange,
      }),
      [dark, locale, layoutMode, onThemeChange],
    );
    return (
      <mod.ValdiSurface
        component={mod.Gallery}
        viewModel={viewModel}
        className="valdi-style-lab-surface"
        data-testid="valdi-style-lab-surface"
      />
    );
  }
  return { default: ValdiGalleryMount };
});

export function ValdiStyleLabSettingsSection({
  onThemePreferenceChange = setThemePreference,
}: {
  readonly onThemePreferenceChange?: (preference: ThemePreference) => void;
}) {
  const intl = useIntl();
  const appearance = useAppearanceTheme();
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("auto");
  const isDark = appearance.resolvedTheme === "dark";

  return (
    <div className="valdi-style-lab-page">
      <SettingsPageHeader
        title={intl.formatMessage(valdiUiKitMessages.pageTitle)}
        description={intl.formatMessage(valdiUiKitMessages.pageDescription)}
      />

      <div className="valdi-style-lab-page__toolbar">
        <span className="valdi-style-lab-page__badge">{intl.formatMessage(valdiUiKitMessages.welcomeHeroBadge)}</span>
        <SettingsSegmented
          label={intl.formatMessage(valdiUiKitMessages.layoutModeLabel)}
          value={layoutMode}
          onValueChange={(next) => setLayoutMode(next as LayoutMode)}
          options={[
            { value: "auto", label: intl.formatMessage(valdiUiKitMessages.layoutAuto) },
            { value: "split", label: intl.formatMessage(valdiUiKitMessages.layoutSplit) },
            { value: "compact", label: intl.formatMessage(valdiUiKitMessages.layoutCompact) },
          ]}
        />
      </div>

      <div
        className={
          layoutMode === "compact" ? "valdi-style-lab-stage valdi-style-lab-stage--compact" : "valdi-style-lab-stage"
        }
      >
        <Suspense
          fallback={
            <div className="valdi-style-lab-loading" role="status">
              {intl.formatMessage(valdiUiKitMessages.loading)}
            </div>
          }
        >
          {layoutMode === "compact" ? (
            <div className="valdi-style-lab-stage__phone-bezel">
              <LazyValdiGallerySurface
                dark={isDark}
                locale={intl.locale}
                layoutMode="compact"
                onThemeChange={(nextDark) => onThemePreferenceChange(nextDark ? "dark" : "light")}
              />
            </div>
          ) : (
            <LazyValdiGallerySurface
              dark={isDark}
              locale={intl.locale}
              layoutMode={layoutMode}
              onThemeChange={(nextDark) => onThemePreferenceChange(nextDark ? "dark" : "light")}
            />
          )}
        </Suspense>
      </div>
    </div>
  );
}
