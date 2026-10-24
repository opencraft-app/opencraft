# Progress

2026-09-17: References inspected; no Graphify. Dirty worktree preserved. No installed app/profile changes. Implementation and real-runtime acceptance pending.

Core fixes implemented. 18 focused tests passed; initial real DSH smoke passed blank create/fork, namespace/function inheritance, invalid spec preflight, restart and correct synthetic model routing. First typecheck found overly broad DshSessionModels return type for a selection-only read; narrowed to Pick<..., current> instead of fabricating catalog/routable fields. Extended tests now cover cold capability registration and schema preflight; running.

Final focused checks: DSH suite 218/218, lifecycle + broker 14/14, local Host typecheck, platform boundaries and Electron build passed. Extended real native smoke passed malformed schema preflight, cold tool registration and inherited tools in actual synthetic outbound request after restart. Documentation impact explicit-path check passed; --staged is empty (no staging). Documentation validation: zero broken first-party links; diff --check passed.

Isolated Electron CDP 9493 uses a new temporary profile and synthetic loopback provider only. After a real Host restart, both QA blank parent and QA blank fork displayed QA Text Model without unavailable/error UI. Testing native UI menu fork next. Applications and user profiles untouched.

Desktop menu acceptance passed: QA blank fork → context menu 新建分支 → a third thread selected, Composer QA Text Model / Workspace Write, no Invalid dynamic tool specification. Screenshot: /tmp/opencraft-thread-bindings-verified.png. No user data or paid provider used. No commit, install or release.
