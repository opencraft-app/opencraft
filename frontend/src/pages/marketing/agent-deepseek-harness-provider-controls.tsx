import { Check, ChevronDown, Eye, EyeOff, Loader2 } from "lucide-react";
import { useState } from "react";

import { useT } from "@/i18n/t";
import type {
  DeepSeekHarnessProvider,
  DeepSeekHarnessProviderID,
} from "@/lib/deepseek-harness-command";

interface ProviderSelectProps {
  providers: DeepSeekHarnessProvider[];
  selectedId: DeepSeekHarnessProviderID;
  disabled?: boolean;
  onSelect: (provider: DeepSeekHarnessProvider) => void;
}

export const DeepSeekHarnessProviderSelect = ({
  providers,
  selectedId,
  disabled = false,
  onSelect,
}: ProviderSelectProps) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];

  return (
    <div className="relative min-w-0">
      <label id="deepseek-harness-provider-label" className="mb-2 block text-sm font-semibold text-black/65">
        {t("模型供应商")}
      </label>
      <button
        type="button"
        aria-labelledby="deepseek-harness-provider-label deepseek-harness-provider-value"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className="flex h-11 w-full items-center justify-between gap-3 rounded-md border border-black/[0.14] bg-white px-3 text-left text-sm text-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20 disabled:cursor-not-allowed disabled:bg-black/[0.025] disabled:text-black/40"
      >
        <span id="deepseek-harness-provider-value" className="min-w-0 truncate">
          {selected?.displayName ?? t("暂无可用模型供应商")}
        </span>
        <ChevronDown className={`size-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && !disabled && providers.length > 0 ? (
        <div
          role="listbox"
          aria-labelledby="deepseek-harness-provider-label"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-black/[0.1] bg-white p-1 shadow-lg"
        >
          {providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              role="option"
              aria-selected={provider.id === selected?.id}
              onClick={() => {
                onSelect(provider);
                setOpen(false);
              }}
              className="flex min-h-10 w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm text-black/80 hover:bg-black/[0.04] focus-visible:outline-none focus-visible:bg-black/[0.06]"
            >
              <span className="min-w-0 truncate">{provider.displayName}</span>
              {provider.id === selected?.id ? <Check className="size-4 shrink-0 text-black" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};

interface ProviderCredentialFormProps {
  provider: DeepSeekHarnessProvider;
  mode: "add" | "edit";
  busy: boolean;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
}

export const DeepSeekHarnessProviderCredentialForm = ({
  provider,
  mode,
  busy,
  onSubmit,
  onCancel,
}: ProviderCredentialFormProps) => {
  const t = useT();
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const inputId = `deepseek-harness-${mode}-${provider.id}-api-key`;

  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
      <div className="min-w-0">
        <label htmlFor={inputId} className="mb-2 block text-sm font-semibold text-black/65">
          {t("{{provider}} API 密钥", { provider: provider.displayName })}
        </label>
        <div className="relative">
          <input
            id={inputId}
            type={visible ? "text" : "password"}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={!provider.writable || busy}
            required={mode === "add"}
            autoComplete="new-password"
            placeholder={mode === "edit" ? t("留空则保留现有密钥") : t("输入 API 密钥")}
            className="h-11 w-full rounded-md border border-black/[0.14] bg-white px-3 pr-11 text-sm text-black/85 placeholder:text-black/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20 disabled:bg-black/[0.025]"
          />
          <button
            type="button"
            onClick={() => setVisible((shown) => !shown)}
            disabled={busy}
            aria-label={visible ? t("隐藏 API 密钥") : t("显示 API 密钥")}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-black/45 hover:text-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-black/20 disabled:opacity-40"
          >
            {visible ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
          </button>
        </div>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row md:justify-end">
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex h-11 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm font-semibold text-black/60 hover:bg-black/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20 disabled:opacity-40"
          >
            {t("取消")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onSubmit(value)}
          disabled={!provider.writable || busy}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-black px-5 text-sm font-semibold text-white hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/30 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-35"
        >
          {busy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          {busy ? t("保存中...") : mode === "edit" ? t("保存修改") : t("保存配置")}
        </button>
      </div>
    </div>
  );
};
