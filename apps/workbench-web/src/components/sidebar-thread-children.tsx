import { useEffect, useId, useState, type ReactNode } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { DisclosureButton } from "@opencraft/design-system-web/button";
import { ChevronDownIcon } from "@opencraft/design-system-web/action-icons";
import { sidebarThreadIdentity, type SidebarThreadTreeNode } from "../sidebar-thread-tree";
import type { SidebarThread } from "./sidebar";

export function SidebarThreadChildren({
  children,
  selectedPath,
  selection,
  searching,
  renderNode,
}: {
  readonly children: readonly SidebarThreadTreeNode<SidebarThread>[];
  readonly selectedPath: ReadonlySet<string>;
  readonly selection: string;
  readonly searching: boolean;
  readonly renderNode: (node: SidebarThreadTreeNode<SidebarThread>) => ReactNode;
}) {
  const intl = useIntl();
  const id = useId();
  const visible = children.slice(0, 3);
  const earlier = children.slice(3);
  const revealSelection = earlier.some((node) => selectedPath.has(sidebarThreadIdentity(node.thread)))
    ? selection
    : null;
  const [expanded, setExpanded] = useState(revealSelection !== null);
  useEffect(() => {
    if (revealSelection !== null) setExpanded(true);
  }, [revealSelection]);
  if (searching || !earlier.length)
    return (
      <ul className="sidebar-thread-tree__children" role="list">
        {(searching ? children : visible).map(renderNode)}
      </ul>
    );
  const showEarlier = expanded;
  return (
    <ul className="sidebar-thread-tree__children" role="list">
      {visible.map(renderNode)}
      <li className="sidebar-thread-tree__earlier">
        <DisclosureButton
          className="sidebar-thread-tree__child-toggle"
          aria-expanded={showEarlier}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDownIcon size={12} aria-hidden="true" className={showEarlier ? undefined : "is-collapsed"} />
          <span>
            {intl.formatMessage(
              { id: "sidebar.children.more", defaultMessage: "More sub-agents ({count})" },
              { count: earlier.length },
            )}
          </span>
        </DisclosureButton>
        <ul id={id} className="sidebar-thread-tree__earlier-items" role="list" hidden={!showEarlier}>
          {showEarlier ? earlier.map(renderNode) : null}
        </ul>
      </li>
    </ul>
  );
}
