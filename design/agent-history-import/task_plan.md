# Local conversation import

Task: connect a local or Bash-enrolled native Agent, select existing conversations during
onboarding, import once, and continue from the conversation directory.

## Provider coverage (2026-11-17)

The Host now declares import support per Agent; the picker and Settings consume
that declaration rather than a Codex/Cursor list. Supported sources are Codex,
Cursor, Pi CLI, Claude Code, CodeBuddy CLI and the connected CodeBuddy IDE.
Uninstalled sources explain installation; unavailable IDE sources explain setup.
DSH conversations belonging to the deployment are already in its conversation
list and are not duplicated through an external CLI importer.

Pi discovers its configured native sessions plus OpenCraft-owned session files,
resumes the exact file and checks native identity/cwd. Claude uses the installed,
pinned official Agent SDK's read APIs exclusively in the history Worker.
CodeBuddy CLI reads its native project JSONL/current parent branch, including
content-addressed image blobs; each conversation owns its original process cwd.
Configured sandbox startup follows the existing sandbox command owner and fails
closed. IDE storage is bounded to the connected account and current project;
the Worker verifies the original record before a cold native resume is admitted.
IDE account/project identity is opaque in the UI and scopes selection/cache.
The import catalog uses a dedicated local-only RPC; version/login probes do not
delay this screen. Empty Pi model-discovery sessions are not import candidates.
No import transcribes history into a new prompt, authenticates another machine,
or replays a business message.

