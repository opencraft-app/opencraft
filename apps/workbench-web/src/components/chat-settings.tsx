import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsPageHeader } from "@opencraft/extension-react";
import { useAppearanceTheme } from "../appearance-theme";
import { requestMobileHaptic } from "../runtime/mobile-valdi-bridge";
import { useTurnNotifications } from "../runtime/turn-notifications-context";
import type { TurnNotificationSnapshot } from "../runtime/turn-notification-controller";
import { useUiPreferencesRuntime } from "../runtime/ui-preferences-runtime";
import { useDefaultFollowUpAction } from "../runtime/use-default-follow-up-action";
import { useOpenPagesInRightPanel } from "../runtime/use-open-pages-in-right-panel";
import { useOptionalAsyncNotices } from "./async-notices";
import { NotificationDestinationSettings } from "./notification-destination-settings";
import "./valdi-surfaces.scss";

const UNAVAILABLE_TURN_NOTIFY: TurnNotificationSnapshot = {
  supported: false,
  permission: "denied",
  enabled: false,
  busy: false,
  delivery: "page",
  backgroundAvailable: false,
  testSent: false,
  error: null,
};
const NO_SUBSCRIBE = () => () => undefined;
const GET_UNAVAILABLE = () => UNAVAILABLE_TURN_NOTIFY;
const UNAVAILABLE_DESTINATIONS = { phase: "unavailable" as const, configuration: null, busy: null };
const GET_UNAVAILABLE_DESTINATIONS = () => UNAVAILABLE_DESTINATIONS;

const LazyValdiChatSettings = lazy(async () => {
  const mod = await import("@opencraft/design-system-web/valdi");
  function ChatSettingsMount({
    viewModel,
  }: {
    readonly viewModel: import("@opencraft/design-system-web/valdi").ChatSettingsProps;
  }) {
    return (
      <mod.ValdiSurface
        component={mod.ChatSettingsSurface}
        viewModel={viewModel}
        className="valdi-chat-settings-surface"
        data-testid="valdi-chat-settings-surface"
      />
    );
  }
  return { default: ChatSettingsMount };
});

