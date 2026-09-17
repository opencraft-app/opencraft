"use client";
import { Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { agentPortalClassName } from "@/components/agents";
import { cn } from "@/lib/utils";
import { MODEL_SELECT_CONTENT_CLASS, ModelCompoundActionContent, modelCompoundClasses } from "./model-form-controls";

export interface ConfiguredProviderModelFormViewProps {
  id: string;
  isGlobalRegion: boolean;
  modelId: string;
  options: Array<{ id: string; name: string; saved: boolean }>;
  busy: boolean;
  loading: boolean;
  saving: boolean;
  checking: boolean;
  duplicate: boolean;
  selectionAvailable: boolean;
  labels: { addModel: string; model: string; loading: string; chooseModel: string; noModels: string; added: string; testModel: string; testing: string; getModels: string; duplicate: string; save: string; cancel: string };
  onModelChange: (value: string) => void;
  onCheck: () => void;
  onProbe: () => void;
  onSave: () => void;
  onCancel: () => void;
  onSelectInteraction: () => void;
}
export function ConfiguredProviderModelFormView({ id, isGlobalRegion, modelId, options, busy, loading, saving, checking, duplicate, selectionAvailable, labels, onModelChange, onCheck, onProbe, onSave, onCancel, onSelectInteraction }: ConfiguredProviderModelFormViewProps) {
  const compound = modelCompoundClasses(isGlobalRegion);
  return (
    <div className="flex min-w-0 flex-wrap items-start gap-3" role="group" aria-label={labels.addModel}>
      <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
        <label htmlFor={id} className="sr-only">{labels.model}</label>
        <div className={compound.control}>
          <Select value={modelId} onValueChange={onModelChange} disabled={busy || !options.length}>
            <SelectTrigger id={id} className={`${compound.field} w-full flex-1`} onPointerDownCapture={onSelectInteraction} onKeyDownCapture={onSelectInteraction}><SelectValue placeholder={loading ? labels.loading : options.length ? labels.chooseModel : labels.noModels} /></SelectTrigger>
            <SelectContent variant="product" position="popper" className={cn(agentPortalClassName, MODEL_SELECT_CONTENT_CLASS)}>
              {options.map((option) => {
                const saved = option.saved;
                return (
                  <SelectItem key={option.id} value={option.id} textValue={option.name} disabled={saved} className="data-[disabled]:cursor-not-allowed data-[disabled]:text-[var(--text-tertiary)] [&>span:last-child]:min-w-0 [&>span:last-child]:flex-1">
                    <span className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <span className="min-w-0 break-all">{option.name}</span>
                      {saved ? <Badge variant="neutral" className="shrink-0 border border-[var(--border-subtle)]">{labels.added}</Badge> : null}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <Button variant="outline" type="button" disabled={busy || !selectionAvailable} onClick={() => onCheck()} className={compound.action}>
            <ModelCompoundActionContent idleLabel={labels.testModel} loadingLabel={labels.testing} loading={checking} />
          </Button>
        </div>
        {!loading && !options.length ? (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onProbe()} className="mt-2 rounded-md text-xs font-normal">
            <RotateCw className="size-3.5" aria-hidden="true" />{labels.getModels}
          </Button>
        ) : null}
        {duplicate ? <p className="mt-2 text-sm text-red-600" role="status">{labels.duplicate}</p> : null}
      </div>
        <div className="flex h-12 shrink-0 items-center gap-2">
          <Button type="button" size="sm" disabled={busy || !selectionAvailable || duplicate} onClick={() => onSave()} className="rounded-md text-xs font-normal">
            {saving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}{labels.save}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={saving} onClick={onCancel} className="rounded-md text-xs font-normal">{labels.cancel}</Button>
        </div>
    </div>
  );
}
