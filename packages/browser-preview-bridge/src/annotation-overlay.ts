/** Self-contained: injected into opaque HTML previews via toString(). */
export function createAnnotationOverlay(win: Window & typeof globalThis) {
  const document = win.document;
  // Electron preloads run before the root element exists. Seal on first draw.
  let documentRoot = document.documentElement;
  type Box = {
    caption?: string;
    selectionRects?: readonly { x: number; y: number; width: number; height: number }[];
    markerId?: string;
    state?: "hover" | "current" | "selected" | "saved";
    kind?: "element" | "region" | "text";
    documentGeneration?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    fixed?: boolean;
    selector?: string;
    targetKey?: string;
    pending?: boolean;
    label?: string;
  };
  let host: HTMLDivElement | null = null,
    shadow: ShadowRoot | null = null;
  let entries: { box: Box; node: HTMLDivElement; target: Element | null; css: string; radius: string }[] = [];
  const generations = new Map<string, WeakRef<Element>>();
  const targets = new Map<string, WeakRef<Element> | null>();
  let frame = 0,
    suspended = false;
  const stop = () => {
    win.cancelAnimationFrame(frame);
    frame = 0;
  };
  const mount = () => {
    if (host?.isConnected) return;
    if (!host) {
      host = win.document.createElement("div");
      // Never adopt/remove a page node with a colliding ID.
      host.id = "opencraft-annotation-host";
      host.setAttribute("aria-hidden", "true");
      host.style.cssText =
        "position:fixed;left:0;top:0;width:0;height:0;overflow:visible;margin:0;padding:0;border:0;pointer-events:none;z-index:2147483647;";
      shadow = host.attachShadow({ mode: "closed" });
    }
    win.document.documentElement?.appendChild(host);
  };
  const tick = () => {
    frame = 0;
    if (
      suspended ||
      !entries.length ||
      win.document.hidden ||
      win.document !== document ||
      document.documentElement !== documentRoot
    )
      return;
    mount();
    // One bounded read pass, then writes; no observer or work while empty/hidden.
    const geometry = new Map<Element, { style: CSSStyleDeclaration; rect: DOMRect }>();
    const read = (element: Element) => {
      let value = geometry.get(element);
      if (!value) {
        const local = element.getBoundingClientRect();
        let x = local.x,
          y = local.y,
          doc = element.ownerDocument;
        for (let depth = 0; doc !== document; depth++) {
          const iframe = doc.defaultView?.frameElement as HTMLIFrameElement | null;
          if (depth > 12 || !iframe?.isConnected || iframe.contentDocument !== doc) throw new Error("Frame changed");
          for (
            let ancestor: Element | null = iframe;
            ancestor;
            ancestor = ancestor.parentElement ?? (ancestor.getRootNode() as ShadowRoot).host ?? null
          ) {
            const css = ancestor.ownerDocument.defaultView!.getComputedStyle(ancestor);
            if (css.transform !== "none" || (css.zoom && css.zoom !== "1" && css.zoom !== "normal"))
              throw new Error("Unsupported frame geometry");
          }
          const box = iframe.getBoundingClientRect();
          x += box.x + iframe.clientLeft;
          y += box.y + iframe.clientTop;
          doc = iframe.ownerDocument;
        }
        value = {
          style: element.ownerDocument.defaultView!.getComputedStyle(element),
          rect: new win.DOMRect(x, y, local.width, local.height),
        };
        geometry.set(element, value);
      }
      return value;
    };
    const parent = (el: Element): Element | null =>
      el.parentElement ??
      (el.getRootNode() as ShadowRoot).host ??
      (el.ownerDocument !== document ? (el.ownerDocument.defaultView?.frameElement ?? null) : null);
    const positions = entries.map(({ box, target }) => {
      try {
        if (box.documentGeneration) {
          const root = generations.get(box.documentGeneration)?.deref();
          if (!root?.isConnected || root.ownerDocument.documentElement !== root) return null;
        }
        if (box.targetKey) {
          if (!target?.isConnected) {
            targets.set(box.targetKey, null);
            return null;
          }
          const { style, rect: r } = read(target);
          if (style.visibility === "hidden" || style.display === "none") return null;
          let left = Math.max(0, r.left),
            top = Math.max(0, r.top),
            right = Math.min(win.innerWidth, r.right),
            bottom = Math.min(win.innerHeight, r.bottom);
          for (let p = parent(target); p; p = parent(p)) {
            const { style: css, rect: bounds } = read(p);
            if (p.tagName === "IFRAME" || /(auto|scroll|hidden|clip)/.test(css.overflowX)) {
              left = Math.max(left, bounds.left + p.clientLeft);
              right = Math.min(right, bounds.left + p.clientLeft + p.clientWidth);
            }
            if (p.tagName === "IFRAME" || /(auto|scroll|hidden|clip)/.test(css.overflowY)) {
              top = Math.max(top, bounds.top + p.clientTop);
              bottom = Math.min(bottom, bounds.top + p.clientTop + p.clientHeight);
            }
          }
          return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
        }
        return {
          left: box.x - (box.fixed ? 0 : win.scrollX),
          top: box.y - (box.fixed ? 0 : win.scrollY),
          width: box.width,
          height: box.height,
        };
      } catch {
        return null;
      }
    });
    entries.forEach((entry, i) => {
      const r = positions[i];
      const radius = entry.target ? (geometry.get(entry.target)?.style.borderRadius ?? "4px") : "2px";
      if (entry.radius !== radius) {
        entry.node.style.setProperty("--target-radius", radius);
        entry.radius = radius;
      }
      const css = r
        ? `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`
        : "display:none";
      if (entry.css !== css) {
        entry.node.style.cssText = css + `;--target-radius:${radius}`;
        entry.css = css;
      }
    });
    if (entries.some(({ box, target }) => !box.targetKey || target?.isConnected))
      frame = win.requestAnimationFrame(tick);
  };
  const visibility = () => {
    stop();
    if (!win.document.hidden && entries.length) tick();
  };
  const clear = (remove = true) => {
    stop();
    entries = [];
    if (remove) host?.remove();
    shadow?.replaceChildren();
    win.document.removeEventListener("visibilitychange", visibility);
  };
  return {
    hit(point: { x: number; y: number; frameWidth: number; frameHeight: number }): string[] {
      if (
        suspended ||
        document.hidden ||
        document.documentElement !== documentRoot ||
        !host?.isConnected ||
        !point ||
        ![point.x, point.y, point.frameWidth, point.frameHeight].every(Number.isFinite) ||
        point.frameWidth <= 0 ||
        point.frameHeight <= 0
      )
        return [];
      // Read exactly the same geometry used to paint; scroll/layout can change between frames.
      stop();
      tick();
      const x = (point.x / point.frameWidth) * win.innerWidth,
        y = (point.y / point.frameHeight) * win.innerHeight;
      return entries
        .filter(({ box, node }) => {
          if (!box.markerId || node.style.display === "none") return false;
          const label = node.querySelector(".label");
          if (!label) return false;
          const r = label.getBoundingClientRect();
          return (
            r.width > 0 &&
            x >= Math.max(0, r.left - 5) &&
            x <= Math.min(win.innerWidth, r.right + 5) &&
            y >= Math.max(0, r.top - 5) &&
            y <= Math.min(win.innerHeight, r.bottom + 5)
          );
        })
        .map(({ box }) => box.markerId!)
        .slice(0, 32);
    },
    bindGeneration(key: string, doc: Document) {
      if (typeof key !== "string" || key.length > 120 || generations.has(key) || !doc.documentElement) return;
      generations.set(key, new WeakRef(doc.documentElement));
      while (generations.size > 64) generations.delete(generations.keys().next().value!);
    },
    suspend(value: boolean) {
      suspended = value;
      stop();
      if (!value) tick();
    },
    bind(key: string, element: Element | null) {
      if (targets.has(key)) return;
      targets.set(key, element ? new WeakRef(element) : null);
      while (targets.size > 64) {
        const unused = [...targets.keys()].find((value) => !entries.some((entry) => entry.box.targetKey === value));
        if (!unused) break;
        targets.delete(unused);
      }
    },
    draw(raw: unknown, color?: unknown) {
      documentRoot ??= document.documentElement;
      clear(false);
      const boxes = Array.isArray(raw) ? (raw.slice(0, 64) as Box[]) : [];
      if (!boxes.length) {
        clear();
        return;
      }
      mount();
      const c = typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color : "#339cff";
      const style = win.document.createElement("style");
      style.textContent = `.box{box-sizing:border-box;border:2px solid ${c};border-radius:var(--target-radius,4px);background:color-mix(in srgb,${c} 3%,transparent);pointer-events:none}.pending{border-style:dashed}.hint{position:absolute;left:0;bottom:100%;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 6px;border-radius:4px;background:${c};color:#fff;font:12px/18px system-ui,sans-serif}.fragment{position:absolute;background:color-mix(in srgb,${c} 16%,transparent);border-radius:2px}.box[data-kind="text"][data-fragments="true"]{background:transparent}.box[data-state="current"]{background:color-mix(in srgb,${c} 7%,transparent);box-shadow:0 0 0 1px #ffffff80}.box[data-state="saved"]{border-width:1px;background:transparent}.box[data-kind="region"]{border-style:dashed;border-radius:2px}.box[data-kind="text"]{border-width:0;border-radius:2px;background:color-mix(in srgb,${c} 16%,transparent)}.box[data-state="current"] .label{box-shadow:0 0 0 2px ${c}40}.box[data-state="saved"] .label{background:#fff;color:${c};border-color:${c}}.label{position:absolute;top:0;right:0;transform:translate(25%,-25%);min-width:22px;height:22px;padding:0 5px;box-sizing:border-box;border-radius:11px 11px 11px 3px;background:${c};color:#fff;border:2px solid #fff;font:700 11px/18px system-ui,sans-serif;text-align:center}`;
      shadow?.append(style);
      for (const box of boxes) {
        if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0)
          continue;
        let target: Element | null = null;
        if (typeof box.targetKey === "string") {
          target = targets.get(box.targetKey)?.deref() ?? null;
        }
        const node = win.document.createElement("div");
        node.className = box.pending ? "box pending" : "box";
        node.dataset.state = box.state ?? (box.pending ? "hover" : "selected");
        node.dataset.kind = box.kind ?? "element";
        if (box.kind === "text" && Array.isArray(box.selectionRects) && box.selectionRects.length) {
          node.dataset.fragments = "true";
          for (const rect of box.selectionRects.slice(0, 64)) {
            if (
              !rect ||
              ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
              rect.width <= 0 ||
              rect.height <= 0
            )
              continue;
            const line = document.createElement("span");
            line.className = "fragment";
            line.style.cssText = `left:${rect.x - box.x}px;top:${rect.y - box.y}px;width:${rect.width}px;height:${rect.height}px`;
            node.append(line);
          }
        }
        if (box.state === "hover" && typeof box.caption === "string") {
          const hint = document.createElement("span");
          hint.className = "hint";
          hint.textContent = box.caption.slice(0, 120);
          node.append(hint);
        }
        if (typeof box.label === "string" && box.label) {
          const label = win.document.createElement("span");
          label.className = "label";
          label.textContent = box.label.slice(0, 4);
          node.append(label);
        }
        shadow?.append(node);
        entries.push({ box, node, target, css: "", radius: "" });
      }

      if (entries.length) {
        win.document.addEventListener("visibilitychange", visibility);
        tick();
      } else clear();
    },
    dispose() {
      clear();
      targets.clear();
      generations.clear();
      host = null;
      shadow = null;
    },
  };
}
