# Controlled preview backend

This package owns the opt-in page bridge: exact origin/source identity,
handshake, request correlation, cancellation and semantic page operations.
It does not implement an Electron browser or trusted native input.

Keep this route independent of browser-cdp. A failed CDP backend must not silently
fall back to page injection. Declare only capabilities established by handshake.

- [ ] Improve preview reference invalidation independently of the CDP migration;
  preserve navigation/generation checks and sensitive-control policy.
