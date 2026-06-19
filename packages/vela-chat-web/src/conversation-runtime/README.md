# conversation-runtime

App-side runtime for the main chat list.

This layer turns Web render-model blocks into a provider-agnostic stream item list,
then owns history/live segmentation, item-level virtualization, near-top loading,
bottom-follow behavior, and session route resume.

The scroll sublayer keeps bottom-anchor decisions testable before touching the
DOM: route/session readiness, measurable dimensions, and post-layout settle
retries are pure model inputs rather than ad hoc component effects.
Session scroll resume is also kept in this layer so the page shell does not
need to know about `sessionStorage` or DOM `scrollTop` details.

Host-specific list policy lives here. Web hosts use the Paseo-style partial
virtualized history path for both desktop and mobile Web. A future true native
mobile renderer can still choose an inverted list strategy without making the
Web renderer mount every history item.

Do not:
- Add OpenAPI wire types here.
- Parse provider raw events here.
- Render concrete message block internals here.

Depends on:
- `adapters`
- React in `scroll` and `strategy`

Used by:
- `components/conversation`
