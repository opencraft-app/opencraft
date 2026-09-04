import { AlertCircle, FileText, Loader2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/i18n/t";
import { cn } from "@/lib/utils";
import { DATONG_PAGE_IDS } from "@/observability/datong";
import { trackDatongClick } from "@/observability/datong-tracker";
import {
  getPersonaStructureWarnings,
  readPersonaMarkdownFile,
  validateCustomSoulMarkdown,
  type PersonaMarkdownErrorCode,
  type PersonaStructureWarning,
} from "@/pages/marketing/agent-persona-upload";
type UploadPayload = {
  markdown: string;
  displayName: string;
};
type PersonaUploadModalProps = {
  disabled: boolean;
  hasExistingSoul: boolean;
  onInject: (payload: UploadPayload) => Promise<void>;
};
type Translate = (text: string, options?: Record<string, unknown>) => string;
function errorMessage(t: Translate, code: PersonaMarkdownErrorCode): string {
  return {
    invalid_extension: t("仅支持 .md 文件"),
    too_large: t("文件不能超过 20 KB"),
    invalid_utf8: t("文件编码需为 UTF-8，请转换后重新上传。"),
    read_failed: t("无法读取文件，请重新选择"),
    empty: t("人设内容不能为空"),
    control_characters: t("文件包含不支持的控制字符"),
  }[code];
}
function warningMessage(t: Translate, warning: PersonaStructureWarning): string {
  return {
    missing_name: t("建议补充顶部 Name 字段，页面将用它展示人设名称"),
    missing_identity: t("建议补充角色定位（Identity）"),
    missing_tone: t("建议补充沟通风格（Communication Style）"),
    missing_principles: t("建议补充工作原则（Working Principles）"),
    missing_boundaries: t("建议补充行为边界（Behavioral Boundaries）"),
    content_too_short: t("内容较短，可能不足以形成稳定人设"),
  }[warning];
}
export function PersonaUploadModal({
  disabled,
  hasExistingSoul,
  onInject,
}: PersonaUploadModalProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const readRequestIdRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"upload" | "edit" | "confirm">("upload");
  const [fileName, setFileName] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [selectionError, setSelectionError] = useState<PersonaMarkdownErrorCode | null>(null);
  const [injectError, setInjectError] = useState(false);
  const [injecting, setInjecting] = useState(false);
  const [reading, setReading] = useState(false);
  const validation = useMemo(
    () => selectionError
      ? { valid: false as const, code: selectionError, byteLength: 0 }
      : validateCustomSoulMarkdown(markdown, fileName, t("自定义人设")),
    [fileName, markdown, selectionError, t],
  );
  const warnings = useMemo(
    () => validation.valid ? getPersonaStructureWarnings(markdown) : [],
    [markdown, validation.valid],
  );
  const reset = () => {
    setView("upload");
    setFileName("");
    setMarkdown("");
    setSelectionError(null);
    setInjectError(false);
    setInjecting(false);
    setReading(false);
    if (inputRef.current) inputRef.current.value = "";
  };
  const close = () => {
    if (injecting) return;
    readRequestIdRef.current += 1;
    setOpen(false);
    reset();
  };
  useEffect(() => () => {
    readRequestIdRef.current += 1;
  }, []);
  const handleFileChange = async (file: File | undefined) => {
    if (!file) return;
    const requestId = ++readRequestIdRef.current;
    setFileName(file.name);
    setMarkdown("");
    setSelectionError(null);
    setInjectError(false);
    setView("upload");
    setReading(true);
    setOpen(true);
    const result = await readPersonaMarkdownFile(file);
    if (readRequestIdRef.current !== requestId) return;
    setReading(false);
    if (result.valid) {
      setMarkdown(result.text);
      setSelectionError(null);
      setView("edit");
    } else {
      setMarkdown("");
      setSelectionError(result.code);
    }
    if (inputRef.current) inputRef.current.value = "";
  };
  const runInject = async () => {
    const current = validateCustomSoulMarkdown(markdown, fileName, t("自定义人设"));
    if (!current.valid) {
      setSelectionError(current.code);
      return;
    }
    setInjecting(true);
    setInjectError(false);
    try {
      await onInject({
        markdown: current.markdown,
        displayName: current.displayName,
      });
      setOpen(false);
      reset();
    } catch {
      setInjecting(false);
      setInjectError(true);
      setView("edit");
    }
  };
  const handlePrimaryAction = () => {
    if (!validation.valid || injecting) return;
    if (hasExistingSoul) {
      setView("confirm");
      return;
    }
    void runInject();
  };
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        disabled={disabled || reading || injecting}
        accept=".md,text/markdown"
        className="sr-only"
        aria-label={t("选择 Markdown 人设文件")}
        onChange={(event) => void handleFileChange(event.target.files?.[0])}
      />
      <button
        type="button"
        disabled={disabled || reading || injecting}
        onClick={() => {
          trackDatongClick("persona_upload_entry_btn", {
            pgid: DATONG_PAGE_IDS.AGENT_PERSONA,
          });
          setOpen(true);
        }}
        className="inline-flex items-center gap-2 rounded-full border border-black/5 bg-black/[0.04] px-5 py-2 text-sm font-medium text-black/85 transition-opacity hover:opacity-75 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Upload className="size-4" aria-hidden="true" />
        {t("上传人设文件")}
      </button>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) close();
        }}
      >
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto md:w-[42rem]"
          onEscapeKeyDown={(event) => {
            if (injecting) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (injecting) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-balance">
              {view === "confirm"
                ? t("覆盖当前人设？")
                : view === "edit"
                  ? t("编辑人设文件")
                  : t("上传人设文件")}
            </DialogTitle>
            {view === "confirm" ? (
              <DialogDescription className="text-pretty">
                {t("旧人设会自动备份，然后注入新人设。")}
              </DialogDescription>
            ) : (
              <DialogDescription className="sr-only">
                {view === "upload"
                  ? `${t("上传人设文件")}。${t("选择 Markdown 人设文件")}`
                  : `${t("编辑人设文件")}。${t("人设内容")}`}
              </DialogDescription>
            )}
          </DialogHeader>

          {reading ? (
            <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-[var(--text-secondary)]" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t("正在读取人设文件…")}
            </div>
          ) : view === "upload" ? (
            <div className="flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed border-black/10 bg-black/[0.02] px-6 py-10 text-center">
              <Upload className="size-8 text-[var(--text-tertiary)]" aria-hidden="true" />
              <p className="mt-3 text-sm font-medium text-[var(--text-primary)]">
                {t("选择 Markdown 人设文件，将其内容填入 SOUL.md")}
              </p>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">
                {t("仅支持 Markdown 文件，文件名不限，扩展名须为 .md，大小不超过 20 KB。")}
              </p>
              {selectionError && (
                <div role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span>{errorMessage(t, selectionError)}</span>
                </div>
              )}
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="mt-4 rounded-lg bg-black px-4 py-2 text-sm font-medium text-white"
              >
                {selectionError ? t("重新上传文件") : t("选择文件")}
              </button>
            </div>
          ) : view === "confirm" ? (
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={injecting}
                onClick={() => {
                  trackDatongClick("persona_upload_cover_cancel_btn", {
                    pgid: DATONG_PAGE_IDS.AGENT_PERSONA,
                  });
                  setView("edit");
                }}
                className="rounded-lg border border-[var(--border-subtle)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] disabled:opacity-50"
              >
                {t("返回编辑")}
              </button>
              <button
                type="button"
                disabled={injecting}
                onClick={() => {
                  trackDatongClick("persona_upload_cover_confirm_btn", {
                    pgid: DATONG_PAGE_IDS.AGENT_PERSONA,
                  });
                  void runInject();
                }}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {injecting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                {injecting ? t("注入中…") : t("覆盖并注入")}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {fileName && (
                <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                  <FileText className="size-4 shrink-0" aria-hidden="true" />
                  <span className="truncate">{fileName}</span>
                </div>
              )}
              {!selectionError || markdown ? (
                <div>
                  <label
                    htmlFor="persona-markdown-editor"
                    className="block text-sm font-medium text-[var(--text-primary)]"
                  >
                    {t("人设内容")}
                  </label>
                  <textarea
                    id="persona-markdown-editor"
                    value={markdown}
                    disabled={injecting}
                    onChange={(event) => {
                      setMarkdown(event.target.value);
                      setSelectionError(null);
                      setInjectError(false);
                    }}
                    spellCheck={false}
                    className={cn(
                      "mt-1.5 h-64 w-full resize-y rounded-md border border-black/10 bg-[var(--surface-base)] px-3 py-2 font-mono text-sm leading-6 text-[var(--text-primary)] focus:border-black/30 focus:outline-none",
                      !validation.valid && "border-red-400",
                    )}
                    aria-invalid={!validation.valid}
                    aria-describedby="persona-markdown-feedback"
                  />
                  <p className="tabular-nums text-right text-xs text-[var(--text-tertiary)]">
                    {t("{{bytes}} 字节 / 20 KB", { bytes: validation.byteLength })}
                  </p>
                </div>
              ) : null}
              <div id="persona-markdown-feedback" aria-live="polite">
                {!validation.valid && (
                  <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <span>{errorMessage(t, validation.code)}</span>
                  </div>
                )}
                {injectError && (
                  <div role="alert" className="mt-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <span>{t("注入失败，请检查网络后重试")}</span>
                  </div>
                )}
              </div>
              {warnings.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <p className="mb-1 text-sm font-medium text-amber-900">{t("人设内容建议")}</p>
                  <ul className="space-y-1 text-sm text-amber-900">
                    {warnings.map((warning) => (
                      <li key={warning}>• {warningMessage(t, warning)}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={injecting}
                  onClick={() => inputRef.current?.click()}
                  className="rounded-lg border border-[var(--border-subtle)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] disabled:opacity-50"
                >
                  {t("重新上传文件")}
                </button>
                <button
                  type="button"
                  disabled={!validation.valid || injecting}
                  onClick={() => {
                    trackDatongClick("persona_upload_inject_btn", {
                      pgid: DATONG_PAGE_IDS.AGENT_PERSONA,
                    });
                    handlePrimaryAction();
                  }}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-black px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {injecting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                  {injecting
                    ? t("注入中…")
                    : injectError
                      ? t("重试注入")
                      : t("注入人设")}
                </button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
