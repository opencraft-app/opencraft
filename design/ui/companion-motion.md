# Companion identity and budgeted motion

A Bot identity chooses stable artwork and palette (`companionIdentity`, version 1).
The shared scene exposes surface, figure, eyes and expression; the original flat
artwork API remains compatible. Activity is presentation input: `rest`, `working`
or `waiting`. It never changes identity, permissions or execution state.

Six geometry-specific presets share one pose sampler: bean sways, sprout rocks,
bun breathes, lamp nods, cloud floats and star tilts. The Web renderer projects
poses onto SVG groups without a React render, layout read, filter, canvas or
per-avatar timer. Shared numeric motion presets stay in design-system; Web owns
DOM projection. A future native renderer can consume the same scene and poses.

`FrameBudget` owns grants and rate accounting, independent of browser APIs.
`VisualFrameBudget` owns one RAF, IntersectionObserver and media/visibility
subscription per Document. Registrations request FPS and priority; they do not
own the clock. Current replies outrank waiting artwork. At most four visible
consumers receive grants, capped at 24 updates/s each for working and 12 for
waiting, within 96 updates in any rolling second. A frame yields after 2ms of
synchronous artwork work. It cannot preempt a single callback or guarantee a
whole-browser frame deadline; the renderer deliberately has tiny bounded work.
Delayed frames never trigger a catch-up burst. Lower-priority excess consumers
retain static artwork and become eligible when a grant is released.

Offscreen, hidden-document, pagehide and live reduced-motion preference changes
stop rendering and restore a complete static face. The final unregister cancels
RAF, disconnects observers and releases document listeners. Contexts without
IntersectionObserver use static artwork. A failed visual callback retires only
its owner. All history and directory avatars default to rest and never register.

IM's activity adapter projects authoritative observations into presentation
activity. Current header and reply status consume the same Bot identity; model
capacity/rate waits are visually calmer. Stale, missing or terminal observations
never invent activity. Accessible status text remains the state authority and is
independent of SVG playback. Motion cannot move the composer or alter drafts,
focus, selection or scroll ownership.

Validation: deterministic 60/120Hz quota, saturation, slow-frame, preemption,
disposal and fault tests; actual SVG gallery with 200 consumers, six presets,
visibility and reduced-motion changes, plus real Workbench DM transitions.
Browser fixtures use synthetic identity/Host observations, never paid inference.
