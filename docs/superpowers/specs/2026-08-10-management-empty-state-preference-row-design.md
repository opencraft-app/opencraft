# Management Empty State Preference Row Design

## 1. Problem

The management pages still render first-run zero data as a centered onboarding composition: icon, title, description, and a filled blue call to action. In a persistent desktop workspace this reads like a marketing webpage, not a macOS management surface.

This also contradicts the existing Tahoe control-system rule that management empty states should be left aligned and should not default to a centered large-icon/blue-button template.

## 2. Approved Direction

Use the selected **Preference row** model for Tasks, Reminders, Agents, Computers, and Members.

- The detail canvas remains top aligned.
- The empty state is one inset grouped row with a hairline border and compact radius.
- Title and description form the leading copy column.
- The available creation action is a compact trailing control.
- Decorative icon tiles and hero spacing are removed.
- The existing toolbar and sidebar geometry remain unchanged.

This is a desktop management state, not onboarding. Onboarding screens may use stronger structure and guidance, but ordinary rectangular text actions stay on the same neutral control model.

## 3. Component Ownership

`ManagementEmptyState` owns the preference-row composition for all management pages. Individual screens provide only copy, optional action state, and callback.

`SystemEmptyState` remains responsible for generic list, canvas, and onboarding states outside the management workspace. Management pages must not select `kind="onboarding"` merely because the collection is empty.

No page may reproduce the row border, padding, title/description layout, or trailing action locally.

## 4. Button Hierarchy

No new button implementation is introduced.

- `SystemButton variant="standard"`: every ordinary text action, including create, submit, confirm, accept, retry, and preference-row actions.
- `SystemButton variant="toolbar"` and `SystemIconButton`: add, refresh, and other toolbar operations.
- `SystemButton variant="destructive"`: destructive operations only.

Wizard and form pages do not choose those variants directly through a generic
"primary" footer slot. `ManagementFormFooter` owns a semantic flow action:
`intent="advance"` and `intent="submit"` preserve flow orchestration, but both
map to the neutral standard control. The flow position cannot choose a color.

Therefore an empty management collection never produces a filled primary button in the detail canvas.

## 5. Layout and Responsive Behavior

At pointer density, the row uses the shared management content measure and standard resource-row height. Leading copy may wrap; the trailing action never stretches.

At compact/touch density, the same component stacks the action below the copy and aligns it to the leading edge. It does not become a full-width primary call to action.

The component uses semantic surface, separator, radius, spacing, typography, and control tokens only.

## 6. Accessibility

- The empty-state group remains a readable content region, not a fake dialog or alert.
- The action retains native button semantics and an explicit accessible label.
- Title precedes description in reading order; action follows the description.
- Button meaning does not depend on color.

## 7. Verification

Automated coverage must prove:

- `ManagementEmptyState` uses the shared preference-row structure.
- Its action renders as `standard`; no empty-state API exposes a visual variant.
- Tasks, Reminders, Agents, Computers, and Members continue to open their existing creation flows.
- The component stacks correctly in compact density.
- No management screen introduces its own empty-state layout.

Release verification uses the internal environment at `http://9.135.236.23`, with desktop and compact screenshots. The acceptance check is the absence of hero spacing, decorative icon tiles, and filled blue empty-state actions while existing creation behavior remains unchanged.
