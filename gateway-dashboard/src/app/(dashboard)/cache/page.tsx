"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Database,
  Zap,
  Target,
  TrendingUp,
  Trash2,
  Save,
  Loader2,
  CheckCircle2,
  XCircle,
  FlaskConical,
} from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  useCacheConfig,
  useUpdateCacheConfig,
  useCacheStats,
  useClearCache,
  useTestEmbedding,
  type CacheConfig,
} from "@/lib/queries/use-cache";

export default function CachePage() {
  const { data: config, isLoading: configLoading } = useCacheConfig();
  const { data: stats, isLoading: statsLoading } = useCacheStats();
  const updateConfig = useUpdateCacheConfig();
  const clearCache = useClearCache();
  const testEmbedding = useTestEmbedding();
  const [testResult, setTestResult] = useState<{ ok: boolean; latency_ms?: number; error?: string } | null>(null);

  const [showClearDialog, setShowClearDialog] = useState(false);
  const [editConfig, setEditConfig] = useState<Partial<CacheConfig> | null>(null);

  // 使用编辑中的值或服务端值
  const currentConfig = editConfig
    ? { ...config, ...editConfig }
    : config;

  const handleSave = () => {
    if (!editConfig) return;
    updateConfig.mutate(editConfig, {
      onSuccess: () => {
        toast.success("缓存配置已更新");
        setEditConfig(null);
      },
      onError: (err) => {
        toast.error("更新失败: " + err.message);
      },
    });
  };

  const handleClear = () => {
    clearCache.mutate(undefined, {
      onSuccess: () => {
        toast.success("缓存已清除");
        setShowClearDialog(false);
      },
      onError: (err) => {
        toast.error("清除失败: " + err.message);
      },
    });
  };

  const updateField = <K extends keyof CacheConfig>(key: K, value: CacheConfig[K]) => {
    setEditConfig((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const handleTestEmbedding = () => {
    setTestResult(null);
    testEmbedding.mutate(undefined, {
      onSuccess: (data) => {
        setTestResult({ ok: true, latency_ms: data.latency_ms });
      },
      onError: (err) => {
        setTestResult({ ok: false, error: err.message });
      },
    });
  };

  // 格式化数字
  const formatNumber = (n: number | undefined) => {
    if (n === undefined || n === null) return "0";
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return n.toString();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="缓存管理"
        description="语义缓存配置与统计，通过向量相似度匹配减少重复的 LLM 调用"
      >
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setShowClearDialog(true)}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          清除全部缓存
        </Button>
      </PageHeader>

      {/* 统计卡片区 */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">命中率</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <>
                <div className="text-2xl font-bold">
                  {stats?.hit_rate?.toFixed(1) ?? "0.0"}%
                </div>
                <p className="text-xs text-muted-foreground">
                  {formatNumber(stats?.total_hits)} 命中 / {formatNumber((stats?.total_hits ?? 0) + (stats?.total_misses ?? 0))} 总请求
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">节省 Token</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <>
                <div className="text-2xl font-bold">
                  {formatNumber(stats?.tokens_saved)}
                </div>
                <p className="text-xs text-muted-foreground">
                  累计节省的 token 数
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">缓存条目</CardTitle>
            <Database className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <>
                <div className="text-2xl font-bold">
                  {formatNumber(stats?.cache_entries)}
                </div>
                <p className="text-xs text-muted-foreground">
                  当前有效缓存条目数
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">今日命中</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <>
                <div className="text-2xl font-bold">
                  {formatNumber(stats?.today_hits)}
                </div>
                <p className="text-xs text-muted-foreground">
                  今日命中 {formatNumber(stats?.today_hits)} / 未命中 {formatNumber(stats?.today_misses)}
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 配置管理区 */}
      <Card>
        <CardHeader>
          <CardTitle>缓存配置</CardTitle>
          <CardDescription>
            调整语义缓存参数，修改后立即生效
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {configLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : (
            <>
              {/* 基本设置 */}
              <div className="grid gap-4 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <Label className="text-base">启用缓存</Label>
                    <p className="text-sm text-muted-foreground">
                      开启语义缓存功能
                    </p>
                  </div>
                  <Switch
                    checked={currentConfig?.enabled ?? false}
                    onCheckedChange={(checked: boolean) => updateField("enabled", checked)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>隔离模式</Label>
                  <Select
                    value={currentConfig?.scope_mode ?? "user"}
                    items={[
                      { value: "user", label: "按用户隔离（最安全）" },
                      { value: "system_prompt", label: "按 System Prompt 隔离" },
                      { value: "global", label: "全局共享（最高命中率）" },
                    ]}
                    onValueChange={(value: string | null) => {
                      if (value) updateField("scope_mode", value);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">按用户隔离（最安全）</SelectItem>
                      <SelectItem value="system_prompt">按 System Prompt 隔离</SelectItem>
                      <SelectItem value="global">全局共享（最高命中率）</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    决定不同请求之间是否共享缓存
                  </p>
                </div>
              </div>

              <Separator />

              {/* 性能参数 */}
              <div className="grid gap-4 md:grid-cols-4">
                <div className="space-y-2">
                  <Label>TTL（秒）</Label>
                  <Input
                    type="number"
                    min={60}
                    max={86400}
                    value={currentConfig?.ttl_seconds ?? 3600}
                    onChange={(e) =>
                      updateField("ttl_seconds", parseInt(e.target.value) || 3600)
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    缓存过期时间（60~86400）
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>相似度阈值</Label>
                  <Input
                    type="number"
                    min={0.5}
                    max={1.0}
                    step={0.01}
                    value={currentConfig?.similarity_threshold ?? 0.95}
                    onChange={(e) =>
                      updateField(
                        "similarity_threshold",
                        parseFloat(e.target.value) || 0.95
                      )
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    越高越精确，越低命中率越高（0.5~1.0）
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>最大缓存条目数</Label>
                  <Input
                    type="number"
                    min={100}
                    max={1000000}
                    value={currentConfig?.max_cache_entries ?? 100000}
                    onChange={(e) =>
                      updateField(
                        "max_cache_entries",
                        parseInt(e.target.value) || 100000
                      )
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    超出后淘汰最少命中的条目
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>最大响应大小（KB）</Label>
                  <Input
                    type="number"
                    min={1}
                    max={10240}
                    value={Math.round((currentConfig?.max_response_bytes ?? 524288) / 1024)}
                    onChange={(e) =>
                      updateField(
                        "max_response_bytes",
                        (parseInt(e.target.value) || 512) * 1024
                      )
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    超出此大小的响应不缓存（最大 10240 KB）
                  </p>
                </div>
              </div>

              <Separator />

              {/* Embedding 配置 */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-medium">Embedding 提供商</h4>
                  <div className="flex items-center gap-2">
                    {testResult && (
                      testResult.ok ? (
                        <span className="flex items-center gap-1 text-xs text-green-600">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          连接成功 ({testResult.latency_ms}ms)
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-destructive">
                          <XCircle className="h-3.5 w-3.5" />
                          {testResult.error}
                        </span>
                      )
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleTestEmbedding}
                      disabled={testEmbedding.isPending}
                    >
                      {testEmbedding.isPending ? (
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <FlaskConical className="mr-2 h-3.5 w-3.5" />
                      )}
                      测试连接
                    </Button>
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label>模型</Label>
                    <Input
                      value={currentConfig?.embedding_model ?? "text-embedding-3-small"}
                      onChange={(e) =>
                        updateField("embedding_model", e.target.value)
                      }
                      placeholder="text-embedding-3-small"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Base URL</Label>
                    <Input
                      value={currentConfig?.embedding_base_url ?? ""}
                      onChange={(e) =>
                        updateField("embedding_base_url", e.target.value)
                      }
                      placeholder="https://api.openai.com"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>API Key</Label>
                    <Input
                      type="password"
                      value={currentConfig?.embedding_api_key ?? ""}
                      onChange={(e) =>
                        updateField("embedding_api_key", e.target.value)
                      }
                      placeholder="sk-..."
                    />
                  </div>
                </div>
              </div>

              {/* 保存按钮 */}
              {editConfig && (
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setEditConfig(null)}
                  >
                    取消
                  </Button>
                  <Button
                    onClick={handleSave}
                    disabled={updateConfig.isPending}
                  >
                    {updateConfig.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    保存配置
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* 清除缓存确认对话框 */}
      <ConfirmDialog
        open={showClearDialog}
        onOpenChange={setShowClearDialog}
        title="清除全部缓存"
        description="确定要清除所有语义缓存条目吗？此操作不可撤销，清除后命中率将归零直到缓存重新填充。"
        confirmLabel="清除全部"
        variant="destructive"
        onConfirm={handleClear}
        loading={clearCache.isPending}
      />
    </div>
  );
}
