# IOA employee footer avatar

## goal
Use the user-provided TOF photo API for the bottom-left employee entrance;
implementation belongs to the IOA/Tencent OA plugin. No message avatars.

## authority
User supplied GET /ebus/rhrc/photo/<size>/<loginName>.png and specified
"左下角员工入口" and "要在ioa插件里面做哈". Prior preview delivery and Git
authorization persist. Hermes investigation is deferred per "先搞ioa 插件".

## context_receipt
Read root/local AGENTS, OpenCraft maintenance/verification, current plugin
controller/account/server contracts, real footer Avatar consumer and existing
Tencent OA unit/browser probes. Prior context route found no package match;
bounded plugin search identified avatarUrl:null and the adjacent footer smoke.

## design
Plugin-owned photo fetch and object URL; same-origin request is re-authenticated
and its target must match the current employee. Upstream uses only fixed API
route and server-controlled origin. Private no-store, 1MiB raster limit and
bounded timeout. Account/expiry/unload fence old loads and release resources.
Failure leaves generic avatar and existing employee name.

## acceptance
Identity-only existing tests exclude photo traffic at the external fetch boundary.
Verify no-auth/other-user rejection, fixed path and absence of forwarded secrets,
upstream failure independence, account switch/late load and revocation. Verify
real footer at 390/1280px in light/dark. Preserve latest preview Web and runtime.

## external limitation
The user-provided api-idc.sgw.woa.com resolves but HTTP access times out from the
current server (both ordinary and direct transport). Actual applied access point
was requested; implement the documented default and keep fallback behavior.
Do not claim real TOF image retrieval from synthetic avatar fixtures.

## verified_delivery
Feature commit 6fd7d4d45 pushed to the existing sender branch. The current preview
was switched by the independent guarded unit opencraft-ioa-avatar-cutover-20261012-r3.
CUTOVER_VERIFIED recorded after real signed identity/photo authorization, native
SSH banner, actual served asset checks and visible mobile footer image/fallback
probes. Only the TOF image boundary was mocked for UI verification; actual upstream
is unavailable and no real employee photo retrieval is claimed.

Web build 20261012-ioa-avatar-r2 preserves sender labels, permission translations
and composer height from the preceding preview. Runtime SHA256
ab2b1d11a603f7e3a511bb2af0d207e71b59a63e0c45e596edc89765f436f25b;
data directory unchanged. Receipt and rollback entries:
/data/tmp/opencraft-ioa-avatar-preview-20261012/delivery.json and previous-web-entry.
Initial stale-Web guard and mobile probe failures restored a healthy previous
preview; the mobile probe now opens the collapsed sidebar before checking it.

## remaining
Actual applied TOF access point or network reachability is required for real
employee pictures. The documented domain times out before an HTTP response.
MR !5252 remains subject to protected review; master merge is not claimed.
