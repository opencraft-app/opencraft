import React from "react";
import { ActionGlyph, type ActionIconProps } from "./icon-glyph";

function SidebarFrame() {
  return <>
    <rect x="4.5" y="4.5" width="15" height="15" rx="2.75" />
    <path d="M10 4.5v15" />
  </>;
}

export function SidebarLayoutIcon(props: ActionIconProps) {
  return <ActionGlyph {...props} kind="sidebar-layout"><SidebarFrame /></ActionGlyph>;
}

export function SidebarCollapseLayoutIcon(props: ActionIconProps) {
  return <ActionGlyph {...props} kind="sidebar-collapse-layout">
    <SidebarFrame />
    <path d="m15 9-3 3 3 3m-3-3h5.5" />
  </ActionGlyph>;
}
