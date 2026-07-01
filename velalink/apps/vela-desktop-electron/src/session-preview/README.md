# Session Preview Renderer

Shared renderer shell for small session thumbnail windows.

`work-monitor` and `session-drag-preview` may own different lifecycle and
pointer behavior, but their thumbnail visual must flow through
`SessionPreviewWindowContent`. Keep title overlay, scale, status treatment, and
preview frame styling here so the two windows cannot drift.
