# UI design topics

Load this index only for a UI implementation/review task. It routes to existing
owners; it does not introduce a second theme, component library or token registry.

Start UI authoring with the [design entry](../../design.md): choose a working
Settings, collection, Chat, Sidebar or inline App pattern, then load only the relevant topic
below. Token numbers and behavior remain at their existing source owners.

| Task | Load next | Authority / validation |
|---|---|---|
| Task catalogs, management lists, page hierarchy and action placement | [Collection composition](collections.md) | Existing Settings/route owners; composition examples and scoped rendered checks |
| Text, font, weight, size, menus, form labels, content typography | [Typography](typography.md) | Existing design-system registry; `npm run check:typography`, `npm run test:typography`, `npm run smoke:typography` |
| Conversation process-summary parity, SVG size, optical weight and clarity | [Activity icons](activity-icons.md) | Shared summary/rail owner; activity policy in typography gate; real Conversation metrics smoke |
| Composer microphone, lightning and action artwork consistency | [Composer icons](composer-icons.md) | Shared design-system-web glyphs; real Composer/voice checks |
| Layout, pane ownership, adaptive presentation | [Workspace invariants](../invariants.md) | Existing Shell geometry and platform adapters |
| Colors, surfaces, controls | [Workbench language](../../docs/workbench-design-language.md), [platform theme ownership](../../docs/architecture/platform/presentation-and-input.md#theme-surfaces-and-native-appearance) | Existing theme engine and shared controls |

For a future topic such as SVG icons, add one scoped document and a corresponding
check under this index when its contract is actually designed. Reuse existing icon
owners; do not prebuild a general design framework or load every topic for every task.

Before editing: identify the semantic role, its current owner, affected consumers
and platform exceptions. After editing: validate the owner and one real consumer.
A screenshot, token reference, or passing lint alone does not prove semantic fit.

IM settings consume shared section rhythm, semantic empty-state typography and
utility modal/SettingsPanel surfaces. Compact stacked forms use
settings-panel-form; reserved validation belongs below its associated input.
