# Website share request authentication repair

## goal
Preserve the signed-in owner Authorization header for enable, reset and stop sharing across both website list pages.

## non_goals
No new tests, access-policy changes, production deployments, or unrelated backend and Skill changes.

## requirement_refs
User: “开启分享仍然操作失败”, “固化进mr吧”. User explicitly requested no added tests.

## interface_refs
`frontend/src/pages/marketing/agent-website-share-dialog.tsx`: shared callAccess helper.
PUT `/v1/websites/{siteId}/access`; POST `/v1/websites/{siteId}/share-code/reset`.
`frontend/src/repositories/http-repositories.ts`: stored token reader and Headers construction neighbor.

## history_context
Current master constructs a Headers object but spreads it as an object, then request init overwrites headers. A fresh frontend deployment therefore lost bearer authentication again.

## acceptance
Request headers retain Content-Type and owner bearer token. Beijing test browser enable returns HTTP 200 / OK and persists share_code.

## affected_paths
`frontend/src/pages/marketing/agent-website-share-dialog.tsx`.

## required_context / context_receipt
Read root and frontend AGENTS.md, frontend-product-surface and tapd-gongfeng-delivery packs, Gongfeng Skill, frontend adjacency card, and the normal HTTP repository header construction. Change-impact map has no matching design-document rule for this component.

## evidence
Before repair: signed-in user6 list/capability GET200; share PUT401 without Authorization.
After test-only static hotfix: share PUT200 with Authorization, OK and code returned. GET confirms share_code. All six owners now pass websites API authentication after refreshing user1's invalid session.

## risks
MR must be merged before future frontend builds include this source repair. Existing test-domain hotfix may be overwritten by builds without this commit. Shanghai and Singapore production were not changed.

## validation
Frontend check/test/build results are recorded during MR preparation. No added tests. Live Beijing browser verification already passed.

## decisions
Use one Headers instance initialized from init.headers; append the stored bearer token and assign headers after spreading request init.

## scan_scope / scan_output
Only the shared share component, adjacent HTTP helper and focused source diff; no credential or runtime artifacts included.

## handoff
Submit this isolated branch to master for review; no automatic merge or production release.
