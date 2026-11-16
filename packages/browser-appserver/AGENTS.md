# Browser AppServer adapter

This package converts platform browser tool definitions, trusted invocation
context and typed results to the AppServer wire protocol. Generated protocol
types belong here, not in browser-core or browser-cdp.

Browser behavior, argument validation, errors and result semantics belong to
browser-core. Preserve existing public exports while moving their implementation.
Compatibility aliases are wire-adapter concerns.

- [ ] Verify the neutral catalog/result through Pi and ACP tool adapters,
  including image results and cancellation, before claiming harness parity.
