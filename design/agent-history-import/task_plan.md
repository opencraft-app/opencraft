# Local conversation import

Task: connect a local Codex/Cursor, select existing conversations during
onboarding, import once, and continue from the conversation directory.

Compose the existing Agent onboarding Start step with a bounded selectable
conversation collection. Shared Button/CheckboxIcon own control feedback;
onboarding owns scrolling and the responsive form. Selection, progress, failure
and imported state stay visible; failed selections remain retryable. Start/Back
are disabled while an import is committing. Existing users have the same import
section under Settings > Chat > Agent, rather than needing to replay onboarding.

Native ACP session/list owns discovery and pagination, including native IDs,
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
