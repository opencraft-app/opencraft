// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
"use client";
import { type ReactNode, type RefObject } from "react";
import { Eye, EyeOff } from "lucide-react";
import { AgentChoiceGroup, AgentChoiceGroupItem, AgentField, agentButtonClassName, agentFieldClassName, agentPanelClassName, agentPortalClassName } from "../../components/agents/index";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { cn } from "../../lib/utils";

const CLS = "lh-std-channel-panel";
export interface ChannelCardViewProps {
  name: string; description: string; icon: ReactNode; connected: boolean; connectedLabel: string;
  guideUrl?: string; guideLabel: string; disconnectLabel: string; connectLabel: string; disconnectDisabled: boolean;
  onConnect: (trigger: HTMLButtonElement) => void; onDisconnect: () => void;
}
export function ChannelCardView(props: ChannelCardViewProps) {
  return <div className={cn(`${CLS}__card`, props.connected && `${CLS}__card--bound`, agentPanelClassName)}>
    <div className={`${CLS}__card-body`}>
      <div className={`${CLS}__card-icon`} aria-hidden="true">{props.icon}</div>
      <div className={`${CLS}__card-content`}>
        <div className={`${CLS}__card-header`}><h3 className={`${CLS}__card-name`}>{props.name}</h3>
          {props.connected ? <Badge variant="success">{props.connectedLabel}</Badge> : null}
        </div>
        <p className={`${CLS}__card-desc`}>{props.description}</p>
      </div>
    </div>
    <div className={`${CLS}__card-action`}>
      <div className={`${CLS}__card-action-right`}>
        {props.guideUrl ? <Button asChild variant="outline" className={cn(agentButtonClassName, `${CLS}__guide-btn`)}>
          <a href={props.guideUrl} target="_blank" rel="noopener noreferrer">{props.guideLabel}</a>
        </Button> : null}
        {props.connected ? <Button type="button" variant="outline" className={cn(agentButtonClassName, `${CLS}__card-unbind`)} onClick={props.onDisconnect} disabled={props.disconnectDisabled}>{props.disconnectLabel}</Button> : null}
        <Button type="button" variant={props.connected ? "outline" : "default"} className={cn(agentButtonClassName, `${CLS}__connect-btn`)} onClick={(event) => props.onConnect(event.currentTarget)}>{props.connectLabel}</Button>
      </div>
    </div>
  </div>;
}
interface ChannelDialogViewProps {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; closeLabel: string;
  returnFocusRef: RefObject<HTMLElement | null>; onCloseAutoFocus?: (event: Event) => void; children: ReactNode;
}
function ChannelDialogView({ open, onOpenChange, title, description, closeLabel, returnFocusRef, onCloseAutoFocus, children }: ChannelDialogViewProps) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent portalClassName={agentPortalClassName} closeLabel={closeLabel} className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-md md:rounded-md"
      onCloseAutoFocus={(event) => {
        onCloseAutoFocus?.(event);
        if (event.defaultPrevented) return;
        if (returnFocusRef.current?.isConnected) { event.preventDefault(); returnFocusRef.current.focus(); }
      }}>
      <DialogHeader className="mb-5"><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      {children}
    </DialogContent>
  </Dialog>;
}
export interface ChannelMethodDialogViewProps extends Omit<ChannelDialogViewProps, "children"> {
  value: "qrcode" | "manual"; onValueChange: (value: "qrcode" | "manual") => void;
  qrLabel: string; qrDescription: string; manualLabel: string; manualDescription: string;
  cancelLabel: string; confirmLabel: string; onConfirm: () => void;
}
export function ChannelMethodDialogView({ value, onValueChange, qrLabel, qrDescription, manualLabel, manualDescription, cancelLabel, confirmLabel, onConfirm, ...dialog }: ChannelMethodDialogViewProps) {
  return <ChannelDialogView {...dialog}>
    <AgentChoiceGroup value={value} onValueChange={(next) => onValueChange(next as "qrcode" | "manual")} aria-label={dialog.description}>
        {[{ value: "qrcode", label: qrLabel, description: qrDescription }, { value: "manual", label: manualLabel, description: manualDescription }].map((item) =>
          <AgentChoiceGroupItem key={item.value} value={item.value}>
            <span className="text-sm font-medium">{item.label}</span><span className="text-pretty text-xs font-normal text-[var(--text-secondary)]">{item.description}</span>
          </AgentChoiceGroupItem>)}
    </AgentChoiceGroup>
    <div className="mt-5 flex flex-wrap justify-end gap-2">
      <DialogClose asChild><Button variant="outline" className={agentButtonClassName}>{cancelLabel}</Button></DialogClose>
      <Button className={agentButtonClassName} onClick={onConfirm}>{confirmLabel}</Button>
    </div>
  </ChannelDialogView>;
}
export interface ChannelCredentialField {
  key: string; label: string; placeholder?: string; value: string; onChange: (value: string) => void;
  secret?: boolean; visible?: boolean; onToggleVisible?: () => void; visibilityLabel?: string;
}
export interface ChannelCredentialDialogViewProps extends Omit<ChannelDialogViewProps, "children" | "onCloseAutoFocus"> {
  fields: ChannelCredentialField[]; cancelLabel: string; submitLabel: string; submitDisabled: boolean; onSubmit: () => void;
}
export function ChannelCredentialDialogView({ fields, cancelLabel, submitLabel, submitDisabled, onSubmit, ...dialog }: ChannelCredentialDialogViewProps) {
  return <ChannelDialogView {...dialog}>
    <div className="grid gap-4">
      {fields.map((field) => <AgentField key={field.key} label={field.label}>
        {(control) => <div className="relative min-w-0">
          <Input {...control} className={cn(agentFieldClassName, field.secret && "pr-11")} type={field.secret && !field.visible ? "password" : "text"} autoComplete={field.secret ? "new-password" : "off"} value={field.value} placeholder={field.placeholder} onChange={(event) => field.onChange(event.target.value)} />
          {field.secret ? <Button type="button" variant="ghost" className="absolute right-1 top-1 size-8 rounded-md p-0" aria-label={`${field.visibilityLabel}: ${field.label}`} onClick={field.onToggleVisible}>
            {field.visible ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
          </Button> : null}
        </div>}
      </AgentField>)}
    </div>
    <div className="mt-5 flex flex-wrap justify-end gap-2">
      <DialogClose asChild><Button type="button" variant="outline" className={agentButtonClassName}>{cancelLabel}</Button></DialogClose>
      <Button type="button" className={agentButtonClassName} disabled={submitDisabled} onClick={onSubmit}>{submitLabel}</Button>
    </div>
  </ChannelDialogView>;
}
