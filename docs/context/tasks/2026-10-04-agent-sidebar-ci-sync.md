## goal
Repair MR !4951's OpenCraft Agent Console drift and make the required sync check visible to frontend contributors before MR submission.

## non_goals
- Change the sidebar behavior, OpenCraft adapter logic, or deployment state.
- Merge or release the MR.

## context_receipt
| File | Reason |
|---|---|
| `docs/context/flows/tapd-gongfeng-delivery.md` | MR update boundary |
| `docs/context/domains/site-environment-routing.md` | Regional frontend boundary |
| `frontend/AGENTS.md` | Frontend validation rules |
| `opencraft/AGENTS.md` | Generated-copy ownership and check |
| `opencraft/MONO2_MIGRATION.md` | Source and generated target contract |
| `docs/context/project/upstream-subtrees.md` | Mono2 source authority |

## evidence
- MR !4951 CI failed in the `opencraft guard` on `i18n/generated/en-US.json` drift. The same `npm --prefix opencraft run check:mono2-agent-console` command reproduced the error locally before repair.
- The frontend source was already committed as `10ceff9cac4bd328a8f4dc8aedb6767606806a7b`; current `origin/master` was merged before regeneration.
- The official sync script regenerated 130 closure files; the changed set is eight locale dictionaries plus `UPSTREAM.json`, whose `sourceRevision` now points to the committed frontend source.
- After sync, the read-only closure check passed, OpenCraft embedded CI tests passed 155/155, plugin typecheck passed, and documentation validation found no errors, warnings, or broken first-party links.

## acceptance
- Sync output is generated only by the repository script and committed separately from frontend source.
- `npm --prefix opencraft run check:mono2-agent-console` passes after sync.
- Relevant OpenCraft checks and changed-path gates pass; remote MR status is checked after push.
- Frontend `AGENTS.md` directs future frontend changes through the same pre-MR check and separate generated commit.

## risks
- The sync script copies the complete bounded Agent Console closure; generated files beyond the initially reported locale may change.

## handoff
- Local repair validated; generated output is pending its separate commit and remote MR CI result.
