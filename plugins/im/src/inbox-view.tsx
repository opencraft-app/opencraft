import { useIntl } from "@opencraft/i18n/react";
import type { ComponentType } from "react";
import type { ExtensionSettingsViewProps } from "@opencraft/extension-react";

/** Both directory and chat routes resolve to this same Component identity.
 * Route activation selects the group; shared ChannelRuntime owns all data. */
export function createInboxView({
  Directory,
  Conversation,
  chatViewId,
}: {
  Directory: ComponentType<ExtensionSettingsViewProps>;
  Conversation: ComponentType<ExtensionSettingsViewProps>;
  chatViewId: string;
}) {
  return function Inbox(props: ExtensionSettingsViewProps) {
    const intl = useIntl(),
      MasterDetail = props.regions?.MasterDetail;
    const selected = props.activation.viewId === chatViewId;
    if (!MasterDetail) return selected ? <Conversation {...props} /> : <Directory {...props} />;
    return (
      <MasterDetail
        master={<Directory {...props} />}
        masterLabel={intl.formatMessage({ id: "people.title", defaultMessage: "Inbox" })}
        detailSelected={selected}
        detail={({ Header }) =>
          selected ? (
            <Conversation {...props} regions={{ ...props.regions, Header }} />
          ) : (
            <div className="im-inbox-empty" role="status">
              <p>
                {intl.formatMessage({
                  id: "im.channels.selectChat",
                  defaultMessage: "Select a chat to start reading.",
                })}
              </p>
            </div>
          )
        }
      />
    );
  };
}
