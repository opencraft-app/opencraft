# Server collaboration spaces

A Server is a collaboration space inside one deployment. Its ID is independent
of a Native engine's `serverId`, Host connection, Hub and human Actor. Creating a
Server does not launch a service process. Local development has a default
`myself` space, initially containing its trusted local human only. Existing
configured multi-user installations bootstrap their already admitted human
members into the historical default space rather than withdrawing existing
access.

The left-edge Server drawer lives below the complete Workbench page. It starts
closed, reveals on a rightward drag from the left edge or an explicit edge
control, and closes on a leftward drag, outside-page click or Escape. One Shell
motion owner drives page translation and drawer depth. The conversation/sidebar
subtrees remain mounted; nested management forms retain their controlled drafts.
Server selection is remembered by Host and account display scope through
`UiPreferencesRuntime`, independently of drawer visibility.

## Authority and storage

Core storage appends `collaboration_spaces`, `collaboration_space_members`,
`collaboration_space_invitations` and `collaboration_space_threads` to the
managed Server schema. A serial Worker performs new SQL and publishes committed
memory projections. The network path checks membership from indexed projections;
it does not query SQLite or write periodic timestamps. Shutdown drains accepted
storage operations. Worker failure closes this new authorization path.

Owners can create 24-hour, single-recipient invitations and remove ordinary
members. The owner cannot be removed. Invitation plaintext is returned only when
issued; storage contains its SHA-256 digest. Repeating acceptance with the same
human reconciles a lost reply, while a different human cannot reuse it. An
invitation cannot authenticate a person or specify an Actor ID. Accepting one
requires an already authenticated, admitted human on the target deployment;
local-account provisioning and server sign-in remain owned by the existing
account service.

New Threads capture their collaboration-space ID in the submission before
asynchronous creation. The Hub validates membership, removes this OpenCraft
field before forwarding the Native request, and commits the resulting
engine/Thread assignment before publishing its receipt. Switching Server while
a creation is in flight cannot move that creation to the new selection.

A missing assignment is not permission. The authenticated gateway can adopt
Native-proven historical Threads older than default-space initialization.
Unrecognized recent Threads remain inaccessible until their actual creation
owner records an assignment. Human conversation lists, reads, Native events and
collaboration execution checks all consume membership in addition to the
existing private-conversation policy. Removal invalidates observed access and
stops future delivery; it cannot retract content already read. Session Actors
retain their existing exact resource/action grants and private-policy checks;
human membership does not issue or inherit Session credentials.

## Protocol

`opencraft/server-spaces` capability version 1 and the same-named RPC provide
`list`, `create`, `select`, `members`, `invite`, `join` and `remove`. Server
selection is per logical client; creating another Server does not change the
selected Host or impersonate its human. `opencraft/server-spaces/changed` is a
title-free invalidation. Older Hosts return unsupported and retain their prior
sidebar. The default development Host is a trusted local-owner transport;
opening another browser tab is not a second human identity.

This scope is membership and conversation collaboration. It does not introduce
hostile-tenant OS, filesystem, shell or model-credential isolation, separate
Agent installations per Server, public account registration, cross-deployment
space federation, or a public sharing address. To invite another person, use a
reachable authenticated deployment and its account admission flow. The private
loopback development endpoint and BB owner-only port share do not provide that
person with access by themselves.


New conversation drafts capture their Server audience in the shared execution
target. Workspace changes retain that audience, and submission validates it
against the draft owner. Selecting another Server opens another draft; another
window changing its picker cannot silently change where an existing draft is
sent. Back navigation restores the picker from the retained View's audience.
