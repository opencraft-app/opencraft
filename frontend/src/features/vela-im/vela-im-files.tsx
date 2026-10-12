import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface FileVisual {
  Icon: LucideIcon;
  /** Tile colour, matching how desktop file managers colour these types. */
  tone: string;
  label: string;
}

const KINDS: Array<{ ext: string[]; visual: FileVisual }> = [
  { ext: ["pdf"], visual: { Icon: FileText, tone: "bg-[#E5484D]", label: "PDF" } },
  { ext: ["doc", "docx", "rtf", "odt", "pages"], visual: { Icon: FileText, tone: "bg-[#2B6DE8]", label: "DOC" } },
  { ext: ["xls", "xlsx", "csv", "tsv", "ods", "numbers"], visual: { Icon: FileSpreadsheet, tone: "bg-[#1F9D55]", label: "XLS" } },
  { ext: ["ppt", "pptx", "key", "odp"], visual: { Icon: Presentation, tone: "bg-[#E8743B]", label: "PPT" } },
  { ext: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"], visual: { Icon: FileArchive, tone: "bg-[#B7791F]", label: "ZIP" } },
  { ext: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "avif"], visual: { Icon: FileImage, tone: "bg-[#8E4EC6]", label: "IMG" } },
  { ext: ["mp4", "mov", "avi", "mkv", "webm", "m4v"], visual: { Icon: FileVideo, tone: "bg-[#D6409F]", label: "VID" } },
  { ext: ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "silk"], visual: { Icon: FileAudio, tone: "bg-[#0E9888]", label: "AUD" } },
  {
    ext: ["js", "jsx", "ts", "tsx", "py", "go", "rs", "java", "c", "cpp", "h", "rb", "php", "sh", "json", "yaml", "yml", "toml", "xml", "html", "css", "sql", "ipynb"],
    visual: { Icon: FileCode, tone: "bg-[#475569]", label: "CODE" },
  },
  { ext: ["txt", "md", "markdown", "log"], visual: { Icon: FileText, tone: "bg-[#64748B]", label: "TXT" } },
];

export const fileVisual = (name: string): FileVisual => {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return KINDS.find((kind) => kind.ext.includes(ext))?.visual ?? { Icon: FileIcon, tone: "bg-[#94A3B8]", label: ext.slice(0, 4).toUpperCase() || "FILE" };
};

export const formatBytes = (bytes: number): string => {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export function FileTypeIcon({ name, className }: { name: string; className?: string }) {
  const { Icon, tone } = fileVisual(name);
  return (
    <span aria-hidden="true" className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-white", tone, className)}>
      <Icon className="size-[18px]" />
    </span>
  );
}
