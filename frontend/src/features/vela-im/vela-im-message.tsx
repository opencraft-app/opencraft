import { Download, MapPin } from "lucide-react";
import type { IMMessage } from "@vela/im-client";
import { useT } from "@/i18n/t";
import { FileTypeIcon, formatBytes } from "./vela-im-files";
import { VelaImMarkdown } from "./vela-im-markdown";
import { describeMessage } from "./vela-im-model";

/** Markdown inside the user's own dark bubble. */
const ON_DARK = "[&_a]:text-white [&_code]:bg-white/15 [&_pre]:bg-white/10 [&_blockquote]:border-white/40 [&_blockquote]:text-white/80 [&_th]:bg-white/10 [&_th]:border-white/20 [&_td]:border-white/20 [&_hr]:border-white/20";

/** Renders any Tencent IM message type; unsupported ones stay visible as a labelled placeholder. */
export function VelaImMessageContent({ message, mine = false }: { message: IMMessage; mine?: boolean }) {
  const t = useT();
  const view = describeMessage(message);
  switch (view.kind) {
    case "text":
      return <VelaImMarkdown text={view.text} className={mine ? ON_DARK : undefined} />;
    case "image":
      return view.url ? (
        <a href={view.fullUrl || view.url} target="_blank" rel="noreferrer" className="block">
          <img src={view.url} alt={t("图片消息")} className="max-h-72 max-w-full rounded-xl border border-black/[0.06] object-contain" loading="lazy" />
        </a>
      ) : <p className="text-black/45">{t("[图片]")}</p>;
    case "audio":
      return (
        <div className="space-y-1">
          {view.url ? <audio controls src={view.url} className="max-w-full" /> : null}
          <p className="text-xs text-black/45">{t("语音 {{seconds}} 秒", { seconds: view.seconds })}</p>
        </div>
      );
    case "video":
      return view.url ? <video controls src={view.url} poster={view.poster || undefined} className="max-h-64 max-w-full rounded-lg" /> : <p className="text-black/45">{t("[视频]")}</p>;
    case "file":
      return (
        <a href={view.url || undefined} target="_blank" rel="noreferrer" download={view.name}
          className="group/file flex w-72 max-w-full items-center gap-3 rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-black/75 transition-colors hover:border-black/15">
          <FileTypeIcon name={view.name} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium" title={view.name}>{view.name}</span>
            <span className="block text-xs text-black/45">{formatBytes(view.size) || t("文件")}</span>
          </span>
          {view.url ? <Download className="size-4 shrink-0 text-black/35 group-hover/file:text-black/60" aria-hidden="true" /> : null}
        </a>
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
