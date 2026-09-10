# Conversation panel ownership

The right panel uses the active conversation `scopeId`, not a browser-history
`viewId`. Draft promotion keeps that scope; revisiting a thread resolves its
existing scope. Navigation remains independently keyed by history entry.

- Panel tabs, selection, visibility and full-width state belong to the scope.
- Browser pages/tabs and terminal sessions belong to application-level resource
  directories keyed by the stable scope. They never retain the evictable scope.
- Panel renderers receive two identities: `ownerId` for stable logical state and
  `presentationId` for the current route/WebView surface. Browser geometry and
  handoff use only the latter.
- Route-view disposal releases only physical browser presentation mappings.
  Thread-scope LRU disposal releases only cached panel state. It does not delete
  a bound conversation alias, kill a PTY, or destroy a browser page.
- If cached panel state is later recreated, plugin resource directories rebuild
  its Browser and Terminal tab descriptors. The outlet starts closed, matching
  Codex's no-retained-ThreadScope fallback.
- Dismissing an unbound Draft is logical deletion: its orphaned resources and
  unbound alias are released when that scope disappears.
- Only `close` invokes terminal termination. `owner-release`, replacement and
  plugin unregistration must not masquerade as user close intent.
- Failed terminal creation never registers a phantom resource. Failed
  termination keeps the session registered; it is not falsely reported as
  disposed.

Browser resources have Web storage reconstruction. Terminal resource ownership
is currently application-process scoped; remote PTY enumeration alone cannot
recover a conversation association after a full renderer restart without a
persisted ownership directory.

Regression coverage: `tests/panel-conversation-ownership.test.ts`, plus existing
panel, browser-runtime, terminal and navigation suites.