export function ChatSettings({
  agentManagement,
  onOpenImSettings,
}: {
  readonly agentManagement?: ReactNode;
  readonly onOpenImSettings?: () => void;
} = {}) {
  const intl = useIntl();
  const appearance = useAppearanceTheme();
  const notices = useOptionalAsyncNotices();
  const preferences = useUiPreferencesRuntime();
  const defaultFollowUpAction = useDefaultFollowUpAction();
  const openPagesInRightPanel = useOpenPagesInRightPanel();
  const controller = useTurnNotifications();

  const notifyState = useSyncExternalStore(
    controller?.subscribe ?? NO_SUBSCRIBE,
    controller?.getSnapshot ?? GET_UNAVAILABLE,
    controller?.getSnapshot ?? GET_UNAVAILABLE,
  );
  const destinationsState = useSyncExternalStore(
    controller?.destinations.subscribe ?? NO_SUBSCRIBE,
    controller?.destinations.getSnapshot ?? GET_UNAVAILABLE_DESTINATIONS,
    controller?.destinations.getSnapshot ?? GET_UNAVAILABLE_DESTINATIONS,
  );

  useEffect(() => {
    void controller?.refresh();
  }, [controller]);

  const [saveError, setSaveError] = useState(false);
  const savingFollowUpRef = useRef(false);
  const savingRightPanelRef = useRef(false);

  const notifyErrorText = useMemo(() => {
    if (!notifyState.error) return undefined;
    if (notifyState.error === "permission") {
      return intl.formatMessage({
        id: "settings.chat.turnNotifications.permissionRequired",
        defaultMessage: "Notification permission was not granted. You can enable it again when ready.",
      });
    }
    if (notifyState.error === "save") {
      return intl.formatMessage({
        id: "settings.chat.saveError",
        defaultMessage: "Could not save your preference. Please try again.",
      });
    }
    if (notifyState.error === "delivery") {
      return intl.formatMessage({
        id: "settings.chat.turnNotifications.showError",
        defaultMessage:
          "The browser could not display a notification. Check your browser and system notification settings.",
      });
    }
    return intl.formatMessage({
      id: "settings.push.error",
      defaultMessage:
        "Could not update push notifications. Check your connection and notification permission, then try again.",
    });
  }, [intl, notifyState.error]);

  useEffect(() => {
    if (notifyErrorText) {
      notices?.error({ key: "chat:turn-notifications", message: notifyErrorText });
    }
  }, [notices, notifyErrorText]);

  useEffect(() => {
    if (notifyState.testSent) {
      notices?.info({
        key: "chat:turn-notifications-test",
        message: intl.formatMessage({
          id: "settings.push.testSent",
          defaultMessage: "Test sent to the push service. Check your device notifications.",
        }),
      });
    }
  }, [intl, notices, notifyState.testSent]);

  const background = notifyState.delivery === "background" || (!notifyState.enabled && notifyState.backgroundAvailable);
  const notifyDescription = !notifyState.supported
    ? intl.formatMessage({
        id: "settings.chat.turnNotifications.unsupported",
        defaultMessage: "Browser notifications are unavailable here. Use a supported browser on HTTPS.",
      })
    : notifyState.permission === "denied"
      ? intl.formatMessage({
          id: "settings.chat.turnNotifications.denied",
          defaultMessage:
            "Notifications are blocked. Allow them in your browser's site settings, then return here.",
        })
      : background
        ? intl.formatMessage({
            id: "settings.chat.turnNotifications.background",
            defaultMessage:
              "Receive notifications when responses on this server complete, fail or stop, even after closing this app. Other servers require this page to remain open.",
          })
        : intl.formatMessage({
            id: "settings.chat.turnNotifications.description",
            defaultMessage:
              "Receive a browser notification after each response completes, fails or stops, including while viewing this page. The page must remain open.",
          });

  const hasExternalDestinations = Boolean(controller && destinationsState.configuration);
  const chatTitle = intl.formatMessage({ id: "settings.chat", defaultMessage: "Chat" });

  const errorMessage = saveError
    ? intl.formatMessage({
        id: "settings.chat.saveError",
        defaultMessage: "Could not save your preference. Please try again.",
      })
    : !hasExternalDestinations
      ? notifyErrorText
      : undefined;

  const handleChangeImmediateFollowUp = useCallback(
    (checked: boolean) => {
      if (savingFollowUpRef.current) return;
      savingFollowUpRef.current = true;
      setSaveError(false);
      void preferences
        .set("chat.defaultFollowUpAction", checked ? "steer" : "queue")
        .catch(() => setSaveError(true))
        .finally(() => {
          savingFollowUpRef.current = false;
        });
    },
    [preferences],
  );

  const handleChangeOpenPagesInRightPanel = useCallback(
    (checked: boolean) => {
      if (savingRightPanelRef.current) return;
      savingRightPanelRef.current = true;
      setSaveError(false);
      void preferences
        .set("chat.openPagesInRightPanel", checked)
        .catch(() => setSaveError(true))
        .finally(() => {
          savingRightPanelRef.current = false;
        });
    },
    [preferences],
  );

  const handleChangeNotifyEnabled = useCallback(
    (enabled: boolean) => {
      if (notifyState.busy) return;
      void controller?.setEnabled(enabled);
    },
    [controller, notifyState.busy],
  );

  const handleTestNotification = useCallback(() => {
    void controller?.test();
  }, [controller]);

  const handleHaptic = useCallback((style: string) => {
    requestMobileHaptic(style === "warning" ? "warning" : style === "light" ? "light" : "selection");
  }, []);

  const viewModel: import("@opencraft/design-system-web/valdi").ChatSettingsProps = useMemo(
    () => ({
      dark: appearance.resolvedTheme === "dark",
      badgeLabel: intl.formatMessage({
        id: "settings.chat.valdiBadge",
        defaultMessage: "Conversation & Alerts",
      }),
      title: chatTitle,
      subtitle: intl.formatMessage({
        id: "settings.chat.valdiSubtitle",
        defaultMessage: "Configure follow-up steering, web link behavior, and completion notifications.",
      }),
      behaviorGroupTitle: intl.formatMessage({
        id: "settings.chat.valdiBehaviorGroup",
        defaultMessage: "Response & Browsing",
      }),
      followUpTitle: intl.formatMessage({
        id: "settings.chat.immediateFollowUp",
        defaultMessage: "Follow up immediately while responding",
      }),
      followUpDescription: intl.formatMessage({
        id: "settings.chat.immediateFollowUp.description",
        defaultMessage:
          "New messages guide the current response. Turn this off to queue them for the next response. Temporary side chats always follow up immediately.",
      }),
      immediateFollowUp: defaultFollowUpAction === "steer",
      rightPanelTitle: intl.formatMessage({
        id: "settings.chat.openPagesInRightPanel",
        defaultMessage: "Open web pages in right panel",
      }),
      rightPanelDescription: intl.formatMessage({
        id: "settings.chat.openPagesInRightPanel.description",
        defaultMessage:
          "Open clicked links and agent-launched web pages in the right-side browser panel. Turn this off to open links in your external browser and keep agent pages in the background.",
      }),
      openPagesInRightPanel,
      externalNotificationsOwner: hasExternalDestinations,
      notificationsGroupTitle: intl.formatMessage({
        id: "settings.chat.valdiNotificationsGroup",
        defaultMessage: "Completion Notifications",
      }),
      notifyTitle: intl.formatMessage({
        id: "settings.chat.turnNotifications",
        defaultMessage: "Notify when a response ends",
      }),
      notifyDescription,
      notifyEnabled: notifyState.enabled,
      notifyDisabled: !notifyState.supported,
      notifyBusy: notifyState.busy,
      showTestNotification: notifyState.enabled && notifyState.delivery === "background",
      testNotifyLabel: intl.formatMessage({
        id: "settings.push.testLabel",
        defaultMessage: "Check notification delivery",
      }),
      testNotifyActionLabel: intl.formatMessage({
        id: "settings.push.test",
        defaultMessage: "Send test notification",
      }),
      connectImLabel: onOpenImSettings
        ? intl.formatMessage({ id: "settings.notifications.connectIm", defaultMessage: "Open IM settings" })
        : undefined,
      errorMessage,
      onChangeImmediateFollowUp: handleChangeImmediateFollowUp,
      onChangeOpenPagesInRightPanel: handleChangeOpenPagesInRightPanel,
      onChangeNotifyEnabled: handleChangeNotifyEnabled,
      onTestNotification: handleTestNotification,
      onOpenImSettings,
      onHaptic: handleHaptic,
    }),
    [
      appearance.resolvedTheme,
      chatTitle,
      defaultFollowUpAction,
      errorMessage,
      handleChangeImmediateFollowUp,
      handleChangeNotifyEnabled,
      handleChangeOpenPagesInRightPanel,
      handleHaptic,
      handleTestNotification,
      hasExternalDestinations,
      intl,
      notifyDescription,
      notifyState.busy,
      notifyState.delivery,
      notifyState.enabled,
      notifyState.supported,
      onOpenImSettings,
      openPagesInRightPanel,
    ],
  );

  return (
    <>
      <Suspense fallback={<SettingsPageHeader title={chatTitle} />}>
        <LazyValdiChatSettings viewModel={viewModel} />
      </Suspense>
      {agentManagement}
      {hasExternalDestinations && controller ? (
        <NotificationDestinationSettings
          controller={controller}
          onOpenImSettings={onOpenImSettings}
          local={notifyState}
          localDescription={notifyDescription}
        />
      ) : null}
    </>
  );
}
