# Chat TAT Session Path CORS Design

## Goal

Allow the browser applications at `https://chat.lightvela.com` and
`https://chat.lightvela.ai` to list the signed-in user's LightVela instances
and create a short-lived Tencent TAT terminal session for an owned instance,
without granting those origins CORS access to other `service-gateway` routes.

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
Method: GET
Path:   /v1/instances

Origin: https://chat.lightvela.com
        https://localhost.lightvela.com
Method: POST
Path:   /v1/instances/{instance_id}/tat/session
```

The Singapore production configuration grants the same two paths to the
corresponding international origins:

```text
Origin: https://chat.lightvela.ai
        https://localhost.lightvela.ai
Method: GET
Path:   /v1/instances

Origin: https://chat.lightvela.ai
        https://localhost.lightvela.ai
Method: POST
Path:   /v1/instances/{instance_id}/tat/session
```

No wildcard origins or ports are introduced. The `localhost.lightvela.com`
and `localhost.lightvela.ai` origins are explicitly trusted HTTPS origins;
this policy accepts the risk that software able to control either local
origin can enumerate the signed-in user's instances and request a general
TAT session. The Tencent TAT WebSocket remains a direct browser-to-Tencent
connection after the authenticated bootstrap call; `service-gateway` does
not proxy WebSocket traffic. The session API is not exposed to these origins,
so this policy does not grant access to the reusable session token returned
by `/auth/session`.

## Validation

Tests cover additive global behavior, preflight method/path matching, actual
authenticated responses, rejection on sibling instance paths, and the exact
Shanghai and Singapore deployment policies.
