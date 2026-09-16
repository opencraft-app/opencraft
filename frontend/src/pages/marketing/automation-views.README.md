# Automations presentation boundary

`agent-automations-panel.tsx` continues to own Bot/Profile identity, loading, capability checks, drafts, eligibility, command construction, request sequencing, rollback and completion callbacks. No view imports a repository, runtime context or cron client.

| View | Inputs and actions | Local UI state |
| --- | --- | --- |
| `AutomationDialogView` | title, close label, children, optional badge/style and stable `returnFocusRef`; `onClose` | visible heading initial focus and close-focus restoration |
| `AutomationCardActionsView` | terminal/paused/busy flags, original test state, labels, actions | Radix menu; view/copy pass their stable menu trigger to the host |
| `AutomationFormActionsView` | eligibility/submitting/test state, labels, test/close/submit callbacks | accessible disabled explanation; no async ownership |
| `AutomationDaysPickerView` | numeric options/selection, translated labels, toggle/clear callbacks | controlled Radix checkbox menu, selecting does not close it |

The Skill and upstream pickers retain their original selection controllers, real slugs/job IDs and retry callbacks. Their Radix Popovers are portalled inside the parent Dialog's interaction scope. Skill selection stays open; CN reselect removes a selected skill, global reselect retains it, and either site can remove a tag. Closing clears only the search query. Upstream selection closes and restores its trigger; Escape closes only the nested picker.

## Lifecycle contracts

- Form Escape/cancel stays available while submitting or testing. Closing the view does not issue stop/cancel, repeat the request, or consume background completion/error callbacks.
- Delete remains host-controlled: pending blocks close and repeat confirmation; refreshed dependencies may require a second confirmation; failure stays open. Successful deletion runs the existing unreferenced-script cleanup before refresh/close. If the card disappears, focus returns to the stable create button.
- A menu or quantity confirmation can hand focus to a new dialog. The parent stores the original stable trigger; closing the previous layer does not steal focus from the new layer.
- Time segments retain blur/Enter validation and invalid-value restoration. Calendar/time Popovers edit drafts; cancel/Escape does not commit. Eighteen daily times still create one minute-level cron job and one managed script configuration.
- `ErrorToast` remains the existing non-dialog notification Portal. It does not own or cancel requests. Scenario module controllers and external resources are unchanged.

## Dependencies and verification

Use the shared Agent Tooltip/Confirm/State and Radix-based UI primitives. Portal surfaces opt into `agents-ui`; there is no global theme override. Popover is pinned to `1.1.15` in frontend so its resolved focus-scope (`1.1.7`) and dismissable-layer (`1.1.11`) are shared with the installed Dialog/Select family. Consumers must verify their own resolved closure; copying version numbers across packages is insufficient.

Adjacent tests cover the named dialogs, initial/return focus, keyboard menus, pending/deferred outcomes, dependency deletion, nested selectors, regional selection rules, time drafts and one-job/script submission. The dedicated global test exercises English UI. The legacy main suite also contains Chinese-only fixtures; running every legacy case under the global default is a separate fixture-compatibility check and is not a substitute for the explicit English interaction tests.
