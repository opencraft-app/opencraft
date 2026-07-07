"use client";

import { useState } from "react";
import { ColumnDef } from "@tanstack/react-table";
import { Eye, Download } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/page-header";
import { DataTable } from "@/components/shared/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiClient, ApiError } from "@/lib/api-client";
import { formatDateTime } from "@/lib/utils";

interface FeedbackAttachment {
  fileName: string;
  contentType: string;
  size: number;
  storageKey: string;
}

interface FeedbackRecord {
  id: string;
  accountId: string;
  feedbackType: string;
  otherText?: string | null;
  description: string;
  subject: string;
  status: string;
  site: string;
  createdAt: string;
  updatedAt: string;
  attachments: FeedbackAttachment[];
  contactInfo?: string | null;
}

const FEEDBACK_TYPE_LABELS: Record<string, string> = {
  bug: "Bug 反馈",
  feature: "功能建议",
  complaint: "投诉",
  other: "其他",
};

const FEEDBACK_STATUS_LABELS: Record<string, string> = {
  open: "待处理",
  reviewing: "处理中",
  resolved: "已解决",
};

function feedbackStatusVariant(status: string): "default" | "secondary" | "outline" {
  switch (status) {
    case "open":
      return "outline";
    case "reviewing":
      return "secondary";
    case "resolved":
      return "default";
    default:
      return "outline";
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function FeedbackPage() {
  const [site, setSite] = useState<"cn" | "global">("cn");
  const [records, setRecords] = useState<FeedbackRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [detail, setDetail] = useState<FeedbackRecord | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  async function load() {
    setIsLoading(true);
    try {
      const data = await apiClient<{ items: FeedbackRecord[] }>(
        `support-feedback/list?site=${site}`
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

  const columns: ColumnDef<FeedbackRecord>[] = [
    { accessorKey: "id", header: "反馈 ID", cell: ({ row }) => <span className="font-mono text-xs">{row.original.id}</span> },
    { accessorKey: "accountId", header: "账号", cell: ({ row }) => <span className="font-mono text-xs">{row.original.accountId}</span> },
    {
      accessorKey: "feedbackType",
      header: "类型",
      cell: ({ row }) => {
        const t = row.original.feedbackType;
        const label = FEEDBACK_TYPE_LABELS[t] ?? t;
        return (
          <span>
            {label}
            {row.original.otherText ? `（${row.original.otherText}）` : ""}
          </span>
        );
      },
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
    { accessorKey: "site", header: "站点", cell: ({ row }) => (row.original.site === "global" ? "国际站" : "国内站") },
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

  const paged = records.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="space-y-6">
      <PageHeader title="用户反馈" description="查看用户提交的反馈与附件。" />

      <div className="flex flex-wrap items-center gap-3">
        <Select value={site} onValueChange={(v) => setSite(v as "cn" | "global")}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="cn">国内站</SelectItem>
            <SelectItem value="global">国际站</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={load} disabled={isLoading}>
          {isLoading ? "加载中..." : "加载反馈"}
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={paged}
        total={records.length}
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

          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-2 text-sm text-muted-foreground">
              <span>账号：<span className="font-mono">{detail?.accountId}</span></span>
              <span>类型：{detail ? (FEEDBACK_TYPE_LABELS[detail.feedbackType] ?? detail.feedbackType) : ""}</span>
              <span>站点：{detail?.site === "global" ? "国际站" : "国内站"}</span>
              <span>状态：{detail ? (FEEDBACK_STATUS_LABELS[detail.status] ?? detail.status) : ""}</span>
              <span>创建：{detail ? formatDateTime(detail.createdAt) : ""}</span>
              <span>更新：{detail ? formatDateTime(detail.updatedAt) : ""}</span>
            </div>

            <div className="rounded-md border p-3 text-sm whitespace-pre-wrap">{detail?.description}</div>

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
