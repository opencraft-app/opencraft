"use client";

import { useState } from "react";
import { ArrowRightLeft, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import type { CtlBot } from "@/lib/queries/use-ctl-bots";
import type {
  GatewayMigrationResult,
  GatewayOperation,
  GatewayQuotaResetResult,
} from "@/lib/queries/gateway-operations";
import { isGatewayOperationConfirmed } from "@/lib/queries/gateway-operation-policy";
import { formatNumber } from "@/lib/utils";

interface GatewayOperationDialogProps {
  target: CtlBot;
  operation: GatewayOperation;
  preview?: GatewayMigrationResult | GatewayQuotaResetResult;
  previewError?: string;
  loading: boolean;
  onClose: () => void;
  onExecute: () => void;
}

function formatUnixTime(value: number): string {
  return value > 0 ? new Date(value * 1000).toLocaleString("zh-CN", { hour12: false }) : "-";
}

export function GatewayOperationDialog({
  target,
  operation,
  preview,
  previewError,
  loading,
  onClose,
  onExecute,
}: GatewayOperationDialogProps) {
  const [confirmation, setConfirmation] = useState("");
  const isMigration = operation === "migrate";
  const migration = isMigration ? preview as GatewayMigrationResult | undefined : undefined;
  const quota = !isMigration ? preview as GatewayQuotaResetResult | undefined : undefined;
  const alreadyReset = quota?.status === "already_reset" || quota?.amount_used_before === 0;
  const confirmed = isGatewayOperationConfirmed(confirmation, target.user_id);
  const executable = !!preview && !previewError && confirmed && !alreadyReset && !loading;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isMigration ? <ArrowRightLeft className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
            {isMigration ? "迁移到 VelaGW" : "重置 VelaGW 额度"}
          </DialogTitle>
          <DialogDescription>
            {target.user_id} · {target.instance_id}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {loading && !preview ? (
            <div className="rounded-md border p-3 text-sm text-muted-foreground">正在执行预检…</div>
          ) : null}
          {previewError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {previewError}
            </div>
          ) : null}
          {migration ? (
            <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-md border p-3 text-sm">
              <dt className="text-muted-foreground">当前网关</dt><dd>{migration.previous_gateway}</dd>
              <dt className="text-muted-foreground">目标网关</dt><dd>{migration.target_gateway}</dd>
              <dt className="text-muted-foreground">实例状态</dt><dd>{target.status}</dd>
              <dt className="text-muted-foreground">操作模式</dt><dd>{migration.already_migrated ? "重新收敛" : "首次迁移"}</dd>
            </dl>
          ) : null}
          {quota ? (
            <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-md border p-3 text-sm">
              <dt className="text-muted-foreground">Set</dt><dd className="font-mono text-xs">{quota.set_id}</dd>
              <dt className="text-muted-foreground">订阅</dt><dd className="font-mono text-xs">{quota.subscription_id}</dd>
              <dt className="text-muted-foreground">当前已用</dt><dd>{formatNumber(quota.amount_used_before)} tokens</dd>
              <dt className="text-muted-foreground">自然重置时间</dt><dd>{formatUnixTime(quota.next_reset_time)}</dd>
              <dt className="text-muted-foreground">有效期</dt><dd>{formatUnixTime(quota.end_time)}</dd>
            </dl>
          ) : null}

          {preview && !previewError ? (
            <div className="space-y-2">
              <Label htmlFor="gateway-operation-confirmation">输入完整用户 ID 确认</Label>
              <Input
                id="gateway-operation-confirmation"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder={target.user_id}
                autoComplete="off"
                disabled={loading || alreadyReset}
              />
              {alreadyReset ? <p className="text-xs text-muted-foreground">当前已用额度为 0，无需重置。</p> : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>取消</Button>
          <Button onClick={onExecute} disabled={!executable}>
            {loading ? "处理中…" : isMigration ? "执行迁移" : "重置额度"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
