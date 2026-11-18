import React, { useState } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { ModalHost } from "../../apps/workbench-web/src/components/modal/modal-host";
import { sideChatCloseRequest } from "../../apps/workbench-web/src/components/side-chat-close-request";
import { WorkspaceFilePath } from "../../apps/workbench-web/src/panels/workspace-file-path";
import "../../apps/workbench-web/src/panels/workspace-resource-panel.scss";

export function FilePathRegression() {
  const [path, setPath] = useState('/workspace/opencraft/packages/sandbox-node/src/lifecycle.ts');
  return <WorkspaceFilePath path={path} onSelect={setPath} />;
}

export function SideChatCloseRegression() {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  Object.assign(window, { showSideChatClose: () => setOpen(true) });
  return <ModalHost requests={[open && sideChatCloseRequest(intl, () => {
    (window as any).sideChatCloseCount = ((window as any).sideChatCloseCount ?? 0) + 1;
    setOpen(false);
  }, () => setOpen(false))]} />;
}
