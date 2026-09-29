# OpenCraft file Explorer rendering

## goal / requirement_refs
User asked to model ownership and implement Codex-like CSS/JS file Explorer rendering.

## non_goals
No direct reuse of recovered Codex assets or vendor implementation; no Host API,
filesystem persistence, preview replacement, commit or deployment change.

## interface_refs / history_context
`WorkspaceResourcePanel` owns selected path and filesystem requests. Existing
`workspaceFileLanguage` identifies extensions, while every file row shows one
generic icon and text is rendered by plain pre/textarea. Local `ref/codex`
recovery shows extension-specific icon mapping and a CodeMirror text file editor.
The reference is a fixed read-only product snapshot, not a source authority.

## acceptance
CSS/JS/TS and related files have distinct file-type cues and syntax-aware
rendering/editing. File identity is Host plus path; query data is the server
snapshot, while unsaved drafts are local UI state. Switching files or receiving
late query results does not silently overwrite a draft or save another file.
Unknown/binary/oversized files retain safe fallbacks.

## context_receipt
Root and OpenCraft AGENTS, maintenance skill and verification reference read
earlier in this conversation. This turn read file Explorer source/tests and
bounded recovered Codex file tree/icon/editor entries.

## affected_paths
Workbench Web workspace resource panel/model, code editor/icon adapter, package
dependencies, relevant tests and formal OpenCraft/domain docs.

## validation / handoff
Focused workspace-resource tests, Workbench Web typecheck, Web production
build, and platform boundary check passed. Formal platform/domain ownership
docs updated; docs-impact and diff whitespace checks passed. Running preview
was not replaced, so phone/browser visual acceptance remains for a later
preview deployment.
