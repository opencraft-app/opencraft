# Crew: Bots as peer members of a space

Status: first core slice. The rules below are the target model; the "Implemented" table
says which parts exist in source. Design rationale and the full rule set live in the
product design document; this page records the contract.

A team is a [collaboration space](server-spaces.md); one person alone is also a team.
Bots are Session Actors that join a space as peer members of its humans. A Bot belongs to
exactly one space.

## Contact rules

- **Humans** in a space whose contact is open may message any member, human or Bot,
  without a per-target grant. A space's `openContact` defaults to on for new spaces and
  off for the historical default space and every space that existed before this change,
  which keep the per-target `message.send` grant rule.
- **Space Bots** proactively reach only their **phonebook**: exact `message.send` grants
  whose target is a member of the Bot's own space, also inside the space. A phonebook is
  one-way: being in Alan's phonebook does not let you be reached by, or reach, anyone else.
- **Bots outside every space** keep the existing per-target grant rule unchanged.

A phonebook entry carries `message.send` and `execution.queue` together: finding someone
includes handing them work. It is a projection of grants owned by `ActorStore`; there is no
second store. Only the space owner edits a Bot's phonebook, and only with members of that
space. Any member of the Bot's space can read it.

`CrewContact` (`packages/access-control/src/crew-contact.ts`) is the single decision used by
`Collaboration` for direct messages and execution requests and by the native channel
projections (`canSend`, `canMessage`). It reads spaces and grants inside the caller's
transaction and writes nothing itself. In a standalone collaboration repository without
space tables it stands aside and the existing grant rule applies.

## Work and its chain

Every hand-off to a space Bot is a piece of **work** in the `crew_work` ledger (migration
`0020_crew_work`), written only by `Collaboration` inside the communication transaction, so a
message and the work it opens commit or roll back together. Work records its assignee, who
handed it over, the work it was split from and its root. `origin` is `member` (a person asked),
`bot` (another Bot handed it on) or `routine` (a Bot started it on its own).

- **Dispatch.** Members dispatch to a Bot of their space; Bots dispatch only to their phonebook,
  and only under open work they hold (`parentWorkId`).
- **Chain pass.** While work is open, its assignee may message everyone the work answers to:
  each requester up the tree, nearest first, then the space owner. This ignores the phonebook,
  covers messages only, and ends when the assignee calls `finish`. Routine work answers to
  the owner only.
- **Budget.** A root allows 8 Bot-to-Bot hand-offs in its whole tree
  (`CREW_DISPATCH_BUDGET`). The next one is rejected with `crew_budget_exhausted`; the Bot
  escalates instead. A rejected hand-off leaves no message.
- **Departures.** A member who left the space is skipped on the chain. A Bot removed from its
  space (or disabled) no longer holds any work, so its pass ends at once.

The core does not decide when work is done: the assignee's runtime reports it with `finish`.
Who on the chain is actually asked, and whether that member can decide, is the runtime's job.

## Protocol

| Method | Who | Effect |
| --- | --- | --- |
| `opencraft/server-spaces` `{action:'contact',spaceId,open}` | space owner | switch open contact |
| `opencraft/server-spaces` `{action:'addBot',spaceId,actorId}` | space owner | add one of the owner's own Bots as a member; it may not belong to another space |
| `opencraft/server-spaces` `{action:'bots',spaceId}` | space owner | the owner's additional assistants that are not yet in any space |
| `opencraft/crew/phonebook/list` `{botId}` | members of the Bot's space | entries, the space members that could be entries, and whether the caller may edit |
| `opencraft/crew/phonebook/set` `{botId,actorId,present}` | space owner | add or remove an entry; adding requires a member of the space |
| `opencraft/crew/work/dispatch` `{targetActorId,content,idempotencyKey,parentWorkId?}` | members; Bots under open work | send and open work |
| `opencraft/crew/work/message` `{workId,targetActorId,content,idempotencyKey}` | the work's assignee | message someone on its chain |
| `opencraft/crew/work/start` `{}` | space Bots | open routine work |
| `opencraft/crew/work/finish` `{workId}` | the work's assignee | close it; the chain pass ends |
| `opencraft/crew/work/get` `{workId}` | assignee, requester, chain | the work with its chain and budget; `request` (the dispatch text) only for the assignee and requester |
| `opencraft/crew/work/list` `{}` | a Bot | its open work |

Removing a Bot uses the existing `remove` action.

## Implemented

| Rule | State |
| --- | --- |
| Bots as space members, one space each | implemented (`addBot`) |
| Same-space humans reach any member, with a per-space switch | implemented; migration `0019_space_open_contact` adds `open_contact` (existing rows 0) |
| Space Bots limited to their phonebook inside their space | implemented for direct messages and `execution.queue` |
| Owner-managed phonebook | implemented |
| Work ledger, chain pass, owner for routine work | implemented in core |
| Budget of 8 Bot-to-Bot hand-offs per root | implemented in core |
| Departed members skipped, removed Bots hold no work | implemented in core |
| Managed Bot runtime takes crew work | implemented: the Host forwards `crew/work/list`, `get`, `message` and `finish` as the Bot; each dispatcher gets one runner conversation; replies go to the nearest person left on the chain |
| Asking upward on the Bot's own judgment | implemented by the same path: a question goes to the immediate dispatcher, which decides or asks its own dispatcher |
| Finishing work | the runtime closes work once its turn settled, no Work linked to that conversation is active and its outbox is empty; a blocked turn stays open |
| Cancelling unstarted work of someone who left | implemented in the runtime: closed before intake without a reply |
| Stopping started work after the current step when its dispatcher leaves | not yet; replies already move up the chain |
| Bots dispatching to their phonebook, routine work | core only; no runtime tool yet |
| Crew UI: space members | implemented in the Server panel: Agents are labelled, the owner switches open contact and adds their own assistants (`bots`, `addBot`) |
| Crew UI: phonebook | implemented in the assistant settings dialog: one switch per space member; members read it, only the owner edits |
| Crew UI: dispatching from the Inbox, work and chain views, desk | not yet |

Runtime: `apps/personal-assistant/src/runtime/crew-intake.mjs`. Its only local fact is which runner
conversation belongs to which dispatcher, stored in the runner `meta` table.

Verification: `tests/identity/crew-contact.test.ts`, `tests/identity/server-spaces.test.ts`,
`apps/personal-assistant/test/crew-intake.test.mjs`, `tests/shell/server-spaces-crew.test.tsx`, `tests/shell/crew-phonebook.test.tsx`. Not verified against a running server, a real model or a client.
