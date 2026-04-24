import { useState } from "react";
import { Link } from "react-router-dom";
import { AuthShell } from "@/pages/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { InviteStatusCard } from "@/components/domain/invite-status-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { InviteCodeValidation } from "@/domain/types";
import { useSession } from "@/contexts/session-context";

const initialStatus: InviteCodeValidation = {
  code: "",
  state: "idle",
  message: "输入你的内测邀请码以确认资格。",
};

export const InvitePage = () => {
  const { validateInviteCode } = useSession();
  const [code, setCode] = useState("VALID2026");
  const [status, setStatus] = useState<InviteCodeValidation>(initialStatus);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onValidate = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const result = await validateInviteCode(code.trim());
      setStatus(result);
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : "校验失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell title="校验邀请码" subtitle="邀请码用于内测准入，不是团队协作邀请。">
      <form className="space-y-4" onSubmit={onValidate}>
        <div className="space-y-2">
          <Label htmlFor="inviteCode">邀请码</Label>
          <Input
            id="inviteCode"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="VALID2026"
            required
          />
        </div>
        <div className="text-xs text-[var(--text-tertiary)]">
          演示码：<code>VALID2026</code> / <code>EXPIRED2026</code> / <code>USED2026</code>
        </div>
        {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}
        <Button className="w-full" disabled={submitting}>
          {submitting ? "校验中..." : "校验邀请码"}
        </Button>
      </form>

      <InviteStatusCard result={status} />

      <div className="flex items-center justify-between text-sm text-[var(--text-secondary)]">
        <Link to="/auth/sign-in" className="lw-link-underline font-semibold">
          继续登录
        </Link>
        <Link to="/auth/sign-in" className="lw-link-underline font-semibold">
          返回登录
        </Link>
      </div>
    </AuthShell>
  );
};
