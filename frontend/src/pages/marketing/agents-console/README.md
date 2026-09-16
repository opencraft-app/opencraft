# Agents console presentation

This directory owns rendering, keyboard/focus behavior and responsive composition only. The page retains Bot identity, eligibility, queries, SDK callbacks, repository calls, creation and maintenance state.

- `AgentConsoleShell`: controlled navigation Sheet on mobile; persistent content slot on desktop and mobile. Only one navigation tree is mounted. The host closes the Sheet on route, Bot or breakpoint changes. On desktop, the existing 68px header and fixed sidebar cover the viewport; profile/footer do not shrink, and the middle slot alone scrolls with hidden scrollbars. Account popups must use a Portal so sidebar clipping cannot hide them. The loading view mirrors these slot boundaries.
- The desktop shell owns decorative scroll-edge shadows: hidden content above/below the middle slot shows the corresponding profile/footer shadow, with a 1px boundary tolerance. It observes both viewport and content size, removes listeners/observers on desktop exit or unmount, and never changes scroll position or business data. Pseudo-elements use the existing gaps without animation, layout changes or pointer interception; mobile retains its existing Sheet.
- Sidebar colors belong to the Agents-scoped presentation CSS: white header/sidebar with a continuous subtle border, white Tabs tracks, and `#dedede` selected navigation/session rows and Tabs with `#171717` text/icons at weight 600. Inactive hover uses the lighter `#f5f5f5`; active hover retains the selected color. Local cascade overrides preserve shared primitive defaults, geometry, disabled states and focus rings.
- `ConsoleBotProfile`: controlled selector with `{ id, label }` options. Status, renewal and maintenance actions are separate slots, never nested inside the selector button.
- `ConsoleSidebarTabs`: controlled `settings | chat`; Radix handles arrow navigation. A repeat click/Enter/Space on the selected tab still invokes the host intent once.
- `ConsoleNavigation`: ordered groups and precomputed hrefs. Each mounted instance generates unique group label IDs.
- `ConsoleSessionList`: receives DTOs, drafts and menu state. The empty string is a valid session ID. Rename/delete callbacks receive IDs, not SDK objects. The host maps these back to its current session data.
- `ConsoleConfirmDialog`: the host owns `open` and `pending`. Confirm prevents Radix's immediate auto-close; the host decides when work completes and closes. Pending blocks Cancel/Escape.
- `ConsoleEditDialog`: controlled edit surface with pending cancellation guards. Both dialog variants restore the captured trigger, or an explicit stable `returnFocusRef` when launched from a transient menu item.
- `ConsoleTooltip`: enabled controls are the native trigger (one Tab stop); disabled controls receive a focusable wrapper. Content is portalled and native text selection is preserved.

All labels/descriptions come from the caller. Portal surfaces explicitly use `agentPortalClassName` (`agents-ui`); the same opt-in scope defines compact radius tokens without changing external shared component defaults.

```tsx
<ConsoleConfirmDialog
  open={confirmOpen}
  onOpenChange={setConfirmOpen}
  pending={pending}
  title={title}
  description={description}
  confirmLabel={confirmLabel}
  cancelLabel={cancelLabel}
  onConfirm={runHostAction}
/>
```

Reference APIs: [Radix Tabs](https://www.radix-ui.com/primitives/docs/components/tabs), [Select](https://www.radix-ui.com/primitives/docs/components/select), [Dialog](https://www.radix-ui.com/primitives/docs/components/dialog), [AlertDialog async submission](https://www.radix-ui.com/primitives/docs/components/alert-dialog#close-after-asynchronous-form-submission).
