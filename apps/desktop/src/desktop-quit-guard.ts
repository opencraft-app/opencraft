import type { IntlPort } from "@opencraft/i18n";
import type { DesktopQuitDecision, DesktopQuitSource } from "./desktop-lifecycle.js";

export type PersistedQuitBehavior = "ask" | "hide" | "quit";

export interface QuitConfirmationDialogSpec {
  readonly type: "question" | "warning";
  readonly message: string;
  readonly detail: string;
  readonly buttons: string[];
  readonly defaultId: number;
  readonly cancelId: number;
  readonly checkboxLabel?: string;
  readonly checkboxChecked?: boolean;
}

export interface QuitConfirmationDialogResult {
  readonly response: number;
  readonly checkboxChecked: boolean;
}

export interface EvaluateDesktopQuitOptions {
  readonly source: DesktopQuitSource;
  readonly relayEnrolled: boolean;
  readonly activeTaskCount: number;
  readonly locale: IntlPort;
  readonly readSavedBehavior: () => PersistedQuitBehavior;
  readonly writeSavedBehavior: (behavior: PersistedQuitBehavior) => void;
  readonly showDialog: (spec: QuitConfirmationDialogSpec) => Promise<QuitConfirmationDialogResult>;
}

/**
 * Evaluates whether a quit request should shut down immediately, hide the main
 * window to keep background work alive, or cancel.
 *
 * - Shortcut/app quit (`source === "app"`): guards both Remote Control and active
 *   local tasks, offering `[Keep Running in Background, Quit Completely, Cancel]`
 *   with an optional "Remember my choice" checkbox.
 * - Explicit Tray quit (`source === "tray"`): never silently hides (so the user
 *   can always exit from the Tray), quitting immediately when no local tasks are
 *   mid-execution and confirming `[Cancel, Quit Completely]` when tasks are active.
 */
export async function evaluateDesktopQuit(options: EvaluateDesktopQuitOptions): Promise<DesktopQuitDecision> {
  const tasksRunning = options.activeTaskCount > 0;
  const relayActive = options.relayEnrolled;

  if (options.source === "tray") {
    if (!tasksRunning) return "quit";
    const intl = options.locale.getSnapshot().intl;
    const cancelLabel = intl.formatMessage({
      id: "desktop.quitConfirm.cancel",
      defaultMessage: "Cancel",
    });
    const quitNowLabel = intl.formatMessage({
      id: "desktop.quitConfirm.quitNow",
      defaultMessage: "Quit Completely",
    });
    const result = await options.showDialog({
      type: "warning",
      message: intl.formatMessage(
        {
          id: "desktop.quitConfirm.tasks.title",
          defaultMessage:
            "{count, plural, one {# local task is still running} other {# local tasks are still running}}",
        },
        { count: options.activeTaskCount },
      ),
      detail: intl.formatMessage({
        id: "desktop.quitConfirm.trayTasks.detail",
        defaultMessage: "Quitting completely will stop active local tasks immediately.",
      }),
      buttons: [cancelLabel, quitNowLabel],
      defaultId: 0,
      cancelId: 0,
    });
    return result.response === 1 ? "quit" : "cancel";
  }

  if (!relayActive && !tasksRunning) {
    return "quit";
  }

  const saved = options.readSavedBehavior();
  if (saved === "hide") return "hide";
  if (saved === "quit") return "quit";

  const intl = options.locale.getSnapshot().intl;
  const keepRunningLabel = intl.formatMessage({
    id: "desktop.quitConfirm.keepRunning",
    defaultMessage: "Keep Running in Background",
  });
  const quitNowLabel = intl.formatMessage({
    id: "desktop.quitConfirm.quitNow",
    defaultMessage: "Quit Completely",
  });
  const cancelLabel = intl.formatMessage({
    id: "desktop.quitConfirm.cancel",
    defaultMessage: "Cancel",
  });
  const message =
    relayActive && tasksRunning
      ? intl.formatMessage({
          id: "desktop.quitConfirm.both.title",
          defaultMessage: "Remote Control and local tasks are running",
        })
      : relayActive
        ? intl.formatMessage({
            id: "desktop.quitConfirm.relay.title",
            defaultMessage: "Remote Control is active",
          })
        : intl.formatMessage(
            {
              id: "desktop.quitConfirm.tasks.title",
              defaultMessage:
                "{count, plural, one {# local task is still running} other {# local tasks are still running}}",
            },
            { count: options.activeTaskCount },
          );

  const result = await options.showDialog({
    type: "question",
    message,
    detail: intl.formatMessage({
      id: "desktop.quitConfirm.app.detail",
      defaultMessage:
        "Hiding keeps OpenCraft running in the background so remote devices stay connected and active tasks can finish. Quitting completely will disconnect Remote Control and stop local tasks.",
    }),
    buttons: [keepRunningLabel, quitNowLabel, cancelLabel],
    defaultId: 0,
    cancelId: 2,
    checkboxLabel: intl.formatMessage({
      id: "desktop.quitConfirm.remember",
      defaultMessage: "Remember my choice when pressing Quit",
    }),
    checkboxChecked: false,
  });

  if (result.response === 0) {
    if (result.checkboxChecked) options.writeSavedBehavior("hide");
    return "hide";
  }
  if (result.response === 1) {
    if (result.checkboxChecked) options.writeSavedBehavior("quit");
    return "quit";
  }
  return "cancel";
}
