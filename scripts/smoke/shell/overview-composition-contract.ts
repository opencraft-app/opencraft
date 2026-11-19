/** Runs inside the real Shell fixture, not a mock DOM. */
export async function verifyPreviewCompositionInBrowser() {
  const modulePath = "/apps/workbench-web/src/components/retained-preview-composition.ts";
  const { leasePreviewComposition, isPreviewCompositionMutation } = await import(/* @vite-ignore */ modulePath);
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
  };
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const node = document.createElement("div");
  node.style.setProperty("opacity", ".7", "important");
  node.style.width = "100px";
  const observer = new MutationObserver(() => {});
  observer.observe(node, { attributes: true, attributeOldValue: true });
  const lease = leasePreviewComposition(node);
  lease.set(0.123456789);
  check(
    observer.takeRecords().every(isPreviewCompositionMutation),
    "CSSOM rounding must not turn an opacity write into layout invalidation",
  );
  node.style.width = "101px";
  check(
    !observer.takeRecords().every(isPreviewCompositionMutation),
    "simultaneous geometry changes cannot be suppressed",
  );
  node.style.opacity = ".8";
  check(
    !observer.takeRecords().every(isPreviewCompositionMutation),
    "external opacity writers cannot reuse a stale composition",
  );
  lease.set(0.3);
  observer.takeRecords();
  node.classList.add("new-theme");
  check(!observer.takeRecords().every(isPreviewCompositionMutation), "class/theme changes must invalidate geometry");
  lease.release();
  check(
    node.style.opacity === "0.7" && node.style.getPropertyPriority("opacity") === "important",
    "release must restore the original value and priority",
  );
  check(!observer.takeRecords().every(isPreviewCompositionMutation), "lease release resumes normal measurement");
  observer.disconnect();

  await frame();
  await frame();
  const card = document.querySelector<HTMLElement>('.panel-overview-card[data-tab-kind="terminal"]')!;
  const w = window as any,
    composition = leasePreviewComposition(card);
  const previousWidth = card.style.width;
  const native = !!document.querySelector('[data-retained-preview-presentation="popover"]');
  const reads = () =>
    w.overviewPerformance.records
      .filter((record: any) => record.kind === "mutation:observePreviewComposition")
      .reduce((total: number, record: any) => total + record.reads, 0);
  w.captureSceneCadence = true;
  w.overviewPerformance.records = [];
  try {
    composition.set(0.123456789);
    await frame();
    await frame();
    const observed = w.overviewPerformance.records.filter(
      (record: any) => record.kind === "mutation:observePreviewComposition",
    );
    if (native) {
      check(observed.length > 0, "opacity test must actually deliver native placement observer callbacks");
      check(reads() === 0, "opacity-only observer callbacks must not measure geometry");
      const floated = [...document.querySelectorAll<HTMLElement>('[data-retained-preview-presentation="popover"]')];
      check(
        floated.some((view) => Math.abs(Number(view.style.opacity) - 0.123456789) < 0.000001),
        "native content must receive sibling opacity",
      );
      check(
        [...document.querySelectorAll<HTMLElement>(".retained-preview-decoration")].some(
          (view) => Math.abs(Number(view.style.opacity) - 0.123456789) < 0.000001,
        ),
        "native decoration must receive the same opacity",
      );
    }
    w.overviewPerformance.records = [];
    card.style.width = "80%";
    await frame();
    await frame();
    if (native) check(reads() > 0, "real width changes must still measure the native placement");
    return { native, opacityCallbacks: observed.length, geometryReads: reads() };
  } finally {
    w.captureSceneCadence = false;
    card.style.width = previousWidth;
    composition.release();
    await frame();
    await frame();
  }
}
