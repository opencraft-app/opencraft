# Channel membership JIT compensation design

Date: 2026-08-17

## Goal

Fix ordinary public Channels that are locally reported as joined while Tencent IM rejects Topic access with
`not member`. Preserve the existing Channel and `channel_members` model, existing Human membership routes,
and current asynchronous Tencent Operation pipeline. Do not add a repair API, a projection table, a background
full scan, or a compatibility mode.

## Product semantics

- `#全员` is the only implicit Channel. Every active Server Member belongs to its Community root conversation.
- Every ordinary Channel has explicit membership and maps to a Tencent Private Topic.
- `visibility=public` means discoverable and self-joinable. It does not change the Tencent Topic type or membership
  transport.
- `visibility=private` means membership must be granted by an Owner/Admin. A Member with an existing active private
  membership may reassert that same membership when its Tencent projection drifts.
- `joined=true` continues to mean that the current Human has an active `channel_members` row whose `im_state` is
  `ready`. The Web may open the Topic only in that state.

## Root cause

`loadChannelMemberWork` currently clears `TopicID` for public Channels. `immembership.Service` treats an empty
TopicID on a `channel_member` operation as success without calling Tencent. The repository then marks the local
membership `ready`, so the Channel API emits `joined=true`; the Web opens the Topic and Tencent correctly rejects
the Human as `not member`.

The chat screen has a second failure-coupling bug: it fetches Channel members before history, but commits the member
list only after history succeeds. A history error therefore fabricates a zero-member UI even when the platform list
request succeeded.

## Backend invariants

### Ordinary Channel transport

`loadChannelMemberWork` must pass the stored non-empty `im_topic_id` for every ordinary Channel, regardless of
visibility. Visibility must not be passed into or inspected by the Tencent membership adapter.

The Worker must never report a `channel_member` ensure/remove as successful solely because `TopicID` is empty.
An empty TopicID is invalid transport input and must end in a failed Operation rather than a ready membership.

`#全员` does not create a `channel_member` operation and therefore does not enter this path.

### Reasserting an existing membership

The existing `PUT /servers/{serverId}/channels/{channelId}/members/{memberId}` ensure route remains the only repair
command. Its repository behavior already turns an existing row into a new desired version: it increments
`membership_version`, sets `im_state=provisioning`, and creates a fresh `im.membership.ensure` Operation.

Authorization for a non-manager self-ensure is:

1. allow when the ordinary Channel is public; or
2. allow when the target is the caller and an existing membership is `active`, including a private Channel.

The second case repairs already-granted access. It must not allow a Human to create or reactivate their own private
Channel membership when no active membership exists. Owner/Admin behavior is unchanged.

The current OpenAPI operation description must be updated to state this existing-membership repair case. The path,
method, request, response and authorization domain do not change.

## Stable client error

The Tencent messaging adapter owns provider error normalization. A Topic history request rejected because the
current IM user is not a member must surface as `PlatformError` code `IM_NOT_MEMBER`.

The application store must react only to this stable code. It must not match provider message text, HTTP wording,
or localized copy. Other IM, authentication, network, and permission errors must retain their existing behavior and
must never trigger membership mutation.

## JIT compensation flow

When an explicitly joined ordinary Channel is selected:

1. wait for the messaging connection and list platform Channel members;
2. commit the successful platform member list independently of history loading;
3. request Tencent Topic history;
4. if history succeeds, render normally;
5. if history fails with `IM_NOT_MEMBER`, automatically call the existing membership ensure route for the current
   Human Member with a fresh idempotency key;
6. track and poll the returned Operation, while presenting “正在重新连接频道” and disabling message actions;
7. after success, refresh Channels and messaging scope, then retry the selected Channel once;
8. if ensure fails, or the single retry again returns `IM_NOT_MEMBER`, stop and show an actionable error.

Compensation is limited to one automatic attempt per Server/Channel selection generation. Navigation to another
conversation cancels the stale retry. A late Operation result must not reopen or overwrite the newly selected
conversation.

Public Channels with `joined=false` do not enter compensation. They continue to show the explicit Join action.

## Existing bad rows

No migration or background scan is required. Existing rows incorrectly marked `ready` are repaired on their first
real Topic access. The ensure command changes the row to `provisioning`, preventing another optimistic history load
until the Tencent Operation succeeds.

This development-stage policy intentionally leaves never-opened bad memberships untouched; they have no user-visible
effect until accessed, at which point JIT repair converges them.

## UI behavior

- Preserve the member list returned by the platform even when Tencent history fails. The member count and picker
  must not fall back to zero because an unrelated IM request failed.
- During JIT repair, replace the raw danger toast with a bounded reconnecting state. Do not expose the provider text
  `not member` as primary product copy.
- On final failure, show that Channel access could not be restored and provide the existing retry/continue action.
- Message composer, search, thread actions, read receipts, and message mutations remain disabled until the Channel
  is joined and history has loaded.

## Tests

Backend RED tests must prove:

- public and private ordinary Channel work both carry their stored TopicID;
- empty TopicID can never complete a `channel_member` operation successfully;
- an ordinary Member can reassert their own existing active private membership;
- the same Member cannot self-join a private Channel without an active membership;
- reassertion increments the version, returns the row to `provisioning`, and creates a new ensure Operation.

Web RED tests must prove:

- the Tencent adapter maps the provider not-member failure to `IM_NOT_MEMBER`;
- selecting a locally joined Channel that returns `IM_NOT_MEMBER` invokes the existing ensure route exactly once;
- successful platform members remain visible while history fails;
- successful compensation refreshes the Channel and retries history once;
- a second `IM_NOT_MEMBER` and all unrelated errors do not loop or mutate membership;
- navigating away fences a late compensation result.

Verification after focused RED/GREEN cycles:

```text
cd backend && go test ./internal/adapters/immembership ./internal/adapters/channelmembership ./internal/app/immembership
cd backend && go test ./... && go vet ./... && go test -race ./...
cd backend && ./scripts/check-generated.sh && ./scripts/check-migration-release.sh && ./scripts/check-openapi-compatibility.sh
cd backend && go run ./cmd/migrationgen --dialect tdsql --verify
cd backend && ./scripts/scan-secrets.sh .
cd web && bun test apps/client/src/application/app-store.test.ts apps/client/src/im
cd web && bun run typecheck && bun test
```

No schema, migration, or new API surface is expected. The current OpenAPI description and generated comments are
updated for private self-repair; compatibility checks must prove that the wire contract did not change.

## Non-goals

- splitting Channel membership authority from IM projection;
- adding a membership repair endpoint;
- periodic Tencent membership inventory scans;
- changing public/private product semantics;
- automatically joining all Server Members to public Channels;
- moving message history into the platform database.
