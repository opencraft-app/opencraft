import "./annotation-toggle.scss";
import { EditIcon } from "@opencraft/design-system-web/action-icons";
import { IconButton } from "@opencraft/design-system-web/button";
import { defineMessages } from "@opencraft/i18n";
import { useIntl } from "@opencraft/i18n/react";
import type { BrowserAnnotationController } from "./use-browser-annotation";

const messages = defineMessages({
  enter: {
    id: "browserAnnotation.toggle.enter",
    defaultMessage: "Annotate page",
    description:
      "Browser toolbar button that enters annotation mode, where clicking an element of the web page attaches a comment for the agent",
  },
  exit: {
    id: "browserAnnotation.toggle.exit",
    defaultMessage: "Exit annotation",
    description:
      "Browser toolbar button label while annotation mode is on; pressing it returns the page to normal browsing",
  },
  blocked: {
    id: "browserAnnotation.toggle.blocked",
    defaultMessage: "The agent is using this page",
    description: "Tooltip of the disabled annotate button while the agent is controlling the in-app browser",
  },
});

/** Desktop toolbar button, or the touch dock button with `touchChrome`. */
export function BrowserAnnotationToggle({
  controller,
  blocked,
  touchChrome = false,
}: {
  readonly controller: BrowserAnnotationController;
  readonly blocked: boolean;
  readonly touchChrome?: boolean;
}) {
  const intl = useIntl();
  if (!controller.available) return null;
  const label = intl.formatMessage(blocked ? messages.blocked : controller.active ? messages.exit : messages.enter);
  const content = (
    <>
      <EditIcon size={touchChrome ? undefined : 14} aria-hidden="true" />
      {controller.count > 0 && !controller.active ? (
        <span className="browser-annotation-count" aria-hidden="true">
          {controller.count}
        </span>
      ) : null}
    </>
  );
  if (touchChrome)
    return (
      <IconButton
        type="button"
        className="panel-mobile-dock__button browser-annotation-toggle"
        aria-label={label}
        aria-pressed={controller.active}
        disabled={blocked && !controller.active}
        data-active={controller.active || undefined}
        onClick={controller.toggle}
      >
        {content}
      </IconButton>
    );
  return (
    <button
      type="button"
      className="browser-toolbar-button browser-annotation-toggle"
      aria-label={label}
      title={label}
      aria-pressed={controller.active}
      disabled={blocked && !controller.active}
      data-active={controller.active || undefined}
      onClick={controller.toggle}
    >
      {content}
    </button>
  );
}
