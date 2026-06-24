# velaChat Agent Notes

## Mono2 frontend integration

`mono2/frontend` does not import this checked-in `velalink/` directory directly.
It imports the published git dependency named `velachat` through
`frontend/node_modules/velachat`, pinned by `frontend/package.json` and
`frontend/pnpm-lock.yaml`.

Implications:

- Editing `mono2/velalink/` alone does not make `mono2/frontend` local preview
  pick up the change.
- A temporary local preview may require syncing the changed files into
  `frontend/node_modules/velachat`, but that is not a durable fix.
- The durable fix is to commit and push the velaChat change upstream, then update
  the `velachat` git commit pin in `mono2/frontend/package.json` and
  `mono2/frontend/pnpm-lock.yaml`.
- After updating the pin, reinstall frontend dependencies and rebuild the
  affected preview before claiming the fix is live.

For `TAT proxy websocket closed` or event-stream reconnect fixes, verify both:

- velaChat tests cover the stream/reconnect behavior.
- mono2 frontend preview is built from a dependency pin that contains the fix,
  not only from the checked-in `velalink/` subtree.
