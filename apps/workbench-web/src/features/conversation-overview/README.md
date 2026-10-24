# Optional conversation overview

All feature behavior, setting, preview read adapter and presentation live here.
The installation preference `sidebar.conversationOverview` defaults to false.
The UI observes the existing admitted multi-Host catalog, ranks attention first,
and reads only the latest two summary Turns for visible cards. Active cards catch
up every four seconds while the document is visible. Reads share two lanes per
Host; there is no Thread resume, execution lease, interaction owner or read receipt.
Preview text stays in a zero-retention Query cache and is removed on dismissal.
`mini-chat.tsx` is the read-only thumbnail renderer, reusing the shared
ChatDocument compiler and projecting only static message content. It never
mounts full chat/Composer providers, loads images or activates links. The canvas
is miniaturized; card identity/status and actions stay at normal UI size. The
thumbnail has no independent scrolling or focus targets. Card styles load with the overview. Settings presentation is separate from
the lightweight preference hook, so neither enters the initial Shell through
this feature's entry point. Mobile projects the action only in its header and
uses the Shell's shared header button appearance.
Notifications use the shared stylesheet-free `async-notices-context` port.
The existing provider and its compatibility exports keep ownership of notices;
this avoids pulling another copy of its typography into the website bootstrap.

To remove: delete this directory, its focused tests and smoke script, remove the
test command's registration and preference
definition, Settings row, App hook/modal/action, Shell header action, and the
overview source return from `useMultiHostThreadCatalog`. Remove `overview.*`
locale entries, the direct `@opencraft/chat-document` dependency if unused elsewhere, and this feature's contract in the design docs. No database
migration, backend owner or Core deployment is involved. Existing stored values
for the removed preference are ignored by the preferences parser.

The shared `ThreadTurnsListRequest.itemsView` also accepts `summary`, matching
the generated native API and existing response type. That protocol correction
is independent of this feature and can remain when the overview is removed.
The notification context/provider separation can also remain independently.
