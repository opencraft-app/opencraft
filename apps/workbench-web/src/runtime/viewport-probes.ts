/** Numeric CSS observations only; the viewport port owns the probe's lifetime. */
export function measureViewportProbes(): Record<string, number> {
  const reference = document.querySelector("[data-timeline-fixed-reference]");
  if (!reference) return {};
  let probe = reference.querySelector<HTMLElement>("[data-viewport-unit-probe]");
  if (!probe) {
    probe = document.createElement("div");
    probe.dataset.viewportUnitProbe = "";
    probe.style.cssText = "position:absolute;inset:0;pointer-events:none;visibility:hidden;";
    for (const unit of ["dvh", "svh", "lvh"]) {
      const child = document.createElement("div");
      child.style.cssText = `position:absolute;width:0;height:100${unit};padding-bottom:env(safe-area-inset-bottom, 0px);box-sizing:content-box;`;
      probe.append(child);
    }
    reference.append(probe);
  }
  const [dynamic, small, large] = Array.from(probe.children, (child) => getComputedStyle(child));
  return {
    cssDynamicHeight: Number.parseFloat(dynamic?.height ?? "") || 0,
    cssSmallHeight: Number.parseFloat(small?.height ?? "") || 0,
    cssLargeHeight: Number.parseFloat(large?.height ?? "") || 0,
    safeBottom: Number.parseFloat(dynamic?.paddingBottom ?? "") || 0,
    keyboardClearanceEnabled: Number(document.documentElement.dataset.keyboardClearance === "true"),
    editingViewportReduced: Number(document.documentElement.dataset.timelineEditingViewportReduced === "true"),
  };
}
