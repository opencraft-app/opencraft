"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Copy, Check, AlertTriangle } from "lucide-react";
import { usePlans } from "@/lib/queries/use-plans";
import { useProvision } from "@/lib/queries/use-provision";
import { useCreateApiKey } from "@/lib/queries/use-users";
import { formatTokens, formatDate } from "@/lib/utils";

const schema = z.object({
  user_id: z.string().min(1, "用户 ID 不能为空"),
  phone: z.string().optional(),
  nickname: z.string().optional(),
  plan_id: z.string().min(1, "请选择套餐"),
  period_start: z.string().optional(), // date input value，如 "2026-04-01"
});

type FormValues = z.infer<typeof schema>;

export function ProvisionForm() {
  const [assignApiKey, setAssignApiKey] = useState(false);
  const [result, setResult] = useState<{
    gateway_user_id: string;
    user_id: string;
    api_key: string | null;
    api_key_assigned: boolean;
    plan_name: string;
    token_balance: number;
    period_start: string;
    period_end: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const plans = usePlans();
  const provision = useProvision();
  const createApiKey = useCreateApiKey();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { user_id: "", phone: "", nickname: "", plan_id: "", period_start: "" },
  });

  async function onSubmit(values: FormValues) {
    try {
      // 将 date input 值（"2026-04-01"）转换为 RFC3339 格式
      const period_start = values.period_start
        ? new Date(values.period_start + "T00:00:00Z").toISOString()
        : undefined;
      const data = await provision.mutateAsync({ ...values, period_start, assign_api_key: assignApiKey });
      setResult(data);
      form.reset();
      setAssignApiKey(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "开通失败");
    }
  }

  function copyKey() {
    if (result?.api_key) {
      navigator.clipboard.writeText(result.api_key);
      setCopied(true);
      toast.success("API Key 已复制到剪贴板");
      setTimeout(() => setCopied(false), 2000);
    }
  }

  async function handleAssignApiKeyNow() {
    if (!result) return;
    try {
      const created = await createApiKey.mutateAsync(result.gateway_user_id);
      setResult((prev) => prev ? {
        ...prev,
        api_key: created.api_key,
        api_key_assigned: true,
      } : prev);
      toast.success("API Key 分配成功");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "分配 API Key 失败");
    }
  }

  if (result) {
    return (
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="text-green-500">开通成功</CardTitle>
          <CardDescription>
            {result.api_key_assigned ? "用户已创建，订阅已激活，API Key 已分配。" : "用户已创建，订阅已激活。"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">用户 ID</span>
              <span className="font-mono">{result.user_id}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">套餐</span>
              <span>{result.plan_name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Token 余额</span>
              <span>{formatTokens(result.token_balance)}</span>
            </div>
            {result.period_start && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">订阅开始</span>
                <span>{formatDate(result.period_start)}</span>
              </div>
            )}
            {result.period_end && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">到期时间</span>
                <span>{formatDate(result.period_end)}</span>
              </div>
            )}
          </div>

          {result.api_key_assigned && result.api_key ? (
            <div className="rounded-md border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">API Key</span>
                <Button variant="ghost" size="sm" onClick={copyKey}>
                  {copied ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <code className="block text-sm font-mono break-all bg-muted p-2 rounded">
                {result.api_key}
              </code>
              <div className="flex items-center gap-1 text-xs text-yellow-500">
                <AlertTriangle className="h-3 w-3" />
                <span>此 API Key 仅显示一次，请立即复制保存。</span>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-dashed p-3 space-y-3">
              <div className="text-sm font-medium">API Key</div>
              <p className="text-sm text-muted-foreground">
                本次只完成了用户与订阅开通，尚未分配 API Key。
              </p>
              <Button onClick={handleAssignApiKeyNow} disabled={createApiKey.isPending}>
                {createApiKey.isPending ? "分配中..." : "立即分配 API Key"}
              </Button>
            </div>
          )}

          <Button
            variant="outline"
            className="w-full"
            onClick={() => setResult(null)}
          >
            继续开通
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle>一键开通</CardTitle>
        <CardDescription>
          默认完成用户创建与订阅开通，可按需立即分配 API Key。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="user_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>用户 ID</FormLabel>
                  <FormControl>
                    <Input placeholder="usr_XXXXXX" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>手机号（可选）</FormLabel>
                  <FormControl>
                    <Input placeholder="138xxxx1234" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="nickname"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>昵称（可选）</FormLabel>
                  <FormControl>
                    <Input placeholder="例如：张三" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="plan_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>套餐</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="选择套餐" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {plans.data?.items?.map((plan) => (
                        <SelectItem key={plan.id} value={plan.id}>
                          {plan.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="period_start"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>订阅开始时间（可选）</FormLabel>
                  <FormControl>
                    <Input
                      type="date"
                      {...field}
                      className="w-full"
                    />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    留空则立即生效，选择日期则从该日期起计算订阅周期。
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex items-start justify-between rounded-md border p-3">
              <div className="space-y-1">
                <div className="text-sm font-medium">立即分配 API Key</div>
                <p className="text-xs text-muted-foreground">
                  默认只开通用户和订阅；开启后会在本次开通成功后直接生成并返回 API Key。
                </p>
              </div>
              <Switch checked={assignApiKey} onCheckedChange={setAssignApiKey} />
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={provision.isPending}
            >
              {provision.isPending ? "开通中..." : "开通用户"}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
