import type {ReactNode} from "react";

import {PlatformFrame, type PlatformFrameProps} from "./app-frame";
import {workspaceSectionBody} from "./workspace-chrome";

export type ManagementScreenFrameProps = Omit<PlatformFrameProps, "children"> & {
  children: ReactNode;
  /**
   * When true, wrap in PlatformFrame (standalone / Style Lab). When false, the
   * parent WorkspaceChrome already owns the rail — emit section body only.
   */
  framed: boolean;
};

/**
 * One dual-path for every management screen: framed PlatformFrame vs chrome-
 * hosted section body. Screens must not re-copy the ternary.
 */
export function ManagementScreenFrame({
  children,
  framed,
  navigation = null,
  ...frameProps
}: ManagementScreenFrameProps) {
  if (framed) {
    return (
      <PlatformFrame {...frameProps} navigation={navigation}>
        {children}
      </PlatformFrame>
    );
  }
  return workspaceSectionBody(navigation, children);
}
