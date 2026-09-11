# Codex Desktop Resume architecture

OpenCraft implements the recovered Desktop hydration state machine in
`@opencraft/appserver-session`. It is a separately governed layer between the typed
AppServer client and the normalized Conversation Read Model.

```text
AppServerClient
  │ typed RPC + notification/request middleware
  ▼
ResumeNotificationBufferService
  │ holds target-thread notifications and server requests
  ▼
ThreadResumeCoordinatorService
  ├─ thread/read metadata
  ├─ StreamOwnershipService
  ├─ HistoryStrategyRegistryService
  │    ├─ Legacy
  │    ├─ Tail + thread/read fallback + background drain
  │    ├─ Paginated Turn/Item loader
  │    └─ Durable Turn loader + five-wide Item hydration
  ├─ ResumeProjectorRegistryService
  └─ ThreadViewStoreService
          │ commit View first
          ▼
  release buffered notifications/requests in arrival order
```

## Resume transaction

1. Deduplicate concurrent Resume calls by exact `threadId`.
2. Set the mounted View to `resuming` and begin wire-level buffering.
3. Read Thread metadata without Turns to obtain path, cwd and history mode.
4. A follower reuses its owner's projection and sends no `thread/resume`.
5. Otherwise acquire provisional owner role and send the full Resume request.
6. Select Legacy, ordinary Tail, Paginated or Durable hydration from Host and
   Thread capabilities.
7. Validate the response identity and required execution/security fields.
8. Reverse server-descending pages, merge by stable Turn/Item ID, and atomically
   commit metadata, history, pagination, execution and security state.
9. Publish owner state, then release buffered notifications and server requests.
10. Ordinary Tail history drains remaining pages in the background. A drain
    failure is isolated as `historyError`; it does not roll back a valid View.

Any pre-commit error restores `needs_resume`, rolls provisional ownership back,
and releases buffered traffic. A physical disconnect clears all ownership and
marks mounted Views `needs_resume`; after initialize advances generation, the
same IDs can be resumed again.

## Cordis extension contract

Agents should add a narrow plugin rather than edit the Coordinator when the
variation is domain-specific:

```ts
const remove = runtime.resumeProjectors.register({
  name: "my-projection",
  priority: 100,
  project(view, context) {
    return { ...view, /* semantic projection */ };
  },
});
```

History strategies have `matches`, `load`, and optional `loadOlder` contracts.
Notification projectors are ordered reducers. All registrations return a
disposer and are owned by Cordis fibers.

`threadId`, `history`, `path`, `excludeTurns`, and `initialTurnsPage` cannot be
overridden through generic extension fields. They are controlled by explicit
Resume options and the selected history strategy.

## Recovered-source ledger

The implementation follows the latest recovered fixed point:

- `reference://codex/.runtime/source-tree-build-r1260-static-startup-final/conversations/resume-thread-with-catalog-hydration-04170.js`
- `reference://codex/.runtime/source-tree-build-r1260-static-startup-final/shared/notification-buffer-04152.js`
- `reference://codex/.runtime/source-tree-build-r1260-static-startup-final/conversations/fetch-thread-turns-with-items-03705.js`
- `reference://codex/.runtime/source-tree-build-r1260-static-startup-final/lazy/app-initial/build-complete-thread-island.js`
- `reference://codex/.runtime/source-tree-build-r1260-static-startup-final/lazy/app-initial/merge-turn-arrays.js`
- `reference://codex/.runtime/source-tree-build-r1260-static-startup-final/conversations/thread-stream-manager-03715.js`

The real 9988 gate restored 132 Turns for an active Thread, committed owner,
model, workspace and approval projections, replayed buffered notifications, and
completed ordinary Tail history drain.

## Deliberate boundary

This is Desktop Resume/View hydration, not V4 Replica. Cross-process durable
`epoch/seq` journal storage, gap replay, snapshot replacement and offline row
retention belong to `@opencraft/appserver-replica`. Resume can feed its common client
reader shape through the V3 compatibility adapter; it does not counterfeit a
server-retained Journal or V4 Authority guarantees.
