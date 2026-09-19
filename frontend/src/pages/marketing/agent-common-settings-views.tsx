"use client";
import Link from "next/link";
import { type KeyboardEventHandler, type RefObject, useId, useRef } from "react";
import { Check, Pencil, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { agentPortalClassName } from "@/components/agents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface CommonSettingRowViewProps {
  setting: { key: string; label: string; description: string; descriptionHref?: string; kind: "switch" | "number" | "select"; step?: string; min?: string; max?: string };
  value: string | number | boolean; draft: string; disabled: boolean; unsupported: boolean; compressionDisabled: boolean;
  editing: boolean; numberChanged: boolean; saving: boolean; editDisabled: boolean; error?: string;
  labels: { unsupported: string; viewContent: string; smart: string; manual: string; off: string; save: string; cancel: string; edit: string; saving: string; compressionDisabled: string };
  selectTriggerRef: RefObject<HTMLButtonElement | null>;
  onSwitchChange: (value: boolean) => void; onSelectChange: (value: string) => void;
  onDraftChange: (value: string) => void; onNumberKeyDown: KeyboardEventHandler<HTMLInputElement>;
  onEdit: () => void; onSave: () => void; onCancel: () => void;
}
export function CommonSettingRowView({ setting, value, draft, disabled, unsupported, compressionDisabled, editing, numberChanged, saving, editDisabled, error, labels, selectTriggerRef, onSwitchChange, onSelectChange, onDraftChange, onNumberKeyDown, onEdit, onSave, onCancel }: CommonSettingRowViewProps) {
  const descriptionId = useId();
  const errorId = useId();
  const restoreEditFocus = useRef(false);
  const controlDescription = { "aria-describedby": error ? `${descriptionId} ${errorId}` : descriptionId, "aria-invalid": !!error };
  return (
                    <div
                      data-testid="common-setting-row"
                      className={cn(
                        "grid gap-4 py-6 sm:items-center sm:gap-10",
                        setting.kind === "switch"
                          ? "sm:grid-cols-[minmax(0,1fr)_auto]"
                          : "sm:grid-cols-[minmax(0,1fr)_17rem]",
                      )}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="text-[15px] font-medium text-black/90">{setting.label}</h4>
                          {unsupported && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">{labels.unsupported}</span>}
                        </div>
                        <p id={descriptionId} className="mt-1 text-pretty text-sm leading-6 text-black/45">
                          {setting.description}
                          {setting.descriptionHref && (
                            <Link
                              href={setting.descriptionHref}
                              className="ml-2 whitespace-nowrap text-[var(--lw-accent)] hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                            >
                              {labels.viewContent}
                            </Link>
                          )}
                        </p>
                      </div>
                      <div className="flex min-w-0 flex-col items-end gap-1.5">
                        {unsupported ? (
                          <span
                            data-testid={`common-setting-unsupported-${setting.key}`}
                            className="inline-flex min-h-6 items-center text-sm text-black/35"
                          >
                            —
                          </span>
                        ) : setting.kind === "switch" ? (
                          <Switch {...controlDescription} aria-label={setting.label}
                            checked={Boolean(value)} disabled={disabled}
                            onCheckedChange={onSwitchChange} />

                        ) : setting.kind === "select" ? (
                          <Select
                            value={String(value)}
                            disabled={disabled}
                            onValueChange={onSelectChange}
                          >
                            <SelectTrigger {...controlDescription} ref={selectTriggerRef} aria-label={setting.label} className="h-10 w-full max-w-[17rem] rounded-md">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent variant="product" position="popper" className={`${agentPortalClassName} max-h-[var(--radix-select-content-available-height)] max-w-[calc(100vw-2rem)]`}>
                              <SelectItem value="smart">{labels.smart}</SelectItem>
                              <SelectItem value="manual">{labels.manual}</SelectItem>
                              <SelectItem value="off">{labels.off}</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : editing ? (
                          <div className="flex w-full max-w-[17rem] items-center gap-2">
                            <Input {...controlDescription}
                              autoFocus
                              type="number"
                              aria-label={setting.label}
                              value={draft}
                              step={setting.step}
                              min={setting.min}
                              max={setting.max}
                              disabled={disabled}
                              onChange={(event) => onDraftChange(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Escape") restoreEditFocus.current = true;
                                onNumberKeyDown(event);
                              }}
                              className="h-10 min-w-0 flex-1 rounded-md border border-black/10 bg-white px-3 text-sm text-black/85 outline-none focus:border-black/30 disabled:cursor-not-allowed disabled:bg-black/[0.03] disabled:text-black/35"
                            />
                            <Button
                              type="button"
                              aria-label={`${labels.save}${setting.label}`}
                              aria-busy={saving}
                              disabled={disabled || !numberChanged}
                              onClick={onSave}
                              className="inline-flex size-8 p-0 shrink-0 items-center justify-center rounded-md bg-[var(--lw-accent)] text-white transition hover:bg-[var(--lw-accent-hover)] disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              {saving ? <Spinner size="md" /> : <Check className="size-4" aria-hidden="true" />}
                            </Button>
                            <Button
                              variant="outline"
                              type="button"
                              aria-label={`${labels.cancel}${labels.edit}${setting.label}`}
                              disabled={saving}
                              onClick={() => { restoreEditFocus.current = true; onCancel(); }}
                              className="inline-flex size-8 p-0 shrink-0 items-center justify-center rounded-md border border-black/10 text-black/55 transition hover:bg-black/[0.03] hover:text-black/80 disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              <X className="size-4" />
                            </Button>
                          </div>
                        ) : (
                          <div
                            className="group/value relative w-full max-w-[17rem] pt-8"
                          >
                            <div
                              className={cn(
                                "flex h-10 w-full items-center justify-end rounded-md border border-black/10 bg-white px-3",
                                disabled && "bg-black/[0.03]",
                              )}
                            >
                              <span
                                data-testid={`common-setting-value-${setting.key}`}
                                className={cn("text-sm tabular-nums", disabled ? "text-black/35" : "text-black/75")}
                              >
                                {value}
                              </span>
                            </div>
                            <Button
                              variant="ghost"
                              ref={(node) => {
                                if (node && restoreEditFocus.current) {
                                  restoreEditFocus.current = false;
                                  node.focus({ preventScroll: true });
                                }
                              }}
                              type="button"
                              aria-label={`${labels.edit}${setting.label}`}
                              disabled={editDisabled}
                              onClick={() => { restoreEditFocus.current = false; onEdit(); }}
                              className="absolute right-2 top-0 inline-flex size-8 p-0 items-center justify-center rounded-md border border-black/10 bg-white text-black/45 opacity-100 shadow-none transition-none hover:text-black/75 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-0 "
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                          </div>
                        )}
                        {saving && <span className="text-xs text-black/45">{labels.saving}</span>}
                        {error && <span id={errorId} role="alert" className="text-right text-xs text-red-600">{error}</span>}
                        {compressionDisabled && <span className="text-xs text-black/35">{labels.compressionDisabled}</span>}
                      </div>
                    </div>
                  );

}
