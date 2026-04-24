"use client";

import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { ProgressTrack, ProgressIndicator } from "@/components/ui/progress";
import {
  MoreHorizontal,
  Plus,
  Pencil,
  Ban,
  CheckCircle,
  BarChart3,
  X,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/page-header";
import { DataTable } from "@/components/shared/data-table";
import {
  useProviders,
  useProviderUsage,
  useCreateProvider,
  useUpdateProvider,
  useValidateProvider,
  useDiscoverProviderModels,
  useValidateProviderModelRequest,
  type ProviderValidationResult,
  type ProviderModelDiscoveryResult,
  type ProviderModelRequestValidationResult,
} from "@/lib/queries/use-providers";
import {
  formatTokens,
  formatNumber,
  formatDateTime,
  statusVariant,
  quotaProgressColor,
} from "@/lib/utils";

interface Provider {
  id: string;
  name: string;
  provider_type: string;
  model_discovery_protocol: string;
  base_url: string;
  api_key: string;
  status: string;
  priority: number;
  weight: number;
  health_check_url: string;
  last_heartbeat: string | null;
  registration_source: string;
  total_quota: number;
  used_quota: number;
  supported_models: string[] | null;
  created_at: string;
  updated_at: string;
}

const PROVIDER_TYPES = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "qwen", label: "Qwen" },
];

