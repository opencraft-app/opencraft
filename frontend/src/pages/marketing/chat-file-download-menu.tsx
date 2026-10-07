import { useEffect, useRef, useState, type RefObject } from "react";
import { Download, Eye } from "lucide-react";

import { useRepositories } from "@/contexts/repository-context";
import { useT } from "@/i18n/t";
import { ChatFileDownloader, chatFileHitFromEvent, type ChatFileHit } from "./chat-file-download";

interface ChatFileDownloadMenuProps {
  readonly botId: string;
  readonly active: boolean;
  readonly mountRef: RefObject<HTMLDivElement | null>;
}

export function ChatFileDownloadMenu({ botId, active, mountRef }: ChatFileDownloadMenuProps) {
  const t = useT();
  const repositories = useRepositories();
  const downloaderRef = useRef<ChatFileDownloader | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number; openAnchor?: HTMLAnchorElement } | null>(null);
  const touchHitRef = useRef<{ path: string; x: number; y: number; time: number } | null>(null);
  const [hover, setHover] = useState<ChatFileHit | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const downloader = new ChatFileDownloader(botId, (id) => repositories.bots.getTerminalSession(id), (message) => {
      setStatus(message === "started" ? t("下载已开始。") : message === "done" ? t("下载完成。") : `${t("下载失败")}: ${message}`);
    }, t);
    downloaderRef.current = downloader;
    return () => {
      downloader.dispose();
      downloaderRef.current = null;
    };
  }, [botId, repositories.bots, t]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !active) return;
    const onContextMenu = (event: MouseEvent) => {
      const hit = chatFileHitFromEvent(event);
      if (!hit) return;
      event.preventDefault();
      event.stopPropagation();
      touchHitRef.current = null;
      setMenu({
        path: hit.path,
        x: Math.max(8, Math.min(event.clientX, window.innerWidth - 160)),
        y: Math.max(8, Math.min(event.clientY, window.innerHeight - 48)),
      });
      setHover(null);
      setStatus(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      const hit = chatFileHitFromEvent(event);
      touchHitRef.current = hit ? { path: hit.path, x: event.clientX, y: event.clientY, time: Date.now() } : null;
    };
    const onTouchClick = (event: MouseEvent) => {
      const pending = touchHitRef.current;
      touchHitRef.current = null;
      if (!pending || Date.now() - pending.time > 1_000) return;
      const hit = chatFileHitFromEvent(event);
      if (hit?.path !== pending.path) return;
      event.preventDefault();
      event.stopPropagation();
      const anchor = event.composedPath().find((node): node is HTMLAnchorElement =>
        node instanceof HTMLAnchorElement && ["file", "workspace-file"].includes(node.dataset.chatResourceKind ?? ""),
      );
      setMenu({
        path: hit.path,
        x: Math.max(8, Math.min(pending.x, window.innerWidth - 160)),
        y: Math.max(8, Math.min(pending.y, window.innerHeight - 88)),
        openAnchor: anchor,
      });
      setHover(null);
      setStatus(null);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        const pending = touchHitRef.current;
        if (pending && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 10) touchHitRef.current = null;
        return;
      }
      const hit = chatFileHitFromEvent(event);
      setHover((previous) => {
        if (!hit?.rects.length) return null;
        if (previous?.path === hit.path && previous.rects.length === hit.rects.length
          && hit.rects.every((rect, index) => {
            const old = previous.rects[index];
            return old !== undefined && rect.left === old.left && rect.right === old.right && rect.bottom === old.bottom;
          })) return previous;
        return hit;
      });
    };
    const clearHover = () => setHover(null);
    const onPointerCancel = () => { touchHitRef.current = null; clearHover(); };
    mount.addEventListener("contextmenu", onContextMenu);
    mount.addEventListener("pointerdown", onPointerDown);
    mount.addEventListener("pointermove", onPointerMove);
    mount.addEventListener("pointercancel", onPointerCancel);
    mount.addEventListener("click", onTouchClick, true);
    mount.addEventListener("pointerleave", clearHover);
    window.addEventListener("scroll", clearHover, true);
    return () => {
      mount.removeEventListener("contextmenu", onContextMenu);
      mount.removeEventListener("pointerdown", onPointerDown);
      mount.removeEventListener("pointermove", onPointerMove);
      mount.removeEventListener("pointercancel", onPointerCancel);
      mount.removeEventListener("click", onTouchClick, true);
      mount.removeEventListener("pointerleave", clearHover);
      window.removeEventListener("scroll", clearHover, true);
    };
  }, [active, mountRef]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menu]);

  useEffect(() => {
    if (!active) {
      setMenu(null);
      setHover(null);
      setStatus(null);
      touchHitRef.current = null;
    }
  }, [active]);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const download = () => {
    if (!menu) return;
    const path = menu.path;
    setMenu(null);
    setStatus(t("准备下载..."));
    void downloaderRef.current?.download(path).catch((error: unknown) => {
      setStatus(`${t("下载失败")}: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  return <>
    {hover && active && !menu ? hover.rects.map((rect, index) => (
      <span
        key={`${hover.path}-${index}`}
        data-testid="chat-file-hover-underline"
        aria-hidden="true"
        className="pointer-events-none fixed z-[99]"
        style={{ left: rect.left, top: rect.bottom - 2, width: rect.right - rect.left, borderBottom: "1px dashed #6b7280" }}
      />
    )) : null}
    {menu && active ? (
      <div
        ref={menuRef}
        role="menu"
        aria-label={menu.openAnchor ? `${t("查看")} / ${t("下载")}` : t("下载")}
        className="fixed z-[100] min-w-36 rounded-lg border border-black/10 bg-white p-1 shadow-lg"
        style={{ left: menu.x, top: menu.y }}
      >
        {menu.openAnchor ? <button
          type="button"
          role="menuitem"
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-black/80 hover:bg-black/5 focus:bg-black/5 focus:outline-none"
          onClick={() => {
            const anchor = menu.openAnchor;
            setMenu(null);
            anchor?.click();
          }}
        >
          <Eye className="size-4" aria-hidden="true" />{t("查看")}
        </button> : null}
        <button
          type="button"
          role="menuitem"
          autoFocus
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-black/80 hover:bg-black/5 focus:bg-black/5 focus:outline-none"
          onClick={download}
        >
          <Download className="size-4" aria-hidden="true" />{t("下载")}
        </button>
      </div>
    ) : null}
    {status && active ? <div role="status" className="fixed top-4 left-1/2 z-[100] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-md bg-black/85 px-3 py-2 text-center text-xs text-white">{status}</div> : null}
  </>;
}
