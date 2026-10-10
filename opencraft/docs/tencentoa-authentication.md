# Tencent OA employee identity

The optional `tencentoa.identity` plugin recognizes the employee authenticated by
the site's TAI/TOF gateway. It registers an independent authentication provider
and an “员工身份” settings page. It does not replace the LightVela account owner.

## Enablement

Start the headless server with `--tencentoa-token-file /absolute/private/token`.
The file must be a regular, non-symlink file owned by the server user, inaccessible
to group/others (mode 0600). Its content is the application's raw 32-byte token;
one trailing newline is accepted. No token is included in source or sent to the
browser. Without configuration the endpoint returns 404 and the plugin contributes
no settings page/provider. Invalid configuration stops startup.

The deployment gateway must forward signed headers and `X-TAI-IDENTITY` on the
same-origin session request. Do not expose decrypted payloads, complete headers,
tokens or ciphertext in diagnostics. The preview is not automatically enabled by
this source change.

## Ownership and invariants

- The installation owns only the private application key. Every request is
  independently verified; there is no server-global “current employee”.
- The plugin verifies uppercase SHA256 gateway signatures and a 180-second
  timestamp window, then authenticates/decrypts compact JWE (`dir` / `A256GCM`).
  The signature and GCM authentication are separate checks; neither substitutes
  for the other.
- Identity expiration is RFC3339 with the documented three-minute clock tolerance.
  Duplicate security headers, conflicting identity aliases, invalid types/dates,
  and contradictions with legacy staff headers are rejected.
- The response projects only English login name, staff ID and expiration. Actual
  gateway field casing is normalized at this boundary. `open_id` is not exposed;
  a Chinese display name is not invented when unavailable.
- Browser identity is memory-only, per client. Request generations fence late
  responses; disposal and 401 revoke identity. Network failure cannot extend an
  identity beyond its authenticated expiration plus clock tolerance.
- Recognition is not resource authorization. This plugin does not grant or isolate
  shared SSH connections, desktop access, conversations or model credentials.
  Gateway/network admission and resource permissions remain separate responsibilities.
- No undocumented nonce-replay rejection or external TOF logout flow is invented.

Protocol basis: user-provided TAI mobile signing and TOF JWE documentation, with
read-only real gateway validation. Unit tests use synthetic credentials exclusively.
