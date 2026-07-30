"use client";

import { useMemo, useState } from "react";
import { ColumnDef } from "@tanstack/react-table";
import { Eye, Download, Paperclip, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/page-header";
import { DataTable } from "@/components/shared/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiClient, ApiError } from "@/lib/api-client";
import { cn, formatDateTime } from "@/lib/utils";

interface FeedbackAttachment {
  fileName: string;
  contentType: string;
  size: number;
  storageKey: string;
}

/** 用户画像（调研问卷，可选填写），与 ticket 后端 feedbackRecordDTO.profile 对齐。 */
interface FeedbackProfile {
  source?: string;
  role?: string;
  aiGoal?: string;
  frequency?: string;
  industry?: string;
}

/** Bug 类排障信息，与 ticket 后端 feedbackRecordDTO.bugInfo 对齐。 */
interface FeedbackBugInfo {
  frequency?: string;
  expected?: string;
}

/** 反馈细分类型枚举，与用户端问卷（support-page.tsx）最新 9 类保持一致。 */
const FEEDBACK_TYPE = {
  ExperienceIssue: "experience_issue",
  BugReport: "bug_report",
  FeatureRequest: "feature_request",
  Rant: "rant",
  Performance: "performance",
  Billing: "billing",
  Security: "security",
  Docs: "docs",
  Other: "other",
} as const;

/** 反馈大类枚举：建议/反馈 或 Bug，与最新问卷（support-page.tsx）对齐。 */
const FEEDBACK_CATEGORY = {
  Suggestion: "suggestion",
  Bug: "bug",
} as const;
type FeedbackCategoryValue = (typeof FEEDBACK_CATEGORY)[keyof typeof FEEDBACK_CATEGORY];

interface FeedbackRecord {
  id: string;
  accountId: string;
  feedbackType: string;
  otherText?: string | null;
  description: string;
  subject: string;
  site: string;
  category?: FeedbackCategoryValue | null;
  profile?: FeedbackProfile | null;
  bugInfo?: FeedbackBugInfo | null;
  createdAt: string;
  updatedAt: string;
  attachments: FeedbackAttachment[];
  contactInfo?: string | null;
}

const FEEDBACK_TYPE_LABELS: Record<string, string> = {
  [FEEDBACK_TYPE.ExperienceIssue]: "体验问题反馈",
  [FEEDBACK_TYPE.BugReport]: "Bug/异常",
  [FEEDBACK_TYPE.FeatureRequest]: "产品功能建议",
  [FEEDBACK_TYPE.Rant]: "产品吐槽",
  [FEEDBACK_TYPE.Performance]: "性能/卡顿问题",
  [FEEDBACK_TYPE.Billing]: "账单/费用问题",
  [FEEDBACK_TYPE.Security]: "安全/隐私问题",
  [FEEDBACK_TYPE.Docs]: "文档/帮助问题",
  [FEEDBACK_TYPE.Other]: "其他",
};

const CATEGORY_LABELS: Record<string, string> = {
  [FEEDBACK_CATEGORY.Suggestion]: "建议/反馈",
  [FEEDBACK_CATEGORY.Bug]: "Bug/异常",
};

// 说明：反馈系统的其它枚举（发生频率 / 使用频率 / 了解渠道 / 角色 / 行业）
// 用户端问卷已经把 value 与中文 label 合一，dashboard 只需直接展示
// record 里的原文即可，不再维护 code→label 映射。

const CATEGORY_FILTER_ALL = "all";
const TYPE_FILTER_ALL = "all";

function feedbackTypeLabel(type: string, otherText?: string | null): string {
  const label = FEEDBACK_TYPE_LABELS[type] ?? type;
  if (type === FEEDBACK_TYPE.Other && otherText?.trim()) {
    return `${label} · ${otherText.trim()}`;
  }
  return label;
}

function categoryLabel(category?: string | null): string {
  if (!category) return "未分类";
  return CATEGORY_LABELS[category] ?? "未分类";
}

/**
 * profileValue 表格里画像单元格取值：非空且 trim 后有内容才展示，否则展示 "-"。
 * 用户端问卷把画像视为可选调研项，此处把"未填"显式呈现，避免运营误判。
 */
function profileValue(value?: string | null): string {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : "-";
}

// ──────────────────────────────────────────────────────────
// 通用筛选器：字段元信息 + 规则求值
// 设计动机：运营侧希望「按任意列 · 包含/等于/… · 什么」组合过滤，
// 而不是仅有账号ID/内容两个固定输入框。字段列表与表格列保持一一映射，
// 后续新增字段只需在 FILTERABLE_FIELDS 加一条即可自动进入筛选器下拉。
// ──────────────────────────────────────────────────────────
type FilterOp = "contains" | "equals" | "not_equals" | "empty" | "not_empty";

interface FilterRule {
  /** 唯一 id，仅用于 React key；不参与逻辑。 */
  id: string;
  /** FILTERABLE_FIELDS 里某一项的 key。 */
  field: string;
  op: FilterOp;
  /** empty/not_empty 时忽略；其它操作时必填。 */
  value: string;
}

interface FilterableField {
  key: string;
  label: string;
  /** 从 record 里抽出用于匹配的字符串（多值以 \n 连接，便于 contains 命中）。 */
  extract: (r: FeedbackRecord) => string;
}

/**
 * evaluateRule 判定单条规则是否命中记录。
 * - contains/equals/not_equals：大小写不敏感字符串比较；对枚举字段自动展开为
 *   "code + 中文 label" 两种形式都可命中，避免运营不知道枚举值究竟是 "bug" 还是
 *   "Bug/异常" 而漏筛。
 * - empty/not_empty：只看 extract 结果是否 trim 后为空。
 */
function evaluateRule(rule: FilterRule, record: FeedbackRecord): boolean {
  const field = FILTERABLE_FIELDS.find((f) => f.key === rule.field);
  if (!field) return true;
  const raw = field.extract(record).trim();
  switch (rule.op) {
    case "empty":
      return raw.length === 0;
    case "not_empty":
      return raw.length > 0;
    case "contains":
    case "equals":
    case "not_equals": {
      const needle = rule.value.trim().toLowerCase();
      if (needle.length === 0) return true; // 未填值视为忽略此规则
      const hay = raw.toLowerCase();
      if (rule.op === "contains") return hay.includes(needle);
      if (rule.op === "equals") return hay === needle;
      return hay !== needle;
    }
  }
}

const FILTER_OPS: { value: FilterOp; label: string }[] = [
  { value: "contains", label: "包含" },
  { value: "equals", label: "等于" },
  { value: "not_equals", label: "不等于" },
  { value: "empty", label: "为空" },
  { value: "not_empty", label: "非空" },
];

const FILTERABLE_FIELDS: FilterableField[] = [
  { key: "id", label: "反馈 ID", extract: (r) => r.id },
  { key: "accountId", label: "账号 ID", extract: (r) => r.accountId },
  { key: "contactInfo", label: "联系方式", extract: (r) => r.contactInfo ?? "" },
  {
    key: "category",
    label: "大类",
    extract: (r) => {
      const code = r.category ?? "";
      const label = code ? (CATEGORY_LABELS[code] ?? "") : "";
      return [code, label].filter(Boolean).join("\n");
    },
  },
  {
    key: "feedbackType",
    label: "类型",
    extract: (r) => {
      const code = r.feedbackType ?? "";
      const label = FEEDBACK_TYPE_LABELS[code] ?? "";
      const other = r.otherText?.trim() ?? "";
      return [code, label, other].filter(Boolean).join("\n");
    },
  },
  { key: "subject", label: "主题", extract: (r) => r.subject ?? "" },
  { key: "description", label: "内容", extract: (r) => r.description ?? "" },
  { key: "profileSource", label: "了解渠道", extract: (r) => r.profile?.source ?? "" },
  { key: "profileRole", label: "角色", extract: (r) => r.profile?.role ?? "" },
  { key: "profileAiGoal", label: "AI 用途", extract: (r) => r.profile?.aiGoal ?? "" },
  { key: "profileFrequency", label: "使用频率", extract: (r) => r.profile?.frequency ?? "" },
  { key: "profileIndustry", label: "行业", extract: (r) => r.profile?.industry ?? "" },
  { key: "bugFrequency", label: "发生频率", extract: (r) => r.bugInfo?.frequency ?? "" },
  { key: "bugExpected", label: "期望结果", extract: (r) => r.bugInfo?.expected ?? "" },
  { key: "attachments", label: "附件数", extract: (r) => String(r.attachments?.length ?? 0) },
  { key: "createdAt", label: "创建时间", extract: (r) => r.createdAt ?? "" },
  { key: "updatedAt", label: "更新时间", extract: (r) => r.updatedAt ?? "" },
];

const LONG_TEXT_PREVIEW_LIMIT = 10;

/**
 * LongTextCell 是"表格里的长文本"通用单元格：
 *   - 空值时展示 "-"；
 *   - 超过 LONG_TEXT_PREVIEW_LIMIT 字时按字数截断并加 "…"；
 *   - 有内容时整格可点，触发外部 onExpand（打开详情弹窗看全文）。
 * 说明：字符统计用 [...str].length 计算，规避 CJK 与 emoji 的 code point 长度差异。
 */
function LongTextCell({
  value,
  onExpand,
  className,
  title = "点击查看完整内容",
}: {
  value?: string | null;
  onExpand: () => void;
  className?: string;
  title?: string;
}) {
  const raw = (value ?? "").trim();
  if (raw.length === 0) {
    return <span className={cn("text-xs text-muted-foreground", className)}>-</span>;
  }
  const chars = Array.from(raw);
  const preview = chars.length > LONG_TEXT_PREVIEW_LIMIT
    ? `${chars.slice(0, LONG_TEXT_PREVIEW_LIMIT).join("")}…`
    : raw;
  return (
    <button
      type="button"
      onClick={onExpand}
      title={title}
      className={cn(
        "text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
    >
      {preview}
    </button>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function FeedbackPage() {
  // 本期仅上线国内站反馈；国际站暂未在后台暴露（后端数据已按 cn/global 隔离）。
  const SITE = "cn" as const;
  const [records, setRecords] = useState<FeedbackRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [detail, setDetail] = useState<FeedbackRecord | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>(CATEGORY_FILTER_ALL);
  const [typeFilter, setTypeFilter] = useState<string>(TYPE_FILTER_ALL);
  // 通用筛选器：每条规则形如「字段 · 操作 · 值」，规则之间是 AND。
  // 相比之前"账号ID/内容"两个固定输入框，这里允许运营对任意字段做
  // 包含/等于/不等于/为空/非空 组合，覆盖真实排障场景。
  const [rules, setRules] = useState<FilterRule[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  async function load() {
    setIsLoading(true);
    try {
      const data = await apiClient<{ items: FeedbackRecord[] }>(
        `support-feedback/list?site=${SITE}`
      );
      setRecords(data.items ?? []);
      setPage(1);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "加载反馈失败";
      toast.error(msg);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDownload(attachment: FeedbackAttachment) {
    try {
      const data = await apiClient<{ url: string }>(
        `support-feedback/sign?key=${encodeURIComponent(attachment.storageKey)}`
      );
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "获取下载链接失败";
      toast.error(msg);
    }
  }

  const filteredRecords = useMemo(() => {
    return records.filter((record) => {
      if (categoryFilter !== CATEGORY_FILTER_ALL) {
        if ((record.category ?? "") !== categoryFilter) return false;
      }
      if (typeFilter !== TYPE_FILTER_ALL) {
        if ((record.feedbackType ?? "") !== typeFilter) return false;
      }
      // 所有自定义规则以 AND 组合命中，任一不命中则剔除该记录。
      for (const rule of rules) {
        if (!evaluateRule(rule, record)) return false;
      }
      return true;
    });
  }, [records, categoryFilter, typeFilter, rules]);

  const resetFilters = () => {
    setCategoryFilter(CATEGORY_FILTER_ALL);
    setTypeFilter(TYPE_FILTER_ALL);
    setRules([]);
    setPage(1);
  };

  const hasActiveFilter =
    categoryFilter !== CATEGORY_FILTER_ALL
    || typeFilter !== TYPE_FILTER_ALL
    || rules.length > 0;

  const addRule = () => {
    setRules((prev) => [
      ...prev,
      { id: `r_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, field: "description", op: "contains", value: "" },
    ]);
    setPage(1);
  };
  const updateRule = (id: string, patch: Partial<FilterRule>) => {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setPage(1);
  };
  const removeRule = (id: string) => {
    setRules((prev) => prev.filter((r) => r.id !== id));
    setPage(1);
  };

  // 列可见性随「大类」筛选联动：
  //   - Bug/异常：只有「期望结果」有意义，画像 5 列全部隐藏；
  //   - 建议/反馈：画像 5 列有意义，隐藏「期望结果」；
  //   - 全部大类：两侧都展示，方便对比。
  // 详情弹窗仍然展示全部字段，不受此规则影响。
  const showProfileColumns = categoryFilter !== FEEDBACK_CATEGORY.Bug;
  const showBugExpectedColumn = categoryFilter !== FEEDBACK_CATEGORY.Suggestion;

  const columns: ColumnDef<FeedbackRecord>[] = useMemo(() => {
    const list: ColumnDef<FeedbackRecord>[] = [
      { accessorKey: "id", header: "反馈 ID", cell: ({ row }) => <span className="font-mono text-xs">{row.original.id}</span> },
      { accessorKey: "accountId", header: "账号", cell: ({ row }) => <span className="font-mono text-xs">{row.original.accountId}</span> },
      {
        id: "contactInfo",
        header: "联系方式",
        cell: ({ row }) => {
          // 用户填写的原文，通常是微信号或邮箱；未填时显示 "-"。
          const raw = (row.original.contactInfo ?? "").trim();
          if (raw.length === 0) {
            return <span className="text-xs text-muted-foreground">-</span>;
          }
          return <span className="max-w-[160px] truncate text-xs">{raw}</span>;
        },
      },
      {
        accessorKey: "category",
        header: "大类",
        cell: ({ row }) => <Badge variant="outline">{categoryLabel(row.original.category)}</Badge>,
      },
      {
        id: "openDetail",
        header: "查看完整表单",
        cell: ({ row }) => (
          <Button variant="ghost" size="sm" onClick={() => setDetail(row.original)}>
            <Eye className="mr-2 h-4 w-4" /> 查看
          </Button>
        ),
      },
      {
        accessorKey: "feedbackType",
        header: "类型",
        cell: ({ row }) => <span>{feedbackTypeLabel(row.original.feedbackType, row.original.otherText)}</span>,
      },
      {
        accessorKey: "subject",
        header: "主题",
        cell: ({ row }) => (
          <LongTextCell
            value={row.original.subject}
            onExpand={() => setDetail(row.original)}
            title="点击查看完整表单"
          />
        ),
      },
      {
        accessorKey: "description",
        header: "内容",
        cell: ({ row }) => (
          <LongTextCell
            value={row.original.description}
            onExpand={() => setDetail(row.original)}
            title="点击查看完整反馈内容"
          />
        ),
      },
    ];

    if (showProfileColumns) {
      list.push(
        {
          id: "profileSource",
          header: "了解渠道",
          cell: ({ row }) => (
            <span className="max-w-[140px] truncate text-xs text-muted-foreground">
              {profileValue(row.original.profile?.source)}
            </span>
          ),
        },
        {
          id: "profileRole",
          header: "角色",
          cell: ({ row }) => (
            <span className="max-w-[140px] truncate text-xs text-muted-foreground">
              {profileValue(row.original.profile?.role)}
            </span>
          ),
        },
        {
          id: "profileAiGoal",
          header: "AI 用途",
          cell: ({ row }) => (
            <LongTextCell
              value={row.original.profile?.aiGoal}
              onExpand={() => setDetail(row.original)}
              title="点击查看完整 AI 用途"
              className="text-xs text-muted-foreground"
            />
          ),
        },
      );
    }

    if (showBugExpectedColumn) {
      list.push(
        {
          id: "bugFrequency",
          header: "发生频率",
          cell: ({ row }) => (
            <span className="max-w-[140px] truncate text-xs text-muted-foreground">
              {profileValue(row.original.bugInfo?.frequency)}
            </span>
          ),
        },
        {
          id: "bugExpected",
          header: "期望结果",
          cell: ({ row }) => (
            <LongTextCell
              value={row.original.bugInfo?.expected}
              onExpand={() => setDetail(row.original)}
              title="点击查看完整期望结果"
              className="text-xs text-muted-foreground"
            />
          ),
        },
      );
    }

    if (showProfileColumns) {
      list.push(
        {
          id: "profileFrequency",
          header: "使用频率",
          cell: ({ row }) => (
            <span className="max-w-[140px] truncate text-xs text-muted-foreground">
              {profileValue(row.original.profile?.frequency)}
            </span>
          ),
        },
        {
          id: "profileIndustry",
          header: "行业",
          cell: ({ row }) => (
            <span className="max-w-[140px] truncate text-xs text-muted-foreground">
              {profileValue(row.original.profile?.industry)}
            </span>
          ),
        },
      );
    }

    list.push(
      {
        id: "attachmentsCount",
        header: "附件",
        cell: ({ row }) => {
          const attachments = row.original.attachments ?? [];
          const count = attachments.length;
          if (count === 0) {
            return <span className="text-xs text-muted-foreground">-</span>;
          }
          // 附件列点击行为：
          //   - 恰好 1 个附件：直接触发下载（预签名 URL 在新标签打开）；
          //   - 多个附件：打开详情弹窗，在弹窗内逐个下载（避免在表格里堆按钮）。
          const handleClick = () => {
            if (count === 1) {
              void handleDownload(attachments[0]);
            } else {
              setDetail(row.original);
            }
          };
          const title = count === 1
            ? `点击下载 ${attachments[0].fileName}`
            : `点击查看 ${count} 个附件并下载`;
          return (
            <button
              type="button"
              onClick={handleClick}
              title={title}
              className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs",
                "underline-offset-2 hover:bg-muted hover:underline",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              )}
            >
              <Paperclip className="h-3 w-3" />
              {count} 个
            </button>
          );
        },
      },
      { accessorKey: "createdAt", header: "创建时间", cell: ({ row }) => formatDateTime(row.original.createdAt) },
      { accessorKey: "updatedAt", header: "更新时间", cell: ({ row }) => formatDateTime(row.original.updatedAt) },
    );

    return list;
  }, [showProfileColumns, showBugExpectedColumn]);

  const paged = filteredRecords.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="space-y-6">
      <PageHeader title="用户反馈" description="查看用户提交的反馈与附件。" />

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={load} disabled={isLoading}>
            {isLoading ? "加载中..." : "加载反馈"}
          </Button>
          <span className="text-sm text-muted-foreground">国内站反馈</span>

          <Select
            value={categoryFilter}
            items={[
              { value: CATEGORY_FILTER_ALL, label: "全部大类" },
              { value: FEEDBACK_CATEGORY.Suggestion, label: "建议/反馈" },
              { value: FEEDBACK_CATEGORY.Bug, label: "Bug/异常" },
            ]}
            onValueChange={(value: string | null) => {
              if (value) {
                setCategoryFilter(value);
                setPage(1);
              }
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={CATEGORY_FILTER_ALL}>全部大类</SelectItem>
              <SelectItem value={FEEDBACK_CATEGORY.Suggestion}>建议/反馈</SelectItem>
              <SelectItem value={FEEDBACK_CATEGORY.Bug}>Bug/异常</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={typeFilter}
            items={[
              { value: TYPE_FILTER_ALL, label: "全部类型" },
              ...Object.values(FEEDBACK_TYPE).map((value) => ({
                value,
                label: FEEDBACK_TYPE_LABELS[value] ?? value,
              })),
            ]}
            onValueChange={(value: string | null) => {
              if (value) {
                setTypeFilter(value);
                setPage(1);
              }
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TYPE_FILTER_ALL}>全部类型</SelectItem>
              {Object.values(FEEDBACK_TYPE).map((value) => (
                <SelectItem key={value} value={value}>
                  {FEEDBACK_TYPE_LABELS[value] ?? value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          {/* 自定义筛选规则列表：每一行 = 字段 + 操作 + 值。规则之间 AND。 */}
          {rules.map((rule) => {
            const needsValue = rule.op !== "empty" && rule.op !== "not_empty";
            const currentField = FILTERABLE_FIELDS.find((f) => f.key === rule.field);
            return (
              <div key={rule.id} className="flex flex-wrap items-center gap-2">
                <Select
                  value={rule.field}
                  items={FILTERABLE_FIELDS.map((f) => ({ value: f.key, label: f.label }))}
                  onValueChange={(v: string | null) => v && updateRule(rule.id, { field: v })}
                >
                  <SelectTrigger className="w-[140px]">
                    <SelectValue>{currentField?.label ?? "选择字段"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {FILTERABLE_FIELDS.map((f) => (
                      <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={rule.op}
                  items={FILTER_OPS.map((o) => ({ value: o.value, label: o.label }))}
                  onValueChange={(v: string | null) => v && updateRule(rule.id, { op: v as FilterOp })}
                >
                  <SelectTrigger className="w-[110px]">
                    <SelectValue>
                      {FILTER_OPS.find((o) => o.value === rule.op)?.label ?? ""}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {FILTER_OPS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {needsValue ? (
                  <Input
                    className="w-64"
                    placeholder={`输入要${FILTER_OPS.find((o) => o.value === rule.op)?.label ?? "匹配"}的内容`}
                    value={rule.value}
                    onChange={(event) => updateRule(rule.id, { value: event.target.value })}
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">（无需填值）</span>
                )}

                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeRule(rule.id)}
                  title="删除这条规则"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            );
          })}

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" size="sm" onClick={addRule}>
              <Plus className="mr-1 h-4 w-4" />
              添加筛选规则
            </Button>
            {hasActiveFilter && (
              <Button variant="ghost" size="sm" onClick={resetFilters}>
                清空全部筛选
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
              共 {filteredRecords.length} 条 / 全量 {records.length} 条
              {rules.length > 0 && `（自定义规则 ${rules.length} 条，AND 组合）`}
            </span>
          </div>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={paged}
        total={filteredRecords.length}
        page={page}
        pageSize={pageSize}
        pageSizeOptions={[20, 50, 100]}
        onPageChange={setPage}
        onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        isLoading={isLoading}
      />

      <Dialog open={!!detail} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle>反馈详情</DialogTitle>
            <DialogDescription>
              反馈 ID：<span className="font-mono text-xs">{detail?.id}</span>
              {detail?.contactInfo ? ` · 联系方式：${detail.contactInfo}` : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[70vh] space-y-4 overflow-y-auto py-2">
            <div className="grid grid-cols-2 gap-2 text-sm text-muted-foreground">
              <span>账号：<span className="font-mono">{detail?.accountId}</span></span>
              <span>大类：{detail ? categoryLabel(detail.category) : ""}</span>
              <span>类型：{detail ? feedbackTypeLabel(detail.feedbackType, detail.otherText) : ""}</span>
              <span>创建：{detail ? formatDateTime(detail.createdAt) : ""}</span>
              <span>更新：{detail ? formatDateTime(detail.updatedAt) : ""}</span>
            </div>

            <div className="rounded-md border p-3 text-sm whitespace-pre-wrap">{detail?.description}</div>

            {detail?.category === FEEDBACK_CATEGORY.Bug && detail.bugInfo && (
              <div className="space-y-2">
                <p className="text-sm font-medium">排障信息</p>
                <div className="grid grid-cols-2 gap-2 rounded-md border p-3 text-sm">
                  {detail.bugInfo.frequency && <span>发生频率：{detail.bugInfo.frequency}</span>}
                  {detail.bugInfo.expected && (
                    <span className="col-span-2 whitespace-pre-wrap">期望结果：{detail.bugInfo.expected}</span>
                  )}
                </div>
              </div>
            )}

            {detail?.profile && (
              <div className="space-y-2">
                <p className="text-sm font-medium">用户画像</p>
                <div className="grid grid-cols-2 gap-2 rounded-md border p-3 text-sm">
                  {detail.profile.source && <span>了解渠道：{detail.profile.source}</span>}
                  {detail.profile.role && <span>角色：{detail.profile.role}</span>}
                  {detail.profile.frequency && <span>使用频率：{detail.profile.frequency}</span>}
                  {detail.profile.industry && <span>行业：{detail.profile.industry}</span>}
                  {detail.profile.aiGoal && (
                    <span className="col-span-2 whitespace-pre-wrap">AI 用途：{detail.profile.aiGoal}</span>
                  )}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <p className="text-sm font-medium">附件（{detail?.attachments.length ?? 0}）</p>
              {detail?.attachments.length ? (
                <ul className="space-y-2">
                  {detail.attachments.map((att) => (
                    <li key={att.storageKey} className="flex items-center justify-between rounded-md border p-2 text-sm">
                      <span className="truncate">
                        {att.fileName}
                        <span className="ml-2 text-xs text-muted-foreground">{formatBytes(att.size)}</span>
                      </span>
                      <Button variant="outline" size="sm" onClick={() => handleDownload(att)}>
                        <Download className="mr-2 h-4 w-4" /> 下载
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">无附件</p>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
