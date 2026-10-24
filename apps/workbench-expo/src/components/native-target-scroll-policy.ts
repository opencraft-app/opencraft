export function selectNativeTargetScrollBehavior({
  requestedBehavior,
  targetWasMountedAtStart,
  currentDistanceFromBottomPx,
  destinationDistanceFromBottomPx,
  viewportHeightPx,
}: {
  readonly requestedBehavior: "instant" | "smooth";
  readonly targetWasMountedAtStart: boolean;
  readonly currentDistanceFromBottomPx: number;
  readonly destinationDistanceFromBottomPx: number;
  readonly viewportHeightPx: number;
}): "instant" | "smooth" {
  return requestedBehavior === "smooth"
    && targetWasMountedAtStart
    && Number.isFinite(viewportHeightPx)
    && viewportHeightPx > 0
    && Number.isFinite(currentDistanceFromBottomPx)
    && Number.isFinite(destinationDistanceFromBottomPx)
    && Math.abs(currentDistanceFromBottomPx - destinationDistanceFromBottomPx) <= viewportHeightPx
    ? "smooth" : "instant";
}
