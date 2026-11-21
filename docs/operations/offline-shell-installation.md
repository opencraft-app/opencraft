# Offline shell installation

The build-scoped Service Worker stages an entire public shell before activation.
An installation record in that deployment's cache distinguishes incomplete,
complete/waiting, and active builds. Failed installation cannot claim clients;
there is no `skipWaiting`, so an existing document keeps its complete worker.

A subsequent installation can reuse successful content-hashed `assets/` responses
from its own staging cache or the same deployment's prior caches. Mutable shell
HTML is fetched again, and unsuccessful or HTML responses cannot stand in for an
immutable asset. Resource fetches send same-origin credentials only, so a
deployment that gates static files behind a session cookie can still install,
and reject redirects. Neither account/API responses nor credentials become
offline configuration.

Installation admits at most two resource transfers concurrently. Each attempt has
a 30-second budget covering fetch, response-body consumption and cache writing.
Transient failures retry at most twice with bounded pacing; terminal client
errors and quota exhaustion do not retry. Terminal failure stops new admission
and aborts sibling transfers. Cache writes are atomic but not cancellable: the
installer separately fences its result so a stalled or late write cannot mark a
failed build complete. Late immutable bytes may remain useful staging data.

Before installation, older inactive/partial caches are reduced to one additional
candidate, preserving active builds, unmarked legacy caches, other deployments
and non-shell caches. Successful activation carries forward sanitized public
configuration and removes obsolete caches in its own deployment only.

## Regression checks

`npm run test:web-updates` includes deterministic worker installation/fetch tests.
`npm run test:web-updates:e2e` includes real Chromium ServiceWorker and Cache API
checks on desktop and touch contexts. The latter use a synthetic artifact server,
not a production SPA, authenticated account, model endpoint or physical device.
They verify failed staging, immutable reuse on retry, cookie omission, retention
of the old controller until its document closes, and the new shell's first offline
navigation. No test forces a waiting update to replace a live document.