const MODEL_DISCOVERY_PROTOCOLS = [
  { value: "openai_compatible", label: "OpenAI Compatible" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Gemini" },
];

const providerSchema = z.object({
  name: z.string().min(1, "名称不能为空"),
  provider_type: z.string().min(1, "供应商类型不能为空"),
  model_discovery_protocol: z.string().min(1, "协议不能为空"),
  api_key: z.string().optional(),
  base_url: z.string().refine(
    (val) => val === "" || /^https?:\/\/.+/.test(val),
    { message: "请输入有效的 URL" }
  ),
  total_quota: z.number().int().min(0, "不能为负数"),
  priority: z.number().int().min(0, "不能为负数"),
  weight: z.number().int().min(0).max(1000).optional(),
  health_check_url: z.string().optional(),
  supported_models: z.array(z.string()).optional(),
});

type ProviderFormValues = z.infer<typeof providerSchema>;

function defaultFormValues(): ProviderFormValues {
  return {
    name: "",
    provider_type: "",
    model_discovery_protocol: "openai_compatible",
    api_key: "",
    base_url: "",
    total_quota: 1000000,
    priority: 1,
    weight: 100,
    health_check_url: "",
    supported_models: [],
  };
}

function providerToFormValues(provider: Provider): ProviderFormValues {
  return {
    name: provider.name,
    provider_type: provider.provider_type,
    model_discovery_protocol:
      provider.model_discovery_protocol ||
      (provider.provider_type === "anthropic" ? "anthropic" : "openai_compatible"),
    api_key: provider.api_key ?? "",
    base_url: provider.base_url || "",
    total_quota: provider.total_quota,
    priority: provider.priority,
    weight: provider.weight ?? 100,
    health_check_url: provider.health_check_url ?? "",
    supported_models: [...(provider.supported_models ?? [])],
  };
}

function isMaskedApiKey(value: string | undefined | null) {
  return (value ?? "").includes("***");
}

export default function ProvidersPage() {
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [usageProviderId, setUsageProviderId] = useState<string | null>(null);
  const [modelInput, setModelInput] = useState("");
  const [validationResult, setValidationResult] =
    useState<ProviderValidationResult | null>(null);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [discoverResult, setDiscoverResult] =
    useState<ProviderModelDiscoveryResult | null>(null);
  const [modelRequestValidationResult, setModelRequestValidationResult] =
    useState<ProviderModelRequestValidationResult | null>(null);
  const [validationModel, setValidationModel] = useState("");

  const { data, isLoading } = useProviders();
  const createProvider = useCreateProvider();
  const updateProvider = useUpdateProvider();
  const validateProvider = useValidateProvider();
  const discoverProviderModels = useDiscoverProviderModels();
  const validateProviderModelRequest = useValidateProviderModelRequest();
  const { data: usageData, isLoading: usageLoading } = useProviderUsage(
    usageProviderId ?? ""
  );

  const form = useForm<ProviderFormValues>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(providerSchema) as any,
    defaultValues: defaultFormValues(),
  });

  const [
    watchedProviderType,
    watchedProtocol,
    watchedBaseURL,
    watchedAPIKey,
    watchedHealthCheckURL,
    watchedSupportedModels,
  ] =
    useWatch({
      control: form.control,
      name: [
        "provider_type",
        "model_discovery_protocol",
        "base_url",
        "api_key",
        "health_check_url",
        "supported_models",
      ],
    });

  useEffect(() => {
    setValidationResult(null);
  }, [dialogOpen, watchedProviderType, watchedBaseURL, watchedAPIKey, watchedHealthCheckURL]);

  useEffect(() => {
    setDiscoveredModels([]);
    setDiscoverResult(null);
    setModelRequestValidationResult(null);
  }, [dialogOpen, watchedProtocol, watchedBaseURL, watchedAPIKey, watchedHealthCheckURL]);

  useEffect(() => {
    const models = watchedSupportedModels ?? [];
    if (models.length === 0) {
      setValidationModel("");
      setModelRequestValidationResult(null);
      return;
    }
    if (!validationModel || !models.includes(validationModel)) {
      setValidationModel(models[0]);
    }
  }, [validationModel, watchedSupportedModels]);

  function inferProtocol(providerType: string) {
    if (providerType === "anthropic") return "anthropic";
    return "openai_compatible";
  }

  function openCreate() {
    setEditingProvider(null);
    form.reset(defaultFormValues());
    setModelInput("");
    setValidationResult(null);
    setDiscoveredModels([]);
    setDiscoverResult(null);
    setModelRequestValidationResult(null);
    setValidationModel("");
    setDialogOpen(true);
  }

  function openEdit(provider: Provider) {
    setEditingProvider(provider);
    form.reset(providerToFormValues(provider));
    setModelInput("");
    setValidationResult(null);
    setDiscoveredModels([]);
    setDiscoverResult(null);
    setModelRequestValidationResult(null);
    setValidationModel(provider.supported_models?.[0] ?? "");
    setDialogOpen(true);
  }

  function validateRequiredFields(
    values: ProviderFormValues,
    options: { requireApiKey: boolean }
  ) {
    let isValid = true;
    form.clearErrors(["provider_type", "model_discovery_protocol", "base_url", "api_key"]);

    if (!values.provider_type.trim()) {
      form.setError("provider_type", { message: "供应商类型不能为空" });
      isValid = false;
    }
    if (!values.model_discovery_protocol.trim()) {
      form.setError("model_discovery_protocol", { message: "协议不能为空" });
      isValid = false;
    }
    if (!values.base_url.trim()) {
      form.setError("base_url", { message: "基础 URL 不能为空" });
      isValid = false;
    }
    if (options.requireApiKey && !(values.api_key ?? "").trim()) {
      form.setError("api_key", { message: "API Key 不能为空" });
      isValid = false;
    }

    return isValid;
  }

  function toggleSupportedModel(model: string) {
    const models = form.getValues("supported_models") ?? [];
    const exists = models.includes(model);
    form.setValue(
      "supported_models",
      exists ? models.filter((item) => item !== model) : [...models, model],
      { shouldDirty: true }
    );
    if (!exists && !validationModel) {
      setValidationModel(model);
    }
    if (exists && validationModel === model) {
      const nextModels = models.filter((item) => item !== model);
      setValidationModel(nextModels[0] ?? "");
      setModelRequestValidationResult(null);
    }
  }

  async function handleValidateConfig() {
    const values = form.getValues();
    const useSavedApiKey = !!editingProvider && (!(values.api_key ?? "").trim() || isMaskedApiKey(values.api_key));
    if (!validateRequiredFields(values, { requireApiKey: !useSavedApiKey })) {
      return;
    }

    const fieldsToValidate: Array<keyof ProviderFormValues> = [
      "provider_type",
      "model_discovery_protocol",
      "base_url",
    ];
    if (!useSavedApiKey) {
      fieldsToValidate.push("api_key");
    }

    const formValid = await form.trigger(fieldsToValidate);
    if (!formValid) {
      return;
    }

    try {
      const result = await validateProvider.mutateAsync({
        provider_id: editingProvider?.id,
        provider_type: values.provider_type.trim(),
        api_key: useSavedApiKey ? undefined : (values.api_key ?? "").trim() || undefined,
        base_url: values.base_url.trim(),
        health_check_url: (values.health_check_url ?? "").trim() || undefined,
      });
      setValidationResult(result);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (err) {
      setValidationResult(null);
      toast.error(
        err instanceof Error ? err.message : "验证供应商配置失败"
      );
    }
  }

  async function handleDiscoverModels() {
    const values = form.getValues();
    const useSavedApiKey = !!editingProvider && (!(values.api_key ?? "").trim() || isMaskedApiKey(values.api_key));
    if (!validateRequiredFields(values, { requireApiKey: !useSavedApiKey })) {
      return;
    }

    const fieldsToValidate: Array<keyof ProviderFormValues> = [
      "model_discovery_protocol",
      "base_url",
    ];
    if (!useSavedApiKey) {
      fieldsToValidate.push("api_key");
    }
    const formValid = await form.trigger(fieldsToValidate);
    if (!formValid) {
      return;
    }

    try {
      const result = await discoverProviderModels.mutateAsync({
        provider_id: editingProvider?.id,
        model_discovery_protocol: values.model_discovery_protocol.trim(),
        api_key: useSavedApiKey ? undefined : (values.api_key ?? "").trim() || undefined,
        base_url: values.base_url.trim(),
        health_check_url: (values.health_check_url ?? "").trim() || undefined,
      });
      setDiscoverResult(result);
      setDiscoveredModels(result.models ?? []);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (err) {
      setDiscoverResult(null);
      setDiscoveredModels([]);
      toast.error(err instanceof Error ? err.message : "查询可用模型失败");
    }
  }

  async function handleValidateModelRequest() {
    const values = form.getValues();
    const useSavedApiKey = !!editingProvider && (!(values.api_key ?? "").trim() || isMaskedApiKey(values.api_key));
    if (!validationModel) {
      toast.error("请先选择一个用于验证的模型");
      return;
    }
    if (!validateRequiredFields(values, { requireApiKey: !useSavedApiKey })) {
      return;
    }

    const fieldsToValidate: Array<keyof ProviderFormValues> = [
      "model_discovery_protocol",
      "base_url",
    ];
    if (!useSavedApiKey) {
      fieldsToValidate.push("api_key");
    }
    const formValid = await form.trigger(fieldsToValidate);
    if (!formValid) {
      return;
    }

    try {
      const result = await validateProviderModelRequest.mutateAsync({
        provider_id: editingProvider?.id,
        model_discovery_protocol: values.model_discovery_protocol.trim(),
        api_key: useSavedApiKey ? undefined : (values.api_key ?? "").trim() || undefined,
        base_url: values.base_url.trim(),
        model: validationModel,
      });
      setModelRequestValidationResult(result);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (err) {
      setModelRequestValidationResult(null);
      toast.error(err instanceof Error ? err.message : "验证模型调用失败");
    }
  }

  async function handleQuickValidate(provider: Provider) {
    try {
      const result = await validateProvider.mutateAsync({
        provider_id: provider.id,
        provider_type: provider.provider_type,
        base_url: provider.base_url,
        health_check_url: provider.health_check_url || undefined,
      });
      if (result.ok) {
        toast.success(`${provider.name}：${result.message}`);
      } else {
        toast.error(`${provider.name}：${result.message}`);
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "验证供应商配置失败"
      );
    }
  }

  async function onSubmit(values: ProviderFormValues) {
    if (!validateRequiredFields(values, { requireApiKey: !editingProvider })) {
      return;
    }

    let supportedModels = values.supported_models ?? [];
    const pendingModel = modelInput.trim();
    if (pendingModel && !supportedModels.includes(pendingModel)) {
      supportedModels = [...supportedModels, pendingModel];
    }
    const input = {
      name: values.name,
      provider_type: values.provider_type,
      model_discovery_protocol: values.model_discovery_protocol,
      total_quota: values.total_quota,
      priority: values.priority,
      weight: values.weight ?? 100,
      health_check_url: values.health_check_url ?? "",
      supported_models: supportedModels,
      ...(values.api_key && !isMaskedApiKey(values.api_key) ? { api_key: values.api_key } : {}),
      ...(values.base_url ? { base_url: values.base_url } : {}),
    };
    try {
      if (editingProvider) {
        await updateProvider.mutateAsync({ id: editingProvider.id, ...input });
        toast.success("供应商已更新");
      } else {
        await createProvider.mutateAsync(input);
        toast.success("供应商已创建");
      }
      setDialogOpen(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "保存供应商失败"
      );
    }
  }

  async function handleToggleStatus(provider: Provider) {
    const newStatus = provider.status === "active" ? "disabled" : "active";
    try {
      await updateProvider.mutateAsync({
        id: provider.id,
        name: provider.name,
        provider_type: provider.provider_type,
        model_discovery_protocol:
          provider.model_discovery_protocol || inferProtocol(provider.provider_type),
        total_quota: provider.total_quota,
        priority: provider.priority,
        weight: provider.weight ?? 100,
        health_check_url: provider.health_check_url ?? "",
        status: newStatus,
      });
      toast.success(
        `供应商已${newStatus === "active" ? "启用" : "禁用"}`
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "更新供应商失败"
      );
    }
  }

  const columns: ColumnDef<Provider>[] = [
    { accessorKey: "name", header: "名称" },
    {
      accessorKey: "provider_type",
      header: "类型",
      cell: ({ row }) => {
        const type = row.original.provider_type;
        const label =
          PROVIDER_TYPES.find((t) => t.value === type)?.label ?? type;
        return <Badge variant="outline">{label}</Badge>;
      },
    },
    {
      accessorKey: "status",
      header: "状态",
      cell: ({ row }) => (
        <Badge variant={statusVariant(row.original.status)}>
          {row.original.status}
        </Badge>
      ),
    },
    {
      accessorKey: "priority",
      header: "优先级",
      cell: ({ row }) => formatNumber(row.original.priority),
    },
    {
      accessorKey: "weight",
      header: "权重",
      cell: ({ row }) => formatNumber(row.original.weight ?? 100),
    },
    {
      id: "source",
      header: "来源",
      cell: ({ row }) => {
        const source = row.original.registration_source ?? "manual";
        const variant = source === "registry" ? "default" : "secondary";
        return (
          <Badge variant={variant}>
            {source === "registry" ? "注册" : "手动"}
          </Badge>
        );
      },
    },
    {
      id: "health",
      header: "健康",
      cell: ({ row }) => {
        const status = row.original.status;
        const lastHeartbeat = row.original.last_heartbeat;
        if (status === "unhealthy") {
          return (
            <div className="flex items-center gap-1" title="不健康">
              <span className="h-2 w-2 rounded-full bg-red-500" />
              <span className="text-xs text-muted-foreground">异常</span>
            </div>
          );
        }
        if (lastHeartbeat) {
          return (
            <div className="flex items-center gap-1" title={`最后心跳: ${lastHeartbeat}`}>
              <span className="h-2 w-2 rounded-full bg-green-500" />
              <span className="text-xs text-muted-foreground">正常</span>
            </div>
          );
        }
        return (
          <div className="flex items-center gap-1" title="无心跳数据">
            <span className="h-2 w-2 rounded-full bg-gray-400" />
            <span className="text-xs text-muted-foreground">-</span>
          </div>
        );
      },
    },
    {
      id: "supported_models",
      header: "支持模型",
      cell: ({ row }) => {
        const models = row.original.supported_models ?? [];
        if (models.length === 0) return <span className="text-muted-foreground text-xs">-</span>;
        if (models.length === 1) {
          return <span className="text-sm truncate max-w-[150px]">{models[0]}</span>;
        }
        return (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground cursor-pointer">
                  <span className="truncate max-w-[120px]">{models[0]}</span>
                  <span className="text-xs text-primary">+{models.length - 1}</span>
                </button>
              }
            />
            <DropdownMenuContent className="max-h-48 w-max max-w-64 overflow-x-auto overflow-y-auto">
              <DropdownMenuLabel className="whitespace-nowrap">支持模型 ({models.length})</DropdownMenuLabel>
              {models.map((m) => (
                <DropdownMenuItem key={m} className="text-sm whitespace-nowrap">
                  {m}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
    {
      id: "quota",
      header: "配额",
      cell: ({ row }) => {
        const { used_quota, total_quota } = row.original;
        const pct = total_quota > 0 ? (used_quota / total_quota) * 100 : 0;
        return (
          <div className="flex items-center gap-2 min-w-[140px]">
            <ProgressPrimitive.Root
              value={Math.min(pct, 100)}
              className="flex flex-1"
            >
              <ProgressTrack>
                <ProgressIndicator
                  className={quotaProgressColor(used_quota, total_quota)}
                />
              </ProgressTrack>
            </ProgressPrimitive.Root>
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {formatTokens(used_quota)}/{formatTokens(total_quota)}
            </span>
          </div>
        );
      },
    },
    {
      id: "actions",
      cell: ({ row }) => {
        const provider = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon" />}
            >
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => openEdit(provider)}>
                <Pencil className="mr-2 h-4 w-4" /> 编辑
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleQuickValidate(provider)}>
                <CheckCircle className="mr-2 h-4 w-4" /> 验证配置
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleToggleStatus(provider)}>
                {provider.status === "active" ? (
                  <>
                    <Ban className="mr-2 h-4 w-4" /> 禁用
                  </>
                ) : (
                  <>
                    <CheckCircle className="mr-2 h-4 w-4" /> 启用
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setUsageProviderId(provider.id)}
              >
                <BarChart3 className="mr-2 h-4 w-4" /> 查看用量
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  const isSaving = createProvider.isPending || updateProvider.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        title="供应商管理"
        description="管理 AI 供应商、API Key 和配额分配。"
      >
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" /> 添加供应商
        </Button>
      </PageHeader>

      <DataTable
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        page={page}
        pageSize={20}
        onPageChange={setPage}
        isLoading={isLoading}
      />

      {/* Add/Edit Provider Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="flex h-[90vh] min-h-0 flex-col overflow-hidden p-0 gap-0 sm:h-auto sm:max-h-[90vh] sm:max-w-2xl">
          <DialogHeader className="shrink-0 border-b px-6 pt-6 pb-4 pr-14">
            <DialogTitle>
              {editingProvider ? "编辑供应商" : "添加供应商"}
            </DialogTitle>
            <DialogDescription>
              {editingProvider
                ? "更新供应商配置。"
                : "配置新的 AI 供应商。"}
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>名称</FormLabel>
                      <FormControl>
                        <Input placeholder="例如：OpenAI 主账号" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="provider_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>类型</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={(value) => {
                          if (!value) return;
                          field.onChange(value);
                          form.setValue("model_discovery_protocol", inferProtocol(value), {
                            shouldDirty: true,
                          });
                        }}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="选择供应商类型" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {PROVIDER_TYPES.map((type) => (
                            <SelectItem key={type.value} value={type.value}>
                              {type.label}
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
                  name="model_discovery_protocol"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>协议</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="选择模型发现协议" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {MODEL_DISCOVERY_PROTOCOLS.map((protocol) => (
                            <SelectItem key={protocol.value} value={protocol.value}>
                              {protocol.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        用于查询模型列表和真实调用验证，不改变现有路由类型。
                      </p>
                      <FormMessage />
                    </FormItem>
                  )}
                />

              <FormField
                control={form.control}
                name="api_key"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>API Key</FormLabel>
                    {editingProvider?.api_key && isMaskedApiKey(field.value) && (
                      <p className="text-xs text-muted-foreground">
                        已回显脱敏密钥；直接保存会继续复用当前密钥，覆盖输入新值即可更新。
                      </p>
                    )}
                    <FormControl>
                      <Input
                        type={editingProvider ? "text" : "password"}
                        className="font-mono"
                        placeholder={
                          editingProvider
                            ? "已回显当前脱敏密钥，输入新密钥以更新"
                            : "输入 API Key"
                        }
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="base_url"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>基础 URL</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="https://api.openai.com/v1"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="supported_models"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>支持模型</FormLabel>
                    <div className="space-y-3 rounded-md border p-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                          <p className="text-sm font-medium">查询可用模型</p>
                          <p className="text-xs text-muted-foreground">
                            根据协议、URL 和 API Key 查询上游模型列表。若返回不完整，可手动补充。
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleDiscoverModels}
                          disabled={discoverProviderModels.isPending}
                        >
                          {discoverProviderModels.isPending ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <CheckCircle className="mr-2 h-4 w-4" />
                          )}
                          {discoverProviderModels.isPending ? "查询中..." : "查询可用模型"}
                        </Button>
                      </div>

                      {discoverResult && (
                        <div
                          className={`rounded-lg border px-3 py-2.5 ${
                            discoverResult.ok
                              ? "border-emerald-500/30 bg-emerald-500/5"
                              : "border-destructive/30 bg-destructive/5"
                          }`}
                        >
                          <div className="space-y-1 text-sm">
                            <p className="font-medium">{discoverResult.message}</p>
                            {discoverResult.endpoint && (
                              <p className="break-all text-xs text-muted-foreground">
                                查询地址：
                                <span className="ml-1 font-mono">
                                  {discoverResult.endpoint}
                                </span>
                              </p>
                            )}
                            {discoverResult.response_excerpt && (
                              <p className="text-xs text-muted-foreground">
                                返回摘要：{discoverResult.response_excerpt}
                              </p>
                            )}
                          </div>
                        </div>
                      )}

                      <div className="space-y-2">
                        <p className="text-sm font-medium">候选模型</p>
                        {discoveredModels.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            还没有查询结果，或上游未返回模型列表。
                          </p>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {discoveredModels.map((model: string) => {
                              const selected = (field.value ?? []).includes(model);
                              return (
                                <Button
                                  key={model}
                                  type="button"
                                  variant={selected ? "default" : "outline"}
                                  size="sm"
                                  onClick={() => toggleSupportedModel(model)}
                                >
                                  {model}
                                </Button>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div className="space-y-2">
                        <p className="text-sm font-medium">已选模型</p>
                        <FormControl>
                          <div className="flex min-h-[40px] flex-wrap items-center gap-1.5 rounded-md border bg-background p-2">
                            {(field.value ?? []).map((model: string) => (
                              <Badge key={model} variant="secondary" className="gap-1 text-xs">
                                {model}
                                <button
                                  type="button"
                                  className="ml-0.5 rounded-full outline-none hover:bg-muted-foreground/20"
                                  onClick={() =>
                                    field.onChange(
                                      (field.value ?? []).filter((m: string) => m !== model)
                                    )
                                  }
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </Badge>
                            ))}
                            {(field.value ?? []).length === 0 && (
                              <span className="text-xs text-muted-foreground">
                                尚未选择模型
                              </span>
                            )}
                          </div>
                        </FormControl>
                      </div>

                      <div className="space-y-2">
                        <p className="text-sm font-medium">手动补充模型</p>
                        <Input
                          className="h-9"
                          placeholder="输入模型名，回车添加"
                          value={modelInput}
                          onChange={(e) => setModelInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              const raw = modelInput.trim();
                              if (!raw) return;
                              if ((field.value ?? []).includes(raw)) {
                                toast.error(`模型 ${raw} 已存在`);
                                return;
                              }
                              field.onChange([...(field.value ?? []), raw]);
                              setModelInput("");
                            }
                          }}
                        />
                      </div>

                      <div className="space-y-3 rounded-md border border-dashed p-3">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                          <div className="grid gap-2">
                            <p className="text-sm font-medium">真实调用验证</p>
                            <p className="text-xs text-muted-foreground">
                              选择一个模型，用当前 URL、Key 和协议发起一次最小请求，确认配置真实可用。
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={handleValidateModelRequest}
                            disabled={
                              validateProviderModelRequest.isPending ||
                              (field.value ?? []).length === 0 ||
                              !validationModel
                            }
                          >
                            {validateProviderModelRequest.isPending ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <CheckCircle className="mr-2 h-4 w-4" />
                            )}
                            {validateProviderModelRequest.isPending
                              ? "验证中..."
                              : "验证模型调用"}
                          </Button>
                        </div>

                        <Select
                          value={validationModel}
                          onValueChange={(value) => {
                            if (!value) return;
                            setValidationModel(value);
                            setModelRequestValidationResult(null);
                          }}
                          disabled={(field.value ?? []).length === 0}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="选择一个验证模型" />
                          </SelectTrigger>
                          <SelectContent>
                            {(field.value ?? []).map((model: string) => (
                              <SelectItem key={model} value={model}>
                                {model}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        {modelRequestValidationResult && (
                          <div
                            className={`rounded-lg border px-3 py-2.5 ${
                              modelRequestValidationResult.ok
                                ? "border-emerald-500/30 bg-emerald-500/5"
                                : "border-destructive/30 bg-destructive/5"
                            }`}
                          >
                            <div className="space-y-2 text-sm">
                              <p className="font-medium">
                                {modelRequestValidationResult.message}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                验证模型：{modelRequestValidationResult.model}
                              </p>
                              <div className="space-y-1">
                                <p className="text-xs text-muted-foreground">请求地址</p>
                                <div className="max-h-20 overflow-auto rounded-md border bg-background/70 px-2 py-1.5 font-mono text-[11px] leading-relaxed break-all text-muted-foreground">
                                  {modelRequestValidationResult.endpoint}
                                </div>
                              </div>
                              {modelRequestValidationResult.response_excerpt && (
                                <div className="space-y-1">
                                  <p className="text-xs text-muted-foreground">返回摘要</p>
                                  <div className="max-h-28 overflow-auto rounded-md border bg-background/70 px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-muted-foreground">
                                    {modelRequestValidationResult.response_excerpt}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      保存时仅写入已选模型；手动补充的模型会和查询结果一起提交到 supported_models。
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="health_check_url"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>健康检查 URL</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="可选，用于注册提供商的健康检查"
                        {...field}
                      />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">
                      服务注册时自动设置，手动添加可留空。
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="space-y-3 rounded-lg border border-dashed p-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">配置验证</p>
                    <p className="text-xs text-muted-foreground">
                      检查基础 URL 和 API Key 是否可访问模型列表接口。编辑时若不填写新密钥，将复用当前已保存的密钥。
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleValidateConfig}
                    disabled={validateProvider.isPending}
                  >
                    {validateProvider.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle className="mr-2 h-4 w-4" />
                    )}
                    {validateProvider.isPending ? "验证中..." : "验证配置"}
                  </Button>
                </div>

                {validationResult && (
                  <div
                    className={`rounded-lg border px-3 py-2.5 ${
                      validationResult.ok
                        ? "border-emerald-500/30 bg-emerald-500/5"
                        : "border-destructive/30 bg-destructive/5"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      {validationResult.ok ? (
                        <CheckCircle className="mt-0.5 h-4 w-4 text-emerald-500" />
                      ) : (
                        <Ban className="mt-0.5 h-4 w-4 text-destructive" />
                      )}
                      <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium">
                          {validationResult.message}
                        </p>
                        <div className="space-y-1 text-xs text-muted-foreground">
                          <p className="break-all">
                            检测地址：
                            <span className="ml-1 font-mono">
                              {validationResult.endpoint}
                            </span>
                          </p>
                          <p>
                            上游状态：{validationResult.status_code ?? "-"} · 延迟：
                            {" "}
                            {validationResult.latency_ms}ms
                            {validationResult.used_saved_api_key
                              ? " · 使用已保存密钥"
                              : " · 使用当前输入密钥"}
                          </p>
                          {validationResult.response_excerpt && (
                            <p className="break-all">
                              响应摘要：{validationResult.response_excerpt}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <FormField
                  control={form.control}
                  name="total_quota"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>总配额</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          {...field}
                          onChange={(e) =>
                            field.onChange(e.target.valueAsNumber || 0)
                          }
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="priority"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>优先级</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          {...field}
                          onChange={(e) =>
                            field.onChange(e.target.valueAsNumber || 0)
                          }
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="weight"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>权重</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          {...field}
                          onChange={(e) =>
                            field.onChange(e.target.valueAsNumber || 100)
                          }
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                </div>
              </div>

              <DialogFooter className="mx-0 mb-0 shrink-0 rounded-none px-6">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDialogOpen(false)}
                >
                  取消
                </Button>
                <Button type="submit" disabled={isSaving}>
                  {isSaving
                    ? "保存中..."
                    : editingProvider
                      ? "更新"
                      : "创建"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* View Usage Dialog */}
      <Dialog
        open={!!usageProviderId}
        onOpenChange={(open) => !open && setUsageProviderId(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>供应商用量</DialogTitle>
            <DialogDescription>
              配额消耗和请求统计。
            </DialogDescription>
          </DialogHeader>

          {usageLoading ? (
            <div className="py-8 text-center text-muted-foreground">
              加载用量数据中...
            </div>
          ) : usageData ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">已用配额</span>
                  <span className="font-medium">
                    {formatTokens(usageData.used_quota)} /{" "}
                    {formatTokens(usageData.total_quota)}
                  </span>
                </div>
                <ProgressPrimitive.Root
                  value={
                    usageData.total_quota > 0
                      ? Math.min(
                          (usageData.used_quota / usageData.total_quota) * 100,
                          100
                        )
                      : 0
                  }
                  className="flex w-full"
                >
                  <ProgressTrack>
                    <ProgressIndicator
                      className={quotaProgressColor(
                        usageData.used_quota,
                        usageData.total_quota
                      )}
                    />
                  </ProgressTrack>
                </ProgressPrimitive.Root>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">
                    请求次数
                  </p>
                  <p className="text-lg font-semibold">
                    {formatNumber(usageData.request_count)}
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">最后使用</p>
                  <p className="text-lg font-semibold">
                    {usageData.last_used_at
                      ? formatDateTime(usageData.last_used_at)
                      : "从未使用"}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground">
              暂无用量数据。
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setUsageProviderId(null)}
            >
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
