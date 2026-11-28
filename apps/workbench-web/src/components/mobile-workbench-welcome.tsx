import { lazy, Suspense, useId, useMemo } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { Button } from "@opencraft/design-system-web/button";
import { useAppearanceTheme } from "../appearance-theme";
import { mobileContainer, openMobileSourceSettings } from "../runtime/mobile-container";
import { requestMobileHaptic } from "../runtime/mobile-valdi-bridge";
import { mobileConnectionMessages } from "./mobile-connection-messages";
import "./mobile-workbench-welcome.scss";

const LazyValdiMobileWelcome = lazy(async () => {
  const mod = await import("@opencraft/design-system-web/valdi");
  function ValdiMobileWelcomeMount({
    viewModel,
  }: {
    readonly viewModel: import("@opencraft/design-system-web/valdi").MobileWelcomeProps;
  }) {
    return (
      <mod.ValdiSurface
        component={mod.MobileWelcomeSurface}
        viewModel={viewModel}
        className="mobile-workbench-welcome__valdi-surface"
        data-testid="valdi-mobile-welcome-surface"
      />
    );
  }
  return { default: ValdiMobileWelcomeMount };
});

export function MobileWorkbenchWelcome({
  onConnect,
  onExplore,
}: {
  readonly onConnect: () => void;
  readonly onExplore: () => void;
}) {
  const intl = useIntl();
  const appearance = useAppearanceTheme();
  const titleId = useId();
  const isNativeContainer = mobileContainer() !== null;

  const viewModel = useMemo(
    () => ({
      dark: appearance.resolvedTheme === "dark",
      hasSourceSettings: isNativeContainer,
      brandLabel: "OpenCraft",
      title: intl.formatMessage({ id: "welcome.title", defaultMessage: "Welcome to OpenCraft" }),
      subtitle: intl.formatMessage({
        id: "mobile.welcome.connectDescription",
        defaultMessage: "Use your OpenCraft server to chat and run agents.",
      }),
      connectGroupTitle: intl.formatMessage({
        id: "settings.groups.application",
        defaultMessage: "Application",
      }),
      connectServerTitle: intl.formatMessage(mobileConnectionMessages.title),
      connectServerDetail: "HTTPS",
      exploreOfflineTitle: intl.formatMessage({
        id: "mobile.welcome.explore",
        defaultMessage: "Explore without a server",
      }),
      exploreOfflineDetail: intl.formatMessage({ id: "settings.appearance", defaultMessage: "Appearance" }),
      sourceSettingsTitle: intl.formatMessage({ id: "mobile.source", defaultMessage: "Workspace source" }),
      sourceSettingsDetail: "Host",
      onConnect,
      onExplore,
      onOpenSourceSettings: isNativeContainer ? () => openMobileSourceSettings() : undefined,
      onHaptic: (style: string) => {
        requestMobileHaptic(style === "warning" ? "warning" : style === "light" ? "light" : "selection");
      },
    }),
    [appearance.resolvedTheme, intl, isNativeContainer, onConnect, onExplore],
  );

  const fallbackChoices = (
    <div className="mobile-workbench-welcome__fallback">
      <h1 id={titleId}>{viewModel.title}</h1>
      <div className="mobile-workbench-welcome__choices">
        <div className="mobile-workbench-welcome__choice">
          <Button variant="primary" onClick={onConnect}>
            {viewModel.connectServerTitle}
          </Button>
        </div>
        <div className="mobile-workbench-welcome__choice">
          <Button variant="secondary" onClick={onExplore}>
            {viewModel.exploreOfflineTitle}
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <section
      className="mobile-workbench-welcome mobile-workbench-welcome--valdi"
      aria-label={viewModel.title}
    >
      <Suspense fallback={fallbackChoices}>
        <LazyValdiMobileWelcome viewModel={viewModel} />
      </Suspense>
    </section>
  );
}
