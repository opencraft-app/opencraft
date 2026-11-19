# Server-side notification default enrollment

The optional product default policy applies to every admitted, verified employee,
not a named test-account allowlist. After a human App Host/AppServer WebSocket is
admitted, the server starts bounded, coalesced initialization in the background.
It does not require a new browser bundle or opening notification settings. The
old explicit defaults POST remains supported and notification GET remains read-only.

The exact authenticated request, current Human generation, null Session credential,
matching browser Origin and current unique verified IM target are checked. Missing
receiver/identity readiness defers and retries after 30 seconds under the same
still-valid request; expiry/revocation stops eligibility. All caches/retries are
bounded and are released at service shutdown. No message is sent by enrollment.

Stored initialization decisions prevent recreating removed/disabled defaults.
Reconnecting may refresh authorization of the same enabled, verified destination;
it never changes the recipient, saved URL, locale, user master or channel opt-outs.
No offline account gets synthetic credentials or a guessed RTX/WeCom association.
Unbound users wait for authoritative identity linkage before becoming eligible.
External notification URL configuration remains a separate server-information concern.
