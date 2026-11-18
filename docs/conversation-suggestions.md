# Composer conversation references

Typing `@` in the normal Composer browses up to eight recent unarchived
conversations in the current execution namespace. Title search returns at most
twenty. Agent/member mentions keep their existing separate behavior. The existing
Composer owns the popup, scrolling, keyboard selection, focus and draft; selecting
an entry only inserts the existing stable reference token. File and conversation
results settle independently and appear in separate groups. Late groups preserve
the keyboard-selected entry. Preview explicitly requests bounded history.

Both searches debounce keyword changes by 180ms and suppress IME composition.
Conversation requests deduplicate identical in-flight work inside the mounted
reference provider. There is deliberately no long-lived result cache: a new lookup
rechecks renames, archives and permission changes. Aborting discards late results;
the current RPC transport does not cancel already-running server queries.

The collaboration `discover` command accepts `suggestions:true`, `limit:1..20`
and optional `sourceThreadId`. Suggestion queries do not paginate or fan out over
all engines. They use the existing caller authorization and select the source
thread's execution namespace (primary for a new draft). Native `thread/list`
receives `archived:false`, `useStateDbOnly:true`, `sortKey:updated_at` and descending
order. This prevents JSONL scan-and-repair. The native title substring query may
still scan database metadata for a no-match query; this is not a full-text index.
Only bounded reference/title/cwd/update metadata crosses the response boundary.
Deploy the collaboration server and Web change together; older servers may reject
the new optional suggestion fields, which surfaces the existing retry state.

## Verification

- Composer, Workbench Web and access-control TypeScript checks.
- `tests/chat/conversation-suggestions.test.ts` checks the actual execution-port
  RPC parameters, response cap, one-namespace routing and no history projection.
- `tests/chat/conversation-collaboration.test.ts` covers bounded command validation
  and existing caller authorization/revocation and delivery behavior.
- `scripts/smoke/composer/smoke-conversation-suggestions.ts` uses the real Composer
  and reference surface with synthetic transport, four light/dark pointer/touch
  Chromium cases. Checks recent entries, stalled files, insertion and focus,
  debounce, IME and late results. It does not prove authenticated production or
  physical iPhone behavior. Screenshots were visually reviewed at narrow width.
- `scripts/performance/benchmark-conversation-suggestions.py` uses a new isolated
  native state database with 1,000/10,000 synthetic rows, 20% archived, and no model
  Turn. Each query runs 25 times. With codex-cli 0.162.1 on the development host,
  10,000-row native RPC P95 was 4.54ms recent, 3.06ms title match and 9.57ms no-match.
  The benchmark asserts result count, archive exclusion and recent ordering.
  These timings exclude gateway, network, debounce and rendering.

The search module loads only on the first `@` lookup, keeping its implementation
out of the mandatory startup graph. Full i18n and boundary checks have unrelated
baseline failures; the modified messages include all four locale catalogs.
Release build, deployment receipts and component source revisions are tracked by
the internal distribution release workflow. The initial development baseline
exceeded the startup budget; no budget or boundary gate is relaxed by this patch.
