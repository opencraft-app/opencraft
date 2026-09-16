import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { agentButtonClassName, agentFieldClassName, AgentTooltip } from "@/components/agents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

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
  const labelId = useId();
  const valueId = useId();
  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];

  return (
    <div className="min-w-0">
      <label id={labelId} className="mb-2 block text-sm font-medium text-[var(--text-secondary)]">
        {t("模型供应商")}
      </label>
      <Select value={selected?.id ?? ""} disabled={disabled} onValueChange={(id) => {
        const provider = providers.find((item) => item.id === id);
        if (provider) onSelect(provider);
      }}>
        <SelectTrigger aria-labelledby={`${labelId} ${valueId}`} className={cn(agentFieldClassName, "w-full gap-3")}>
          <SelectValue asChild><span id={valueId} className="min-w-0 flex-1 truncate text-left">{selected?.displayName ?? t("暂无可用模型供应商")}</span></SelectValue>
        </SelectTrigger>
        <SelectContent aria-labelledby={labelId} position="popper" sideOffset={4} className="agents-ui max-h-[var(--radix-select-content-available-height)] w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)] rounded-md">
          {providers.map((provider) => (
            <SelectItem key={provider.id} value={provider.id} className="rounded-md py-2">{provider.displayName}</SelectItem>
          ))}
        </SelectContent>
      </Select>
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
    <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end" onKeyDown={(event) => {
      if (event.key === "Escape" && onCancel && !busy) { event.preventDefault(); onCancel(); }
    }}>
      <div className="min-w-0">
        <label htmlFor={inputId} className="mb-2 block text-sm font-semibold text-black/65">
          {t("{{provider}} API 密钥", { provider: provider.displayName })}
        </label>
        <div className="relative">
          <Input
            id={inputId}
            autoFocus={mode === "edit"}
            type={visible ? "text" : "password"}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={!provider.writable || busy}
            required={mode === "add"}
            autoComplete="new-password"
            placeholder={mode === "edit" ? t("留空则保留现有密钥") : t("输入 API 密钥")}
            className={cn(agentFieldClassName, "w-full pr-11")}
          />
          <AgentTooltip triggerMode="control" content={visible ? t("隐藏 API 密钥") : t("显示 API 密钥")}><Button variant="ghost"
            type="button"
            onClick={() => setVisible((shown) => !shown)}
            disabled={busy}
            aria-label={visible ? t("隐藏 API 密钥") : t("显示 API 密钥")}
            className={cn(agentButtonClassName, "absolute right-0 top-0 size-10 px-0 text-[var(--text-secondary)]")}
          >
            {visible ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
          </Button></AgentTooltip>
        </div>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row md:justify-end">
        {onCancel ? (
          <Button
            type="button"
            onClick={onCancel}
            disabled={busy}
            variant="outline"
            className={agentButtonClassName}
          >
            {t("取消")}
          </Button>
        ) : null}
        <Button
          type="button"
          onClick={() => onSubmit(value)}
          disabled={!provider.writable || busy}
          className={agentButtonClassName}
        >
          {busy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          {busy ? t("保存中...") : mode === "edit" ? t("保存修改") : t("保存配置")}
        </Button>
      </div>
    </div>
  );
};
