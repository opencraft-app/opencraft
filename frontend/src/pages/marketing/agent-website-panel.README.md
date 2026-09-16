# Website presentation boundary

`AgentWebsitePanel` owns account-level capability/site reads, `SiteID` eligibility,
delete requests, operation polling, timeout notices, timer cleanup and refreshes.
It does not take a Bot or Profile. A successful DELETE response closes the
confirmation and locks only that site; it does not prove remote deletion completed.
Polling success removes the row and refreshes both resources. Failure or timeout
retains the row and refreshes it. Unmount stops local polling, not the remote operation.

`WebsiteSiteRowView` accepts formatted address/metadata/status, optional notice,
visit URL, action eligibility and callbacks. It has no repository or network imports.
The delete callback returns its native trigger for UI-only focus coordination:
cancel/failure restores that button; accepted deletion removes it, so focus returns
to the stable list heading. Visits and CN-only sharing retain their original guards.

`WebsiteShareDialog` keeps the existing `site`, `onClose`, `onChanged` public API.
It owns duration/code state, enable/reset/stop requests and clipboard fallback.
`WebsiteShareDialogView` consumes those values, translated labels and controlled
callbacks. It only owns Radix presentation and opener focus. Pending work blocks
close and mutation controls. Successful responses call `onChanged`; clipboard
failure after a successful reset does not undo the new code or report “copied”.
Copying again reuses that plaintext code instead of issuing another reset.
The view forwards an explicit content ref so the clipboard fallback's temporary
textarea stays inside the active Dialog focus scope. Its native selection is not
replaced by a focus-trap exemption. The textarea is removed in `finally`, and its
previous connected control is restored only if the textarea still held focus.

The views depend on shared `AgentTooltip`, `Button`, `Dialog` and `Select` only.
Delete confirmation uses `AgentConfirmDialog`; each controller still determines
its own close timing. Portal content opts into `agents-ui` and six-pixel corners.
No duplicate controller, remote cancellation, bulk selection or new deletion
policy was introduced.

## Tests

`src/pages/__tests__/website-interactions.test.tsx` renders both real controllers
with synthetic fetch responses: deferred acceptance, exact SiteID and request
bodies, polling timing/terminal states/unmount, pending close guards, nested Select
keyboard behavior, clipboard fallback and focus restoration. Its explicit Chinese
translation fixture is separate from `website-interactions.global.test.tsx`, which
uses actual English dictionaries and global feature guards. The existing usage and
operation-response tests remain in the regression set. No remote writes are tested.
