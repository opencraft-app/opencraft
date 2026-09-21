## goal

Expose Settings from the anonymous LightVela sign-in menu without initiating or requiring login.

## non_goals

- Do not change domestic/international login routes, authentication state, or account storage.
- Do not add a second settings implementation or alter authenticated account actions.

## requirement_ids / requirement_refs / requirement_excerpt

- User request: add a Settings entry to the sign-in menu while unauthenticated.

## interface_refs / data_structure_refs

- `apps/workbench-web/src/components/shell-navigation/account-sign-in-menu.tsx`: anonymous account menu owner.
- `ShellNavigationConfig.onOpenSettings`: existing semantic settings navigation owner.
- Invariant: Settings navigation is independent of sign-in; selecting it must not call a sign-in option.

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md`; OpenCraft maintenance guidance.
- `relevant_evolution`: existing authenticated account panel has Settings, while the anonymous provider-choice menu does not.
- `superseded_refs`: none.

## acceptance

- Anonymous sign-in menu has an accessible Settings item after login choices.
- Selecting Settings closes the menu and invokes the existing `onOpenSettings` route.
- Login choices and pending/error actions retain their behavior.

## affected_paths

- `opencraft/apps/workbench-web/src/components/shell-navigation/account-sign-in-menu.tsx`
- `opencraft/apps/workbench-web/src/components/shell-navigation/index.tsx`

## required_context

- `identity-access` and OpenCraft UI maintenance guidance.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/identity-access.md` | Login boundary | Keep settings navigation independent of authentication. |
| `apps/workbench-web/src/components/shell-navigation/account-sign-in-menu.tsx` | Menu owner | Add the entry using the existing Radix menu. |
| `apps/workbench-web/src/components/shell-navigation/index.tsx` | Navigation wiring | Pass the existing settings route callback. |

## evidence

- Focused source contract confirms the anonymous menu has a separated Settings item wired to `onOpenSettings`, not a sign-in option.

## risks

- Settings action could accidentally select a login provider; use a separate Radix item and callback.

## validation

- `npx tsx --test tests/workbench-shell-account.test.ts`: the new Settings-entry assertion passed; an existing unrelated assertion fails because `lightvela-account-view.tsx` is now a deprecated re-export while the test still expects its old JSX body.
- `npm run test:workbench:unit`: blocked by existing worktree assertions that expect pre-existing `app.tsx` structure, unrelated to the menu change.
- Focused test, `npm run typecheck`, and `git diff --check` passed.

## decisions

- Reuse existing `onOpenSettings`, Radix dropdown, and `Settings` icon; no new route or primitive.

## scan_scope

- Workbench shell navigation and settings route wiring.

## scan_output

- Anonymous footer uses `AccountSignInMenu`; authenticated account content already exposes Settings through the same config callback.

## handoff

- Source implementation is complete and uncommitted. The current desktop preview bundle does not yet contain this change; isolated preview inspection remains required for UI acceptance.
