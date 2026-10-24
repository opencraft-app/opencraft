import { serverFetch } from "./server-context";

/** Geometry only. No content, route, account, input value or user agent. */
export function createViewportDiagnostics() {
  // A page may stay open through many keyboard cycles. Bound traffic without
  // making later interactions permanently invisible after the first 64 samples.
  let credits = 64;
  let creditedAt = performance.now();
  let lastMeasuredAt = -Infinity;
  let lastSignature = "";
  let touchGeometry: Record<string, number> = {};
  let touchSequence = 0;
  let observations = 0;
  let editorMinTop = Infinity, editorMaxTop = -Infinity;
  let shellMinTop = Infinity, shellMaxTop = -Infinity;
  const episode = `viewport-${Date.now().toString(36)}`;
  return (event?: Event) => {
    if (event?.type === "touchstart") {
      const touch = (event as TouchEvent).changedTouches?.[0];
      if (touch) touchGeometry = {
        touchSequence: ++touchSequence % 100_000,
        touchScreenClientY: touch.screenY - touch.clientY,
        touchPageClientY: touch.pageY - touch.clientY,
      };
    }
    if (document.visibilityState !== "visible") return;
    const now = performance.now();
    credits = Math.min(64, credits + Math.max(0, now - creditedAt) / 125);
    creditedAt = now;
    const shell = document.querySelector<HTMLElement>(".app-shell-root");
    const visual = window.visualViewport;
    if (!shell || !visual) return;
    const sourceRevision = document.querySelector<HTMLMetaElement>('meta[name="opencraft-source-revision"]')?.content;
    if (!sourceRevision || !/^[a-f0-9]{40}$/.test(sourceRevision)) return;
    const rect = shell.getBoundingClientRect();
    const active = document.activeElement;
    const editing = active instanceof HTMLElement && (active.isContentEditable || /^(INPUT|TEXTAREA)$/.test(active.tagName));
    const editorRect = editing ? active.getBoundingClientRect() : null;
    observations = Math.min(100_000, observations + 1);
    if (editorRect) {
      editorMinTop = Math.min(editorMinTop, editorRect.top);
      editorMaxTop = Math.max(editorMaxTop, editorRect.top);
    }
    shellMinTop = Math.min(shellMinTop, rect.top);
    shellMaxTop = Math.max(shellMaxTop, rect.top);
    // Only these two rectangles need frame-rate observation: their extrema
    // retain an excursion that recovers before the next bounded report. Detailed
    // geometry and hit testing describe the report frame, so read them only when
    // a transmission is eligible. This observer never schedules its own frame.
    if (now - lastMeasuredAt < 80 || credits < 1) return;
    lastMeasuredAt = now;
    const rootRect = document.documentElement.getBoundingClientRect();
    const bodyRect = document.body.getBoundingClientRect();
    const fixedRect = document.querySelector("[data-timeline-fixed-reference]")?.getBoundingClientRect();
    const style = window.getComputedStyle(shell);
    const composer = editing ? active.closest(".opencraft-composer-shell") : null;
    const sendElement = composer?.querySelector(".opencraft-composer-submit")
      ?? (editing ? null : document.querySelector(".opencraft-composer-submit"));
    const send = sendElement?.getBoundingClientRect();
    const composerRect = composer?.getBoundingClientRect();
    const draft = editing ? active.closest<HTMLElement>(".new-thread-draft-main") : null;
    const sendHit = send && send.width > 0 && send.height > 0
      ? sendElement?.contains(document.elementFromPoint(send.left + send.width / 2, send.top + send.height / 2))
      : false;
    const geometry = {
      layoutHeight: innerHeight, layoutWidth: innerWidth,
      visualHeight: visual.height, visualWidth: visual.width,
      visualTop: visual.offsetTop, visualLeft: visual.offsetLeft,
      pageTop: visual.pageTop, scrollY, scale: visual.scale,
      shellTop: rect.top, shellHeight: rect.height,
      // Independent observations: never derive a positioning correction here.
      cssTop: Number.parseFloat(style.top) || 0,
      cssHeight: Number.parseFloat(style.height) || 0,
      clientHeight: document.documentElement.clientHeight,
      rootTop: rootRect.top, rootHeight: rootRect.height,
      bodyTop: bodyRect.top, bodyHeight: bodyRect.height,
      fixedTop: fixedRect?.top ?? 0, fixedLeft: fixedRect?.left ?? 0,
      editorTop: editorRect?.top ?? 0,
      sendBottom: send?.bottom ?? 0, editing: Number(editing),
      editorBottom: editorRect?.bottom ?? 0,
      composerTop: composerRect?.top ?? 0, composerBottom: composerRect?.bottom ?? 0,
      draftScroll: draft?.scrollTop ?? 0, editorScroll: editing ? active.scrollTop : 0,
      sendTop: send?.top ?? 0, sendHit: Number(Boolean(sendHit)),
      editorMinTop: Number.isFinite(editorMinTop) ? editorMinTop : 0,
      editorMaxTop: Number.isFinite(editorMaxTop) ? editorMaxTop : 0,
      shellMinTop, shellMaxTop,
      ...touchGeometry,
    };
    const signature = JSON.stringify(geometry);
    if (signature === lastSignature) return;
    lastSignature = signature; credits--;
    void serverFetch("/__opencraft_apphost_diagnostic", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "viewport", episode, sourceRevision, ...geometry, observedSamples: observations }),
      keepalive: true, signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
    observations = 0;
    editorMinTop = Infinity; editorMaxTop = -Infinity;
    shellMinTop = Infinity; shellMaxTop = -Infinity;
  };
}
