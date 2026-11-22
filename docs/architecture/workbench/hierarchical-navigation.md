# Hierarchical application navigation

The application Router owns URL, history entries and their serialized semantic
navigation paths. `AdaptiveNavigation` validates and transforms those paths; it
is instantiated for an operation, never installed as a competing route writer.
Geometry remains a separate projection. Restored semantic nodes need no width.

A View may declare `navigationParent: { viewId, resourceUri? }`. IM group chats
use Inbox. Opening a registered child from its parent adds a semantic level;
selecting a sibling replaces the parent's descendants. A child opened from a
different surface retains the exact caller instead. Selecting a root starts a
new semantic path, while the browser retains its real back/forward timeline.
`pushViewResource` adds a resource level; replacement retains its ancestors.

`canReturn` and `returnToParent()` describe semantic return. `canGoBack`, `back()`
and `forward()` retain their history meanings. A parent with an exact owned
history key uses Router POP, potentially skipping sibling history entries. A
direct link resolves declared parents without inventing earlier visits; return
uses REPLACE when that parent has no owned history entry. Browser Back itself
keeps its normal history behavior. Paths are bounded to 32 unique identities;
cyclic declared parents fail closed. Contribution changes update context without
creating history or retiring pending conversation activation.

The header projects semantic Back into its existing leading action slot. Compact
CSS distinguishes this action from optional history controls. The shared mobile
horizontal-input arbiter chooses semantic return or sidebar reveal. Cancellation,
selection, editors, readable horizontal content, foreground dialogs and reserved
native edges keep the existing ownership rules. Router-entry changes revoke a
held gesture. The Shell page plane projects navigation with the shared continuous panel
spring. Push and return animate in opposite directions; browser POP uses the same
projection. The Shell's existing gesture progress drives the foreground and a
parallax ancestor preview. Cancellation springs to zero; completion reaches one
before committing semantic return. Modal, scope and lifecycle interruptions revoke
that completion. Reduced motion skips travel. Native-container Back selects semantic return before history;
the bridge protocol is unchanged. Packaged mobile binaries require their normal
separate rebuild and are not updated by a Web deployment.

`RouteViewStack` retains only previously mounted extension ancestors from the
Router path. React Activity suspends their effects; returning restores input and
scroll state. It never mounts unseen direct-link parents. Unrelated roots and
popped children leave this presentation cache. Conversation runtimes and drafts
retain their existing resource owners; the stack does not terminate them.

Validation covers exact-parent POP, sibling selection, caller context, deep-link
REPLACE, resource nesting, root switching, browser forward/reload, late metadata,
cycles, real Inbox/group components, retained input/scroll, desktop/touch headers,
right-swipe commit/cancel/modal exclusion and the simulated native bridge. Physical
phone gestures and a rebuilt native binary are separate acceptance surfaces.

RouteStackMotion owns the entire Shell page presentation: route header, body and
floating page input share one translation. Global sidebar geometry stays outside
that page. RouteViewStack only retains logical content Activities.

RouteStackMotion owns only transient presentation. Its pre-mutation snapshot keeps
an outgoing page visible after its Activity stops effects. Previously visited
ancestors have inert static previews, including form values and scroll positions;
no second React view, frame or media owner is mounted for a gesture. The preview
cache follows the bounded Router path and account-scoped stack lifetime. Direct
links do not fabricate an unseen parent preview. Live DOM/input resumes only in
the selected route, and interruption retires the prior animation writer.

Deferred views acquire a framework presentation-readiness lease while their module
is pending. A route departure can prepare its snapshot immediately, but entrance
starts when the mounted destination releases all pending leases. Failure releases
the lease to show retry; stale/hidden views cannot start a retired transition.
Header registration and layout-only renders do not cancel a prepared entrance.
