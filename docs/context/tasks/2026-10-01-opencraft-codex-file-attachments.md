## goal
Make ordinary browser-selected files genuinely sendable through the Codex Host, with truthful, recoverable Composer feedback.

## follow_up_2026_10_01
Live preview showed an 10,840-byte Markdown file staged and persisted as a native `UserMessage` `mention`, but the Codex rollout's model-facing `response_item` contained only the typed text. The user explicitly requested a reference-informed implementation of model-visible file delivery. Keep the staging/mention display path, and add a Host-owned, model-visible file locator only after verifying the staged reference. Do not confuse a persisted `mention` with model context.

Reference scope: `ref/bb/apps/host-daemon/src/command-handlers/prompt-attachments.ts` stages under the execution Host and preserves `localFile` as a typed input; `ref/paseo/packages/server/src/server/agent/prompt-attachments.ts` and `providers/codex-app-server-agent.ts` render uploaded-file name/path into Codex text input; `ref/codex/composer/create-composer-file-attachments-controller-09984.ts` materializes browser files before sending. These references inform ownership and conversion, not a claim that their protocols are identical.

Implementation: the Codex Host validates an owned staged `mention` against its manifest immediately before direct or queued `turn/start`/`turn/steer`, then adds a model-visible text locator while retaining the `mention` for history. The generated text has an empty UI placeholder span, which the shared timeline projector omits from the visible bubble. Queued input remains unchanged until dispatch, and validation precedes the queue claim.

Display follow-up: after native acknowledgement, the staged file appeared as an `@name` context chip because the optimistic file attachment and authoritative `mention` had different presentation inputs. Keep one canonical message identity. Codex reference uses explicit `attachments` on the pending Turn and authoritative UserMessage where available, with a narrowly defined content fallback. This AppServer version lacks a generic file UserInput, so the Host now tags its validated locator's UI-only text element; the shared projector classifies only the immediately following tagged mention as a file. A legacy exact-locator match covers already-sent preview messages. Ordinary mentions stay context chips; no filename/path guessing in the Renderer.

2026-10-02 regression: the live Codex rollout preserved the Host's tagged
locator and `mention` in its acknowledged `UserMessage`, but `Turn.params`
still contained the unaugmented Composer input. Chat normalization selected
`Turn.params` even after server acknowledgement, so the file stayed an `@name`
context chip; a subsequent preview exposed the model locator in the bubble.
The repair keeps Composer input canonical for ordinary messages, but selects
the acknowledged server content when it carries the Host-owned staged-file
display span. This preserves one message identity and lets the shared
projector hide the locator and render the file attachment. File-only and
file-plus-text cases have regression assertions based on the actual rollout
shape. The previous rollback failed because its target was a stopped
transient systemd unit no longer defined; the next cutover must recreate the
preserved package as a new transient unit, not `systemctl start` the vanished
unit.

## non_goals
- No production rollout, commit, or push. The user subsequently authorized replacing the temporary self-hosted preview; preserve its package and data for rollback.
- No new generic Codex `localFile` input type; staged files use supported `mention` input.

## durable_attachment_follow_up_2026_10_02
The Host owns one persistent mapping `(threadId, clientUserMessageId) -> AttachmentRef[]` in its data root. Direct and queued dispatch validate staged refs and record that mapping before the native request. Codex still receives supported `mention` plus model-visible locator; the mapping, not the locator, is the display authority. The Host projects typed attachment metadata into live UserMessage notifications, Turn responses, paged Turns/Items and resumed Thread history. Fork clones mappings to the new Thread identity. Draft removal is rejected once an attachment is referenced by a sent/prepared message, preserving historical bytes. Existing rollout entries lacking a mapping retain an exact Host-generated locator compatibility path.

