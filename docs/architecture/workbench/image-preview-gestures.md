# Preview input capabilities

Images and expanded Mermaid diagrams consume the shared ZoomableImage viewport.
Mermaid remains vector SVG and its download exports the original untransformed SVG.
The preview owns pan, scale (0.2–5), rotation and rotated-content bounds. Gallery
paging, double tap, pointer rotation snapping and modal close remain with their
existing owners. Closing, changing source or resizing resets transient transforms.

Wheel deltas pan in both axes. Ctrl/Meta-wheel pinch scales around the cursor.
Browsers exposing cumulative gesture scale/rotation use the gesture event adapter.
Electron forwards available BrowserWindow rotate-gesture degree deltas through a
read-only preload subscription; the hovered viewport consumes them and a zero
end marker preserves the angle. There is no operating-system exclusion.

Current Chromium Web does not expose trackpad rotation angle or GestureEvent;
pan/pinch and touchscreen PointerEvents continue to work there. Event-adapter
checks do not constitute macOS/Windows hardware acceptance. Desktop native bridge
changes require a new Electron client, not just a server-side Web deployment.

Validation: tests/chat/image-transform.test.ts,
scripts/smoke/resources/smoke-preview-trackpad.ts,
scripts/smoke/resources/smoke-mermaid-display.ts and the existing image preview
smokes (including touch rotation, paging and modal/focus behavior).

The document ClientRuntime prevents native whole-page pinch defaults (Chromium
Ctrl-wheel and WebKit gesture start/change) with non-passive capture listeners.
Propagation remains intact so preview viewports still pan/scale/rotate normally.
Ordinary wheel scrolling and keyboard shortcuts retain their existing owners.
Retiring the document releases all listeners. This also applies to embedded
browser hosts, without relying on a WeChat user-agent check or viewport metadata.
