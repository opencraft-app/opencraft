import { CodeInput } from "@/components/domain/code-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface PhoneCodeFieldsProps {
  phone: string;
  code: string;
  sending: boolean;
  cooldownLeft: number;
  onPhoneChange: (value: string) => void;
  onCodeChange: (value: string) => void;
  onSendCode: () => Promise<void>;
}

export const PhoneCodeFields = ({
  phone,
  code,
  sending,
  cooldownLeft,
  onPhoneChange,
  onCodeChange,
  onSendCode,
}: PhoneCodeFieldsProps) => {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="phone">手机号</Label>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <Input
            id="phone"
            value={phone}
            onChange={(event) => onPhoneChange(event.target.value)}
            type="tel"
            inputMode="numeric"
            placeholder="13800138000"
            required
          />
          <Button
            type="button"
            variant="outline"
            onClick={onSendCode}
            disabled={sending || cooldownLeft > 0}
            className="h-11 shrink-0 rounded-[1rem] px-4 text-sm"
          >
            {cooldownLeft > 0 ? `${cooldownLeft}s 后重发` : "发送验证码"}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <Label>验证码</Label>
        <CodeInput value={code} onChange={onCodeChange} />
        <p className="text-xs text-[var(--text-tertiary)]">演示码：123456</p>
      </div>
    </>
  );
};