The current implementation does not yet claim durable cross-Host replication or garbage collection of historical files. Queue draft presentation remains owned by its original input until dispatch; the durable mapping starts at dispatch. No online preview replacement is part of this source change until focused and package-level verification completes.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | Root and local rules | Scope and verification |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`, `references/verification.md` | Maintenance method | Separate source and runtime evidence |
| `opencraft/docs/platform-architecture.md`, `opencraft/docs/chat-ui-architecture.md` | Architecture authority | Keep bytes in Host and Draft state in Composer |
| `ref/codex/composer/create-composer-file-attachments-controller-09984.ts`, `ref/bb/apps/host-daemon/src/command-handlers/prompt-attachments.ts` | Read-only references | Compare local/remote materialization and failure ownership |

## acceptance
- Codex Host advertises attachment staging only when it can serve `attachment/stage` and `attachment/remove` itself.
- A small Markdown file stages under the Codex Host data root, is readable by the Codex process, and compiles to a native `mention` path; pure attachment input is allowed.
- A failed or pending ordinary file visibly explains why Send is unavailable, supports retry, and does not silently enter another Draft.
- Disconnected logical clients cannot receive another client's stage response; repeated stage identity remains idempotent.

## validation
- Focused adapter, staging, Composer, compiler tests; affected workspace typechecks, Web build, boundary and documentation checks.
- Running preview replacement uses a separate systemd switcher and must be verified from the reconnected session.

## decisions
- Reuse the existing local staging service through a narrow package export; Codex adapter owns its instance under its data root.
- Intercept only the declared attachment methods for initialized logical clients, and suppress late replies after client-epoch change.
- Keep Host errors in attachment state for diagnosis, but render short, stable user-facing card status and retry controls.

## evidence
- Final focused adapter/compiler/Composer suite: 46/46 passed; Local staging service suite: 4/4 passed, including Codex Host stage/replay/remove and pure Markdown attachment input.
- Local Host, Daemon, Composer and Web workspace typechecks passed; Web and Daemon production builds passed.
- Boundary check, documentation validation and scoped `git diff --check` passed.
- No running preview was replaced. A mobile browser acceptance pass is still needed after an explicitly authorized preview update.
- Follow-up focused adapter, staging and chat-core suite: 120/120 passed, including direct and queued attachment delivery plus stale-reference rejection. Workspace typechecks, Daemon production build, boundary check and `git diff --check` passed. The running preview was not replaced in this follow-up.
- User-authorized preview replacement completed on 2026-10-01: independent cutover unit succeeded; live unit is `opencraft-attach-model-20261001-preview.service`, PID 3647699, serving build `20261001125627-4a4d842ae4ea` with runtime SHA-256 `f4d59479e6bd247b5e6a329e876a848e7e292657edee61fbfa754cf46997e36d`. `/__opencraft_health` returned `{"ok":true,"appServerConfigured":true}`; candidate archive passed headless package smoke. The previous unit and package remain available for rollback. Actual mobile file-reading behavior remains to be checked by sending a new attachment.
- Sent-file presentation follow-up: 127/127 focused chat-core, Web layout and Codex adapter tests passed; affected workspace typechecks, platform boundary check and Web release build passed. Source now marks Host-validated staged file locators and projects only marked/legacy-exact mentions as file cards. No preview switch in this follow-up; the running service still has the previous display behavior.
- 2026-10-02: inspected the actual Codex rollout `item_completed` payload for the affected file; it retained the tagged text span plus `mention`. The normalized `Turn.params` path, not native persistence, was the divergent display owner. Focused chat-core tests 94/94 passed after the ownership fix; chat-core and Web typechecks plus boundary check passed. The live preview still runs the regressed 2026-10-01 package pending a separately verified replacement.
- After replacing that preview, the user reported that an in-progress steer still showed `@filename`. The steering row also owns a local unaugmented input and suppresses its matching server `UserMessage`; its projector reads `input` before `content`. The same acknowledged-span rule now updates the steering input while keeping the local row identity/status. A focused steering file regression test was added; 95/95 chat-core tests pass. This follow-up source is not yet in the running preview.
- Small ownership refactor: ordinary Turn and steer now call one `acknowledgedDisplayInput` reconciliation function. The delivery path selects the local input and matching server Item; the shared function alone chooses whether the Host-owned staged-file display span makes the acknowledged server content authoritative. This is a bounded compatibility step, not yet the proposed durable typed-attachment sidecar for cross-device history.
