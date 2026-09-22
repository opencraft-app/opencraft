"use client";

import { FormEvent, useState } from "react";
import { Gift, RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/shared/page-header";
import {
  type ReferralAttributionResetResult,
  useReferralAttribution,
  useResetReferralAttribution,
} from "@/lib/queries/use-referral-admin";
import { formatDateTime, formatNumber } from "@/lib/utils";

interface ReferralSearch {
  inviteeUserID: string;
  attributionID?: string;
}

function rewardStatusVariant(status: string) {
  if (status === "granted") {
    return "default" as const;
  }
  if (status === "cancelled") {
    return "secondary" as const;
  }
  return "outline" as const;
}

function rewardSideLabel(side: string) {
  return side === "inviter" ? "邀请人" : side === "invitee" ? "被邀请人" : side;
}

export default function ReferralsPage() {
  const [inviteeInput, setInviteeInput] = useState("");
  const [attributionInput, setAttributionInput] = useState("");
  const [search, setSearch] = useState<ReferralSearch | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [operator, setOperator] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [lastResult, setLastResult] =
    useState<ReferralAttributionResetResult | null>(null);

  const attribution = useReferralAttribution(
    search?.inviteeUserID ?? "",
    search?.attributionID
  );
  const resetAttribution = useResetReferralAttribution();
  const preview = attribution.data;

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const inviteeUserID = inviteeInput.trim();
    if (!inviteeUserID) {
      toast.error("请输入被邀请人用户 ID");
      return;
    }
    setSearch({
      inviteeUserID,
      attributionID: attributionInput.trim() || undefined,
    });
    setLastResult(null);
    setResetOpen(false);
    setConfirmation("");
    setReason("");
    setIdempotencyKey("");
  }

  function openResetDialog() {
    if (!preview?.resettable) {
      return;
    }
    if (!idempotencyKey) {
      setIdempotencyKey(crypto.randomUUID());
    }
    setResetOpen(true);
  }

  async function handleReset() {
    if (!preview || !idempotencyKey) {
      return;
    }
    try {
      const result = await resetAttribution.mutateAsync({
        inviteeUserID: preview.attribution.invitee_user_id,
        expectedAttributionID: preview.attribution.attribution_id,
        idempotencyKey,
        operator: operator.trim(),
        reason: reason.trim(),
      });
      setLastResult(result);
      setResetOpen(false);
      setSearch(null);
      setConfirmation("");
      setReason("");
      setIdempotencyKey("");
      toast.success("邀请归因已重置");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "邀请归因重置失败");
    }
  }

  const queryError = attribution.error instanceof Error ? attribution.error.message : "";
  const canReset =
    Boolean(preview?.resettable) &&
    operator.trim().length > 0 &&
    reason.trim().length > 0 &&
    confirmation === preview?.attribution.invitee_user_id &&
    idempotencyKey.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="邀请返利"
        description="查询邀请归因；仅在确认奖励状态安全后，撤销精确赠送积分并释放该用户的旧归因。重置后仍需先访问新邀请链接，再完成下一次首次开通。"
      />

      <Card>
        <CardHeader>
          <CardTitle>归因查询</CardTitle>
          <CardDescription>
            默认查询用户最新归因；如需处理历史记录，请同时填写精确归因 ID。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 md:grid-cols-[minmax(260px,1fr)_minmax(260px,1fr)_auto]"
            onSubmit={handleSearch}
          >
            <div className="space-y-2">
              <Label htmlFor="referral-invitee-user-id">被邀请人用户 ID</Label>
              <Input
                id="referral-invitee-user-id"
                placeholder="usr_..."
                value={inviteeInput}
                onChange={(event) => setInviteeInput(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="referral-attribution-id">归因 ID（可选）</Label>
              <Input
                id="referral-attribution-id"
                placeholder="rattr_..."
                value={attributionInput}
                onChange={(event) => setAttributionInput(event.target.value)}
              />
            </div>
            <Button
              type="submit"
              variant="outline"
              className="self-end"
              disabled={attribution.isFetching}
            >
              <RefreshCw
                className={attribution.isFetching ? "animate-spin" : ""}
                aria-hidden="true"
              />
              查询
            </Button>
          </form>
          {queryError && (
            <p className="mt-4 text-sm text-destructive" role="alert">
              {queryError}
            </p>
          )}
        </CardContent>
      </Card>

      {lastResult && (
        <Card>
          <CardHeader>
            <CardTitle>最近一次重置结果</CardTitle>
            <CardDescription>
              操作已写入审计记录，可使用操作 ID 追踪。
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <ResultField label="操作 ID" value={lastResult.operation_id} />
            <ResultField label="归因 ID" value={lastResult.attribution_id} />
            <ResultField label="删除奖励" value={String(lastResult.rewards_removed)} />
            <ResultField
              label="撤销积分订阅"
              value={String(lastResult.subscriptions_revoked)}
            />
          </CardContent>
        </Card>
      )}

      {preview && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div className="space-y-1.5">
              <CardTitle>归因详情</CardTitle>
              <CardDescription>
                重置会删除这条归因及关联奖励事实，不会删除注册、开通或退款记录。
              </CardDescription>
            </div>
            <Badge variant={preview.resettable ? "default" : "destructive"}>
              {preview.resettable ? "可重置" : "禁止重置"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-x-6 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
              <DetailField label="归因 ID" value={preview.attribution.attribution_id} />
              <DetailField label="活动 ID" value={preview.attribution.campaign_id} />
              <DetailField label="邀请码" value={preview.attribution.referral_code} />
              <DetailField label="邀请人" value={preview.attribution.inviter_user_id} />
              <DetailField label="被邀请人" value={preview.attribution.invitee_user_id} />
              <DetailField
                label="注册时间"
                value={formatDateTime(preview.attribution.registered_at)}
              />
            </div>

            {!preview.resettable && preview.block_reason && (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {preview.block_reason}
              </p>
            )}

            <div className="space-y-3">
              <h3 className="text-sm font-medium">关联奖励</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>对象</TableHead>
                    <TableHead>受益用户</TableHead>
                    <TableHead>积分</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>精确订阅名</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rewards.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                        没有关联奖励
                      </TableCell>
                    </TableRow>
                  ) : (
                    preview.rewards.map((reward) => (
                      <TableRow key={reward.reward_id}>
                        <TableCell>{rewardSideLabel(reward.reward_side)}</TableCell>
                        <TableCell>
                          <code className="font-mono text-xs">
                            {reward.beneficiary_user_id}
                          </code>
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {formatNumber(reward.credit_amount)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={rewardStatusVariant(reward.status)}>
                            {reward.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <code className="block max-w-80 truncate font-mono text-xs">
                            {reward.subscription_name || "-"}
                          </code>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            <div className="flex justify-end">
              <Button
                variant="destructive"
                onClick={openResetDialog}
                disabled={!preview.resettable}
              >
                <RotateCcw aria-hidden="true" />
                重置归因
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Gift className="size-4" aria-hidden="true" />
              重置邀请归因
            </DialogTitle>
            <DialogDescription>
              系统会撤销下方奖励对应的精确 free-credit 订阅，然后删除归因与奖励行并记录审计日志。套餐权益不会被修改。
              本操作不会自动绑定新邀请码，也不会使用历史开通记录补发奖励。
            </DialogDescription>
          </DialogHeader>

          {preview && (
            <div className="space-y-4">
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
                <div className="font-mono">{preview.attribution.attribution_id}</div>
                <div className="mt-1 text-muted-foreground">
                  {preview.attribution.inviter_user_id} → {preview.attribution.invitee_user_id}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="referral-reset-operator">操作人</Label>
                <Input
                  id="referral-reset-operator"
                  placeholder="企业账号或姓名"
                  value={operator}
                  maxLength={128}
                  onChange={(event) => setOperator(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="referral-reset-reason">原因</Label>
                <Textarea
                  id="referral-reset-reason"
                  placeholder="说明误归因背景和工单信息"
                  value={reason}
                  maxLength={512}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="referral-reset-confirmation">
                  输入被邀请人 ID 以确认
                </Label>
                <Input
                  id="referral-reset-confirmation"
                  placeholder={preview.attribution.invitee_user_id}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setResetOpen(false)}
              disabled={resetAttribution.isPending}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleReset()}
              disabled={!canReset || resetAttribution.isPending}
            >
              {resetAttribution.isPending ? "处理中…" : "确认重置"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <code className="mt-1 block truncate font-mono text-xs" title={value}>
        {value || "-"}
      </code>
    </div>
  );
}

function ResultField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <code className="mt-1 block truncate font-mono text-sm" title={value}>
        {value}
      </code>
    </div>
  );
}
