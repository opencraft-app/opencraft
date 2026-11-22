/** Header owns leading navigation/main chrome and trailing window actions.
 * The aperture between them belongs to the panel toolbar, including while
 * panes animate. Paint is derived from live pane geometry, never tab contents. */
export function headerSurfaceGeometry(windowWidth: number, mainViewportEnd: number,
  leadingMinimum: number, trailingWidth: number): { leadingWidth: number; trailingWidth: number } {
  const width = Math.max(0, windowWidth);
  const trailing = Math.min(width, Math.max(0, trailingWidth));
  return {
    leadingWidth: Math.min(width - trailing, Math.max(0, leadingMinimum, mainViewportEnd)),
    trailingWidth: trailing,
  };
}
