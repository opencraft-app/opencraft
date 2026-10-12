import { FileText, MapPin } from "lucide-react";
import type { IMMessage } from "@vela/im-client";
import { useT } from "@/i18n/t";
import { describeMessage } from "./vela-im-model";

/** Renders any Tencent IM message type; unsupported ones stay visible as a labelled placeholder. */
export function VelaImMessageContent({ message }: { message: IMMessage }) {
  const t = useT();
  const view = describeMessage(message);
  switch (view.kind) {
    case "text":
      return <p className="whitespace-pre-wrap break-words">{view.text}</p>;
    case "image":
      return view.url ? (
        <a href={view.fullUrl || view.url} target="_blank" rel="noreferrer">
          <img src={view.url} alt={t("图片消息")} className="max-h-64 max-w-full rounded-lg object-contain" loading="lazy" />
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
        <a href={view.url || undefined} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-lg border border-black/[0.08] bg-white px-3 py-2 text-black/75 hover:border-black/15">
          <FileText className="size-5 shrink-0 text-black/45" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{view.name}</span>
            <span className="block text-xs text-black/45">{Math.max(1, Math.round(view.size / 1024))} KB</span>
          </span>
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
