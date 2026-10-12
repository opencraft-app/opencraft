import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Download, ExternalLink, MapPin, X } from "lucide-react";
import type { IMMessage } from "@vela/im-client";
import { useT } from "@/i18n/t";
import { FileTypeIcon, formatBytes } from "./vela-im-files";
import { VelaImMarkdown } from "./vela-im-markdown";
import { describeMessage } from "./vela-im-model";

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const VIDEO_FILE = /\.(mp4|webm|mov|m4v)$/i;
const AUDIO_FILE = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;

/** Full-size image over the page. Tencent serves media as downloads, so opening the URL directly would save it. */
function ImageLightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const tool = "inline-flex size-9 items-center justify-center rounded-full bg-white/10 text-white/85 transition-colors hover:bg-white/20 hover:text-white";
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={t("图片预览")} onClick={onClose}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm">
      <div className="absolute right-4 top-4 flex gap-2" onClick={(e) => e.stopPropagation()}>
        <a href={src} target="_blank" rel="noreferrer" className={tool} aria-label={t("在新窗口打开")}><ExternalLink className="size-4" /></a>
        <a href={src} download={name} className={tool} aria-label={t("下载")}><Download className="size-4" /></a>
        <button type="button" onClick={onClose} className={tool} aria-label={t("关闭")}><X className="size-4" /></button>
      </div>
      <img src={src} alt={name} onClick={(e) => e.stopPropagation()} className="max-h-[88vh] max-w-[92vw] rounded-lg object-contain shadow-2xl" />
    </div>,
    document.body,
  );
}

function ImagePreview({ src, fullSrc, name }: { src: string; fullSrc?: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="block max-w-full cursor-zoom-in" title={name}>
        <img src={src} alt={name} className="max-h-72 max-w-full rounded-xl border border-black/[0.06] object-contain" loading="lazy" />
      </button>
      {open ? <ImageLightbox src={fullSrc || src} name={name} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function DownloadLink({ url, name }: { url: string; name: string }) {
  const t = useT();
  return (
    <a href={url} download={name} target="_blank" rel="noreferrer" aria-label={t("下载 {{name}}", { name })}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-black/40 hover:bg-black/[0.05] hover:text-black/70">
      <Download className="size-4" />
    </a>
  );
}

/** Renders any Tencent IM message type; unsupported ones stay visible as a labelled placeholder. */
export function VelaImMessageContent({ message }: { message: IMMessage }) {
  const t = useT();
  const view = describeMessage(message);
  switch (view.kind) {
    case "text":
      return <VelaImMarkdown text={view.text} />;
    case "image":
      return view.url ? <ImagePreview src={view.url} fullSrc={view.fullUrl} name={t("图片消息")} /> : <p className="text-black/45">{t("[图片]")}</p>;
    case "audio":
      return (
        <div className="w-72 max-w-full space-y-1 rounded-xl border border-black/[0.08] bg-white p-2">
          {view.url ? <audio controls preload="metadata" src={view.url} className="h-9 w-full" /> : null}
          <p className="px-1 text-xs text-black/45">{t("语音 {{seconds}} 秒", { seconds: view.seconds })}</p>
        </div>
      );
    case "video":
      return view.url
        ? <video controls playsInline preload="metadata" src={view.url} poster={view.poster || undefined} className="max-h-72 max-w-full rounded-xl border border-black/[0.06] bg-black" />
        : <p className="text-black/45">{t("[视频]")}</p>;
    case "file":
      // Media that arrives as a plain file (other clients, Agents' tools) still previews and plays inline.
      if (view.url && IMAGE_FILE.test(view.name)) return <ImagePreview src={view.url} name={view.name} />;
      if (view.url && VIDEO_FILE.test(view.name)) {
        return <video controls playsInline preload="metadata" src={view.url} title={view.name} className="max-h-72 max-w-full rounded-xl border border-black/[0.06] bg-black" />;
      }
      return (
        <div className="w-72 max-w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-black/75">
          <div className="flex items-center gap-3">
            <FileTypeIcon name={view.name} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium" title={view.name}>{view.name}</span>
              <span className="block text-xs text-black/45">{formatBytes(view.size) || t("文件")}</span>
            </span>
            {view.url ? <DownloadLink url={view.url} name={view.name} /> : null}
          </div>
          {view.url && AUDIO_FILE.test(view.name) ? <audio controls preload="metadata" src={view.url} className="mt-2 h-9 w-full" /> : null}
        </div>
      );
    case "location":
      return (
        <p className="flex items-center gap-2">
          <MapPin className="size-4 shrink-0 text-black/45" />
          <span>{view.description || `${view.latitude}, ${view.longitude}`}</span>
        </p>
      );
    case "face":
      return <p className="text-2xl leading-none">{view.data}</p>;
    case "merger":
      return (
        <div className="space-y-1">
          <p className="font-medium">{view.title || t("聊天记录")}</p>
          {view.abstracts.map((line, index) => <p key={index} className="truncate text-xs text-black/50">{line}</p>)}
        </div>
      );
    case "custom":
      return <p className="break-words">{view.description || view.data || t("[自定义消息]")}</p>;
    case "tip":
      return <p className="text-xs text-black/45">{view.text || t("群成员有变动")}</p>;
    case "event":
      // Rendered by the conversation as a system line with member names.
      return null;
    case "revoked":
      return <p className="italic text-black/40">{t("消息已撤回")}</p>;
    default:
      return <p className="text-black/45">[{view.label}]</p>;
  }
}
