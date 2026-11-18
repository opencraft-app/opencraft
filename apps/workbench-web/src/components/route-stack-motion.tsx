import { Component, createContext, useContext, useImperativeHandle, useRef, type RefObject, type ReactNode } from "react";
import { animate, useReducedMotion, type MotionValue } from "motion/react";
import { ViewPresentationReadinessContext, type ViewPresentationReadiness } from "@opencraft/extension-react";
import type { ApplicationNavigationSnapshot } from "../runtime/workbench-navigation";
import { projectRouteStack, type RouteFamilies } from "../runtime/route-presentation-key";
import { PANEL_CONTINUOUS_SPRING_TRANSITION } from "./use-panel-animation";
import "./route-stack-motion.scss";

/** Presentation input from the existing Shell gesture owner; never owns routes. */
export const RouteStackGestureContext = createContext<MotionValue<number> | null>(null);
export const RouteStackFocusContext = createContext<((target: HTMLElement) => void) | null>(null);
interface Preview { node: HTMLElement; restore(): void }
function capture(source: HTMLElement, overlay?: HTMLElement | null): Preview {
  const node = source.cloneNode(true) as HTMLElement;
  const originals = [source, ...source.querySelectorAll<HTMLElement>("*")];
  const copies = [node, ...node.querySelectorAll<HTMLElement>("*")];
  // Static presentation must not create a second document, media player or resource owner.
  for (const item of node.querySelectorAll("iframe,object,embed,script,audio,video")) {
    const placeholder = document.createElement("div"), original = originals[copies.indexOf(item as HTMLElement)];
    placeholder.style.width = `${original?.clientWidth ?? 0}px`; placeholder.style.height = `${original?.clientHeight ?? 0}px`;
    item.replaceWith(placeholder);
  }
  for (const hidden of node.querySelectorAll('[hidden],[style*="display: none"],[data-route-snapshot="exclude"]')) hidden.remove();
  const restore: (() => void)[] = [];
  for (let index = 0; index < originals.length; index++) {
    const original = originals[index]!, copy = copies[index]!;
    // Removed hidden Activities and resource placeholders must not survive in
    // restoration closures; otherwise each ancestor pins every earlier DOM tree.
    if (copy !== node && !node.contains(copy)) continue;
    copy.removeAttribute("id"); copy.removeAttribute("autofocus"); copy.removeAttribute("form"); copy.removeAttribute("name");
    if (original instanceof HTMLInputElement && copy instanceof HTMLInputElement) { copy.value = original.value; copy.checked = original.checked; }
    if (original instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement) copy.value = original.value;
    if (original instanceof HTMLCanvasElement && copy instanceof HTMLCanvasElement) {
      try { copy.getContext("2d")?.drawImage(original, 0, 0); } catch { /* A renderer can own a non-2D canvas. */ }
    }
    const top = original.scrollTop, left = original.scrollLeft;
    restore.push(() => { copy.scrollTop = top; copy.scrollLeft = left; });
  }
  node.style.removeProperty("transform"); node.style.removeProperty("z-index");
  let floating: Preview | undefined;
  if (overlay?.childElementCount) {
    floating = capture(overlay);
    const bounds = source.getBoundingClientRect(), box = overlay.getBoundingClientRect();
    Object.assign(floating.node.style, { position: "absolute", left: box.left - bounds.left + "px", top: box.top - bounds.top + "px", width: box.width + "px", height: box.height + "px" });
    node.append(floating.node);
  }
  node.inert = true; node.setAttribute("aria-hidden", "true");
  return { node, restore: () => { restore.forEach(run => run()); floating?.restore(); } };
}
/** Acquire direct manipulation only when the current page is ready. */
export interface RouteStackGesturePresentation { acquire(): number | null }
interface Props { owner?: string; current: string; path: readonly string[]; progress: MotionValue<number> | null; reduced: boolean; pageX: MotionValue<number>; overlay: HTMLElement | null; children: ReactNode }
/** Snapshot lifecycle runs before React hides/unmounts the outgoing Activity.
 * Only inert pixels survive departure; a hidden ancestor never resumes effects to preview.
 */
