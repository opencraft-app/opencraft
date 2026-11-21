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

Provider-specific identity lookup and reservation policies belong to the trusted
installation adapter; this public core does not bundle a corporate identity
provider or infer identity from display names. An avatar descriptor grants no
login, membership, admission or message access. Disabled, revoked or unadmitted
identities must not acquire authority through a presentation adapter.

`tests/extensions/channel-avatar.test.tsx` exercises the shared descriptor-based
presentation and fallback behavior with synthetic providers. Corporate identity
adapter and real image-service acceptance are outside this public candidate.
