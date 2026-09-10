# Bot Chat motion ownership

This note fixes the ownership boundaries for the Bot-native conversation surface. It uses the current Grok Bot 0.39.0 renderer as the motion authority and the older reconstructed tree only as a readable historical aid:

- Grok Bot 0.39.0 defines the current 39-state vocabulary, 18 shape families, effect mapping, eye topology, pointer following, stage registry, spring clock, group presence, and transcript gating.
- Grok Bot 0.18 reconstructed source remains useful for readable component boundaries, but is not used to override current behavior.

The 0.18 repository is an unofficial reconstruction, so readable names are useful evidence but not release-source authority. Timing and lifecycle decisions are taken from the current renderer where the two differ.

## Ownership

| Owner                       | Owns                                                                                         | Must not own                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `BotConversationSource`     | authoritative messages, roster, append-oriented Presence facts                               | pixels, animation frames, transient exit chrome              |
| Bot Chat View lease         | one deterministic demo event clock per mounted View                                          | sharing playback state with another tab or View              |
| `BotMotionReplayController` | deterministic demo event clock, scene identity, play/pause/seek                              | SVG geometry, pointer coordinates, production protocol state |
| `BotAvatarStage`            | one `Presence -> visual state` projection per participant                                    | message history, transport reconciliation                    |
| transcript surface          | whether live presence is eligible, group aggregation, 1200 ms label hold, 140 ms exit        | avatar physics, protocol state                               |
| `BotAvatar` engine          | persistent spring values, pose clock, visibility pause, reduced motion, imperative reactions | choosing the current Presence fact                           |
| message row                 | historical attribution snapshot                                                              | observing live Presence                                      |
| Composer                    | draft and submit intent                                                                      | live activity indicator or avatar state                      |

## Invariants

1. Presence is a transient fact stream, never a persisted chat message.
2. A participant has at most one current Presence projection. Within one run, `seq` is authoritative even if replay observation time is newer; across runs, observation time selects the newer run.
3. Historical message avatars are static. Header and trailing activity marks are the only live avatar surfaces.
4. A streaming assistant message and its trailing working/typing indicator are mutually exclusive. The indicator exits over 140 ms when the message surface takes ownership.
5. An unacknowledged initial user send does not immediately fabricate a working row.
6. Activity text is held for at least 1200 ms and transitions over 300 ms, preventing rapid tool updates from producing visual chatter.
7. Group presence retains every active participant and is aggregated at the transcript boundary; array order is not authority.
8. The animation effect is mounted once per live mark. Semantic state changes update refs and spring targets instead of recreating the RAF loop.
9. The physics step is capped at `1/120s`; a backgrounded or blurred page pauses its logical clock, so resume cannot jump.
10. Idle marks sleep once settled. Static marks never start RAF. Reduced-motion clients snap to the current target.
11. Streaming text may update frequently without remounting an existing message or replaying its entry animation.
12. Replay playback state is not run identity. Pausing and resuming a scene keeps its `runId`; only entering another scene creates a new scene epoch.
13. Cross-position motion uses one persistent actor. Header, thread, group, and Composer are placement anchors, not separate owners that remount the avatar.
14. The Stage owns the pointer observation once; individual avatars consume the shared pointer sample and cannot install competing global listeners.
15. Replay scenes are not product UI. The replay clock projects immutable messages and Presence facts; the surface renders them through the normal transcript, group-presence, and Composer paths.
16. A replay controller is View-owned. Two mounted Bot Chat views never share playback position, timers, or pause state.
17. Transient Presence never changes Composer Dock geometry. It may be visually anchored to the Composer, but it remains an overlay so `streaming -> complete` cannot move an already painted message.
18. The Transcript tail has one owner. Presence owns it only before a message surface exists; the optimistic/streaming message takes ownership synchronously, with no retained exiting row that can later change Transcript height.
19. Presentation state is not protocol state. Replay may supply a typed visual override to the Stage, but it cannot invent an AppServer Presence phase or persist a motion name into the conversation.
20. Effects are actor-owned front/back layers. They share the actor clock and geometry; they do not mount an adjacent layout row or become a second avatar identity.
21. Eye expression is part of the continuous actor model. Width, height, gap, vertical offset, rotation, blink, and gaze are independently interpolated so state changes never swap an SVG subtree.

## Reference map

- 0.18 Avatar boundary and static behavior: `/data/grok/grok-bot-0.18-reconstructed/frontend/src/recovered/features/conversation/workspace/agent-avatar.tsx`
- 0.18 readable SVG character engine: `/data/grok/grok-bot-0.18-reconstructed/frontend/src/recovered/features/onboarding/signed-in/character.tsx`
- Current 0.39.0 state/effect/shape engine: `/data/grok/wakaru-standard/chunk_mIe.js`
- Current Stage engine registry, claims, and static/live dispatch: `/data/grok/wakaru-standard/entry.js`
- Current activity lifecycle: `/data/grok/wakaru-standard/entry.js` near `hmt = 1200`, `Gmt = 140`, `Umt`, and `Hmt`

## Current implementation

- Domain projection: `packages/bot-conversation/src/model.ts`
- Stage projection: `plugins/bot-chat/src/bot-avatar-stage.tsx`
- State policy: `plugins/bot-chat/src/bot-avatar-motion.ts`
- Persistent SVG spring engine: `plugins/bot-chat/src/bot-avatar.tsx`
- Transcript eligibility and activity lifetime: `plugins/bot-chat/src/bot-chat-view.tsx`
- Deterministic presentation replay: `plugins/bot-chat/src/motion-replay.ts`
- Eighteen-shape vocabulary: `plugins/bot-chat/src/bot-avatar-shapes.ts`

The replay is deliberately replaceable. A future protocol adapter can publish the same messages and Presence facts; the Stage, persistent actor, pointer following, shape morphs, and cross-position continuity remain unchanged. The old scene-card laboratory is intentionally absent from the product surface.
