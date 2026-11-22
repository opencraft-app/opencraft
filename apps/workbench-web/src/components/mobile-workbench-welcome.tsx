import { useId } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { Button } from "@opencraft/design-system-web/button";
import { mobileConnectionMessages } from "./mobile-connection-messages";
import "./mobile-workbench-welcome.scss";

export function MobileWorkbenchWelcome({ onConnect, onExplore }: {
  readonly onConnect: () => void;
  readonly onExplore: () => void;
}) {
  const intl = useIntl();
  const titleId = useId();
  const connectDescriptionId = useId();
  const exploreDescriptionId = useId();

  return (
    <section className="mobile-workbench-welcome" aria-labelledby={titleId}>
      <h1 id={titleId}>{intl.formatMessage({ id: "welcome.title", defaultMessage: "Welcome to OpenCraft" })}</h1>
      <div className="mobile-workbench-welcome__choices">
        <div className="mobile-workbench-welcome__choice">
          <Button variant="primary" aria-describedby={connectDescriptionId} onClick={onConnect}>
            {intl.formatMessage(mobileConnectionMessages.title)}
          </Button>
          <p id={connectDescriptionId}>{intl.formatMessage({
            id: "mobile.welcome.connectDescription",
            defaultMessage: "Use your OpenCraft server to chat and run agents.",
          })}</p>
        </div>
        <div className="mobile-workbench-welcome__choice">
          <Button variant="secondary" aria-describedby={exploreDescriptionId} onClick={onExplore}>
            {intl.formatMessage({ id: "mobile.welcome.explore", defaultMessage: "Explore without a server" })}
          </Button>
          <p id={exploreDescriptionId}>{intl.formatMessage({
            id: "mobile.welcome.exploreDescription",
            defaultMessage: "Browse the workspace and customize its appearance. You can connect a server later in Settings.",
          })}</p>
        </div>
      </div>
    </section>
  );
}
