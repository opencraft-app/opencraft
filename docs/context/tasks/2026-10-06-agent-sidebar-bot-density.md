---
id: agent-sidebar-bot-density-20261006
type: task
scope: Compact the desktop Agent sidebar Bot selector shown in the user screenshot.
triggers: ["Agent sidebar Bot selector density"]
owner: LightVela frontend
authority: primary
source_of_truth:
  - frontend/src/styles.css
status: in-review
reviewed_at: 2026-10-06
review_due: 2026-10-20
revision: 1.0.0
precedence: task
derived: false
---

## goal

Reduce the desktop sidebar Bot selector height and Bot name font size slightly.

## non_goals

- No mobile target-size, Bot behavior, route, billing, or backend changes.

## requirement_ids / requirement_refs / requirement_excerpt

- User screenshot on 2026-10-06 highlights the desktop Bot selector and requests a shorter box and smaller Bot name. External issue ID: unknown.

## interface_refs / data_structure_refs

- `.lv-agents-sidebar-profile .lv-agent-profile-wrap`, `.lv-agent-profile`, and `.lv-agent-profile-name` in `frontend/src/styles.css` own this geometry.
- The mobile baseline remains 44px minimum height with a 14px Bot name; the collapsed desktop selector keeps its existing 32px override.

## history_context

- `current_design_refs`: current source and `frontend/src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts`.
- `relevant_evolution`: the existing Agent sidebar density rules already split desktop and mobile styling.
- `superseded_refs`: older sidebar spacing snapshots are history only.

## acceptance

- Expanded desktop selector minimum height changes from 44px to 40px, vertical padding from 4px to 3px, and name font from 14px to 13px.
- Mobile and collapsed selector sizing stay unchanged; focused test, frontend check, regional builds, and `git diff --check` pass.

## affected_paths

- `frontend/src/styles.css`
- `frontend/src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts`
- This Task Pack.

## required_context

- Exact route query matched no Pack; bounded search located the CSS and adjacent test.

## context_receipt

| File | Reason | Use |
|---|---|---|
| `AGENTS.md@user-provided` | Repository boundary | Validation and handoff |
| `frontend/AGENTS.md@f3046979d` | Frontend guidance read earlier in this task | Focused UI validation |
| `frontend/src/styles.css@f9bac5d26` | Current implementation | Desktop-only sizing |
| `frontend/src/pages/marketing/agent-settings-page.tsx@f9bac5d26` | Selector markup | Keep actions and Bot behavior intact |
| `frontend/src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts@f9bac5d26` | Adjacent test | Desktop/mobile spacing assertions |

## evidence

- `validate_context.py --route 'frontend Agent desktop sidebar Bot profile selector height and bot name font size'` returned no Pack; bounded `rg` found the selector styles and neighboring test.
- The expanded desktop selector now has a 40px minimum trigger height and 3px vertical wrapper padding, for a 48px minimum outlined box; the Bot name is 13px/18px. Mobile retains 44px and 14px/20px.
- Nav-spacing test passed 7/7. An Agent page component test confirmed restart and delete controls render (1/1). One older multi-Bot test was stopped after it stalled, and is not counted as passed.
- `pnpm check` passed with 0 new TypeScript diagnostics. CN and global builds passed; `git diff --check` passed.

## risks

- Compacting a selected Bot with status or renewal badges may need a second line; minimum height allows content to grow.

## validation

- Focused nav-spacing test, `pnpm check`, both regional builds, `git diff --check`, and staged change-impact check.

## decisions

- Change only the expanded desktop selector; preserve mobile dimensions and existing desktop collapse behavior.

## scan_scope

- Agent profile CSS, rendered markup, and adjacent nav-spacing test.

## scan_output

- Bounded symbol search: `lv-agent-profile-wrap|lv-agent-profile-name|lv-agent-profile`.

## handoff

- Local change validated on `codex/mobile-account-menu`; user previously authorized delivery through MR !5036. Commit, push, MR update, and CI verification remain to complete.
