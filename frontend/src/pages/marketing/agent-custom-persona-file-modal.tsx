import { AlertCircle, FileText, Loader2 } from "lucide-react";
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
import {
  hasTopLevelSoulName,
  validateCustomSoulMarkdown,
  type PersonaMarkdownErrorCode,
} from "@/pages/marketing/agent-persona-upload";

export type CustomPersonaSavePayload = {
  markdown: string;
  displayName: string;
};

type CustomPersonaFileModalProps = {
  open: boolean;
  initialMarkdown: string;
  onClose: () => void;
  onSave: (payload: CustomPersonaSavePayload) => Promise<boolean>;
};

type Translate = (text: string, options?: Record<string, unknown>) => string;

function validationMessage(t: Translate, code: PersonaMarkdownErrorCode): string {
  return {
    invalid_extension: t("仅支持 .md 文件"),
    too_large: t("文件不能超过 20 KB"),
    invalid_utf8: t("文件编码需为 UTF-8，请转换后重新上传。"),
    read_failed: t("无法读取文件，请重新选择"),
    empty: t("人设内容不能为空"),
    control_characters: t("文件包含不支持的控制字符"),
  }[code];
}

export function CustomPersonaFileModal({
  open,
  initialMarkdown,
  onClose,
  onSave,
}: CustomPersonaFileModalProps) {
  const t = useT();
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [showNameWarning, setShowNameWarning] = useState(false);
  const saveRequestIdRef = useRef(0);
  const validation = useMemo(
    () => validateCustomSoulMarkdown(markdown, "SOUL.md", t("自定义人设")),
    [markdown, t],
  );
  const unchanged = markdown === initialMarkdown;
  const hasName = useMemo(() => hasTopLevelSoulName(markdown), [markdown]);

  useEffect(() => {
    saveRequestIdRef.current += 1;
    if (!open) return;
    setMarkdown(initialMarkdown);
    setSaving(false);
    setSaveError(false);
    setShowNameWarning(false);
  }, [initialMarkdown, open]);

  useEffect(() => () => {
    saveRequestIdRef.current += 1;
  }, []);

  const close = () => {
    if (!saving) onClose();
  };

  const save = async () => {
    if (!validation.valid || unchanged || saving) return;
    if (!hasName) {
      setShowNameWarning(true);
      return;
    }
    const requestId = ++saveRequestIdRef.current;
    setSaving(true);
    setSaveError(false);
    try {
      const saved = await onSave({
        markdown: validation.markdown,
        displayName: validation.displayName,
      });
      if (saveRequestIdRef.current !== requestId) return;
      setSaving(false);
      if (saved) onClose();
    } catch {
      if (saveRequestIdRef.current !== requestId) return;
      setSaving(false);
      setSaveError(true);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto md:w-[42rem]"
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (saving) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-balance">{t("编辑人设文件")}</DialogTitle>
          <DialogDescription className="sr-only">
            {`${t("编辑人设文件")}。${t("人设内容")}`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <FileText className="size-4 shrink-0" aria-hidden="true" />
            <span>SOUL.md</span>
          </div>

          <div>
            <label
              htmlFor="custom-persona-markdown-editor"
              className="block text-sm font-medium text-[var(--text-primary)]"
            >
              {t("人设内容")}
            </label>
            <textarea
              id="custom-persona-markdown-editor"
              value={markdown}
              disabled={saving}
              onChange={(event) => {
                setMarkdown(event.target.value);
                setSaveError(false);
                setShowNameWarning(false);
              }}
              spellCheck={false}
              className={cn(
                "mt-1.5 h-64 w-full resize-y rounded-md border border-black/10 bg-[var(--surface-base)] px-3 py-2 font-mono text-sm leading-6 text-[var(--text-primary)] focus:border-black/30 focus:outline-none",
                !validation.valid && "border-red-400",
              )}
              aria-invalid={!validation.valid}
              aria-describedby="custom-persona-markdown-feedback"
            />
            <p className="tabular-nums text-right text-xs text-[var(--text-tertiary)]">
              {t("{{bytes}} 字节 / 20 KB", { bytes: validation.byteLength })}
            </p>
          </div>

          <div id="custom-persona-markdown-feedback" aria-live="polite">
            {!validation.valid && (
              <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{validationMessage(t, validation.code)}</span>
              </div>
            )}
            {showNameWarning && (
              <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{t("请补充顶部 Name 字段，页面将用它展示人设名称")}</span>
              </div>
            )}
            {saveError && (
              <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{t("保存失败，请检查网络后重试")}</span>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={close}
              className="rounded-lg border border-[var(--border-subtle)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] disabled:opacity-50"
            >
              {t("取消")}
            </button>
            <button
              type="button"
              disabled={!validation.valid || unchanged || saving}
              onClick={() => void save()}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-black px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {saving ? t("保存中…") : t("保存修改")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
