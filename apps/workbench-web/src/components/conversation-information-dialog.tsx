import { CopyIcon as Copy, FolderIcon as Folder, TerminalIcon as SquareTerminal } from "@opencraft/design-system-web/action-icons";

import { useIntl } from "@opencraft/i18n/react";
import { SettingsCopyButton } from "@opencraft/extension-react";
import { ModalSurface } from "./modal";
import { InformationPanel, InformationRow } from "./modal/information-panel";
import { AdaptiveSheetHandle } from "./modal/adaptive-sheet-handle";

/** Loaded on demand; the caller retains the confirmed, read-only metadata. */
export default function ConversationInformationDialog({ project, workspaceDirectory, onDismiss, returnFocus }: {
  readonly project?: string;
  readonly workspaceDirectory?: string;
  readonly onDismiss: () => void;
  readonly returnFocus: () => HTMLElement | null;
}) {
  const intl = useIntl();
  const title = intl.formatMessage({ id: "chat.details.title", defaultMessage: "Conversation info" });
  return <ModalSurface label={title} size="compact" appearance="utility" presentation="adaptive-sheet"
    closeLabel={intl.formatMessage({ id: "common.close", defaultMessage: "Close" })}
    onDismiss={onDismiss} returnFocus={returnFocus}>
    <AdaptiveSheetHandle onDismiss={onDismiss} />
    <InformationPanel title={title}>
      {project ? <InformationRow icon={<Folder />} label={intl.formatMessage({ id: "chat.details.project", defaultMessage: "Project" })} value={project} /> : null}
      {workspaceDirectory ? <InformationRow icon={<SquareTerminal />} label={intl.formatMessage({ id: "chat.details.directory", defaultMessage: "Working directory" })}
        value={workspaceDirectory} monospace actions={<SettingsCopyButton value={workspaceDirectory} icon={<Copy />} iconOnly
          label={intl.formatMessage({ id: "chat.details.copyDirectory", defaultMessage: "Copy working directory" })}
          successLabel={intl.formatMessage({ id: "common.copied", defaultMessage: "Copied" })}
          errorLabel={intl.formatMessage({ id: "chat.details.copyFailed", defaultMessage: "Could not copy. Select the path to copy manually." })} />} /> : null}
    </InformationPanel>
  </ModalSurface>;
}
