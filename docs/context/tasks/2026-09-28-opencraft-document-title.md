# Dynamic Workbench document title

## goal / requirement_refs
User request: 网页标题根据页面任务标题动态变化。

## non_goals
No preview replacement, restart, commit or backend changes.

## interface_refs / history_context
`app.tsx` already projects the active catalog Thread or extension title into the
header. `index.html` only supplied a static OpenCraft title. Reuse that projection,
do not add another Thread title cache. Formal reference: platform-architecture.md.

## acceptance
Current task/extension name followed by ` · OpenCraft`; draft/settings fallback;
rename and navigation update the same document; background views do not write it.

## context_receipt
Read root/OpenCraft AGENTS, maintenance SKILL and verification reference, task
template, routed agent-gateway-runtime/site-environment-routing/upstream-subtrees/
service-opencraft packs; inspected relevant platform architecture title ownership
and neighboring window-chrome test. No OpenCraft adjacency card exists.

## affected_paths
Web app shell, document-title formatter/test, platform/domain docs.

## validation / handoff
17/17 focused document-title/window-chrome tests passed; Web typecheck, platform
boundaries, Web build, explicit docs-impact and diff whitespace checks passed.
Browser tool lists no available tabs; actual client title/navigation acceptance
is not claimed. Source and local build updated; running preview unchanged.