Native contracts inspected read-only: Pi 1.5.2, Claude Agent SDK 0.3.263,
Claude ACP 0.107.3 and CodeBuddy CLI 2.184.0 package contracts, plus the installed
CodeBuddy CN 1.106.1 / coding-copilot 3.10.0 storage contract. Adapter implementation
is independent; no third-party implementation was copied. Protocol docs:
[Pi](https://docs.pi.dev/latest/session-format),
[Claude](https://code.claude.com/docs/en/sessions),
[CodeBuddy](https://www.codebuddy.ai/docs/cli/codebuddy-dir).

Validation includes Worker-backed discovery/read, exact native IDs/cwd, SDK
parsing, source containment, branch selection, no discovery-time prompt, scope
isolation and old-Host compatibility. Installed Pi 1.5.2 also resumed a synthetic
external terminal file without inference or prompt replay. UI smoke exercises
all six declared sources, the four new import transactions, late responses and
Host replacement, desktop/touch input and three themes; its Host is simulated.
Screenshots are under `/tmp/opencraft-native-agent-import-ui`. Actual production
accounts, Linux sandbox limits and upgraded remote/IDE execution remain separate
from these tests. Full gate has the previously recorded Expo/worklets mismatch.

Actual Web preview: `/settings/chat` → import sheet shows all six source names;
the installed local Pi and Claude readers are present, CodeBuddy CLI explains
installation, and the existing untrusted/older IDE connection explains setup.
Observed local catalog reply: 2 ms without login probes; read-only native counts
were Codex 128, Cursor 7, Pi 3 and Claude 0. A separate synthetic regression
verifies that empty Pi discovery records are excluded. Inspected desktop
light and touch dark consumer screenshots: consistent source/name/count axis,
quiet navigation, touch targets preserved, explanatory text wraps inside the
container. Original onboarding smoke also passes, including the no-login-probe
invariant. No real conversation was imported or user message sent by this check.

Compose the existing Agent onboarding Start step with a bounded selectable
conversation collection. Shared Button/CheckboxIcon own control feedback;
onboarding owns scrolling and the responsive form. Selection, progress, failure
and imported state stay visible; failed selections remain retryable. Start/Back
are disabled while an import is committing. Existing users have the same import
section under Settings > Chat > Agent, rather than needing to replay onboarding.

Provider-native catalogs own discovery and pagination (ACP session/list when available), including native IDs,
titles and cwd. ACP routing ledger owns resumable imports; native history readers
own transcripts. No transcript is converted into a fresh prompt. Host binds the
import to myself before catalog notification. Saved routing survives restart;
repeated native IDs reuse their existing route. Cache/selection are scoped by
Host and account/display identity and retired on owner disposal. Late completion
cannot move another identity's view. Only Hosts advertising historyImport render
the entry; older Hosts keep their existing onboarding.

Validation: actual local Codex/Cursor native discovery, import in an isolated
Host, native-history reads, duplicate import, myself assignment and thread/list.
No real model inference was sent. ACP fixture covers restart and explicit resume
followed by a Turn on the original native ID. Browser smoke covers keyboard
selection, busy controls, retry, imported state and back/forward continuity;
viewed screenshots at 1100x850 and 390x844. Existing touch onboarding smoke is
retained. Final evidence is in this thread's agent-history-import artifact.


## Later import from model configuration

The model configuration entry now has a visible Import local conversations
button beside Open agent setup. It opens a dedicated history sheet with native
Codex/Cursor choices and automatic initial discovery, independent of model
selection and onboarding completion. Return keeps the same settings route and
unsaved provider draft. Reuses the same history selection/import owner.

Reviewed the actual model-services route at 1300×950 and touch 390×844, including
Codex → Cursor and return. Fixed the configuration grid to reserve a real row
for its action card; fixed the shared onboarding overlay's intrinsic grid track
so long native paths cannot push the sheet outside a narrow viewport. Real
browser asserts the narrow section is inside the viewport. No personal history
was imported during this UI check. Typecheck, i18n, shared-control ownership and
existing onboarding smoke passed.

## Native Codex project groups

Codex desktop state owns local project IDs, names, order and explicit Thread
membership. A read-only projection in the existing history Worker reads this
source; only recognized saved project roots provide a legacy directory fallback.
Explicit projectless/remote assignments are not guessed from cwd. This is source
presentation metadata, not another writable OpenCraft execution Project catalog.

Imports persist source project metadata in their existing ACP routing ledger.
Older deterministic native imports are backfilled by catalog discovery without
creating/reimporting sessions. The directory event/parser, SQL projection,
Merkle checksum, shared Workbench projection and display cache carry the same
optional contract. A missing/unreadable source retains committed metadata;
unchanged state does not rewrite routing records. Scope/ACL and execution cwd
remain owned by their existing authorities.

Sidebar uses source ID + Host for project identity, folder headings, native
ordering, per-project folding and six-row pagination. Same-named projects and
different Hosts remain distinct. Task attention/pin/private precedence is
retained; ungrouped conversations stay Recent. Project members omit repeated
project subtitles. Import selection also shows original folder group headings.

Validation: 62 focused tests passed for source membership, directory boundary,
rename/checksum, Worker errors/recovery, old import backfill, restart/resume,
offline display and sidebar projection. Actual running service showed three
backfilled projects from previously imported history; fold/unfold and reload
passed. Reviewed desktop 1300×950, real touch context 390×844, and actual Codex
import selection with project names/order. No new personal sessions were
imported or sent prompts during these checks.


## Agent-first discovery and folder selection

Import is a collection browser: Agent overview → project/directory folders →
conversation selection. The existing onboarding sheet owns width and scrolling;
shared Buttons own navigation and checkboxes. Each Agent loads its native
session directory independently, keeps its counts while subsequent pages load,
and exposes errors/retry without clearing another Agent or the current selection.
The import source is explicit on the overview, folder view and conversation rows.
Local history discovery does not require a successful online login probe. Cursor
status was reproduced returning no output after timeout, while the Host's native
Cursor history RPC returned six records in 10 ms. History-only entry therefore
reads the native directory directly through its existing history RPC and does
not run authentication probes. Import still records the original native session;
resuming/generating retains the existing runtime authentication checks.

States: cold-loading displays source identities and reading status; cached-refreshing
keeps counts/folders/selection; fresh shows discovered counts; cached-error keeps
data and scoped retry; Host/account change remounts and removes the old query scope.
Back through folders/Agents preserves selection. Busy import disables exits.


Verification for the source-first flow: running local Web Workbench history
sheet at 1300×900 with mouse and 390×900 with touch showed Codex 16 folders /
120 conversations and Cursor 3 folders / 6 conversations. Reviewed the actual
Agent overview, Cursor folders and conversation selection. Source icons, counts
and back navigation read in order; narrow paths ellipsize inside their own row
without horizontal page overflow. No personal conversation was imported or sent.

The existing onboarding browser smoke now covers the same hierarchy in both
onboarding and history-only entry: cold loading, counts during pagination, a
failed page retaining earlier counts, independent Agent failures, selection across
back navigation, import retry and busy exits. Reviewed screenshots in light,
dark and lavender, including keyboard and touch paths. Query lifetime uses its
existing cache owner with zero retention after the last scoped observer leaves,
so closing one view does not evict another active view's source data. History
UI is loaded on demand rather than expanding the startup resource budget.
Evidence: this thread's `Artifacts/agent-history-flow` and the onboarding smoke
screenshots under `/tmp/opencraft-agent-onboarding/history-*`.


## Resume directory names, scope, counts and recognizable rows

The old picker delegated discovery to ACP session/list, whose preview title and
population need not match Codex's native resume directory. The native-history
Worker now reads the newest Codex state index read-only, prefers native names
(with session_index.jsonl names for older schemas), and keyset-pages the active
or archived directory. Native child/attached agent threads are excluded from
user resume choices. Missing native indexes retain the ACP fallback; archive
controls are advertised only when the native directory supports them. Directory
reads neither start ACP nor issue session/resume; SQLite stays in the Worker.
Names, creation/update dates and archive support flow through the existing
history RPC and import identity. No rollout/session/account file is modified.

Collection pattern: retain Agent→folder navigation and shared selection controls;
add a wrapping search/sort/status toolbar within the existing sheet width. Rows
show native names and localized time, folder path appears once, folder count
reflects search results, and selected IDs survive sorting/search/archive switches.
Source scanning/progress and the explicit 5000-row guard remain honest; 100 is
an import batch size, not a catalog size.

Validation: 41 focused native directory/ACP/grouping tests passed, including
206 active rows across two pages, archive isolation, child exclusion, old schema
and native name-index compatibility, and zero ACP calls during native discovery.
A read-only local run enumerated 122 active sessions in 29 directories. Browser
smoke covered seven illustrative resume rows (fixture data, not the user's remote
count), search, created/updated ordering, archive switch and preserved selection.
Desktop/touch light, dark and lavender screenshots were reviewed after theme
transitions settled. A full-width shared select initially forced desktop controls
onto separate rows; only external shell width was adjusted so desktop groups
controls while the narrow sheet wraps them. No business control paint was changed.
Web/Host TypeScript, i18n and platform/control checks passed. The source and web
are updated; an existing remote companion must apply the official --update before
its native index can be read by the new implementation. Remote count parity is
not claimed before that update; no user conversation was imported or resumed.


Delivery checkpoint: the restarted local dev Host/Web serves companion archive
`745b991e16e2d6ce64a26fa11ff8e3223e79ff5ce56862590e0db23da4072931`.
The actual local Web history picker displayed 16 native project/folder groups and
122 active conversations (the read-only index has 29 distinct cwd values; native
project grouping intentionally combines some of those). Search, sorting and the
advertised archive selector were present. The existing remote pairing remained
online; it was not updated remotely or re-enrolled. The user applies the existing
official --update command to obtain the new remote reader. No parity claim about
that remote folder's seven CLI entries has been made without its updated data.


## Imported remote conversations in Chat and ready-Agent handoff

Read-only inspection confirmed four committed imports in the enrolled companion's
thread/list. Two frontend issues hid them: a fresh browser did not admit the
personally enrolled online Host's catalog, and the old native timestamps placed
ungrouped remote imports behind a large local Recent page. Owner-observed online
personal profiles now admit metadata reads independently of the active chat Host;
arbitrary idle SSH/control recipes still do not dial, and recipe/account fences
remain in force. Cwd from the native Thread survives the shared display projection
and scoped display cache (optional for old snapshots). Personal-machine cwd groups
are Host-qualified and visible before old local projects; these are viewer groups,
not invented native project IDs. Original dates and native session files stay intact.
Import completion continues invalidating that Host's existing catalog query.

The empty-model notice previously checked only the selected local DSH model. It
now independently checks native installation/login and advertised selectable models
on the current or personally enrolled online Hosts. A cached model declaration
alone is insufficient. Disabled Agents, hidden/policy-restricted models, account
and display scopes and cancellation are respected. Verified choices replace the
repeat-enrollment/configure prompt with Use Agent · machine actions. User selection
uses the existing intent-fenced Host/draft migration, retaining draft text and
attachments; it never silently changes a draft or sends a turn.

Actual local Web acceptance used the already-imported remote rows, without another
import: all four appeared in the machine-qualified cwd group on a fresh browser.
A typed unsent probe survived selecting the remote Codex, the setup notice
vanished, and clicking an imported row opened its historical user/assistant content
on the original Host. No model turn, install or remote configuration change was
performed. Runtime-boundary smoke covers keyboard/touch checking/ready states,
failed Agent handoff and draft preservation; native-readiness/catalog/cache/draft
and sidebar grouping tests passed. Web TypeScript, i18n and platform/control
checks passed. This is a client fix; the current running Web serves it and the
existing remote daemon requires no update. No GitHub release or merge is claimed.

## Native data homes and sidebar instance hierarchy

Read-only diagnosis of the updated remote companion found that the native resume
names existed in a second Codex home, while the importer queried the configured
default home. This was an actual source mismatch, not a failed updater. Discovery
now enumerates native home candidates in the existing history Worker, resolves
links and excludes SQLite-only stores without sessions. No credentials, shell
profiles or native files are changed. The import collection uses the existing
SettingsSelect for the canonical data path and prefers a resume-name index for
browsing. Source-specific queries, selections and trusted discovery candidates
cannot be mixed across homes. Old companions retain default history compatibility
and show a retry/update explanation if source discovery is unavailable.

Explicit imports persist a Host-owned source binding and use separate ledger
namespaces. The existing ACP transport receives that source's CODEX_HOME on
resume; default imports retain their original identity and environment. Same
native UUIDs in two homes remain separate after restart. Missing bindings fail
closed. Reading the directory never resumes native execution.

Sidebar project collections now nest under physical instance identity when more
than one instance contributes visible conversations; multiple Agent connections
on the same known machine share the instance. Working-directory and native
project identity remain Host-scoped. One instance omits that heading, retaining
the two-level project/session view. Both disclosures retain independent state;
menu visibility also respects a collapsed instance. Existing urgent, pinned and
private task-flow projections retain their ownership.

Acceptance: synthetic two-home Worker/native-history fixtures verify names,
source isolation, duplicate UUID imports, restart and the actual test ACP peer's
resume environment (without creating a session or sending a prompt). The real
history picker was viewed in desktop and actual touch contexts: data path above
the collection, seven short titles, relative dates, responsive filters and
source switching, with isolated import parameters. Screenshots are in
/tmp/opencraft-agent-onboarding/resume-directory-*.png. The original remote
companion is not automatically updated; its new source endpoint and seven-row
parity remain to be verified after the official update.

Final client acceptance also exercised the real running local Workbench against
its existing enrolled remote catalog: two instance groups, one remote working
project and four previously committed remote sessions were present. Both the
instance and project disclosures worked through keyboard/touch in the real
Sidebar fixtures, including light/dark themes and the single-instance fallback.
The real page's local group was collapsed to review the remote three-level tree;
no native prompt, remote update or additional import was performed. Viewed
artifacts: /tmp/opencraft-sidebar-instances-{desktop,touch}-{light,dark}.png and
/tmp/opencraft-live-instance-project-session.png. The nested rows fit without
horizontal overflow; instance labels and indented folder/session rows preserve
recognizable provenance. Web/Host TypeScript, focused native source/ACP/catalog
and grouping tests, onboarding/sidebar browser smoke, i18n, controls and platform
boundary checks passed.

Running local preview: PID 16240, 127.0.0.1:5173. Its generated companion archive
is a45b493ecb1d714dd02e56512675b4d706d558311dbfd9be4dbd09c4fbef1689.
The original remote machine remains on its previous runtime until its owner
executes the official --update control. Seven-row parity on that original
machine is not claimed from synthetic tests or from the existing four imports.

## Rename instance display labels

The instance row now has an always-discoverable edit action beside the disclosure,
using shared IconButton and the same utility rename dialog presentation as Chat.
A shared EntityRenameDialog keeps title/field labels supplied by the caller while
the existing conversation wrapper preserves its original API and wording. Save is
explicit, blank input is disabled, pending dismissal is fenced, and a failed
write retains the input with inline retry feedback. Returning focus targets the
original edit button; renaming never changes the instance key or folded state.

`sidebar.instanceNames` is a typed installation preference whose entries are
partitioned by current display/account scope and stable machine identity (Host ID
only when no physical machine identity is known). Writes use UiPreferencesRuntime
CAS/update; the preference changes sidebar presentation only, not OS hostnames,
remote daemon identities or connection recipes. A scope change remounts the editor
lease, keeping late results out of the next account's view.

Viewed real Sidebar fixtures in desktop keyboard and actual touch contexts, light
and dark themes, including blank/cancel, injected persistence failure and retry,
successful edit, opener focus and full reload via the real IndexedDB adapter.
The edit stays aligned at the right edge without shrinking disclosure hit targets;
long labels ellipsize while the action remains visible. Viewed artifacts:
/tmp/opencraft-instance-rename-{desktop,touch}-{light,dark}.png and the updated
/tmp/opencraft-sidebar-instances-*.png. Preference persistence/validation tests,
Web TypeScript, i18n and control/platform boundary checks passed. The running
local Web serves the feature; no remote companion update is required.

## Enrollment owner while a remote Agent is selected

Actual read-only RPC reproduced the reported page: the remote companion returned
"Personal machine enrollment is unavailable", while the deployment owner listed
the enrolled machine as connected. HostAgentOnboarding forwarded enrollment
requests through the currently selected Agent, conflating execution placement
with deployment admission authority.

The active supervisor now exposes a narrow personalMachines owner port bound to
its deployment bootstrap Host (the same assembly-owned identity used for server
storage), independent of the selected execution Host. The application context and
HostAgentOnboarding carry that port to PersonalMachineSetup; native Agent status,
model discovery and history still target their selected machine. No navigation or
execution target changes to load enrollment. Hostless/unavailable owners reject
rather than falling back to an arbitrary remote companion.

Keyboard/touch runtime-boundary smoke keeps a remote Agent selected, loads the
owner directory and generates a synthetic command; it asserts that no enrollment
RPC reaches that remote Agent. Actual local Workbench acceptance selected the
existing remote Codex, opened remote setup and observed only owner list traffic,
a working Generate Bash command button and the existing connected machine. The
URL/remote execution selection stayed unchanged. No new pairing, prompt or remote
configuration was created. Viewed /tmp/opencraft-enrollment-owner-live.png and
/tmp/opencraft-machine-settings-evidence/enrollment-owner-*.png. Web TypeScript
and platform/control boundary checks passed. The running local Web serves this
client-only routing correction.

## CodeBuddy IDE native client (2026-11-16)

Task: connect the IDE agent independently of CodeBuddy CLI. The Agent settings
consumer keeps the existing SettingsListItem composition, page-owned gutter and
scrolling; Connect IDE is the primary setup action. Native login and project-trust
follow-up actions are explicit. IDE and CLI have separate IDs, labels and readiness.
The extension and Host own transport; the native IDE owns authentication, project,
permissions, model and execution. Details and initial limits: docs/codebuddy-ide.md.

Viewed actual React settings consumers in desktop keyboard and genuine touch
contexts, light/dark themes: /tmp/opencraft-codebuddy-ide-ui/*.png. Reviewed the
whole rows, separate IDE/CLI names, connect/trust actions and disabled readiness
switches. The list fits the narrow container without clipping; keyboard focus is
visible and touch retains the same actions. This is UI verification with fixture
status, not a native model execution claim.

Built and installed the OpenCraft VSIX through CodeBuddy's own CLI. In a separate
validation profile, actual CodeBuddy CN 1.106.1 activated the extension, established
the authenticated loopback transport and answered describe through its native
commands. That profile reports authenticated=false and workspaceTrusted=false.
Login and trust remain native user actions; no trust database or credential was
copied/modified. A live model turn remains unverified pending those actions.
The original IDE window was not forcibly reloaded or terminated.

Native command tests use mocked IDE completion with real WebSocket/ACP transport;
they cover same native ID, current-project fencing, busy/concurrent sends, trust,
invalid credentials and browser Origin rejection. Host/Web type checks, relevant
onboarding/model-cache regressions and i18n checks accompany this implementation.

After updating local preview PID 58247, also viewed the real application's Agent
onboarding sheet at 127.0.0.1:5173, with live Host/native IDE status (not a fixture):
/tmp/opencraft-codebuddy-ide-ui/live-onboarding.png. It displays CodeBuddy IDE and
CodeBuddy CLI separately, and shows the native untrusted-project action correctly.
Live status confirms connectionRequired=false, authenticated=false,
workspaceTrusted=false. Existing enrolled remote machine remained connected after
the preview restart. The final installed VSIX includes the native trust-panel
command; already-running extension hosts need native window reload to consume
that final artifact. No original IDE window was forcibly reloaded.

## Onboarding completion and first native input (2026-11-16)

Continued the earlier onboarding report against the current checkout and live Web
preview. Keep the first-run gate full-page; setup reopened from Settings consumes
the existing workbench route stage so the Settings navigation remains visible.
The sheet owns its scrolling, Settings rows retain their shared composition, and
Back is the quiet exit. Router revision changes dismiss non-gate setup; Start
returns to Chat with the selected model and the retained Composer draft. Covered
route content is inert without unmounting its business owners. The canvas now
uses the existing surface token; the old undefined background token fell back to
white in dark mode. Its regression assertion failed against that old background
before the correction, then passed in light/dark/Lavender and touch contexts.

Real first-message tests exposed a separate initialization deadlock in both
Codex and Cursor: session/new succeeds before the native transcript exists, and
the initial history read failed before the pending input could be submitted.
New sessions persist an explicit no-input attestation. The Worker may project an
empty page only for that attested missing source, still validates any existing
source, and fails for corruption. Accepting the first input revokes the marker;
public callers cannot forge it. Legacy/imported records are not inferred empty.
Also fenced late sidebar catch-up callbacks at their React owner's lifetime,
after logs showed them accessing a disposed Host registry during shutdown.

Viewed the actual settings sheet, Cursor's live model list and its visible
navigation at /settings/opencraft.builtin-agents.model-services. Desktop
keyboard, desktop touch (1100x850) and phone touch (390x844) passed entry/return
and route-bound geometry checks. The explicit Back button restored model
settings; selecting Appearance dismissed setup. Start returned to Chat while
preserving an unsent Chinese draft. Viewed:
/tmp/opencraft-continue-sheet-after.png,
/tmp/opencraft-continue-phone-verified.png,
/tmp/opencraft-agent-onboarding/touch-dark.png.

Actual Codex and Cursor first prompts returned OPENCRAFT_OK / CURSOR_OK and
turn/completed=completed. Fresh browser loads recovered those native messages;
the Codex target's history reads had no errors. Viewed
/tmp/opencraft-continue-codex-verified.png,
/tmp/opencraft-continue-codex-reloaded.png and
/tmp/opencraft-continue-cursor-reloaded.png. The latest preview's runtime-error
endpoint remained empty after the Cursor acceptance and client shutdown.

Validation: 68 focused ACP/native-history/attention tests; 67 Router/restore
tests; onboarding browser smoke; Web/Host TypeScript; i18n checks/tests;
controls checks/tests and platform boundaries passed. Fixed an existing test's
cleanup ordering by closing its restored engine before deleting the fixture.
The full gate was attempted and stopped in test:startup: the installed Expo
contract requires react-native-worklets 0.13.0, but this workspace has 0.13.1.
No mobile dependencies were changed. Full gate log:
/tmp/opencraft-continue-gate.log. Electron/Expo device execution and other agents'
login/model services were not verified. No installed binary or release produced.
The local source preview runs as PID 32581 on port 5173 and is exposed through
BB Connect at https://sliver--5173.getbb.app.

## Read-only Composer recovery latency (2026-11-16)

Measured the reported loading Composer against the live remote conversation
“新增文档更新分类筛选项”. The initial read requested ten full Turns, including
older tool output, before the current snapshot could become authoritative.
Read-only opening now requests the latest single Turn through the existing
negotiated initial window. Full Items and the older cursor are preserved;
ordinary backfill, snapshot-overlap reconciliation, cancellation budgets and
execution ownership remain unchanged. No attention scheduling change was made.

An isolated browser comparison against the same live backend requested the old
ten-Turn window as a control: 3,210,442 bytes / 3,364 ms for the history RPC and
3,743 ms until the Composer cleared its loading state. The optimized desktop
sample used 21,338 bytes / 165 ms and cleared loading at 629 ms. A separate
390x844 touch browser sample used 70,259 bytes / 1,098 ms and cleared loading at
1,625 ms; the active Turn continued growing between samples. These are observed
samples, not a latency guarantee or a change to model execution duration.

Viewed the actual touch Composer and desktop older-history flow in
/tmp/opencraft-load-touch-optimized.png and
/tmp/opencraft-load-older-verified.png. Scrolling back expanded one rendered
Turn to five while the Composer remained ready. The probe sent no resume,
new prompt or interruption. Comparison evidence is recorded in
/tmp/opencraft-load-comparison.json. The control override affected only its
isolated test browser, without changing the backend or source policy.

Validation: 106 session/recovery-budget/notification/hydration tests passed,
including a regression that loads an older large tool output intact after the
initial one-Turn read. Session and Web TypeScript checks passed. The prior full
gate's unrelated Expo/worklets mismatch remains unresolved; no new full gate
claim is made. The existing source preview PID 32581 consumed the client update;
no remote Host or native task was restarted. Installed Electron and Expo device
presentation were not verified, and no binary or release was produced.

## Connected ACP screenshot input (2026-11-16)

The reported unsent screenshot failed in the ACP adapter's unconditional
text-only input mapper, before native prompt dispatch. The adapter now converts
Composer inline images and staged Host-local images to ACP v1 image blocks,
gated by the current session transport's declared image capability. It preserves
text/image order and the accepted user-message image projection. Connected model
catalogs retain saved input modalities; old missing declarations remain
conservative without waking the peer. The reading/input/result composition and
existing Composer/attachment owners are unchanged; no new UI surface or wording
was introduced. Ordinary failed-input/draft ownership remains in the existing
Composer/runtime flow.

Regression tests first reproduced the screenshot's text-only rejection. Then
62 ACP, model-cache, capability and attachment tests passed, with Web-independent
adapter/Host TypeScript and platform boundaries. The tests verify exact image
bytes, inline/local/image-only inputs, retained images, cold catalog declarations
and rejection before Turn creation for unsupported peers, malformed/oversized
content, excess images, remote URLs and opaque file IDs. No silent text fallback.
The installed Codex ACP 2.6.0 initialize response declares image=true; that probe
sent no prompt and consumed no model quota.

Viewed actual Workbench desktop and 390x844 touch-browser sends through an
isolated WebSocket Host backed by the changed real ACP adapter and a subprocess
test peer. Both sent text plus image and rendered the accepted image/reply:
/tmp/opencraft-acp-image-desktop-sent.png,
/tmp/opencraft-acp-image-touch-sent.png. Native/model responses were synthetic;
this is not a claim of real remote image inference. Evidence:
/tmp/opencraft-acp-image-ui.json and /tmp/opencraft-acp-image-ui.log. The probe
neither forwarded test prompts to a remote Agent nor retried the user's failed
business request. Initial harness failures were missing fixture approval fields
and native-picker timing, corrected before both paths passed.

Prepared the companion source archive using a separate temporary Git index,
preserving the user's shared index and unrelated work. Restarted the idle local
source preview as PID 97240, with the existing port/share. The served archive's
three affected runtime files match this checkout; its checksum receipt is
/tmp/opencraft-acp-image-served-artifact.json. This provides the corrected remote
update package; it does not replace an already-running remote companion. Remote
runtime update and real remote model image inference remain unverified. Update
the companion after its active tasks finish, then retry the unsent message;
no remote task was restarted as part of this change. No formal release or
installed Electron/Expo validation was performed.

## Codex base-model selection confirmation (2026-11-16)

Investigated the later “requested model was not selected” unsent input. A
read-only probe showed the existing remote conversation idle on
codex:gpt-6.1-sol[high], present in its catalog. An isolated real Codex ACP 2.6.0
session reproduced the adapter false rejection: requesting the declared base
gpt-6.1-sol returned native config model=gpt-6.1-sol, reasoning_effort=medium;
the adapter projected gpt-6.1-sol[medium] and compared that whole identity to the
requested base. Native selection succeeded, but adapter confirmation rejected.
No prompt was sent during that real-native probe.

For declared Codex base selections only, confirmation now compares the observed
base, retaining the full observed native model/effort in metadata. Explicit
reasoning variants still require an exact match. The regression failed before
the fix and passed afterward; refusing either a different base or an ignored
explicit effort still prevents native prompt dispatch. The real-native base,
low and high selection probes now all confirm correctly, without inference.
Evidence: /tmp/opencraft-model-selection-probe.json.

Validation: 64 ACP/catalog/capability/attachment tests and adapter TypeScript
passed. Viewed the existing desktop and touch Workbench image-send flow again
with a fixture initialized through a base-model request and a parameterized
native catalog. Both actual UI sends reached the changed adapter with text and
image; native/model replies in that UI probe remain synthetic. Evidence:
/tmp/opencraft-model-selection-ui.log and
/tmp/opencraft-acp-image-desktop-sent.png,
/tmp/opencraft-acp-image-touch-sent.png. No UI geometry or text was changed.
Prepared the revised source package through the same separate temporary index;
remote companion update remains required, with no automatic replay of the
user's failed message and no remote program restart performed by this task.

## Existing-source image capability recovery (2026-11-16)

The next screenshot failed the client compiler's image preflight, before native
prompt dispatch. Live read-only model/list returned text-only for all six
gpt-6.1-sol variants. Verified the enrolled remote companion identity; the earlier display-name
wording did not identify the actual enrolled companion correctly.

Found three connected ownership/cache faults. The Host's scoped model list read
the default Agent catalog instead of the imported Thread's Codex source; its
earlier projected modalities could stay cached. ACP deduplication let an older
session with no declaration replace a known image declaration for the same
model ID. The submission compiler also fell back from a missing scoped model
page to a cached unscoped page. Now the Host reads the actual Thread/source,
projects current metadata, ACP prefers live negotiation or the latest observed
saved declaration, and the compiler consumes only its requested scope. Native
initialization invalidates client model pages. Missing Codex/Cursor declarations
can initialize in a deduplicated background lane, without new/load/resume/prompt;
Host close drains those probes. Unknown data stays conservative until observed.

New regressions failed against the old source/dedup behavior and now pass.
Execution/capability/attachment suites passed (67 before adding the final cold
source probe); the complete seven-test connected-model suite also passed with
that probe. The compiler regression covers both directions of disagreement
between scoped and unscoped input capabilities. Adapter, Host, runtime and Web
TypeScript and boundaries passed. The broader session-model test file has two
existing failures (removed-model expectation and undeclared priority-tier
expectation); both still fail with the original cache fallback restored. Logs:
/tmp/opencraft-existing-session-baseline-tests.log,
/tmp/opencraft-existing-source-tests.log,
/tmp/opencraft-existing-source-compiler-test.log.

Viewed desktop and touch Workbench sends through the actual ConnectedAgentHost
projection, real source-scoped ACP adapter and a subprocess test peer. The default
source deliberately declares text-only while the imported source declares image.
Both UI sends retained text plus image and rendered accepted replies without
page errors. Screenshots:
/tmp/opencraft-existing-source-image-desktop-sent.png,
/tmp/opencraft-existing-source-image-touch-sent.png;
log /tmp/opencraft-existing-source-image-ui.log. The native/model boundary remains
synthetic in this UI test; it is not remote inference evidence.

Prepared the revised companion source archive via the separate temporary index,
then restarted the idle local source preview as PID 25637. Runtime errors remain
empty. Remote companion upgrade and end-to-end remote inference have not been
verified. Requested the actual machine's SSH address/user because the enrolled
Workbench transport exposes no supported companion update control; no remote
upgrade or business-prompt replay was performed. The revised served archive
receipt is /tmp/opencraft-existing-source-served-artifact.json.