class StackSurface extends Component<Props> {
  private live = { current: null as HTMLDivElement | null };
  private preview = { current: null as HTMLDivElement | null };
  private cache = new Map<string, Preview>();
  private stop: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private gestureProgress = 0;
  private foreground = 0;
  private phase: "idle" | "enter" | "return" | "gesture" = "idle";
  private waiting: (() => void) | undefined;
  private leases = new Set<{ key: string }>();
  private readiness: ViewPresentationReadiness = { acquire: () => {
    const lease = { key: this.props.current }; this.leases.add(lease);
    return () => {
      this.leases.delete(lease);
      queueMicrotask(() => { if (!this.hasPending()) { const ready = this.waiting; this.waiting = undefined; ready?.(); } });
    };
  } };
  private hasPending() { return [...this.leases].some(lease => lease.key === this.props.current); }
  private generation = 0;
  private ignoreReset = false;
  private focusRequest: { target: HTMLElement; origin: Element | null } | null = null;
  private requestFocus = (target: HTMLElement) => {
    this.focusRequest = { target, origin: target.ownerDocument.activeElement };
    queueMicrotask(() => this.flushFocus());
  };
  private flushFocus() {
    const request = this.focusRequest;
    if (!request || this.live.current?.inert) return;
    this.focusRequest = null;
    const { target, origin } = request, active = target.ownerDocument.activeElement;
    // A modal focus trap may park focus on its container while live pixels are
    // inert. Accept that handoff, but not a user move to other persistent chrome.
    if (!target.isConnected || target.closest('[inert],[hidden]') ||
      (active !== target.ownerDocument.body && active !== origin && active !== target && active !== target.closest('[role="dialog"],[role="alertdialog"]'))) return;
    target.focus({ preventScroll: true });
  };
  getSnapshotBeforeUpdate(previous: Props) {
    if (previous.current === this.props.current) return null;
    const related = previous.path.some(key => this.props.path.includes(key));
    const source = related ? this.live.current : null;
    const page = source ? capture(source, previous.overlay) : null;
    if (page) this.cache.set(previous.current, page);
    const returning = previous.path.includes(this.props.current);
    const interrupted = source && this.preview.current?.childElementCount &&
      (this.phase === "return" || (!returning && this.phase !== "idle"));
    const snapshot = interrupted ? this.captureScene(previous.overlay) : page;
    // Retaining one collection owner does not imply an in-place presentation.
    // The host composition declares whether its *visible* aperture is paged;
    // hidden retained ancestors must not select the transition for this page.
    const paged = source && [...source.querySelectorAll<HTMLElement>('[data-route-stack-presentation="page"]')]
      .some(element => element.getClientRects().length > 0);
    return { snapshot, returning, progress: interrupted ? 0 : this.foreground, related,
      inPlace: previous.owner !== undefined && previous.owner === this.props.owner && !paged };
  }
  acquire() {
    // A loading destination or an ancestor still returning from its child is
    // not the foreground page yet. Keep that presentation under Stack control.
    if (this.waiting || this.hasPending() || this.phase === "return") return null;
    const position = Math.max(0, Math.min(1, this.foreground));
    ++this.generation; this.stop?.(); this.stop = undefined; this.ignoreReset = false;
    if (this.live.current) this.live.current.inert = false;
    return position;
  }
  componentDidMount() { this.bind(); }
  componentDidUpdate(previous: Props, _state: unknown, departure: { snapshot: Preview | null; returning: boolean; progress: number; related: boolean; inPlace: boolean } | null) {
    if (previous.progress !== this.props.progress) { this.bind(); if (!departure && this.gestureProgress > 0) this.reset(); }
    if (this.props.reduced && !previous.reduced) this.reset();
    if (!departure) return;
    this.reset();
    this.ignoreReset = true;
    const allowed = new Set(this.props.path);
    for (const key of this.cache.keys()) if (!allowed.has(key)) this.cache.delete(key);
    // Shared collection owners keep selection updates in place, but must not
    // discard an already visible back-drag. Settle its inert outgoing pixels
    // without creating another live collection or conversation owner.
    const draggedReturn = departure.returning && departure.progress > 0;
    if ((departure.inPlace && !draggedReturn) || this.props.reduced || !departure.snapshot || !departure.related) return;
    this.show(departure.snapshot);
    const remaining = departure.returning ? Math.max(0, 1 - departure.progress) : 1;
    const start = () => {
      this.phase = departure.returning ? "return" : "enter";
      this.preview.current!.style.pointerEvents = departure.returning ? "auto" : "none";
      this.run(departure.returning ? 1 - remaining : 0, 1, value => {
        if (departure.returning) {
          this.place(this.preview.current, value, 1);
          this.place(this.live.current, (value - 1) * .25, 0);
        } else {
          this.place(this.preview.current, -value * .25, 0);
          this.place(this.live.current, 1 - value, 1);
        }
      }, departure.returning);
    };
    if (this.hasPending()) {
      this.place(this.preview.current, 0, 1); this.place(this.live.current, 1, 0);
      this.live.current!.inert = true; this.waiting = start;
    } else start();
  }
  componentWillUnmount() { this.unsubscribe?.(); this.reset(); this.cache.clear(); this.leases.clear(); }
  private bind() {
    this.unsubscribe?.();
    this.unsubscribe = this.props.progress?.on("change", value => this.drag(value));
  }
  private show(snapshot: Preview) {
    const host = this.preview.current;
    if (!host) return;
    host.replaceChildren(snapshot.node); snapshot.restore();
  }
  private place(element: HTMLElement | null, x: number, z: number) {
    if (!element) return;
    if (element === this.live.current) { this.foreground = x; this.props.pageX.set(x * element.clientWidth); }
    element.style.transform = `translateX(${x * 100}%)`; element.style.zIndex = String(z);
  }
  private captureScene(overlay: HTMLElement | null): Preview {
    const frame = this.live.current!.parentElement!.getBoundingClientRect();
    const previous = this.preview.current!.firstElementChild as HTMLElement;
    const box = previous.getBoundingClientRect(), current = this.live.current!.getBoundingClientRect();
    const behind = capture(previous);
    behind.node.style.transform = `translateX(${box.left - frame.left}px)`;
    behind.node.style.zIndex = this.preview.current!.style.zIndex;
    // Repeated redirects before an entrance has painted must not accumulate
    // invisible page layers or wrapper chains in the departure scene.
    if (current.left >= frame.right || current.right <= frame.left) return behind;
    const ahead = capture(this.live.current!, overlay);
    ahead.node.style.transform = `translateX(${current.left - frame.left}px)`;
    ahead.node.style.zIndex = this.live.current!.style.zIndex;
    const node = document.createElement("div");
    Object.assign(node.style, { position: "absolute", inset: "0", overflow: "clip" });
    node.append(behind.node, ahead.node); node.inert = true; node.setAttribute("aria-hidden", "true");
    return { node, restore: () => { behind.restore(); ahead.restore(); } };
  }
  private reset() {
    this.phase = "idle";
    ++this.generation; this.stop?.(); this.stop = undefined;
    this.props.pageX.set(0); this.foreground = 0; this.waiting = undefined;
    if (this.preview.current) { this.preview.current.replaceChildren(); this.preview.current.removeAttribute("style"); }
    if (this.live.current) { this.live.current.removeAttribute("style"); this.live.current.inert = false; }
    queueMicrotask(() => this.flushFocus());
  }
  private run(from: number, to: number, update: (value: number) => void, interactive = false) {
    const generation = this.generation;
    this.live.current!.inert = !interactive;
    update(from);
    // Do not spend the spring's clock mounting the destination. Establish its
    // first pose now, then start the shared spring on the next presentation frame.
    const frame = requestAnimationFrame(() => {
      if (generation !== this.generation) return;
      const playback = animate(from, to, { ...PANEL_CONTINUOUS_SPRING_TRANSITION,
        onUpdate: update, onComplete: () => { if (generation === this.generation) this.reset(); } });
      this.stop = () => playback.stop();
    });
    this.stop = () => cancelAnimationFrame(frame);
  }
  private drag(value: number) {
    this.gestureProgress = value;
    if (value <= 0) { if (this.ignoreReset) { this.ignoreReset = false; return; } this.reset(); return; }
    this.ignoreReset = false;
    if (this.props.reduced) return;
    const parent = this.props.path.at(-2), preview = parent ? this.cache.get(parent) : undefined;
    if (this.preview.current?.firstChild !== preview?.node) { this.reset(); if (preview) this.show(preview); }
    else { ++this.generation; this.stop?.(); this.stop = undefined; }
    this.phase = "gesture";
    // A direct-link parent has no mounted view; reveal the shared surface until it is ready.
    this.place(this.live.current, value, 1); this.place(this.preview.current, (value - 1) * .25, 0);
  }
  render() { return <div className="page-stack" data-page-stack>
    <div className="page-stack__preview" ref={this.preview} data-sidebar-gesture="ignore" aria-hidden="true" />
    <div className="page-stack__live" ref={this.live}><ViewPresentationReadinessContext.Provider value={this.readiness}><RouteStackFocusContext.Provider value={this.requestFocus}>{this.props.children}</RouteStackFocusContext.Provider></ViewPresentationReadinessContext.Provider></div>
  </div>; }
}
export function RouteStackMotion({ owner, current, path, children, pageX, overlay, gesturePresentation }: Pick<Props, "owner" | "current" | "path" | "children" | "pageX" | "overlay"> & { gesturePresentation?: RefObject<RouteStackGesturePresentation | null> }) {
  const progress = useContext(RouteStackGestureContext), reduced = useReducedMotion() === true;
  const surface = useRef<StackSurface | null>(null);
  useImperativeHandle(gesturePresentation, () => ({ acquire: () => surface.current?.acquire() ?? null }), []);
  // Page chrome and floating input share this route frame. Persistent Shell
  // navigation is outside it and must not enter outgoing snapshots.
  return <StackSurface ref={surface} owner={owner} current={current} path={path} progress={progress} reduced={reduced} pageX={pageX} overlay={overlay}>{children}</StackSurface>;
}

export interface RouteStackPresentation { readonly current: string; readonly path: readonly string[]; readonly scope: string; readonly owner?: string }
export function routeStackPresentation(navigation: Pick<ApplicationNavigationSnapshot, "navigationPath" | "applicationRoute" | "routeScopeId">, scope: string, families?: RouteFamilies): RouteStackPresentation {
  return projectRouteStack(navigation, scope, families);
}
