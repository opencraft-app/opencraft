/** Reviewed pure EO body from Codex 26.930.31428/build 12913:
 * unpacked/webview/assets/sites-end-resource-b8a510733e15.js.
 * Only the ordinary-task policy is consumed here. This small oracle is kept
 * portable: tests do not require a developer's private extracted-app directory
 * or pretend that React/service ports validate the complete original UI. */
export function originalTaskDisclosure({ hasFinalAssistantStarted: e, isTurnCancelled: t,
  hasRenderableAgentItems: n, allowCollapseBeforeFinal: r = false, forceExpanded: i = false,
  preventAutoCollapse: a, persistedCollapsed: o }: {
    hasFinalAssistantStarted: boolean; isTurnCancelled: boolean; hasRenderableAgentItems: boolean;
    allowCollapseBeforeFinal?: boolean; forceExpanded?: boolean; preventAutoCollapse?: boolean; persistedCollapsed?: boolean;
  }) {
  return (r || e && !t) && n
    ? { shouldAllowCollapse: true, isCollapsed: !i && (o ?? !a) }
    : { shouldAllowCollapse: false, isCollapsed: false };
}
