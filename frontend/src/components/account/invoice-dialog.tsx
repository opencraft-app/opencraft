import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";

type InvoiceType = "personal" | "enterprise";
export interface InvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InvoiceDialog({ open, onOpenChange }: InvoiceDialogProps) {
  const [invoiceType, setInvoiceType] = useState<InvoiceType>("personal");
  const [name, setName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const reset = useCallback(() => {
    clearTimer();
    setInvoiceType("personal");
    setName("");
    setTaxId("");
    setEmail("");
    setSubmitting(false);
  }, [clearTimer]);
  useEffect(() => {
    if (!open) reset();
    return clearTimer;
  }, [clearTimer, open, reset]);
  useLayoutEffect(() => {
    if (open && !wasOpenRef.current && document.activeElement instanceof HTMLElement) {
      previousFocusRef.current = document.activeElement;
    }
    wasOpenRef.current = open;
  }, [open]);
  const close = () => {
    reset();
    onOpenChange(false);
  };
  const changeType = (value: string) => {
    if (value === invoiceType || (value !== "personal" && value !== "enterprise")) return;
    setInvoiceType(value);
    setName("");
    setTaxId("");
    setEmail("");
  };
  const validEmail = email.includes("@") && email.includes(".");
  const canSubmit = name.trim().length >= 2 && validEmail
    && (invoiceType === "personal" || taxId.trim().length >= 15);
  const submit = () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    clearTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      setSubmitting(false);
      onOpenChange(false);
    }, 1000);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => next ? onOpenChange(true) : close()}>
      <DialogContent
        portalClassName="agents-ui"
        closeLabel="关闭"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const previousFocus = previousFocusRef.current;
          if (previousFocus?.isConnected) previousFocus.focus();
        }}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-md border border-black/[0.08] bg-white p-0 shadow-xl md:w-[28rem]"
      >
        <div className="p-5 sm:p-6">
          <DialogHeader className="mb-5 pr-8">
            <DialogTitle className="text-balance">申请发票</DialogTitle>
            <DialogDescription className="text-pretty">填写发票信息，电子发票将发送至您的邮箱。</DialogDescription>
          </DialogHeader>
          <RadioGroup aria-label="类型" value={invoiceType} onValueChange={changeType} className="mb-5 grid grid-cols-2 gap-2 rounded-md bg-black/[0.03] p-1">
            <RadioGroupItem value="personal" className="rounded-md px-3 py-2 text-sm font-semibold text-[var(--text-secondary)] data-[state=checked]:bg-white data-[state=checked]:text-[var(--text-primary)] data-[state=checked]:shadow-sm">个人</RadioGroupItem>
            <RadioGroupItem value="enterprise" className="rounded-md px-3 py-2 text-sm font-semibold text-[var(--text-secondary)] data-[state=checked]:bg-white data-[state=checked]:text-[var(--text-primary)] data-[state=checked]:shadow-sm">企业</RadioGroupItem>
          </RadioGroup>
          <div className="space-y-4">
            <InvoiceField id="invoice-name" label={invoiceType === "personal" ? "发票抬头" : "企业名称"} placeholder={invoiceType === "personal" ? "请输入个人姓名" : "请输入企业全称"} value={name} onChange={setName} maxLength={60} />
            {invoiceType === "enterprise" ? <InvoiceField id="invoice-tax-id" label="企业税号" placeholder="请输入统一社会信用代码" value={taxId} onChange={(value) => setTaxId(value.replace(/[^A-Za-z0-9]/g, "").slice(0, 20))} maxLength={20} /> : null}
            <InvoiceField id="invoice-email" label="接收邮箱" type="email" placeholder="请输入邮箱地址" value={email} onChange={setEmail} />
          </div>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={close}>取消</Button>
            <Button type="button" disabled={!canSubmit || submitting} onClick={submit} aria-busy={submitting}>
              {submitting ? <><Spinner />提交中...</> : "提交申请"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface InvoiceFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "email" | "text";
  placeholder: string;
  maxLength?: number;
}

function InvoiceField({ id, label, value, onChange, type = "text", placeholder, maxLength }: InvoiceFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-[var(--text-primary)]">
        {label} <span aria-hidden="true" className="text-[var(--danger)]">*</span>
      </label>
      <input
        id={id}
        type={type}
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        className="lw-input w-full"
      />
    </div>
  );
}
