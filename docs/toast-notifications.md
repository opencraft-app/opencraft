# Toast notifications

Web/Electron and embedded Workbench share a notification owner through
`AsyncNoticesProvider` in `apps/workbench-web/src/components/async-notices.tsx`.
Features consume `useAsyncNotices()` rather than importing Sonner or rendering
error blocks near an action. Desktop and touch Shell headers do not display a
notification bell or reserve space for a notification-history entrance.
Native app presentations need their own platform adapter; this Web provider does
not claim to deliver operating-system/browser background notifications.

```tsx
const notices = useAsyncNotices();
notices.error({
  key: `pin:${hostId}:${threadId}`,
  message: intl.formatMessage({ id: "chat.pin.failed", defaultMessage: "Could not update pin. Try again." }),
  detail: conversationTitle,
});
```

Choose an accurate localized message for the operation. Never render raw RPC
errors, tokens, payloads or internal diagnostics. Keys include operation and
stable target identity; matching keys replace the current Toast and update one
history record. `info`, `success`, `warning` and `error` have the same contract.
Use notifications only for meaningful outcomes; successful background reads do
not need a Toast. An uncertain mutation result must not be automatically replayed
or described as certainly rejected.

Transient notifications appear top-right without changing content geometry or
moving focus. They normally expire in five seconds, can be closed manually and
show at most three at once. Sonner owns timing, keyboard/swipe and announcement
behavior; shared theme tokens own presentation. `dismiss(key)` and `dismissAll()`
only affect transient notices belonging to this provider.

The provider retains the current page session's last 50 records, newest first;
this history has no Shell header entrance. The optional `NotificationCenter`
consumer can read it when explicitly mounted by a host. A
repeat updates the record and occurrence count and becomes unread again.
Opening the center marks records read; arrivals while open are marked read.
Opening also dismisses transient overlays without deleting history. Clear history
explicitly removes records and transient overlays. Expiry/manual dismissal never
deletes history. History is in memory, cleared by provider disposal/page reload;
no persistence or cross-device synchronization is provided.

Full and embedded Workbench instances use separate channels. Embedded overlays
portal into the presentation root and use bundled Shadow DOM styles. Disposal
cleans up owned Toasts and suppresses late operation callbacks. The center is
nonmodal and uses the existing Radix Popover focus/keyboard/close behavior.

Notification read state is presentation metadata, independent of conversation
unread replies, approval requests and failed execution attention. This center
does not add task authority, retries, navigation or a durable inbox.

Validation: `tests/chat/notice-history.test.ts` and
`scripts/smoke/conversation/smoke-conversation-header-menu.ts` exercise actual consumers, layout,
focus, expiry, all severities, history, owner isolation and disposal.
`scripts/smoke/shell/smoke-notification-header.ts` checks the real Shell action slots without
a bell, with Toast feedback and nonmodal editing at phone/desktop widths.
