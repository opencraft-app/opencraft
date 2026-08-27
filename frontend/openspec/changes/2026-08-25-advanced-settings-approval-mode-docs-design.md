# Advanced Settings Approval Mode Documentation Design

## Goal

Bring the existing Advanced Settings documentation in line with the current Hermes Agent interface.

The update documents the Security group and its Approval Mode selector for both LightVela documentation sites.

It also corrects the save-flow description so that it distinguishes approval-mode saves from settings that require a Gateway restart.

## Scope

Update the domestic Chinese source at `src/content/docs/configuration/advanced-settings.md`.

Update the international Simplified Chinese source at `src/content/docs/global/configuration/advanced-settings.md`.

Update the international English source at `src/content/docs/en/configuration/advanced-settings.md`.

Update the international Indonesian source at `src/content/docs/id/configuration/advanced-settings.md`.

Keep the existing page structure, images, routes, sidebar entries, and metadata registrations unchanged.

Regenerate the rendered Fumadocs outputs after the source edits.

## User-Facing Content

Add a Security row to the page summary, coverage list, and settings table.

Document the three Approval Mode choices: Smart, Always Ask, and Off.

Explain that turning approval off requires an explicit confirmation and leaves a visible warning while dangerous commands can run without approval.

Explain that restoring the Security group returns Approval Mode to Smart.

Clarify that Approval Mode is saved and read back without restarting the Gateway.

Clarify that Memory and Context Management settings continue to restart the Gateway before configuration read-back.

Do not expose Hermes configuration keys, terminal commands, implementation details, or unverified security guarantees.

## Content Approach

Use a short, task-oriented explanation rather than a new standalone safety guide.

Place Approval Mode before the existing Memory and Context Management instructions because it is the first group in the product UI.

Use matching information architecture in the domestic Chinese, international Simplified Chinese, and international English sources.

Use concise risk wording for Off so users understand the consequence without implying that it is suitable for general use.

## Verification

Run `pnpm docs:sync` to regenerate the `zh-cn`, `zh-sg`, `en-us`, `id-id`, and generated `zh-hant` outputs.

Confirm that each generated Advanced Settings page includes the new Security and Approval Mode content in its appropriate language.

Confirm that the existing `setting-1-cn.png` and `setting-1-en.png` references remain valid.

Run the relevant documentation checks and inspect the edited sources for disallowed internal information and region-specific wording.
