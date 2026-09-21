"use client";

import { useEffect, useState } from "react";
import { Link2, Unlink } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api-client";
import { buildAuthShadowBindingRequest } from "@/lib/queries/auth-shadow-binding";
import {
  useAuthAdminShadowBinding,
  useDisableAuthAdminShadowBinding,
  useUpsertAuthAdminShadowBinding,
} from "@/lib/queries/use-auth-admin";
import { formatDateTime } from "@/lib/utils";

export function ShadowBindingsPanel({ initialUserID = "" }: { initialUserID?: string }) {
  const [lookupUserID, setLookupUserID] = useState(initialUserID);
  const [selectedUserID, setSelectedUserID] = useState(initialUserID);
  const [shadowUserName, setShadowUserName] = useState("");
  const [uin, setUin] = useState("");
  const [ownerUin, setOwnerUin] = useState("");
  const [appId, setAppId] = useState("");
  const [reason, setReason] = useState("");
  const binding = useAuthAdminShadowBinding(selectedUserID, selectedUserID.length > 0);
  const upsertBinding = useUpsertAuthAdminShadowBinding();
  const disableBinding = useDisableAuthAdminShadowBinding();

  useEffect(() => {
    if (!initialUserID) return;
    setLookupUserID(initialUserID);
    setSelectedUserID(initialUserID);
  }, [initialUserID]);

  useEffect(() => {
    setShadowUserName("");
    setUin("");
    setOwnerUin("");
    setAppId("");
    setReason("");
  }, [selectedUserID]);

  useEffect(() => {
    if (!binding.data) return;
    setShadowUserName(binding.data.shadowUserName);
    setUin(String(binding.data.uin));
    setOwnerUin(String(binding.data.ownerUin));
    setAppId(String(binding.data.appId));
  }, [binding.data]);

  async function handleBind() {
    try {
      const request = buildAuthShadowBindingRequest({
        userId: selectedUserID,
        shadowUserName,
        uin,
        ownerUin,
        appId,
        reason,
      });
      await upsertBinding.mutateAsync(request);
      setSelectedUserID(request.userId);
      toast.success("testing 影子账号绑定已生效");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "绑定失败");
    }
  }

  async function handleUnbind() {
    const normalizedReason = reason.trim();
    if (!selectedUserID || !normalizedReason) {
      toast.error("解绑前请输入原因");
      return;
    }
    try {
      await disableBinding.mutateAsync({ userID: selectedUserID, reason: normalizedReason });
      toast.success("testing 影子账号已解绑，该 UIN 可重新分配");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "解绑失败");
    }
  }

  const missingBinding = binding.error instanceof ApiError && binding.error.status === 404;

  return (
    <div className="space-y-6 pt-4">
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
        <div className="font-medium">仅限共享 testing 环境</div>
        <p className="mt-1 text-muted-foreground">
          这里管理 Auth 的真实 shadow_bindings。生产默认关闭；改绑必须先显式解绑，不接收 SecretID、SecretKey 或密码。
        </p>
      </div>

      <div className="flex max-w-3xl gap-2">
        <div className="flex-1">
          <Label htmlFor="shadow-binding-user-id" className="sr-only">LightVela 用户 ID</Label>
          <Input
            id="shadow-binding-user-id"
            placeholder="LightVela testing 用户 ID，例如 usr_..."
            value={lookupUserID}
            onChange={(event) => {
              setLookupUserID(event.target.value);
              setSelectedUserID("");
            }}
          />
        </div>
        <Button
          variant="outline"
          onClick={() => setSelectedUserID(lookupUserID.trim())}
          disabled={!lookupUserID.trim()}
        >
          查询绑定
        </Button>
      </div>

      {binding.data && (
        <div className="rounded-lg border p-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="font-medium">当前状态</span>
            <Badge variant={binding.data.status === "active" ? "default" : "outline"}>
              {binding.data.status}
            </Badge>
          </div>
          <div className="mt-3 grid gap-2 font-mono text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div>user: {binding.data.userId}</div>
            <div>uin: {binding.data.uin}</div>
            <div>owner: {binding.data.ownerUin}</div>
            <div>app: {binding.data.appId}</div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">更新时间：{formatDateTime(binding.data.updatedAt)}</p>
        </div>
      )}

      {missingBinding && (
        <p className="text-sm text-muted-foreground">当前用户尚未绑定 testing 影子账号，可在下方创建。</p>
      )}
      {binding.error && !missingBinding && (
        <p role="alert" className="text-sm text-destructive">
          {binding.error instanceof Error ? binding.error.message : "查询绑定失败"}
        </p>
      )}

      <div className="grid gap-4 rounded-lg border p-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="shadow-user-name">影子用户名</Label>
          <Input
            id="shadow-user-name"
            value={shadowUserName}
            onChange={(event) => setShadowUserName(event.target.value)}
            placeholder="mock_..."
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="shadow-uin">UIN</Label>
          <Input id="shadow-uin" inputMode="numeric" value={uin} onChange={(event) => setUin(event.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="shadow-owner-uin">OwnerUIN</Label>
          <Input id="shadow-owner-uin" inputMode="numeric" value={ownerUin} onChange={(event) => setOwnerUin(event.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="shadow-app-id">AppID</Label>
          <Input id="shadow-app-id" inputMode="numeric" value={appId} onChange={(event) => setAppId(event.target.value)} />
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="shadow-binding-reason">操作原因</Label>
          <Textarea
            id="shadow-binding-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="例如：为个人 DevCloud 联调分配 testing mock 账号"
          />
        </div>
        <div className="flex flex-wrap gap-2 md:col-span-2">
          <Button onClick={() => void handleBind()} disabled={!selectedUserID || upsertBinding.isPending}>
            <Link2 className="mr-2 h-4 w-4" />
            {upsertBinding.isPending ? "绑定中..." : "绑定 testing 账号"}
          </Button>
          <Button
            variant="destructive"
            onClick={() => void handleUnbind()}
            disabled={!binding.data || binding.data.status === "disabled" || disableBinding.isPending}
          >
            <Unlink className="mr-2 h-4 w-4" />
            {disableBinding.isPending ? "解绑中..." : "显式解绑并回收"}
          </Button>
        </div>
      </div>
    </div>
  );
}
