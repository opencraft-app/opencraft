import type { ReactNode } from "react";
import { AccountStatusBadge, accountCardClass } from "@/components/account/account-surface";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface OrderItem {
  id: string;
  description: string;
  type: string;
  duration: string;
  quantity: number;
  amount: string;
  date: string;
  status: string;
}

export interface AccountOrdersTableProps {
  orders: readonly OrderItem[];
  currencyFormatter: (amount: string, order: OrderItem) => string;
  pagination: {
    currentPage: number;
    pageSize: number;
    totalCount: number;
    onPreviousPage?: () => void;
    onNextPage?: () => void;
  };
}

const columns = ["订单号", "描述", "类型", "时长", "数量", "金额", "日期", "状态"] as const;

export function AccountOrdersTable({ orders, currencyFormatter, pagination }: AccountOrdersTableProps) {
  const totalPages = Math.max(1, Math.ceil(pagination.totalCount / pagination.pageSize));

  return (
    <section className={cn(accountCardClass, "min-w-0 overflow-hidden")}>
      <div className="hidden lg:block">
        <table className="w-full border-collapse" aria-label="订单历史">
          <thead className="bg-black/[0.02]">
            <tr>{columns.map((column) => (
              <th key={column} scope="col" className={cn("whitespace-nowrap border-b border-black/[0.06] px-4 py-3 text-left text-xs font-semibold text-[var(--text-secondary)]", column === "数量" && "text-center", column === "金额" && "text-right")}>{column}</th>
            ))}</tr>
          </thead>
          <tbody>{orders.map((order) => (
            <tr key={order.id} data-order-id={order.id} className="hover:bg-black/[0.02]">
              <TableCell><span className="font-mono text-xs text-[var(--text-tertiary)]">{order.id.slice(0, 10)}…</span></TableCell>
              <TableCell>{order.description}</TableCell><TableCell>{order.type}</TableCell>
              <TableCell><span className="text-[var(--text-tertiary)]">{order.duration}</span></TableCell>
              <TableCell className="text-center tabular-nums">{order.quantity}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{currencyFormatter(order.amount, order)}</TableCell>
              <TableCell><span className="text-xs tabular-nums text-[var(--text-secondary)]">{order.date}</span></TableCell>
              <TableCell><AccountStatusBadge tone="success">{order.status}</AccountStatusBadge></TableCell>
            </tr>
          ))}</tbody>
        </table>
      </div>

      <div data-testid="account-orders-mobile-list" className="divide-y divide-black/[0.06] lg:hidden">
        {orders.map((order) => (
          <article key={order.id} data-order-id={order.id} className="min-w-0 space-y-3 p-4">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0"><div className="break-all font-mono text-xs tabular-nums text-[var(--text-tertiary)]">{order.id}</div><div className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{order.description}</div></div>
              <AccountStatusBadge tone="success">{order.status}</AccountStatusBadge>
            </div>
            <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <OrderDetail label="类型" value={order.type} /><OrderDetail label="时长" value={order.duration} />
              <OrderDetail label="数量" value={String(order.quantity)} valueClassName="tabular-nums" />
              <OrderDetail label="金额" value={currencyFormatter(order.amount, order)} valueClassName="break-words font-mono tabular-nums" />
              <OrderDetail label="日期" value={order.date} valueClassName="break-words tabular-nums" className="col-span-2" />
            </dl>
          </article>
        ))}
      </div>

      <div className="flex flex-col gap-3 border-t border-black/[0.06] bg-black/[0.02] px-4 py-3 text-xs text-[var(--text-tertiary)] sm:flex-row sm:items-center sm:justify-between">
        <span className="tabular-nums">共 {pagination.totalCount} 条数据</span>
        <div className="flex items-center justify-between gap-3 sm:justify-end"><span className="tabular-nums">{pagination.pageSize} 条/页</span><div className="flex items-center gap-1">
          <Button type="button" variant="outline" size="sm" className="size-8 rounded-md p-0" aria-label="上一页" disabled={pagination.currentPage <= 1} onClick={pagination.onPreviousPage}><span aria-hidden="true">‹</span></Button>
          <span className="flex size-8 items-center justify-center rounded-md bg-[var(--text-primary)] font-semibold tabular-nums text-white" aria-current="page">{pagination.currentPage}</span>
          <Button type="button" variant="outline" size="sm" className="size-8 rounded-md p-0" aria-label="下一页" disabled={pagination.currentPage >= totalPages} onClick={pagination.onNextPage}><span aria-hidden="true">›</span></Button>
        </div></div>
      </div>
    </section>
  );
}

function TableCell({ className, children }: { className?: string; children: ReactNode }) {
  return <td className={cn("whitespace-nowrap border-b border-black/[0.04] px-4 py-3.5 text-sm text-[var(--text-primary)]", className)}>{children}</td>;
}

function OrderDetail({ label, value, className, valueClassName }: { label: string; value: string; className?: string; valueClassName?: string }) {
  return <div className={cn("min-w-0", className)}><dt className="text-xs text-[var(--text-tertiary)]">{label}</dt><dd className={cn("mt-1 min-w-0 text-[var(--text-primary)]", valueClassName)}>{value}</dd></div>;
}
