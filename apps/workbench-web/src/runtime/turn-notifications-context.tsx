import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { useStableEvent } from "@opencraft/react-runtime";
import { createWorkbenchThreadLocation, type TurnCompletionObserver, type TurnCompletion } from "@opencraft/workbench-runtime";
import { TurnNotificationController } from "./turn-notification-controller";
import { useUiPreferencesRuntime } from "./ui-preferences-runtime";

const TurnNotificationsContext = createContext<TurnNotificationController | null>(null);

/** Both standalone and embedded RuntimeProviders consume the same platform port. */
export function TurnNotificationsProvider({ source, notifications, openConversation, children }: {
  readonly source: TurnCompletionObserver;
  readonly notifications: TurnNotificationController;
  readonly openConversation: (location: ReturnType<typeof createWorkbenchThreadLocation>) => Promise<boolean>;
  readonly children: ReactNode;
}) {
  const preferences = useUiPreferencesRuntime();
  const intl = useIntl();
  const open = useStableEvent((completion: TurnCompletion) => {
    void openConversation(createWorkbenchThreadLocation(completion.hostId, completion.threadId)).catch(() => undefined);
  });
  const completed = useStableEvent((completion: TurnCompletion) => {
    const title = completion.status === "failed"
      ? intl.formatMessage({ id: "notifications.turn.failed", defaultMessage: "OpenCraft · Response failed" })
      : completion.status === "interrupted"
        ? intl.formatMessage({ id: "notifications.turn.interrupted", defaultMessage: "OpenCraft · Response stopped" })
        : intl.formatMessage({ id: "notifications.turn.completed", defaultMessage: "OpenCraft · Response complete" });
    const contextualTitle = completion.threadTitle
      ? intl.formatMessage({ id: "notifications.turn.contextTitle", defaultMessage: "{threadTitle} · {status}" }, { threadTitle: completion.threadTitle, status: title })
      : title;
    const body = completion.userMessage
      ? intl.formatMessage({ id: "notifications.turn.userMessage", defaultMessage: "You: {message}" }, { message: completion.userMessage })
      : intl.formatMessage({ id: "notifications.turn.body", defaultMessage: "Click to return to the conversation." });
    void notifications.show(completion, contextualTitle, body, () => open(completion));
  });
  useEffect(() => {
    notifications.configure(intl.locale, {
      completed: intl.formatMessage({ id: "notifications.turn.completed", defaultMessage: "OpenCraft · Response complete" }),
      failed: intl.formatMessage({ id: "notifications.turn.failed", defaultMessage: "OpenCraft · Response failed" }),
      interrupted: intl.formatMessage({ id: "notifications.turn.interrupted", defaultMessage: "OpenCraft · Response stopped" }),
      body: intl.formatMessage({ id: "notifications.turn.body", defaultMessage: "Click to return to the conversation." }),
      test: intl.formatMessage({ id: "notifications.push.test", defaultMessage: "OpenCraft · Notifications enabled" }),
    });
  }, [notifications, intl]);
  useEffect(() => {
    const stopPreferences = notifications.connect(preferences);
    const stopSource = source.subscribe(completed);
    const stopClicks = notifications.observeClicks(open);
    const refresh = () => { if (document.visibilityState === "visible") void notifications.refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopPreferences(); stopSource(); stopClicks();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [source, preferences, notifications, open, completed]);
  return <TurnNotificationsContext.Provider value={notifications}>{children}</TurnNotificationsContext.Provider>;
}

export function useTurnNotifications(): TurnNotificationController | null {
  return useContext(TurnNotificationsContext);
}
