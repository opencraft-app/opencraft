# Channel identity avatars

The native Channels read model exposes an optional installation-verified
`ChannelIdentityAvatar` (`kind`, `name`), not a photo URL, login proof or grant.
Message senders, members, invite candidates and people use the same provider
projection. Display names never become photo-account lookup keys. Core validates
the descriptor and fails to the existing fallback if an adapter fails or returns
malformed data. Products resolve descriptors through `IdentityAvatarContext`;
`AvatarImage` owns loading/error fallback without changing layout.

`ChannelSummary.participants` is a presentation preview, not another roster or
membership authority. A direct summary carries its peer, even without message
history. A group carries at most four eligible members in stable Actor-ID order.
The storage Worker stops scanning once that preview is full and deduplicates
identity lookups within a directory read only. The next read rechecks current
bindings, admission, removals and profile state. No provider lookup moves onto
the network main loop and no cross-read avatar identity cache is introduced.

The shared IM `ConversationAvatar` renders direct peers or a group-member mosaic
using the existing `ChatAvatar`, including Bot portraits and per-cell fallbacks.
It never uses a group's title or latest speaker as its identity. Old servers
without the optional summary field retain the old fallback behavior. Member
grids, full rosters, candidate rows, selected chips and chat switcher consume the
same descriptors. The existing directory renderer no longer guesses photos from
its display labels. Avatar geometry uses the shared channel-avatar size token.

Join may lend a photo to a pending trusted OA directory reservation **for roster
presentation only**. The exact pending reservation must name `tencentoa` as its
login provider and have one valid directory alias; the mutable Actor display
name is irrelevant. The reservation remains disabled with no login binding or
admission. It cannot authenticate, become an invite candidate, speak as a native
sender, or inherit message grants. Ordinary disabled, revoked or unadmitted
Actors cannot lend photos. Claiming or retiring a reservation changes subsequent
read projections; it never fabricates an OA login.

`native-channel-avatar-projection.test.ts` covers trusted identity, scope,
revocation, reservation safety and preview bounds; `channel-avatar-worker.test.ts`
tests the actual storage worker. `channel-identity-avatar.browser.ts` exercises
the actual Shell/IM/Composer and property dialogs with synthetic account/RPC and
local decoded image fixtures on desktop/touch and light/dark. The product's
`channel-avatar-bundle.smoke.mjs` is bundled and run against the actual candidate
Worker/extension using an isolated temporary database, without provider calls.
Physical devices and real IOA image delivery are separate acceptance checks.
