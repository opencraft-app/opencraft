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

## Protocol

| Method | Who | Effect |
| --- | --- | --- |
| `opencraft/server-spaces` `{action:'contact',spaceId,open}` | space owner | switch open contact |
| `opencraft/server-spaces` `{action:'addBot',spaceId,actorId}` | space owner | add an enabled Session Actor as a member; it may not belong to another space |
| `opencraft/crew/phonebook/list` `{botId}` | members of the Bot's space | phonebook entries |
| `opencraft/crew/phonebook/set` `{botId,actorId,present}` | space owner | add or remove an entry; adding requires a member of the space |

Removing a Bot uses the existing `remove` action.

## Implemented

| Rule | State |
| --- | --- |
| Bots as space members, one space each | implemented (`addBot`) |
| Same-space humans reach any member, with a per-space switch | implemented; migration `0019_space_open_contact` adds `open_contact` (existing rows 0) |
| Space Bots limited to their phonebook inside their space | implemented for direct messages and `execution.queue` |
| Owner-managed phonebook | implemented |
| Chain pass: a Bot reaches everyone on its dispatch chain and the owner for that work | not yet; needs the dispatch chain from the work runtime |
| Delegation budget between Bots | not yet |
| Leaving members, paused Bots and escalation routing | not yet |
| Bot runtime sending as itself (superapp peer port) | not yet; the personal assistant runtime still talks only to its owner |
| Crew UI | not yet |

Verification: `tests/identity/crew-contact.test.ts`, `tests/identity/server-spaces.test.ts`.
