"use client";

import { useMemo, useState } from "react";
import { ColumnDef } from "@tanstack/react-table";
import { Eye, Download } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiClient, ApiError } from "@/lib/api-client";
import { formatDateTime } from "@/lib/utils";

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
  status: string;
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

const CATEGORY_FILTER_ALL = "all";

const FEEDBACK_STATUS = {
  OPEN: "open",
  REVIEWING: "reviewing",
  RESOLVED: "resolved",
} as const;

const FEEDBACK_STATUS_LABELS: Record<string, string> = {
  [FEEDBACK_STATUS.OPEN]: "待处理",
  [FEEDBACK_STATUS.REVIEWING]: "处理中",
  [FEEDBACK_STATUS.RESOLVED]: "已解决",
};

function feedbackStatusVariant(status: string): "default" | "secondary" | "outline" {
  switch (status) {
    case FEEDBACK_STATUS.OPEN:
      return "outline";
    case FEEDBACK_STATUS.REVIEWING:
      return "secondary";
    case FEEDBACK_STATUS.RESOLVED:
      return "default";
    default:
      return "outline";
  }
}

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
    if (categoryFilter === CATEGORY_FILTER_ALL) return records;
    return records.filter((record) => (record.category ?? "") === categoryFilter);
  }, [records, categoryFilter]);

  const columns: ColumnDef<FeedbackRecord>[] = [
    { accessorKey: "id", header: "反馈 ID", cell: ({ row }) => <span className="font-mono text-xs">{row.original.id}</span> },
    { accessorKey: "accountId", header: "账号", cell: ({ row }) => <span className="font-mono text-xs">{row.original.accountId}</span> },
    {
      accessorKey: "category",
      header: "大类",
      cell: ({ row }) => <Badge variant="outline">{categoryLabel(row.original.category)}</Badge>,
    },
    {
      accessorKey: "feedbackType",
      header: "类型",
      cell: ({ row }) => <span>{feedbackTypeLabel(row.original.feedbackType, row.original.otherText)}</span>,
    },
    { accessorKey: "subject", header: "主题", cell: ({ row }) => <span className="max-w-[240px] truncate">{row.original.subject}</span> },
    {
      accessorKey: "status",
      header: "状态",
      cell: ({ row }) => (
        <Badge variant={feedbackStatusVariant(row.original.status)}>
          {FEEDBACK_STATUS_LABELS[row.original.status] ?? row.original.status}
        </Badge>
      ),
    },
    { accessorKey: "createdAt", header: "创建时间", cell: ({ row }) => formatDateTime(row.original.createdAt) },
    {
      id: "actions",
      header: "操作",
      cell: ({ row }) => (
        <Button variant="ghost" size="sm" onClick={() => setDetail(row.original)}>
          <Eye className="mr-2 h-4 w-4" /> 查看
        </Button>
      ),
    },
  ];

  const paged = filteredRecords.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="space-y-6">
      <PageHeader title="用户反馈" description="查看用户提交的反馈与附件。" />

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
            <DialogTitle>{detail?.subject}</DialogTitle>
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
              <span>状态：{detail ? (FEEDBACK_STATUS_LABELS[detail.status] ?? detail.status) : ""}</span>
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
