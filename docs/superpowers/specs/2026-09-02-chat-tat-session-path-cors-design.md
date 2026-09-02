# Chat TAT Session Path CORS Design

## Goal

Allow the browser application at `https://chat.lightvela.com` to create a
short-lived Tencent TAT terminal session for an owned LightVela instance,
without granting that origin CORS access to other `service-gateway` routes.

## Policy

`service-gateway` keeps its existing global and route-level
`allowed_origins` behavior. A route may additionally define `cors_allow`
entries containing an HTTP method, an allowlisted route path pattern, and a
list of exact origins. These entries are additive and apply only when both the
method and path match.

For a browser preflight, the rule method is matched against
`Access-Control-Request-Method`. For the actual request, it is matched against
the request method. Existing authentication, path allowlists, real-name
checks, instance ownership checks, running-state checks, and subscription
checks remain unchanged.

The Shanghai production configuration grants only:

```text
Origin: https://chat.lightvela.com
        https://localhost.lightvela.com
Method: POST
Path:   /v1/instances/{instance_id}/tat/session
```

No wildcard origins or ports are introduced. `localhost.lightvela.com` is an
explicitly trusted HTTPS origin; this policy accepts the risk that software
able to control that local origin can request a general TAT session as the
signed-in user. The Tencent TAT WebSocket remains a direct
browser-to-Tencent connection after the authenticated bootstrap call;
`service-gateway` does not proxy WebSocket traffic.

## Validation

Tests cover additive global behavior, preflight method/path matching, actual
authenticated responses, rejection on sibling instance paths, and the exact
Shanghai deployment policy.
