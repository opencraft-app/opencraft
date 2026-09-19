# Agents console presentation

This directory owns rendering, keyboard/focus behavior and responsive composition only. The page retains Bot identity, eligibility, queries, SDK callbacks, repository calls, creation and maintenance state.

- `AgentConsoleShell`: controlled navigation Sheet on mobile; persistent content slot on desktop and mobile. Only one navigation tree is mounted. The host closes the Sheet on route, Bot or breakpoint changes. On desktop, the existing 68px header and fixed sidebar cover the viewport; profile/footer do not shrink, and the middle slot alone scrolls with hidden scrollbars. Account popups must use a Portal so sidebar clipping cannot hide them. The loading view mirrors these slot boundaries.
- The desktop shell owns decorative scroll-edge shadows: hidden content above/below the middle slot shows the corresponding profile/footer shadow, with a 1px boundary tolerance. It observes both viewport and content size, removes listeners/observers on desktop exit or unmount, and never changes scroll position or business data. Pseudo-elements use the existing gaps without animation, layout changes or pointer interception; mobile retains its existing Sheet.
- Sidebar colors belong to the Agents-scoped presentation CSS: white header/sidebar with a continuous subtle border, `#f2f2ef` selected navigation/session rows and `#171717` text/icons at weight 600. Inactive hover uses `#f7f7f5`; active hover retains the selected color. A session's background belongs to its complete row, including the separate menu button; navigation and menu remain independent controls.
- Agent Tabs opt into `components/agents/agent-tabs.tsx`: `segmented` uses a light track and white bordered selection; `underline` uses transparent labels and a 2px active underline. List and trigger declare the same variant. Form choices use `AgentChoiceGroup` / Radix RadioGroup with a selected border and check; they are not tabs without panels. There is no global active-tab recoloring; public/shared Tabs defaults remain unchanged. `data-agent-tabs-variant` and the shared theme tokens form the OpenCraft host styling boundary, including portals and dark themes.
- `ConsoleBotProfile`: avatar, name/status column, maintenance actions, then an optional controlled selector with `{ id, label }` options. Names truncate without shrinking actions; the arrow exists only for multiple options. Status, renewal and maintenance actions remain separate slots, never nested inside the selector button.
- `ConsoleSidebarTabs`: controlled `settings | chat`; Radix handles arrow navigation. A repeat click/Enter/Space on the selected tab still invokes the host intent once. Its local B treatment composes the existing segmented variant: 40px light track, 4px padding/gap, no outer or trigger border, white active item with `shadow-sm`, and transparent inactive items. The two triggers share one local class contract, with no added animation; keyboard focus and unavailable Chat descriptions remain. This does not change shared Tabs/AgentTabs defaults or other consumers.
- `ConsoleNavigation`: ordered groups and precomputed hrefs. Each mounted instance generates unique group label IDs.
- `ConsoleSessionList`: receives DTOs, drafts and menu state. The empty string is a valid session ID. Rename/delete callbacks receive IDs, not SDK objects. The host maps these back to its current session data.
- Loading follows the same slot boundaries: the first session fetch shows a row-sized shared `Skeleton` while retaining the navigation region; later refreshes keep existing sessions and use local `Spinner` feedback. The list does not own fetching, retries or scroll position.
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
